import { existsSync } from "node:fs";
import { keepsPersonsTitle, openDrafts, promiseOf, titleChanged } from "../shared/contract-editing.js";
import { DraftSchema, HELP_LINKS, RequestSchema, TaskModelsSchema } from "../shared/protocol.js";
import { heldRepository, isRun } from "../shared/jobs.js";
import { isArchivable, notArchivable } from "../shared/archive.js";
import { specSlugOf } from "../shared/spec-slug.js";
import { listExplorer, readExplorerFile } from "./explorer.js";
import { exportedNames } from "./symbols.js";
import { graphView } from "./plan/graph.js";
import { contractImpact, impactView } from "./plan/impact.js";
import { nameSpecAfterRename, saveSpec, specPath, specTitles, specView, type SpecDeps } from "./plan/spec.js";
import { archiveExport, ticketExport } from "./tickets/export.js";
import { retainedOutput } from "./tickets/output.js";
import { discardTicket } from "./tickets/discard.js";
import { ANOTHER_PLANNING_HOLDS, DELETE_TICKET_GONE, DELETE_WAITS_FOR_COMMANDS } from "../shared/discard.js";
import {
  deleteDraftedFromSpec,
  deleteSpec,
  removeSpecFolder,
  type WorkDeps,
} from "./tickets/work.js";
import { pullRequestUrl, ticketWorktree, type TicketRecords } from "./tickets/open.js";
import { effectiveLimits, readManifest, saveManifest, specFolder } from "./repository/config.js";
import { objectsPath } from "./repository/layout.js";
import { findingsOnRecord } from "./records.js";
import { recordOpened, saveAsk, setArchived } from "./profile/preferences.js";
import { openLogin } from "./providers/status.js";
import { usageReport } from "./providers/usage.js";
import {
  admitDraftArgs,
  admitFromSpecArgs,
  approveArgs,
  assertEditable,
  assertDecidable,
  assertResumable,
  decisionArgs,
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
import type { ChangeMarks } from "./plan/marks.js";
import type { DriftReadings } from "./plan/drift.js";
import type { ModelCatalogs } from "./providers/catalogs.js";
import type { PowerHold } from "./power.js";
import type { Profile, RegisteredRepository } from "./profile/store.js";
import type { RepositoryRegistry } from "./repository/registry.js";
import type { TicketReads } from "./tickets/reads.js";
import type { WorkspaceReads } from "./workspace-reads.js";
import type { claudeUsage, codexUsage } from "./usage-probe.js";
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
  marks: ChangeMarks;
  drift: DriftReadings;
  catalogs: ModelCatalogs;
  usageProbe: { claude: typeof claudeUsage; codex: typeof codexUsage };
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

  const work: WorkDeps = {
    tickets: m.ticketRecords,
    reads: m.reads,
    changes: m.changes,
    repository,
    sessions: () => m.profile.state.editingSessions,
    discard: (repo, key) => discardDrafted(m, repo, key),
  };

  return Object.freeze({
    // Planning's own records, which never leave this machine.
    editingOpen: async (request) => {
      // A spec is opened by the slug that names its folder, so the folder has to
      // be there: the schema holds the slug to a path segment, and this holds it
      // to one this repository actually wrote. A session pointing at nothing
      // would be a planning whose first save mints the folder back, which is a
      // spec created by opening a spec that had gone.
      if (request.target.kind === "spec" && !existsSync(specPath(repository(request.target.repoId), request.target.slug)))
        throw new Error(
          "That spec is no longer in the repository. It may have been renamed or removed " +
            "since this list was read.",
        );
      const opened = await m.editing.open(request.target, request.legacy);
      // A planning writing a spec that already has a plan takes that plan.
      //
      // The planning and the ticket were split — the session holds the spec,
      // the ticket holds the same spec, and nothing joins them. Left split, the
      // picker lists one piece of work twice, opening the ticket starts a
      // second planning beside the first, and deleting either leaves the other
      // (D-101, D-103).
      if (opened.key === null && opened.specSlug !== null) {
        // Not as its maker: this planning is finding a ticket already drafted
        // from its spec, which the command line may have admitted, and deleting
        // the planning must not delete work it did not do.
        await m.interviews.planDrafted(opened.id);
        return m.editing.read(opened.id);
      }
      return opened;
    },
    editingRead: (request) => m.editing.read(request.id),
    drafts: () => openDrafts(m.profile.state.editingSessions, specTitles(repository)),
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
    editingVisited: (request) => m.editing.visit(request.id, request.pane),
    editingContractVisited: (request) => m.editing.visitContract(request.id),
    editingDiscard: async (request) => {
      // The chat goes with the planning it belongs to: a discarded planning has
      // no spec for the interview to write and no plan for it to change.
      //
      // And so does the ticket this planning drafted: throwing the plan away
      // and leaving the ticket on the board would delete the way in and not
      // the thing, with no way back to the plan it came from. Whatever stage it
      // had reached: a piece of work is deleted whole
      // (D-129).
      //
      // The one it drafted, and never one it was merely opened over: planning
      // started from a ticket the CLI admitted, or from one another session
      // made, holds that key from birth. Discarding on the key alone would
      // throw away work this planning did not do and cannot give back.
      const session = m.editing.read(request.id);
      // A command running in the repository holds the delete of the ticket
      // this planning drafted (D-129), so the discard is refused before
      // anything goes, and the person finds the work as it was and why.
      if (session.key !== null && session.admitted && heldRepository(m.jobs.live(), session.repoId))
        throw new Error(DELETE_WAITS_FOR_COMMANDS);
      const discarded = m.editing.discard(request.id, request.revision);
      // Waited out before anything is deleted: a session whose stdin has closed
      // finishes the turn it is in, and a turn that writes the spec after the
      // folder has gone writes it back.
      m.interviews.stop(request.id);
      await m.interviews.exited(request.id);
      let refused: string | null = null;
      if (session.key !== null && session.admitted)
        refused = await discardDrafted(m, repository(session.repoId), session.key);
      // A planning that never took the ticket its own spec was drafted into
      // still deletes it. The bin does not open the session, so nothing has
      // joined the two (`editingOpen` heals a planning that is opened); a
      // ticket left here would put a row back in the picker under the same
      // title, which reads as the delete having made a copy.
      //
      // Only a plan still in plan_review, and only where no other planning is
      // curating it: a plan this planning's spec was drafted into and then ran
      // is work standing on its own, and one another session holds is that
      // session's to throw away.
      if (session.key === null && session.specSlug !== null)
        refused = await deleteDraftedFromSpec(work, session.repoId, session.specSlug, request.id);
      // Work left standing is said, as deleting it outright says it: a command
      // that started while the chat wound down, or a pull request open. The
      // planning has gone, and the work stays where it is listed, to delete
      // once that has settled. A ticket already gone left nothing to delete,
      // and one another planning holds is that planning's.
      if (refused !== null && refused !== DELETE_TICKET_GONE && refused !== ANOTHER_PLANNING_HOLDS)
        throw new Error(refused);
      // And the spec they came from, once nothing is left holding it, a ticket
      // already gone included: it names the folder no more than a deleted one
      // does (D-129). Not where the ticket refused to go: a plan still standing
      // is read against the spec it names (D-103).
      if (session.specSlug !== null && (refused === null || refused === DELETE_TICKET_GONE))
        await removeSpecFolder(work, session.repoId, session.specSlug, {
          sessionId: request.id,
          claims: session.key,
        });
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
    driftCheck: (request) => m.drift.check(request.id),
    driftDismiss: (request) => m.drift.dismiss(request.id),
    specDelete: (request) => deleteSpec(work, request.repoId, request.slug),
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
    models: (request) => m.catalogs.read(request.provider),
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
    askSave: (request) => {
      if (!m.profile.state.repositories.some((entry) => entry.id === request.repoId))
        throw new Error("This repository is no longer connected. Choose it again in Settings.");
      saveAsk(m.profile.state, request.repoId, request.text);
      // Saved with no change event: this comes at every pause in typing, and
      // the page that sent it already holds the text.
      m.profile.save();
      return null;
    },

    forgetRepository: scoped<"forgetRepository">((repo) => m.registry.forget(repo.id)),
    ticketOpened: scoped<"ticketOpened">(async (repo, request) => {
      if (!(await m.tickets.list(repo)).tickets.some((ticket) => ticket.key === request.key))
        throw new Error(`${request.key} is not in this repository.`);
      recordOpened(m.profile.state, repo.id, request.key, new Date());
      m.profile.save();
      m.changes.opened(m.profile.state.lastOpened);
      return null;
    }),
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
    taskModels: scoped<"taskModels">(async (repo, request) => {
      // The models this one ticket runs on. Held beside the ticket rather than
      // on the contract, because they are not among the four fields approving
      // freezes (ADR-0016) — and refused once it is approved, because what runs
      // is settled when the loop is started.
      const ticket = (await m.tickets.list(repo)).tickets.find((entry) => entry.key === request.key);
      if (ticket === undefined) throw new Error(`${request.key} is not in this repository.`);
      if (ticket.approved_at !== null)
        throw new Error(
          `${request.key} is approved, and what it runs on was settled with it. Its models are ` +
            "no longer this page's to change.",
        );
      m.profile.state.taskModels[repo.id + ":" + request.key] = TaskModelsSchema.strip().parse(
        request.models,
      );
      m.changes.preferences(m.profile.state);
      return null;
    }),
    discard: scoped<"discard">(async (repo, request) => {
      // Which spec this plan was drafted from, read before it goes: after the
      // delete there is no record left to ask. Read through the check rather
      // than by cutting the recorded string, because what it names is about to
      // be deleted recursively.
      const held = (await m.tickets.list(repo)).tickets.find((ticket) => ticket.key === request.key);
      // Reading the spec folder can refuse a repository whose config names one
      // it may not have. That is not a reason to refuse the delete.
      const slug = (() => {
        try {
          return held === undefined ? null : specSlugOf(held.admission.spec?.path, specFolder(repo));
        } catch {
          return null;
        }
      })();
      // Deleting work outright says the reason it stays.
      const refusal = await discardDrafted(m, repo, request.key);
      if (refusal !== null) throw new Error(refusal);
      // The spec goes with the plan it drafted, as it does when a planning is
      // thrown away: one piece of work is deleted as one thing.
      if (slug !== null) await removeSpecFolder(work, repo.id, slug, { sessionId: null, claims: null });
      return null;
    }),
    archive: scoped<"archive">(async (repo, request) => {
      const list = await m.tickets.list(repo);
      const keys = [...new Set(request.keys)];
      if (keys.some((key) => !list.tickets.some((ticket) => ticket.key === key)))
        throw new Error("A ticket to file is not in the repository's ticket store.");
      const carried = list.tickets.find(
        (ticket) =>
          request.archived &&
          keys.includes(ticket.key) &&
          !isArchivable({ jobs: m.profile.state.jobs as Job[] }, { repoId: repo.id, ticket }),
      );
      if (carried !== undefined) throw new Error(notArchivable(carried.key, carried.state));
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
    rename: scoped<"rename">(async (repo, request) => {
      m.tickets.contract(repo, request.key);
      // The spec first, because it is the step that can refuse: a spec that
      // cannot be retitled refuses the rename whole, and the ticket keeps the
      // name it had rather than one its spec does not carry.
      const retitled = await nameSpecAfterRename(m.tickets, repo, request.key, request.title);
      m.profile.state.titles[repo.id + ":" + request.key] = request.title;
      m.changes.preferences(m.profile.state);
      if (retitled) m.changes.changed(true, { kind: "records", repoId: repo.id, key: request.key });
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
    specSave: scoped<"specSave">((repo, request) => {
      const saved = saveSpec(m.planDeps, repo, request);
      // The picker and the title bar name the planning by its spec's title,
      // which they read off the drafts list: a save that landed a new title
      // has that list read again.
      if (saved.conflicting.length === 0 && titleChanged(request))
        m.changes.changed(false, { kind: "editing", sessionId: request.id });
      return saved;
    }),
    replan: scoped<"replan">((repo, request) => replan(m, repo, request)),

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
    admit: scoped<"admit">((repo, request, context) => admit(m, repo, request, context)),
    edit: scoped<"edit">((repo, request, context) =>
      m.jobs.start(
        { repo, key: request.key, kind: request.kind, owner: context.owner, label: "Update task contract" },
        async (job, run) => {
          m.tickets.assertDigest(repo, request.key, request.digest);
          const current = m.tickets.contract(repo, request.key).contract;
          assertEditable(current);
          // What the plan promised before this edit, for the marks on it.
          const before = promiseOf(current);
          await run.invoke(editArgs(request.key, request.draft));
          job.resultKey = request.key;
          m.marks.recordPlanChange(repo, request.key, before);
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
 * Delete a piece of work, and say why where it stays.
 *
 * Every caller passes through here — the contract page's own delete, the
 * planning that drafted it being thrown away, and a stopped plan drafted again
 * from its spec — so the guards are stated once and the callers differ only in
 * what they do with the reason.
 */
async function discardDrafted(
  m: HostModules,
  repo: RegisteredRepository,
  key: string,
): Promise<string | null> {
  const refusal = await discardTicket(
    {
      tickets: m.ticketRecords,
      profile: m.profile,
      liveJobs: () => m.jobs.live(),
      stopChats: async (ids) => {
        const running = new Set(m.interviews.running());
        await Promise.all(
          ids
            .filter((id) => running.has(id))
            .map((id) => {
              m.interviews.stop(id);
              return m.interviews.exited(id);
            }),
        );
      },
    },
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
      // What the plan promised before, so what the edit changed of it can be
      // marked on every planning over the ticket; an edit that only rearranged
      // the graph changes nothing here and marks nothing.
      const before = m.marks.promiseAt(repo, request.key);
      await run.invoke(graphEditArgs(request.key, request));
      job.resultKey = request.key;
      m.marks.recordPlanChange(repo, request.key, before);
    },
  );
}

/** Why a plan is not drafted while a group of the interview's questions stands (D-117). */
const ANSWER_THE_QUESTIONS_FIRST =
  "Answer the chat's questions first — its answers change the spec this drafts from.";

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
      // A group of questions the interview has put and the person has not
      // answered is a spec still moving: drafting over it turns a spec the
      // answers were about to change into a plan (D-117). The Spec pane
      // withholds the press, and this is the line behind it, so the surface is
      // not the one that counts for itself. Not
      // on a re-draft: `startOver` is the way back from a plan that is already
      // wrong, and holding it behind a question would strand the person on it.
      if (request.kind === "generatePlan" && session.asking !== null)
        throw new Error(ANSWER_THE_QUESTIONS_FIRST);
      // The Spec pane holds the press while a turn is in flight (D-102); this
      // is the line behind it. The chat is stopped, which winds up a turn
      // still there — what was held is said, the change is recorded, and the
      // note handing the spec over is put — and the draft waits for the child
      // to exit, because a session whose stdin has closed finishes the turn it
      // is in and can write the spec until it goes: the draft reads the file
      // that turn left behind. Behind the refusal above, so a standing
      // question still stops this: its answers are what would change the spec.
      // Not on a re-draft, where the conversation is a chat about a plan that
      // exists and ending it is no part of drafting it again.
      //
      // And asked again once it has exited: the turn winding down can put a
      // group of its own after the stop, and that group holds the draft as
      // one standing before the press does.
      if (request.kind === "generatePlan") {
        m.interviews.stop(request.id);
        await m.interviews.exited(request.id);
        if (m.editing.read(request.id).asking !== null) throw new Error(ANSWER_THE_QUESTIONS_FIRST);
      }
      // What the plan promised before it is drafted again, for the marks on the
      // re-draft. A first draft has no before, and records nothing.
      const before = request.kind === "startOver" ? m.marks.promiseAt(repo, request.key) : null;
      const settings = m.profile.state.settings;
      // Read once the chat has stopped, so a title its last turn wrote is the
      // title the person's name is held against (D-127).
      const slug = session.specSlug;
      const keepTitle = keepsPersonsTitle(
        m.editing.read(request.id),
        specTitles(() => repo)(repo.id, slug),
      );
      await run.invoke(
        admitFromSpecArgs(
          `${specFolder(repo)}/${slug}/spec.md`,
          request.kind === "startOver" ? request.key : null,
          keepTitle,
          request.models?.draftingProvider ?? settings.draftingProvider,
          request.models?.executorModel ?? settings.executorModel,
        ),
      );
      m.recordAdmitted(job, repo, request.models);
      if (request.kind === "startOver") {
        // A name the person gave the ticket outlives the re-draft: the board
        // keeps it, so the spec the re-draft titled takes it back.
        const given = m.profile.state.titles[repo.id + ":" + request.key];
        if (given !== undefined) await nameSpecAfterRename(m.tickets, repo, request.key, given);
        m.marks.recordPlanChange(repo, request.key, before);
      }
    },
  );
}

/**
 * A stopped plan drafted again from the spec it was drafted from: the stopped
 * ticket goes, and a fresh admission drafts the plan, which the page lands on.
 */
async function replan(
  m: HostModules,
  repo: RegisteredRepository,
  request: RequestOf<"replan">,
): Promise<ReplyMap["replan"]> {
  const ticket = (await m.tickets.list(repo)).tickets.find((entry) => entry.key === request.key);
  if (!ticket) throw new Error("This task is no longer in the repository's ticket store.");
  // The spec the stopped plan was drafted from, in the words the CLI refuses
  // in, because this is the same question `admit --start-over` asks and a
  // person should not meet two sentences for one answer.
  //
  // Built from the repository's spec folder and the slug the record names,
  // never from the recorded string itself: `specSlugOf` is the guard for that
  // field, and a recorded path that leaves this repository's spec folder is a
  // spec this admission has no business reading.
  const folder = specFolder(repo);
  const slug = specSlugOf(ticket.admission.spec?.path, folder);
  if (slug === null)
    throw new Error(
      `${request.key} was not drafted from a spec, so there is no spec to start over from. A plan ` +
        "drafted from a spec is admitted with perbo admit --from-spec",
    );
  const spec = `${folder}/${slug}/spec.md`;
  // And the file has to be there. `admit` says this itself, but only after a
  // job has been started and a model asked, so it is asked here first in the
  // CLI's own sentence: a spec deleted in the person's own editor is the
  // reachable way to press this with nothing to draft from.
  const at = specPath(repo, slug);
  if (!existsSync(at)) throw new Error(`no spec at ${at}`);
  // Only a spent record, in `admit`'s own words: a spent ticket is not the plan
  // its spec has, it is the plan it did not get, and a run killed outside the
  // executor's window leaves one saying `executing`, which is still the plan
  // this spec has. Asked here rather than left to `admit`, because the stopped
  // ticket is deleted before the admission runs.
  if (!["failed", "plan_invalid", "cancelled"].includes(ticket.state))
    throw new Error(
      `${request.key} was already drafted from ${spec}, and one spec is one piece of work: ` +
        `${request.key} is ${ticket.state}, which is past re-drafting, so this spec has its plan`,
    );
  // On this ticket's own models, and the new plan keeps them: it is the same
  // work, and a person who chose what drafts it did not choose again by
  // pressing this. Read before the delete below takes them.
  const models = m.profile.state.taskModels[repo.id + ":" + request.key];
  // And under the name the person gave the spec, where the planning that
  // records it is still there and the spec still states it (D-127). Read
  // before the delete below throws that planning away.
  const planning = m.profile.state.editingSessions.find(
    (each) => each.repoId === repo.id && each.key === request.key && each.phase !== "discarded",
  );
  const keepTitle =
    planning !== undefined && keepsPersonsTitle(planning, specTitles(() => repo)(repo.id, slug));
  // The stopped ticket goes, and everything recorded after its contract with
  // it — the attempts and the bundles they sealed — while the spec it was
  // drafted from stays, because the new plan is drafted from it
  // (D-129). Deleted first, so the new plan is
  // named as the only plan this spec has rather than apart from the one it
  // replaces (D-127).
  const refusal = await discardDrafted(m, repo, request.key);
  if (refusal !== null) throw new Error(refusal);
  // A fresh admission, not a move: the approved contract is frozen
  // (ADR-0016), so the plan is drafted again from the spec.
  //
  // Run as a job and waited on, rather than called straight: an admission
  // takes its turn behind the others in this repository, and the page it was
  // pressed on has nowhere to go until there is a planning to name.
  const settings = m.profile.state.settings;
  const job = m.jobs.start(
    { repo, key: null, kind: "admit", label: "Draft a plan from the spec" },
    async (job, run) => {
      await run.invoke(
        admitFromSpecArgs(
          spec,
          null,
          keepTitle,
          models?.draftingProvider ?? settings.draftingProvider,
          models?.executorModel ?? settings.executorModel,
        ),
      );
      m.recordAdmitted(job, repo, models);
    },
  );
  await m.jobs.settled(job.id);
  // The stopped ticket is already gone, so a refusal from here on says so and
  // names where the spec it leaves is drafted from.
  const lost = (): Error =>
    new Error(
      `${request.key} was deleted and its plan could not be drafted again: ${job.error ?? "the admission failed"}. ` +
        "Its spec is in Create's picker; draft the plan from there.",
    );
  if (job.state !== "completed" || job.resultKey === null) throw lost();
  const opened = await m.editing
    .open({ kind: "planning", repoId: repo.id, key: job.resultKey }, undefined)
    .catch(() => {
      throw lost();
    });
  // The new planning holds the same spec, and who named it with it, so the
  // next draft from it keeps the person's name as this one did (D-127).
  m.editing.carryNamed(opened.id, planning?.named ?? null);
  return { sessionId: opened.id, pane: opened.nodes > 0 ? "graph" : "criteria" };
}

/** A contract saved from the form. */
function admit(
  m: HostModules,
  repo: RegisteredRepository,
  request: RequestOf<"admit">,
  context: RouteContext,
): Job {
  return m.jobs.start(
    { repo, key: null, kind: request.kind, owner: context.owner, label: "Save task contract" },
    async (job, run) => {
      await run.invoke(admitDraftArgs(DraftSchema.parse(request.draft)));
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
  // A decision that answers findings carries on the run that stopped for it,
  // and publishes as that run was going to: a decided delivery then opens the
  // pull request that run would have
  // (D-NEW-a-person-s-answer-closes-a-routed-finding). A principle alone
  // publishes nothing.
  const publish =
    request.kind === "run"
      ? request.publish
      : request.decisions.length > 0 &&
        ((m.profile.state.jobs as Job[])
          .filter((job) => job.repoId === repo.id && job.key === request.key && isRun(job))
          .at(-1)?.publish ??
          false);
  const job = m.jobs.start(
    {
      repo,
      key: request.key,
      kind: request.kind,
      label: "Run engineering loop",
      publish,
    },
    async (job, run) => {
      m.tickets.assertDigest(repo, request.key, request.digest);
      const resumeFrom = request.kind === "run" ? request.resumeFrom : null;
      if (resumeFrom)
        assertResumable(await m.tickets.detail(repo.id, request.key), resumeFrom);
      if (request.kind === "decide") {
        // Each answer closes its finding
        // (D-NEW-a-person-s-answer-closes-a-routed-finding); the principle
        // carries the same words to the executor.
        const ticket = await m.tickets.ticket(repo, request.key);
        assertDecidable(
          findingsOnRecord(await m.tickets.bundles(repo), ticket.ticket_id, objectsPath(repo)),
          request.decisions,
        );
        const author = m.profile.state.settings.name || "Local user";
        for (const decision of request.decisions) {
          await run.invoke(decisionArgs(request.key, decision, author));
          if (run.signal.aborted) return;
        }
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
            publish,
          ),
        ),
      );
      if (request.kind === "run" && request.approve) {
        await run.invoke(approveArgs(request.key));
        // What it promises was settled with the approval, and a card offering
        // to change it would offer what the interview may not do (ADR-0016).
        m.drift.forget(repo.id, request.key, null);
      }
      if (run.signal.aborted) return;
      await run.invoke(runArgs(request.key, path, resumeFrom));
    },
  );
  // A filed ticket whose loop starts again is back on Home, and stays there
  // when that run ends until it is filed again (S4).
  const entry = repo.id + ":" + request.key;
  if (m.profile.state.archived.includes(entry)) {
    setArchived(m.profile.state, repo.id, [request.key], false);
    m.changes.preferences(m.profile.state);
  }
  return job;
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
