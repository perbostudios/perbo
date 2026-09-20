import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  TicketSchema,
  STANDING_PROHIBITED_KEY,
  readStandingProhibited,
} from "@perbo/contracts";
import { heldRepository } from "../shared/jobs.js";
import {
  DraftSchema,
  HELP_LINKS,
  RequestSchema,
  TaskModelsSchema,
} from "../shared/protocol.js";
import type {
  Detail,
  Change,
  Job,
  Provider,
  ReplyMap,
  Repository,
  Request,
  Snapshot,
  TaskModels,
} from "../shared/protocol.js";
import { runProcess, startLineProcess } from "./process.js";
import { discoverModels } from "./model-catalog.js";
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
import { listExplorer, readExplorerFile } from "./explorer.js";
import { exportedNames } from "./symbols.js";
import { graphView } from "./plan/graph.js";
import { impactView } from "./plan/impact.js";
import { InterviewHost } from "./interview/host.js";
import { JobRunner } from "./jobs/runner.js";
import { openLogin, probeProviders } from "./providers/status.js";
import { usageReport } from "./providers/usage.js";
import { PowerHold } from "./power.js";
import { Notices } from "./notifications.js";
import { pullRequestUrl, ticketWorktree, type TicketRecords } from "./tickets/open.js";
import { archiveExport, ticketExport } from "./tickets/export.js";
import { retainedOutput } from "./tickets/output.js";
import { discardTicket } from "./tickets/discard.js";
import {
  saveSpec,
  specView,
  type SpecDeps,
} from "./plan/spec.js";
import {
  admitDraftArgs,
  admitFromFileArgs,
  admitFromSpecArgs,
  approveArgs,
  assertEditable,
  assertResumable,
  doctorArgs,
  doctorConfig,
  editArgs,
  graphEditArgs,
  principleArgs,
  runArgs,
  runConfig,
  syncArgs,
  verdictArgs,
  writePrivate,
} from "./jobs/commands.js";
import { seedArchived, setArchived } from "./profile/preferences.js";
import {
  effectiveLimits,
  readConfig,
  readManifest,
  saveManifest,
  specFolder,
  writeConfig,
} from "./repository/config.js";
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
 * A capability registry. A renderer request carries a repository id and, where
 * a surface reads one file, a repository-relative path; it never carries a
 * command, an absolute path or any other filesystem target. Every path is
 * resolved under the registered repository through `safePath` and refused
 * otherwise — outside the repository, through a symlink, or on the never-read
 * list, which the explorer neither lists nor previews.
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
      },
      repository: (id) => this.repository(id),
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
      standing: (repoId) => readStandingProhibited(readConfig(this.repository(repoId))),
      setStanding: (repoId, entries) => {
        const repo = this.repository(repoId);
        writeConfig(repo, {
          ...(readConfig(repo) ?? {}),
          [STANDING_PROHIBITED_KEY]: entries,
        });
        this.changes.changed(true, { kind: "records", repoId: repo.id, key: null });
      },
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
        mode: "desktop" as const,
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
    return { ...workspace, interviews };
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
  private async dispatch(
    request: Request,
    owner?: EditingOwner,
  ): Promise<unknown> {
    if (request.kind === "editingOpen")
      return this.editing.open(request.target, request.legacy);
    if (request.kind === "editingRead") return this.editing.read(request.id);
    if (request.kind === "drafts") return openDrafts(this.state.editingSessions);
    if (request.kind === "editingSave")
      return this.editing.save(
        request.id,
        request.revision,
        request.repoId,
        request.form,
      );
    if (request.kind === "editingSubmit")
      return this.editing.submit(
        request.id,
        request.revision,
        request.operationId,
        request.intent,
      );
    if (request.kind === "explorerMark")
      return this.editing.mark(
        request.id,
        request.revision,
        request.path,
        request.mark,
        request.always,
      );
    if (request.kind === "explorerUndo")
      return this.editing.undo(request.id, request.revision, request.edit);
    if (request.kind === "editingStop") return this.editing.stop(request.id);
    if (request.kind === "editingDiscard") {
      // The chat goes with the planning it belonged to: there is no longer a
      // spec for the interview to write or a plan for it to change.
      const discarded = this.editing.discard(request.id, request.revision);
      this.interviews.stop(request.id);
      return discarded;
    }
    // The interview docked beside the panes (D-102). Planning-lane work, like
    // the explorer's reads: answered here rather than as a job, so a run is
    // never in its way and it is never in a run's.
    if (request.kind === "interviewStart")
      return this.interviews.start(request.id, request.repoId);
    if (request.kind === "interviewTurn")
      return this.interviews.turn(request.id, request.text);
    if (request.kind === "interviewStop") return this.interviews.stop(request.id);
    if (request.kind === "snapshot") return this.snapshot();
    if (request.kind === "repositorySnapshot")
      return this.tickets.repositorySnapshot(request.repoId);
    // Planning-lane work (D-101): answered here, never as a job, so a run is
    // never in the way of reading a file and a read is never in the way of one.
    if (request.kind === "explorerList")
      return listExplorer(this.execute, this.repository(request.repoId));
    if (request.kind === "explorerRead")
      return readExplorerFile(
        this.execute,
        this.repository(request.repoId),
        request.path,
      );
    if (request.kind === "symbolIndex")
      return exportedNames(
        { cli: this.cli, reads: this.reads, execute: this.execute },
        this.repository(request.repoId),
      );
    if (request.kind === "providers") return this.providers();
    if (request.kind === "login")
      return openLogin(this.options.io, request.provider);
    if (request.kind === "models") return discoverModels(request.provider);
    if (request.kind === "exportArchive") {
      if (request.repoId !== null) this.repository(request.repoId);
      const { name, content } = archiveExport(await this.snapshot(), request);
      return this.options.io.saveFile(name, content);
    }
    if (request.kind === "openHelp") {
      await this.options.io.openExternal(HELP_LINKS[request.page]);
      return null;
    }
    if (request.kind === "chooseRepository") {
      const path = await this.options.io.chooseDirectory();
      return path === null ? null : this.registerRepository(path);
    }
    if (request.kind === "saveSettings") {
      this.state.settings = request.settings;
      this.changes.preferences(this.state);
      this.options.io.applyTheme?.(request.settings.theme);
      this.power.update();
      return request.settings;
    }
    if (request.kind === "specRead") return specView(this.planDeps(), request.id);
    if (request.kind === "impactRead")
      return impactView(
        {
          editing: this.editing,
          repository: (id) => this.repository(id),
          cli: this.cli,
          execute: this.execute,
        },
        request.id,
      );
    if (request.kind === "usage")
      return usageReport({
        repositories: () => this.registry.all(),
        lookup: (id) => this.repository(id),
        tickets: this.tickets,
        settings: () => this.state.settings,
        providers: () => this.providers(),
        probe: this.options.usageProbe ?? codexUsage,
      });
    if (request.kind === "cancel") return this.jobs.cancel(request.jobId);
    const repo = this.repository(request.repoId);
    if (request.kind === "forgetRepository") return this.registry.forget(repo.id);
    if (request.kind === "graphRead")
      return graphView({ tickets: this.tickets, execute: this.execute }, repo, request.key);
    // Every edit the Graph pane makes is this command (D-100): applied to a
    // copy, validated whole and recorded with its author by the CLI, which is
    // also what the interview's edits go through. The pane writes nothing.
    if (request.kind === "graphEdit" || request.kind === "graphUndo")
      return this.jobs.start(
        {
          repo,
          key: request.key,
          kind: request.kind,
          label: request.kind === "graphUndo" ? "Undo a plan edit" : "Change the plan's graph",
        },
        async (job, context) => {
          await context.invoke(graphEditArgs(request.key, request));
          job.resultKey = request.key;
        },
      );
    if (request.kind === "detail") return this.detail(repo.id, request.key);
    if (request.kind === "taskSummary")
      return this.tickets.summary(repo.id, request.key);
    if (request.kind === "discard") {
      await discardTicket(
        {
          tickets: this.ticketRecords(),
          profile: { state: this.state },
          liveJobs: () => this.liveJobs(),
        },
        repo,
        request.key,
      );
      this.changes.changed(true, { kind: "records", repoId: repo.id, key: null });
      this.changes.preferences(this.state);
      return null;
    }
    if (request.kind === "archive") {
      const list = await this.tickets.list(repo);
      const keys = [...new Set(request.keys)];
      if (keys.some((key) => !list.tickets.some((ticket) => ticket.key === key)))
        throw new Error("A ticket to file is not in the repository's ticket store.");
      setArchived(this.state, repo.id, keys, request.archived);
      this.changes.preferences(this.state);
      return null;
    }
    if (request.kind === "output")
      return retainedOutput(
        repo,
        await this.detail(repo.id, request.key),
        request.attemptId,
      );
    if (request.kind === "manifest") return readManifest(repo);
    if (request.kind === "saveManifest") {
      // The refusals keep their order: a repository with no configuration to
      // edit says so before a busy one does, and a stale digest after both.
      readManifest(repo);
      if (heldRepository(this.liveJobs(), repo.id))
        throw new Error(
          "Wait for the commands running in this repository to finish before changing the manifest.",
        );
      saveManifest(repo, request.digest, request.value);
      this.changes.changed(true, { kind: "records", repoId: repo.id, key: null });
      return null;
    }
    if (request.kind === "rename") {
      this.tickets.contract(repo, request.key);
      this.state.titles[repo.id + ":" + request.key] = request.title;
      this.changes.preferences(this.state);
      return null;
    }
    if (request.kind === "openRepository") {
      await this.options.io.openPath(repo.path);
      return null;
    }
    if (request.kind === "openWorktree") {
      await this.options.io.openPath(
        await ticketWorktree(
          { tickets: this.ticketRecords(), execute: this.execute },
          repo,
          request.key,
        ),
      );
      return null;
    }
    if (request.kind === "openPullRequest") {
      await this.options.io.openExternal(
        pullRequestUrl(await this.detail(repo.id, request.key)),
      );
      return null;
    }
    if (request.kind === "export") {
      const { name, content } = ticketExport(
        request.key ?? repo.name,
        request.key
          ? await this.detail(repo.id, request.key)
          : (await this.snapshot()).tasks.filter((row) => row.repoId === repo.id),
      );
      return this.options.io.saveFile(name, content);
    }
    if (request.kind === "doctor")
      return this.jobs.start(
        {
          repo,
          key: null,
          kind: request.kind,
          label: request.writeConfig
          ? "Save repository configuration"
          : "Check repository readiness",
        },
        async (job, context) => {
          const path = writePrivate(
            this.options.dataDirectory,
            `doctor-${job.id}.json`,
            JSON.stringify(doctorConfig(this.state.settings)),
          );
          await context.invoke(doctorArgs(path, request.writeConfig));
        },
      );
    if (request.kind === "specSave")
      return saveSpec(this.planDeps(), repo, request);
    if (request.kind === "generatePlan" || request.kind === "startOver")
      return this.jobs.start(
        {
          repo,
          key: request.kind === "startOver" ? request.key : null,
          kind: "draft",
          owner,
          label: request.kind === "startOver"
          ? "Draft this plan again from the spec"
          : "Draft a plan from the spec",
        },
        async (job, context) => {
          const session = this.editing.read(request.id);
          if (session.repoId !== repo.id)
            throw new Error("This planning belongs to another repository.");
          if (session.specSlug === null)
            throw new Error("Write the spec before generating a plan from it.");
          await context.invoke(
            admitFromSpecArgs(
              `${specFolder(repo)}/${session.specSlug}/spec.md`,
              request.kind === "startOver" ? request.key : null,
              request.models?.draftingProvider ?? this.state.settings.draftingProvider,
              request.models?.executorModel ?? this.state.settings.executorModel,
            ),
          );
          this.recordAdmitted(job, repo, request.models);
        },
      );
    if (request.kind === "draft" || request.kind === "admit")
      return this.jobs.start(
        {
          repo,
          key: null,
          kind: request.kind,
          owner,
          label: request.kind === "draft"
          ? "Draft a task contract"
          : "Save task contract",
        },
        async (job, context) => {
          const args =
            request.kind === "draft"
              ? admitFromFileArgs(
                  writePrivate(
                    this.options.dataDirectory,
                    `source-${job.id}.md`,
                    request.outcome,
                  ),
                  request.models?.draftingProvider ?? this.state.settings.draftingProvider,
                  request.models?.executorModel ?? this.state.settings.executorModel,
                )
              : admitDraftArgs(DraftSchema.parse(request.draft));
          await context.invoke(args);
          this.recordAdmitted(job, repo, request.models);
        },
      );
    if (request.kind === "edit")
      return this.jobs.start(
        {
          repo,
          key: request.key,
          kind: request.kind,
          owner,
          label: "Update task contract",
        },
        async (job, context) => {
          this.tickets.assertDigest(repo, request.key, request.digest);
          assertEditable(this.tickets.contract(repo, request.key).contract);
          await context.invoke(editArgs(request.key, request.draft));
          job.resultKey = request.key;
          if (request.models) {
            this.state.taskModels[repo.id + ":" + request.key] = request.models;
            this.changes.preferences(this.state);
          }
        },
      );
    if (request.kind === "sync")
      return this.jobs.start(
        {
          repo,
          key: request.key,
          kind: request.kind,
          label: "Refresh delivery from GitHub",
        },
        async (_job, context) => {
          await context.invoke(syncArgs(request.key));
        },
      );
    if (request.kind === "principle")
      return this.jobs.start(
        {
          repo,
          key: request.key,
          kind: request.kind,
          label: "Record a product decision",
        },
        async (_job, context) => {
          await context.invoke(principleArgs(request.answer));
        },
      );
    if (request.kind === "verdict")
      return this.jobs.start(
        {
          repo,
          key: request.key,
          kind: request.kind,
          label: "Record finding feedback",
        },
        async (_job, context) => {
          await context.invoke(
            verdictArgs(request, this.state.settings.name || "Local user"),
          );
        },
      );
    if (request.kind === "run" || request.kind === "decide")
      return this.jobs.start(
        {
          repo,
          key: request.key,
          kind: request.kind,
          label: "Run engineering loop",
        },
        async (job, context) => {
          this.tickets.assertDigest(repo, request.key, request.digest);
          const resumeFrom = request.kind === "run" ? request.resumeFrom : null;
          if (resumeFrom)
            assertResumable(await this.detail(repo.id, request.key), resumeFrom);
          if (request.kind === "decide") {
            await context.invoke(principleArgs(request.answer));
            if (context.signal.aborted) return;
          }
          const path = writePrivate(
            this.options.dataDirectory,
            `run-${job.id}.json`,
            JSON.stringify(
              runConfig(
                this.state.taskModels[repo.id + ":" + request.key] ?? this.state.settings,
                effectiveLimits(repo, this.state.settings),
                request.kind === "run" ? request.publish : false,
              ),
            ),
          );
          if (request.kind === "run" && request.approve)
            await context.invoke(approveArgs(request.key));
          if (context.signal.aborted) return;
          await context.invoke(runArgs(request.key, path, resumeFrom));
        },
      );
    const unreachable: never = request;
    throw new Error(`Unsupported request ${String(unreachable)}`);
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
