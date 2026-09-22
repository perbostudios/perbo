import { openDrafts } from "../shared/contract-editing.js";
import { DraftSchema, HELP_LINKS, RequestSchema } from "../shared/protocol.js";
import { heldRepository } from "../shared/jobs.js";
import { discoverModels } from "./model-catalog.js";
import { listExplorer, readExplorerFile } from "./explorer.js";
import { exportedNames } from "./symbols.js";
import { graphView } from "./plan/graph.js";
import { contractImpact, impactView } from "./plan/impact.js";
import { saveSpec, specView, type SpecDeps } from "./plan/spec.js";
import { archiveExport, ticketExport } from "./tickets/export.js";
import { retainedOutput } from "./tickets/output.js";
import { discardTicket } from "./tickets/discard.js";
import { pullRequestUrl, ticketWorktree, type TicketRecords } from "./tickets/open.js";
import { effectiveLimits, readManifest, saveManifest, specFolder } from "./repository/config.js";
import { setArchived } from "./profile/preferences.js";
import { openLogin } from "./providers/status.js";
import { usageReport } from "./providers/usage.js";
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
import type { Cli } from "./cli.js";
import type { Changes } from "./changes.js";
import type { ContractEditing, EditingOwner } from "../shared/contract-editing.js";
import type { Execute } from "./repository/git.js";
import type { InterviewHost } from "./interview/host.js";
import type { JobRunner } from "./jobs/runner.js";
import type { PowerHold } from "./power.js";
import type { Profile, RegisteredRepository } from "./profile/store.js";
import type { RepositoryRegistry } from "./repository/registry.js";
import type { TicketReads } from "./tickets/reads.js";
import type { WorkspaceReads } from "./workspace-reads.js";
import type { codexUsage } from "./usage-probe.js";
import type { probeProviders } from "./providers/status.js";
import type { HostIO } from "./service.js";
import type {
  Job,
  ReplyMap,
  Request,
  RequestHandlers,
  RequestOf,
  Snapshot,
  TaskModels,
} from "../shared/protocol.js";

/**
 * A capability registry. A renderer request carries a repository id and, where
 * a surface reads one file, a repository-relative path; it never carries a
 * command, an absolute path or any other filesystem target. Every path is
 * resolved under the registered repository through `safePath` and refused
 * otherwise — outside the repository, through a symlink, or on the never-read
 * list, which the explorer neither lists nor previews.
 */
export interface HostModules {
  io: HostIO;
  dataDirectory: string;
  profile: Profile;
  changes: Changes;
  registry: RepositoryRegistry;
  tickets: TicketReads;
  ticketRecords: TicketRecords;
  planDeps: SpecDeps;
  cli: Cli;
  execute: Execute;
  reads: WorkspaceReads;
  editing: ContractEditing;
  interviews: InterviewHost;
  jobs: JobRunner;
  power: PowerHold;
  usageProbe: typeof codexUsage;
  snapshot(): Promise<Snapshot>;
  providers(): ReturnType<typeof probeProviders>;
  /** The key admission handed back, and the models the person chose for it. */
  recordAdmitted(job: Job, repo: RegisteredRepository, models: TaskModels | undefined): void;
}

/** What a request carries besides itself: the editing session that started it, where one did. */
export interface RouteContext {
  owner?: EditingOwner | undefined;
}

/** Every Request kind the protocol declares, which the table must answer exactly. */
export function requestKinds(): string[] {
  return RequestSchema.options.map((option) => option.shape.kind.value).sort();
}

/**
 * A handler for a request that names a repository.
 *
 * The lookup happens before any handler work, so "no longer connected" and
 * "the path changed" are answered before a busy lane or a stale digest is.
 */
function inRepository<K extends Request["kind"]>(
  lookup: (id: string) => RegisteredRepository,
  handler: (
    repo: RegisteredRepository,
    request: RequestOf<K>,
    context: RouteContext,
  ) => Promise<ReplyMap[K]> | ReplyMap[K],
): RequestHandlers<RouteContext>[K] {
  return ((request: RequestOf<K>, context: RouteContext) =>
    handler(
      lookup((request as RequestOf<K> & { repoId: string }).repoId),
      request,
      context,
    )) as RequestHandlers<RouteContext>[K];
}

/** The capability map: one entry per Request kind, and nothing else. */
export function createRoutes(m: HostModules): RequestHandlers<RouteContext> {
  const repository = (id: string): RegisteredRepository => m.registry.lookup(id);
  const settings = (): Profile["state"]["settings"] => m.profile.state.settings;
  const scoped = <K extends Request["kind"]>(
    handler: (
      repo: RegisteredRepository,
      request: RequestOf<K>,
      context: RouteContext,
    ) => Promise<ReplyMap[K]> | ReplyMap[K],
  ): RequestHandlers<RouteContext>[K] => inRepository<K>(repository, handler);

  return Object.freeze({
    // Planning's own records, which never leave this machine.
    editingOpen: (request) => m.editing.open(request.target, request.legacy),
    editingRead: (request) => m.editing.read(request.id),
    drafts: () => openDrafts(m.profile.state.editingSessions),
    editingSave: (request) =>
      m.editing.save(request.id, request.revision, request.repoId, request.form),
    editingSubmit: (request) =>
      m.editing.submit(request.id, request.revision, request.operationId, request.intent),
    explorerMark: async (request) => {
      // Scope is one of the four fields approval freezes, and the freeze is
      // the CLI's: `perbo edit` refuses every state but plan_review. Nothing
      // on this path asked, so a mark on an approved ticket was taken, written
      // to the draft, and could never be compiled in — a mark the person would
      // have gone on believing in. The standing list is the one exception: it
      // is the repository's, not this ticket's, and D-105 has the guard read it
      // again when a run starts, so it binds an approved ticket and is allowed
      // to be written for one.
      //
      // Either way on the list, which is what `always` being set at all means:
      // true adds the path and false takes back what this draft added, and a
      // rule that admitted only the adding would let a person put a path on the
      // repository's list from an approved ticket and never take it off. Null
      // is the ticket's own scope, and that is what the freeze holds.
      const session = m.editing.read(request.id);
      if (session.key !== null && request.always === null) {
        const repo = repository(session.repoId);
        const ticket = (await m.tickets.list(repo)).tickets.find(
          (entry) => entry.key === session.key,
        );
        if (ticket?.approved_at)
          throw new Error(
            "This contract is approved, so its scope is frozen. Start over from the spec to plan it again.",
          );
      }
      return m.editing.mark(
        request.id,
        request.revision,
        request.path,
        request.mark,
        request.always,
      );
    },
    explorerUndo: (request) => m.editing.undo(request.id, request.revision, request.edit),
    editingStop: (request) => m.editing.stop(request.id),
    editingDiscard: async (request) => {
      // The chat goes with the planning it belonged to: there is no longer a
      // spec for the interview to write or a plan for it to change.
      //
      // And so does the ticket this planning drafted: throwing the plan away
      // and leaving the ticket on the board would delete the way in and not
      // the thing, with no way back to the plan it came from.
      // A ticket that has run is not a draft, so it stays, and the reason it
      // stays is the one deleting a contract outright would have given.
      //
      // The one it drafted, and never one it was merely opened over: planning
      // started from a ticket the CLI admitted, or from one another session
      // made, holds that key from birth. Discarding on the key alone would
      // throw away work this planning did not do and cannot give back.
      const session = m.editing.read(request.id);
      const discarded = m.editing.discard(request.id, request.revision);
      m.interviews.stop(request.id);
      if (session.key !== null && session.admitted)
        await discardDrafted(m, repository(session.repoId), session.key);
      return discarded;
    },
    // The interview docked beside the panes (D-102). Planning-lane work, like
    // the explorer's reads: answered here rather than as a job, so a run is
    // never in its way and it is never in a run's.
    interviewStart: (request) => m.interviews.start(request.id, request.repoId),
    interviewTurn: (request) => m.interviews.turn(request.id, request.text),
    interviewStop: (request) => m.interviews.stop(request.id),

    snapshot: () => m.snapshot(),
    repositorySnapshot: (request) => m.tickets.repositorySnapshot(request.repoId),
    // Planning-lane work (D-101): answered here, never as a job, so a run is
    // never in the way of reading a file and a read is never in the way of one.
    explorerList: (request) => listExplorer(m.execute, repository(request.repoId)),
    explorerRead: (request) =>
      readExplorerFile(m.execute, repository(request.repoId), request.path),
    symbolIndex: (request) =>
      exportedNames(
        { cli: m.cli, reads: m.reads, execute: m.execute },
        repository(request.repoId),
      ),
    specRead: (request) => specView(m.planDeps, request.id),
    impactRead: (request) =>
      impactView(
        { editing: m.editing, repository, cli: m.cli, execute: m.execute },
        request.id,
      ),
    // The same reading, of a compiled contract's own scope. Impact is only
    // ever actionable before approval — a scope frozen is a scope no warning
    // can move — so the count belongs on the page approving happens on, and
    // that page is reached from a ticket rather than from a planning session.
    impactContract: (request) =>
      contractImpact(
        { tickets: m.ticketRecords, repository, cli: m.cli, execute: m.execute },
        request.repoId,
        request.key,
      ),

    providers: () => m.providers(),
    login: (request) => openLogin(m.io, request.provider),
    models: (request) => discoverModels(request.provider),
    usage: () =>
      usageReport({
        repositories: () => m.registry.all(),
        lookup: repository,
        tickets: m.tickets,
        settings,
        providers: () => m.providers(),
        probe: m.usageProbe,
      }),

    openHelp: async (request) => {
      await m.io.openExternal(HELP_LINKS[request.page]);
      return null;
    },
    chooseRepository: async () => {
      const path = await m.io.chooseDirectory();
      return path === null ? null : await m.registry.register(path);
    },
    saveSettings: (request) => {
      m.profile.state.settings = request.settings;
      m.changes.preferences(m.profile.state);
      m.io.applyTheme?.(request.settings.theme);
      m.power.update();
      return request.settings;
    },
    exportArchive: async (request) => {
      if (request.repoId !== null) repository(request.repoId);
      const { name, content } = archiveExport(await m.snapshot(), request);
      return m.io.saveFile(name, content);
    },
    cancel: (request) => m.jobs.cancel(request.jobId),

    forgetRepository: scoped<"forgetRepository">((repo) => m.registry.forget(repo.id)),
    graphRead: scoped<"graphRead">((repo, request) =>
      graphView({ tickets: m.tickets, execute: m.execute }, repo, request.key),
    ),
    // Every edit the Graph pane makes is this command (D-100): applied to a
    // copy, validated whole and recorded with its author by the CLI, which is
    // also what the interview's edits go through. The pane writes nothing.
    graphEdit: scoped<"graphEdit">((repo, request) => graphEdit(m, repo, request)),
    graphUndo: scoped<"graphUndo">((repo, request) => graphEdit(m, repo, request)),
    detail: scoped<"detail">((repo, request) => m.tickets.detail(repo.id, request.key)),
    taskSummary: scoped<"taskSummary">((repo, request) => m.tickets.summary(repo.id, request.key)),
    discard: scoped<"discard">(async (repo, request) => {
      // Deleting a contract outright says the reason it stays, where throwing
      // away the planning that drafted it carries on past one.
      const refusal = await discardDrafted(m, repo, request.key);
      if (refusal !== null) throw new Error(refusal);
      return null;
    }),
    archive: scoped<"archive">(async (repo, request) => {
      const list = await m.tickets.list(repo);
      const keys = [...new Set(request.keys)];
      if (keys.some((key) => !list.tickets.some((ticket) => ticket.key === key)))
        throw new Error("A ticket to file is not in the repository's ticket store.");
      setArchived(m.profile.state, repo.id, keys, request.archived);
      m.changes.preferences(m.profile.state);
      return null;
    }),
    output: scoped<"output">(async (repo, request) =>
      retainedOutput(repo, await m.tickets.detail(repo.id, request.key), request.attemptId),
    ),
    manifest: scoped<"manifest">((repo) => readManifest(repo)),
    saveManifest: scoped<"saveManifest">((repo, request) => {
      // The refusals keep their order: a repository with no configuration to
      // edit says so before a busy one does, and a stale digest after both.
      readManifest(repo);
      if (heldRepository(m.jobs.live(), repo.id))
        throw new Error(
          "Wait for the commands running in this repository to finish before changing the manifest.",
        );
      saveManifest(repo, request.digest, request.value);
      m.changes.changed(true, { kind: "records", repoId: repo.id, key: null });
      return null;
    }),
    rename: scoped<"rename">((repo, request) => {
      m.tickets.contract(repo, request.key);
      m.profile.state.titles[repo.id + ":" + request.key] = request.title;
      m.changes.preferences(m.profile.state);
      return null;
    }),
    openRepository: scoped<"openRepository">(async (repo) => {
      await m.io.openPath(repo.path);
      return null;
    }),
    openWorktree: scoped<"openWorktree">(async (repo, request) => {
      await m.io.openPath(
        await ticketWorktree({ tickets: m.ticketRecords, execute: m.execute }, repo, request.key),
      );
      return null;
    }),
    openPullRequest: scoped<"openPullRequest">(async (repo, request) => {
      await m.io.openExternal(pullRequestUrl(await m.tickets.detail(repo.id, request.key)));
      return null;
    }),
    export: scoped<"export">(async (repo, request) => {
      const { name, content } = ticketExport(
        request.key ?? repo.name,
        request.key
          ? await m.tickets.detail(repo.id, request.key)
          : (await m.snapshot()).tasks.filter((row) => row.repoId === repo.id),
      );
      return m.io.saveFile(name, content);
    }),
    specSave: scoped<"specSave">((repo, request) => saveSpec(m.planDeps, repo, request)),

    doctor: scoped<"doctor">((repo, request) =>
      m.jobs.start(
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
            m.dataDirectory,
            `doctor-${job.id}.json`,
            JSON.stringify(doctorConfig(settings())),
          );
          await context.invoke(doctorArgs(path, request.writeConfig));
        },
      ),
    ),
    generatePlan: scoped<"generatePlan">((repo, request, context) => fromSpec(m, repo, request, context)),
    startOver: scoped<"startOver">((repo, request, context) => fromSpec(m, repo, request, context)),
    draft: scoped<"draft">((repo, request, context) => admit(m, repo, request, context)),
    admit: scoped<"admit">((repo, request, context) => admit(m, repo, request, context)),
    edit: scoped<"edit">((repo, request, context) =>
      m.jobs.start(
        { repo, key: request.key, kind: request.kind, owner: context.owner, label: "Update task contract" },
        async (job, run) => {
          m.tickets.assertDigest(repo, request.key, request.digest);
          assertEditable(m.tickets.contract(repo, request.key).contract);
          await run.invoke(editArgs(request.key, request.draft));
          job.resultKey = request.key;
          if (request.models) {
            m.profile.state.taskModels[repo.id + ":" + request.key] = request.models;
            m.changes.preferences(m.profile.state);
          }
        },
      ),
    ),
    sync: scoped<"sync">((repo, request) =>
      m.jobs.start(
        { repo, key: request.key, kind: request.kind, label: "Refresh delivery from GitHub" },
        async (_job, run) => {
          await run.invoke(syncArgs(request.key));
        },
      ),
    ),
    principle: scoped<"principle">((repo, request) =>
      m.jobs.start(
        { repo, key: request.key, kind: request.kind, label: "Record a product decision" },
        async (_job, run) => {
          await run.invoke(principleArgs(request.answer));
        },
      ),
    ),
    verdict: scoped<"verdict">((repo, request) =>
      m.jobs.start(
        { repo, key: request.key, kind: request.kind, label: "Record finding feedback" },
        async (_job, run) => {
          await run.invoke(verdictArgs(request, settings().name || "Local user"));
        },
      ),
    ),
    run: scoped<"run">((repo, request) => loop(m, repo, request)),
    decide: scoped<"decide">((repo, request) => loop(m, repo, request)),
  }) as RequestHandlers<RouteContext>;
}

/**
 * Delete a contract that has never run, and say why where it stays.
 *
 * Both callers pass through here — the contract page's own delete and the
 * planning that drafted it being thrown away — so the guards are stated once
 * and the two differ only in what they do with the reason.
 */
async function discardDrafted(
  m: HostModules,
  repo: RegisteredRepository,
  key: string,
): Promise<string | null> {
  const refusal = await discardTicket(
    { tickets: m.ticketRecords, profile: m.profile, liveJobs: () => m.jobs.live() },
    repo,
    key,
  );
  if (refusal !== null) return refusal;
  m.changes.changed(true, { kind: "records", repoId: repo.id, key: null });
  m.changes.preferences(m.profile.state);
  return null;
}

/** Applied to a copy, validated whole and recorded with its author by the CLI. */
function graphEdit(
  m: HostModules,
  repo: RegisteredRepository,
  request: RequestOf<"graphEdit"> | RequestOf<"graphUndo">,
): Job {
  return m.jobs.start(
    {
      repo,
      key: request.key,
      kind: request.kind,
      label: request.kind === "graphUndo" ? "Undo a plan edit" : "Change the plan's graph",
    },
    async (job, run) => {
      await run.invoke(graphEditArgs(request.key, request));
      job.resultKey = request.key;
    },
  );
}

/** A plan drafted from the spec this planning wrote (D-103). */
function fromSpec(
  m: HostModules,
  repo: RegisteredRepository,
  request: RequestOf<"generatePlan"> | RequestOf<"startOver">,
  context: RouteContext,
): Job {
  return m.jobs.start(
    {
      repo,
      key: request.kind === "startOver" ? request.key : null,
      kind: "draft",
      owner: context.owner,
      label:
        request.kind === "startOver"
          ? "Draft this plan again from the spec"
          : "Draft a plan from the spec",
    },
    async (job, run) => {
      const session = m.editing.read(request.id);
      if (session.repoId !== repo.id)
        throw new Error("This planning belongs to another repository.");
      if (session.specSlug === null)
        throw new Error("Write the spec before generating a plan from it.");
      const settings = m.profile.state.settings;
      await run.invoke(
        admitFromSpecArgs(
          `${specFolder(repo)}/${session.specSlug}/spec.md`,
          request.kind === "startOver" ? request.key : null,
          request.models?.draftingProvider ?? settings.draftingProvider,
          request.models?.executorModel ?? settings.executorModel,
        ),
      );
      m.recordAdmitted(job, repo, request.models);
    },
  );
}

/** A contract drafted from the person's own words, or saved from the form. */
function admit(
  m: HostModules,
  repo: RegisteredRepository,
  request: RequestOf<"draft"> | RequestOf<"admit">,
  context: RouteContext,
): Job {
  return m.jobs.start(
    {
      repo,
      key: null,
      kind: request.kind,
      owner: context.owner,
      label: request.kind === "draft" ? "Draft a task contract" : "Save task contract",
    },
    async (job, run) => {
      const settings = m.profile.state.settings;
      const args =
        request.kind === "draft"
          ? admitFromFileArgs(
              writePrivate(m.dataDirectory, `source-${job.id}.md`, request.outcome),
              request.models?.draftingProvider ?? settings.draftingProvider,
              request.models?.executorModel ?? settings.executorModel,
            )
          : admitDraftArgs(DraftSchema.parse(request.draft));
      await run.invoke(args);
      m.recordAdmitted(job, repo, request.models);
    },
  );
}

/** The engineering loop, with the decision a person answered first where there is one. */
function loop(
  m: HostModules,
  repo: RegisteredRepository,
  request: RequestOf<"run"> | RequestOf<"decide">,
): Job {
  return m.jobs.start(
    { repo, key: request.key, kind: request.kind, label: "Run engineering loop" },
    async (job, run) => {
      m.tickets.assertDigest(repo, request.key, request.digest);
      const resumeFrom = request.kind === "run" ? request.resumeFrom : null;
      if (resumeFrom)
        assertResumable(await m.tickets.detail(repo.id, request.key), resumeFrom);
      if (request.kind === "decide") {
        await run.invoke(principleArgs(request.answer));
        if (run.signal.aborted) return;
      }
      const settings = m.profile.state.settings;
      const path = writePrivate(
        m.dataDirectory,
        `run-${job.id}.json`,
        JSON.stringify(
          runConfig(
            m.profile.state.taskModels[repo.id + ":" + request.key] ?? settings,
            effectiveLimits(repo, settings),
            request.kind === "run" ? request.publish : false,
          ),
        ),
      );
      if (request.kind === "run" && request.approve)
        await run.invoke(approveArgs(request.key));
      if (run.signal.aborted) return;
      await run.invoke(runArgs(request.key, path, resumeFrom));
    },
  );
}

/**
 * Answer one request from the table.
 *
 * The handler is read off the table itself and never off anything it
 * inherits, so a kind spelled like a property of every object — `toString`,
 * `constructor` — is a kind this host does not answer rather than a function
 * it happens to hold.
 */
export async function route(
  routes: RequestHandlers<RouteContext>,
  request: Request,
  context: RouteContext,
): Promise<unknown> {
  const table = routes as Record<string, unknown>;
  const handler = Object.hasOwn(table, request.kind) ? table[request.kind] : undefined;
  if (typeof handler !== "function")
    throw new Error(`Unsupported request ${String(request.kind)}`);
  return await (handler as (r: Request, c: RouteContext) => Promise<unknown>)(request, context);
}
