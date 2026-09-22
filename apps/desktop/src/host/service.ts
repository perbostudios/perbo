import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TicketSchema } from "@perbo/contracts";
import type {
  Detail,
  Change,
  Job,
  Provider,
  ReplyMap,
  Repository,
  Request,
  RequestHandlers,
  Snapshot,
  TaskModels,
} from "../shared/protocol.js";
import {
  RequestSchema,
  TaskModelsSchema,
} from "../shared/protocol.js";
import { runProcess, startLineProcess } from "./process.js";
import { probeProviders } from "./providers/status.js";
import { seedArchived } from "./profile/preferences.js";
import { readStanding, writeStanding } from "./repository/config.js";
import type { TicketRecords } from "./tickets/open.js";
import type { SpecDeps } from "./plan/spec.js";
import {
  ContractEditing,
  openDrafts,
  type EditingOwner,
} from "../shared/contract-editing.js";
import { WorkspaceReads } from "./workspace-reads.js";
import { Profile } from "./profile/store.js";
import { Changes } from "./changes.js";
import { RepositoryRegistry } from "./repository/registry.js";
import { createCli, type Cli } from "./cli.js";
import { TicketReads } from "./tickets/reads.js";
import { InterviewHost } from "./interview/host.js";
import { JobRunner } from "./jobs/runner.js";
import { PowerHold } from "./power.js";
import { Notices } from "./notifications.js";
import { createRoutes, route, type RouteContext } from "./routes.js";
import type { ProfileState, RegisteredRepository } from "./profile/store.js";
import { codexUsage } from "./usage-probe.js";

export interface HostIO {
  chooseDirectory(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  saveFile(name: string, content: string): Promise<string | null>;
  notify(title: string, body: string, options?: { silent: boolean }): void;
  /** AFK mode (S6F): keep the machine awake while a run is live. */
  holdSleep?(hold: boolean, displaySleep: boolean): void;
  onBattery?(): boolean;
  applyTheme?(theme: "light" | "dark" | "system"): void;
  /** Runs a fixed sign-in command in the person's own terminal; absent where the host has no terminal to open. */
  openTerminal?(command: readonly string[]): Promise<void>;
}
export interface ServiceOptions {
  dataDirectory: string;
  cliPath: string;
  nodeBinary: string;
  electronNode?: boolean;
  version: string;
  io: HostIO;
  changed: (change: Change) => void;
  process?: typeof runProcess;
  /** The long-lived spawn the interview runs through; injected by tests. */
  startProcess?: typeof startLineProcess;
  /** The provider's own account of its plan windows; injected by tests. */
  usageProbe?: typeof codexUsage;
}

/**
 * The host the renderer talks to: it builds the modules and routes a request
 * to the one that answers it.
 */
export class DesktopService {
  private readonly options: ServiceOptions;
  private readonly execute: typeof runProcess;
  private readonly spawn: typeof startLineProcess;
  private readonly profile: Profile;
  private readonly changes: Changes;
  private readonly cli: Cli;
  private readonly registry: RepositoryRegistry;
  private readonly tickets: TicketReads;
  private readonly editing: ContractEditing;
  private readonly reads = new WorkspaceReads();
  private readonly jobs: JobRunner;
  private readonly power: PowerHold;
  private readonly notices: Notices;
  private readonly routes: RequestHandlers<RouteContext>;
  private readonly interviews: InterviewHost;

  /** The profile's own record, which every module mutating a preference is handed. */
  private get state(): ProfileState {
    return this.profile.state;
  }

  constructor(options: ServiceOptions) {
    this.options = options;
    this.execute = options.process ?? runProcess;
    this.spawn = options.startProcess ?? startLineProcess;
    this.profile = Profile.open(options.dataDirectory);
    this.changes = new Changes({
      reads: this.reads,
      save: () => this.profile.save(),
      emit: (change) => options.changed(change),
    });
    this.cli = createCli({
      nodeBinary: options.nodeBinary,
      cliPath: options.cliPath,
      electronNode: options.electronNode,
      execute: this.execute,
      spawn: this.spawn,
    });
    this.registry = new RepositoryRegistry({
      profile: this.profile,
      changes: this.changes,
      reads: this.reads,
      execute: this.execute,
      liveJobs: () => this.liveJobs(),
    });
    this.power = new PowerHold({
      io: options.io,
      settings: () => this.state.settings,
      liveJobs: () => this.liveJobs(),
      changes: this.changes,
    });
    this.notices = new Notices({
      io: options.io,
      settings: () => this.state.settings,
      repositories: () => this.registry.all(),
      tickets: { list: (repo) => this.tickets.list(repo) },
    });
    this.jobs = new JobRunner({
      profile: this.profile,
      changes: this.changes,
      reads: this.reads,
      cli: this.cli,
      editing: {
        started: (owner, job) => this.editing.started(owner, job),
        settled: (job) => this.editing.settled(job),
      },
      liveChanged: () => this.power.update(),
      progressed: (job) => this.notices.stage(job),
      settled: (job) => this.notices.outcome(job),
    });
    this.interviews = new InterviewHost({
      editing: {
        read: (id) => this.editing.read(id),
        converse: (id, line, at) => this.editing.converse(id, line, at),
        recordInterview: (id, session, provider) =>
          this.editing.recordInterview(id, session, provider),
        recordSpec: (id, slug) => this.editing.recordSpec(id, slug),
        beginAsking: (id, entry) => this.editing.beginAsking(id, entry),
        answerAsking: (id, text) => this.editing.answerAsking(id, text),
        countNodes: (id, nodes) => this.editing.countNodes(id, nodes),
      },
      repository: (id) => this.repository(id),
      tickets: { contract: (repo, key) => this.tickets.contract(repo, key) },
      cli: this.cli,
      changes: this.changes,
    });
    this.tickets = new TicketReads({
      reads: this.reads,
      cli: this.cli,
      registry: this.registry,
      settings: () => this.state.settings,
    });
    this.editing = new ContractEditing({
      records: () => this.state.editingSessions,
      persist: (records) => {
        const previous = this.state.editingSessions;
        this.state.editingSessions = records;
        try {
          this.profile.save();
        } catch (error) {
          this.state.editingSessions = previous;
          throw error;
        }
        for (const record of records)
          if (previous.find((entry) => entry.id === record.id) !== record)
            this.changes.changed(false, { kind: "editing", sessionId: record.id });
      },
      repository: (id) => {
        this.repository(id);
      },
      defaults: (repoId, key) =>
        TaskModelsSchema.strip().parse(
          this.state.taskModels[repoId + ":" + key] ?? this.state.settings,
        ),
      detail: (repoId, key) => this.detail(repoId, key),
      start: async (request, owner) =>
        (await this.dispatch(request, owner)) as Job,
      stop: async (jobId) => {
        await this.dispatch({ kind: "cancel", jobId });
      },
      id: randomUUID,
      standing: (repoId) => readStanding(this.repository(repoId)),
      setStanding: (repoId, entries) => {
        const repo = this.repository(repoId);
        writeStanding(repo, entries);
        this.changes.changed(true, { kind: "records", repoId: repo.id, key: null });
      },
    });
    this.routes = createRoutes({
      io: options.io,
      dataDirectory: options.dataDirectory,
      profile: this.profile,
      changes: this.changes,
      registry: this.registry,
      tickets: this.tickets,
      ticketRecords: this.ticketRecords(),
      planDeps: this.planDeps(),
      cli: this.cli,
      execute: this.execute,
      reads: this.reads,
      editing: this.editing,
      interviews: this.interviews,
      jobs: this.jobs,
      power: this.power,
      usageProbe: options.usageProbe ?? codexUsage,
      snapshot: () => this.snapshot(),
      providers: () => this.providers(),
      recordAdmitted: (job, repo, models) => this.recordAdmitted(job, repo, models),
    });
    this.editing.recover();
    this.profile.save();
    this.options.io.applyTheme?.(this.state.settings.theme);
  }

  private repository(id: string): RegisteredRepository {
    return this.registry.lookup(id);
  }
  registerRepository(path: string): Promise<Repository> {
    return this.registry.register(path);
  }
  async snapshot(): Promise<Snapshot> {
    // The live interviews are counted outside the shared read: they are this
    // host's own state rather than anything read off a repository, and a
    // cached listing would say one was still there after it had gone.
    const interviews = this.interviews.running();
    const working = this.interviews.working();
    const workspace = await this.reads.read("snapshot", "snapshot", async () => {
      const records = await Promise.all(
        this.state.repositories.map((repo) => this.tickets.repositorySnapshot(repo.id)),
      );
      const tasks = records.flatMap((entry) => entry.tasks);
      if (
        !records.some((entry) => entry.errors.length) &&
        seedArchived(this.state, tasks)
      )
        this.profile.save();
      return {
        version: this.options.version,
        settings: this.state.settings,
        repositories: records.map((entry) => entry.repository),
        tasks,
        jobs: this.state.jobs as Job[],
        errors: records.flatMap((entry) => entry.errors),
        titles: this.state.titles,
        taskModels: this.state.taskModels,
        sequence: this.changes.sequence,
        archived: this.state.archived,
        power: this.power.state,
        repositoryErrors: Object.fromEntries(
          records.map((entry) => [entry.repository.id, entry.errors]),
        ),
        drafts: openDrafts(this.state.editingSessions),
      };
    });
    return { ...workspace, interviews, working };
  }
  async detail(repoId: string, key: string): Promise<Detail> {
    return this.tickets.detail(repoId, key);
  }
  providers(): Promise<Provider[]> {
    return probeProviders(this.execute, this.options.dataDirectory);
  }
  /** The jobs still tracked, in either lane. */
  private liveJobs(): Job[] {
    return this.jobs.live();
  }
  async request<T extends Request>(input: T): Promise<ReplyMap[T["kind"]]> {
    const request = RequestSchema.parse(input);
    return (await this.dispatch(request)) as ReplyMap[T["kind"]];
  }
  private dispatch(request: Request, owner?: EditingOwner): Promise<unknown> {
    return route(this.routes, request, { owner });
  }
  /** What the planning modules are given of the rest of the host. */
  private planDeps(): SpecDeps {
    return {
      editing: this.editing,
      repository: (id) => this.repository(id),
      contract: (repo, key) => this.tickets.contract(repo, key),
    };
  }
  /** The key admission handed back, and the models the person chose for it. */
  private recordAdmitted(
    job: Job,
    repo: RegisteredRepository,
    models: TaskModels | undefined,
  ): void {
    const admitted = z.object({ ticket: TicketSchema }).parse(job.result);
    job.resultKey = admitted.ticket.key;
    if (models) {
      this.state.taskModels[repo.id + ":" + admitted.ticket.key] = models;
      this.changes.preferences(this.state);
    }
  }
  /** What a module reading a ticket's records is given, so it never reads the store twice over. */
  private ticketRecords(): TicketRecords {
    return {
      list: (repo) => this.tickets.list(repo),
      contract: (repo, key) => this.tickets.contract(repo, key),
    };
  }
  /** Called by the host when the machine moves between mains and battery. */
  powerChanged(): void {
    this.power.update();
  }
  async shutdown(): Promise<void> {
    this.interviews.shutdown();
    await this.jobs.shutdown();
  }
}
