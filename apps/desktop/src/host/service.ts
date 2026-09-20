import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  ApproachRecordSchema,
  MaterializationManifestSchema,
  PlanContractSchema,
  ReviewArtifactSchema,
  RunBundleSchema,
  TicketSchema,
  STANDING_PROHIBITED_KEY,
  SymbolIndexSchema,
  UnsupportedRepositorySchema,
  hasAcceptanceCriteria,
  isNeverReadPath,
  planNodes,
  planSizeCounts,
  readStandingProhibited,
  sizeEstimate,
} from "@perbo/contracts";
import type {
  GraphEdge,
  PlanContract,
  SymbolIndex,
  Ticket,
  UnsupportedRepository,
} from "@perbo/contracts";
import type { PlanNode } from "@perbo/contracts/plan";
import { busyMessage, exclusiveJob, heldRepository, isLive, lane } from "../shared/jobs.js";
import { judgingChecks } from "../shared/checks.js";
import {
  EMPTY_SPEC_TEXT,
  PlanningError,
  SpecConflict,
  impactReport,
  parseSpec,
  readSpecText,
  requirementNodes,
  specTitleFromMessage,
  writeNodePages,
  writeSpecFile,
} from "@perbo/planning";
import {
  DraftSchema,
  HELP_LINKS,
  PREVIEW_BYTE_CAP,
  RequestSchema,
  SettingsSchema,
  TaskModelsSchema,
  INTERVIEW_NEEDS_A_TITLE,
} from "../shared/protocol.js";
import { InterviewEventSchema, InterviewTurnSchema, encodeInterviewTurn } from "@perbo/contracts/interview-protocol";
import type {
  Detail,
  Change,
  ChangeInput,
  EditingSession,
  ExplorerFile,
  ExplorerListing,
  GraphCriterionView,
  GraphLiveView,
  GraphNodeView,
  GraphView,
  ImpactView,
  InterviewEdit,
  InterviewEntry,
  InterviewStatus,
  Job,
  PowerState,
  Provider,
  ReplyMap,
  Repository,
  Request,
  Snapshot,
  SpecSaveReply,
  SpecSections,
  SpecView,
  SymbolIndexView,
  TaskModels,
  TaskSummary,
  UsageReport,
} from "../shared/protocol.js";
import { childEnvironment, redact, requireSuccess, runProcess, startLineProcess } from "./process.js";
import type { LineProcess, ProcessOptions, ProcessResult } from "./process.js";
import { isArchived } from "../shared/archive.js";
import { discoverModels } from "./model-catalog.js";
import {
  ContractEditing,
  openDrafts,
  type EditingOwner,
  interviewProviderFor,
  interviewSessionArgs,
} from "../shared/contract-editing.js";
import { WorkspaceReads } from "./workspace-reads.js";
import { ProfileStateSchema } from "./profile/store.js";
import { explorerPath, safePath } from "./repository/paths.js";
import { repositoryStatus, topLevel, trackedFiles } from "./repository/git.js";
import { pullRequestUrl, ticketWorktree, type TicketRecords } from "./tickets/open.js";
import { archiveExport, ticketExport } from "./tickets/export.js";
import { retainedOutput } from "./tickets/output.js";
import { discardTicket } from "./tickets/discard.js";
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
import {
  forgetRepository,
  setArchived,
} from "./profile/preferences.js";
import {
  effectiveLimits,
  readConfig,
  readManifest,
  saveManifest,
  specFolder,
  writeConfig,
} from "./repository/config.js";
import {
  attemptsPath,
  bundlesPath,
  configPath,
  objectsPath,
  perboPath,
  principlesPath,
  ticketPath,
} from "./repository/layout.js";
import type { ProfileState, RegisteredRepository } from "./profile/store.js";
import { runnerProgress } from "../shared/runner-progress.js";
import {
  currentMonth,
  isEarlyStop,
  ledgerFor,
  listBundles,
  liveGraph,
  readAttempts,
  readDraftEdits,
  readLatestDraftEdit,
  summariseTicket,
  type StoredAttempt,
} from "./records.js";
import { codexUsage } from "./usage-probe.js";

const ListSchema = z.object({ tickets: z.array(TicketSchema) });
const CheckSchema = z
  .object({
    name: z.string().optional(),
    check_id: z.string().optional(),
    status: z.string(),
    summary: z.string().optional(),
    detail: z.string().nullable().optional(),
    command: z.string().nullable().optional(),
    output: z.unknown().optional(),
    /**
     * Present on a result the runner ran for one node of an execution graph
     * (D-107). The desktop shows what judges the change, which is the results
     * without it.
     */
    node: z.object({ node_id: z.string() }).passthrough().optional(),
  })
  .passthrough();
const ReportSchema = z
  .object({
    attempts: z.array(
      z
        .object({
          attempt_id: z.string(),
          run: z.number(),
          round: z.number(),
          started_at: z.string(),
          outcome: z.string(),
          termination: z
            .object({ reason: z.string(), detail: z.string() })
            .passthrough(),
          agent: z.object({ model: z.string() }).passthrough(),
          cost: z.object({
            micros: z.number().nullable(),
            basis: z.string(),
            partial: z.boolean(),
          }),
          ceilings: z.array(
            z.object({
              resource: z.string(),
              used: z.number().nullable(),
              // Null where nothing bounds the resource, which after D-096 is
              // most of them on most runs.
              ceiling: z.number().nullable(),
              hit: z.boolean(),
            }),
          ),
          review: ReviewArtifactSchema.nullable(),
          review_decision: z.string().nullable(),
          changed_files: z
            .array(
              z.object({
                path: z.string(),
                change_kind: z.string(),
                additions: z.number().nullable(),
                deletions: z.number().nullable(),
              }),
            )
            .nullable(),
          checks: z.array(CheckSchema).nullable(),
          verification: z.unknown(),
          bundles: z.array(RunBundleSchema),
        })
        .passthrough(),
    ),
    total_cost: z
      .object({
        micros: z.number(),
        partial: z.number(),
        unavailable: z.number(),
      })
      .passthrough(),
    verdicts: z.array(z.unknown()),
  })
  .passthrough();

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
export const LOGIN_COMMANDS = {
  claude: ["claude", "auth", "login"],
  codex: ["codex", "login"],
} as const;
/**
 * The text of one message the interview streamed, or null where it carries
 * none to show.
 *
 * A reading rather than a declaration: the messages travel as the Claude Agent
 * SDK shaped them, and the shapes are the provider's. Its `SDKAssistantMessage`
 * is `{ type: 'assistant', message: BetaMessage, … }`, whose `message` is
 * "Shaped like an Anthropic Messages API Message object (role 'assistant'):
 * id, model, content blocks (text, thinking, tool_use, ...)" — so what is read
 * is the text blocks, and a message that does not look like that shows nothing
 * rather than something guessed.
 */
const SdkAssistantSchema = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  }),
});
export function interviewSaid(message: Record<string, unknown>): string | null {
  const parsed = SdkAssistantSchema.safeParse(message);
  if (!parsed.success) return null;
  const text = parsed.data.message.content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
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
  private readonly statePath: string;
  private state: ProfileState;
  private readonly editing: ContractEditing;
  private readonly reads = new WorkspaceReads();
  private sequence = 0;
  /** Every command still running, by job id: planning beside a run (D-101). */
  private readonly active = new Map<
    string,
    { job: Job; controller: AbortController; done: Promise<void> }
  >();
  /**
   * The tail of each repository's admissions. The ticket store hands out a key
   * by scanning what it holds, so two `admit` processes over one store return
   * the same key and the second overwrites the first; within a repository they
   * take turns. Planning still runs beside a run, beside an edit, and beside
   * planning in another repository.
   */
  private readonly admissions = new Map<string, Promise<void>>();
  /**
   * The interview beside each planning session, by that session's id (D-102).
   * One at a time per session, and any number across sessions: the interview
   * is planning-lane work, so it is never in a run's way and a run is never in
   * its. It outlives the pane it was started from, as drafting outlives the
   * screen that asked for it (D-095), and goes when it is stopped, when its
   * planning is discarded, or when the app closes.
   */
  private readonly interviews = new Map<string, { repoId: string; child: LineProcess }>();
  private lastSave = 0;

  constructor(options: ServiceOptions) {
    this.options = options;
    this.execute = options.process ?? runProcess;
    this.spawn = options.startProcess ?? startLineProcess;
    mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 });
    this.statePath = join(options.dataDirectory, "workspace.json");
    const stored = existsSync(this.statePath)
      ? z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(readFileSync(this.statePath, "utf8")))
      : null;
    this.state = stored
      ? ProfileStateSchema.parse(stored)
      : {
          version: 1,
          settings: SettingsSchema.parse({}),
          repositories: [],
          jobs: [],
          titles: {},
          taskModels: {},
          archived: [],
          archivedSeeded: true,
          editingSessions: [],
        };
    // A profile from before the four notification moments keeps what its one switch said.
    const legacy = z
      .looseObject({
        notifications: z.boolean().optional(),
        notifyOn: z.unknown().optional(),
      })
      .safeParse(stored?.["settings"] ?? {});
    if (
      legacy.success &&
      legacy.data.notifyOn === undefined &&
      legacy.data.notifications === false
    )
      this.state.settings.notifyOn = {
        decision: false,
        review: false,
        ceiling: false,
        stage: false,
      };
    for (const job of this.state.jobs)
      if (job.state === "running" || job.state === "stopping") {
        job.state = "interrupted";
        job.error =
          "Perbo closed before the command reported an outcome. Refresh the ticket from its CLI records before starting again.";
        job.endedAt = new Date().toISOString();
      }
    this.editing = new ContractEditing({
      records: () => this.state.editingSessions,
      persist: (records) => {
        const previous = this.state.editingSessions;
        this.state.editingSessions = records;
        try {
          this.save();
        } catch (error) {
          this.state.editingSessions = previous;
          throw error;
        }
        for (const record of records)
          if (previous.find((entry) => entry.id === record.id) !== record)
            this.changed(false, { kind: "editing", sessionId: record.id });
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
        this.changed(true, { kind: "records", repoId: repo.id, key: null });
      },
    });
    this.editing.recover();
    this.save();
    this.options.io.applyTheme?.(this.state.settings.theme);
  }

  private save(): void {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, this.statePath);
    this.lastSave = Date.now();
  }
  private changed(
    persist = true,
    change: ChangeInput = { kind: "records", repoId: null, key: null },
  ): void {
    if (change.kind === "records")
      this.reads.invalidate(change.repoId ?? "all");
    if (change.kind === "repositories" || change.kind === "preferences")
      this.reads.invalidate("all");
    if (persist) this.save();
    this.options.changed({ ...change, sequence: ++this.sequence });
  }
  private preferencesChanged(persist = true): void {
    this.changed(persist, {
      kind: "preferences",
      settings: this.state.settings,
      titles: this.state.titles,
      taskModels: this.state.taskModels,
      archived: this.state.archived,
    });
  }
  private repository(id: string): RegisteredRepository {
    const repo = this.state.repositories.find((entry) => entry.id === id);
    if (!repo)
      throw new Error(
        "This repository is no longer connected. Choose it again in Settings.",
      );
    if (realpathSync(repo.path) !== repo.path)
      throw new Error(
        "The repository path changed. Reconnect the repository before continuing.",
      );
    perboPath(repo);
    return repo;
  }
  private trackedFiles(repo: RegisteredRepository): Promise<string[]> {
    return trackedFiles(this.execute, repo.path);
  }
  private async explorerList(repo: RegisteredRepository): Promise<ExplorerListing> {
    const tracked = await this.trackedFiles(repo);
    const files = tracked.filter((path) => !isNeverReadPath(path)).sort();
    return {
      files,
      hidden: tracked.length - files.length,
      standing: readStandingProhibited(readConfig(repo)),
    };
  }
  /**
   * One file, read-only (D-015). A file larger than the cap or holding a NUL
   * byte comes back with the reason and no text: a truncated preview reads as
   * the whole file, and a decoded binary is not text.
   */
  private async explorerRead(
    repo: RegisteredRepository,
    requested: string,
  ): Promise<ExplorerFile> {
    const path = explorerPath(repo, requested);
    const full = safePath(repo, path);
    if (!existsSync(full)) throw new Error(`${path} is not a tracked file in this repository.`);
    if (lstatSync(full).isDirectory())
      throw new Error(`${path} is a folder. The tree already lists what is in it.`);
    if (!(await this.trackedFiles(repo)).includes(path))
      throw new Error(`${path} is not a tracked file in this repository.`);
    const bytes = lstatSync(full).size;
    const refuse = (refusal: string): ExplorerFile => ({ path, bytes, text: null, refusal });
    if (bytes > PREVIEW_BYTE_CAP)
      return refuse(
        `${path} is larger than the 256 KiB the preview reads, so nothing is shown rather than part of it. Open it in your editor.`,
      );
    const raw = readFileSync(full);
    if (raw.includes(0))
      return refuse(`${path} is a binary file. There is nothing here to read.`);
    return { path, bytes, text: raw.toString("utf8"), refusal: null };
  }
  private cli(
    args: string[],
    repo: RegisteredRepository,
    options: Partial<ProcessOptions> = {},
  ): Promise<ProcessResult> {
    const env = childEnvironment();
    if (this.options.electronNode) env.ELECTRON_RUN_AS_NODE = "1";
    return this.execute(
      this.options.nodeBinary,
      [this.options.cliPath, ...args, "--repo", repo.path],
      { ...options, cwd: repo.path, env },
    );
  }
  /**
   * The same CLI, the same environment and the same `--repo`, as a child that
   * stays: stdin written a line at a time and stdout read the same way. The
   * interview is the one command shaped like that, because the conversation is
   * the process (D-102).
   */
  private cliChild(
    args: string[],
    repo: RegisteredRepository,
    options: Omit<Parameters<typeof startLineProcess>[2], "cwd" | "env">,
  ): LineProcess {
    const env = childEnvironment();
    if (this.options.electronNode) env.ELECTRON_RUN_AS_NODE = "1";
    return this.spawn(
      this.options.nodeBinary,
      [this.options.cliPath, ...args, "--repo", repo.path],
      { ...options, cwd: repo.path, env },
    );
  }
  private async metadata(
    repo: RegisteredRepository,
  ): Promise<Repository> {
    return this.reads.read("metadata:" + repo.id, repo.id, () =>
      this.readMetadata(repo),
    );
  }
  private async readMetadata(
    repo: RegisteredRepository,
  ): Promise<Repository> {
    try {
      this.repository(repo.id);
      const status = await repositoryStatus(this.execute, repo.path);
      const config = existsSync(configPath(repo))
        ? z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(readFileSync(configPath(repo), "utf8")))
        : {};
      const manifest = MaterializationManifestSchema.safeParse(
        config["materialization_manifest"],
      );
      const protectedPaths = z
        .array(z.string())
        .safeParse(config["protected_paths"]);
      return {
        ...repo,
        ...status,
        configured: existsSync(configPath(repo)),
        error: null,
        ...(manifest.success
          ? {
              testCommand: manifest.data.verify.command.join(" "),
              manifestCount: manifest.data.entries.length,
            }
          : {}),
        ...(protectedPaths.success
          ? { prohibitedPaths: protectedPaths.data }
          : {}),
      };
    } catch (error) {
      return {
        ...repo,
        branch: "Unavailable",
        head: "",
        dirty: false,
        configured: false,
        error: redact(String(error)),
      };
    }
  }
  async registerRepository(path: string): Promise<Repository> {
    const canonical = realpathSync(path);
    const root = await topLevel(this.execute, canonical);
    if (realpathSync(root) !== canonical)
      throw new Error("Choose the root folder of the Git checkout.");
    const existing = this.state.repositories.find(
      (repo) => repo.path === canonical,
    );
    if (existing) return this.metadata(existing);
    const repo = {
      id: randomUUID(),
      name: basename(canonical),
      path: canonical,
    };
    perboPath(repo);
    this.state.repositories.push(repo);
    this.changed(true, { kind: "repositories" });
    return this.metadata(repo);
  }
  async snapshot(): Promise<Snapshot> {
    // The live interviews are counted outside the shared read: they are this
    // host's own state rather than anything read off a repository, and a
    // cached listing would say one was still there after it had gone.
    const interviews = [...this.interviews.keys()];
    const workspace = await this.reads.read("snapshot", "snapshot", async () => {
      const records = await Promise.all(
        this.state.repositories.map((repo) => this.repositorySnapshot(repo.id)),
      );
      const tasks = records.flatMap((entry) => entry.tasks);
      if (
        !this.state.archivedSeeded &&
        !records.some((entry) => entry.errors.length)
      ) {
        // The first complete listing after this preference arrived: what had already finished is already filed.
        this.state.archived = [
          ...new Set([
            ...this.state.archived,
            ...tasks
              .filter((row) => isArchived(row.ticket.state))
              .map((row) => row.repoId + ":" + row.ticket.key),
          ]),
        ];
        this.state.archivedSeeded = true;
        this.save();
      }
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
        sequence: this.sequence,
        archived: this.state.archived,
        power: this.power,
        repositoryErrors: Object.fromEntries(
          records.map((entry) => [entry.repository.id, entry.errors]),
        ),
        drafts: openDrafts(this.state.editingSessions),
      };
    });
    return { ...workspace, interviews };
  }
  private list(repo: RegisteredRepository) {
    return this.reads.read("list:" + repo.id, repo.id, async () =>
      ListSchema.parse(
        JSON.parse(
          requireSuccess(
            await this.cli(["list", "--all", "--json"], repo),
          ),
        ),
      ),
    );
  }
  private async repositorySnapshot(
    repoId: string,
  ): Promise<ReplyMap["repositorySnapshot"]> {
    const repo = this.repository(repoId);
    return this.reads.read("repository:" + repoId, repoId, async () => {
      const [metadata, listing] = await Promise.allSettled([
        this.metadata(repo),
        this.list(repo),
      ]);
      if (metadata.status === "rejected") throw metadata.reason;
      const repository = metadata.value;
      try {
        if (repository.error) throw new Error(repository.error);
        if (listing.status === "rejected") throw listing.reason;
        const list = listing.value;
        return {
          repository,
          tasks: list.tickets.map((ticket) => ({
            repoId,
            repository: repo.name,
            ticket,
          })),
          errors: [],
        };
      } catch (error) {
        return {
          repository,
          tasks: [],
          errors: [`${repo.name}: ${redact(String(error))}`],
        };
      }
    });
  }
  /**
   * Rewrite the page of each node beside a spec that has just been written
   * (D-103): a page states what the spec and the graph say, and the spec has
   * just moved. Nothing to do until this session holds a plan.
   *
   * A spec still being written has no Outcome or no requirement yet and is not
   * one pages can be generated from; its pages are left as they are until it is
   * complete, which the next save does.
   */
  private refreshNodePages(
    repo: RegisteredRepository,
    id: string,
    specPath: string,
  ): void {
    const session = this.editing.read(id);
    if (session.key === null) return;
    const contract = this.readContract(repo, session.key).contract;
    let spec;
    try {
      spec = parseSpec(readFileSync(specPath, "utf8"));
    } catch (error) {
      if (error instanceof PlanningError) return;
      throw error;
    }
    writeNodePages({ repositoryRoot: repo.path, specFolder: dirname(specPath), spec, contract });
  }

  /**
   * This repository's symbol and import index, read fresh from `perbo index`
   * (D-015). The Spec pane's `@Symbol` completion and the Impact pane's
   * warnings both read it here.
   *
   * The command is run for the answer rather than `.perbo/index.json` read
   * off disk: nothing keeps that file fresh, and a stale one would let the
   * Spec pane mark a name that has since appeared, or the Impact pane miss an
   * importer that has since arrived. The record comes back on stdout and is
   * held to the schema the contract declares; a repository the index cannot
   * describe answers `supported: false`, which is a different fact from an
   * index holding no files, so the two are parsed against their own schemas
   * and never flattened into one.
   */
  private async symbolIndex(
    repo: RegisteredRepository,
  ): Promise<SymbolIndex | UnsupportedRepository> {
    const record: unknown = JSON.parse(
      requireSuccess(await this.cli(["index", "--json"], repo)),
    );
    return record !== null && typeof record === "object" && "supported" in record
      ? UnsupportedRepositorySchema.parse(record)
      : SymbolIndexSchema.parse(record);
  }

  /**
   * The exported names the Spec pane completes `@Symbol` from, and marks
   * against (D-015, SCP-321).
   *
   * The names come from the index and from nothing the renderer sent
   * ([ADR-0023](../../../../docs/adr/0023-untrusted-context-boundary.md) §4).
   * Building the index reads the whole tracked tree, so the five sections
   * asking at once share one run.
   */
  private async exportedNames(
    repo: RegisteredRepository,
  ): Promise<SymbolIndexView> {
    return this.reads.read("symbols:" + repo.id, repo.id, async () => {
      const index = await this.symbolIndex(repo);
      if ("supported" in index)
        return { supported: false, reason: index.reason, languages: index.languages_seen };
      // `perbo index` parses the whole tracked tree and has no never-read
      // filter of its own, so a file this surface may not name can export a
      // symbol (ADR-0030). Both halves of what a name carries would cross: the
      // name itself, and the path the popup prints beside it. Nothing outside
      // the list the explorer would show is offered.
      const named = new Set((await this.trackedFiles(repo)).filter((path) => !isNeverReadPath(path)));
      return {
        supported: true,
        names: index.files
          .filter((file) => named.has(file.path))
          .flatMap((file) =>
            file.exports
              // `export * from` records the name `*`, which is not a name a spec
              // can refer to: what it exports is not knowable without reading the
              // file it names.
              .filter((each) => each.name !== "*")
              .map((each) => ({ name: each.name, kind: each.kind, path: file.path })),
          ),
        headCommit: index.head_commit,
        workingTree: index.working_tree,
        builtAt: index.built_at,
      };
    });
  }

  /**
   * One planning session's spec, read from the repository (D-103).
   *
   * The file is what this says. Between one save and the next the repository
   * holds the spec, so a spec edited outside the app — by hand, or in a second
   * window — is what the pane shows the next time it reads.
   */
  private specView(id: string): SpecView {
    const session = this.editing.read(id);
    const empty: SpecSections = {
      outcome: "",
      requirements: "",
      no_gos: "",
      rabbit_holes: "",
      notes: "",
    };
    if (session.specSlug === null)
      return { slug: null, path: null, title: "", sections: empty, requirements: [] };
    const repo = this.repository(session.repoId);
    const folder = `${specFolder(repo)}/${session.specSlug}`;
    const path = `${folder}/spec.md`;
    const read = readSpecText(safePath(repo, ...path.split("/")));
    // The nodes a requirement landed in come from the contract this session
    // holds, where it holds one; before the first draft every answer is none.
    const held = session.key ? this.readContract(repo, session.key).contract : null;
    // P0 has neither criteria nor nodes, so it lands no requirement anywhere.
    const contract = held !== null && "acceptance_criteria" in held ? held : null;
    const carried = requirementNodes(
      { requirements: read.requirements.flatMap((each) => (each.id === null ? [] : [{ id: each.id, text: each.text }])) },
      contract,
    );
    return {
      slug: session.specSlug,
      path,
      title: read.text.title,
      sections: {
        outcome: read.text.outcome,
        requirements: read.text.requirements,
        no_gos: read.text.no_gos,
        rabbit_holes: read.text.rabbit_holes,
        notes: read.text.notes,
      },
      requirements: read.requirements.map((each) => ({
        id: each.id,
        text: each.text,
        nodes: carried.find((carry) => carry.id === each.id)?.nodes ?? [],
      })),
    };
  }

  /**
   * The impact warnings for one planning session's draft (D-015, SCP-320).
   *
   * Derived when a person asks the pane for them and never on its own: the
   * index is a parse of the whole tracked tree, which is not work to do because
   * a pane was opened.
   *
   * Every input is the host's own — the tracked tree from Git in the registered
   * repository, the scope off the session's form, the spec off the file the
   * session records — so nothing a renderer sent reaches a path or an argument
   * (ADR-0023 §4). Asking changes neither the draft nor the spec: it rebuilds
   * the index file `perbo index` keeps at `.perbo/index.json`, and the
   * pane's two actions are the draft's own mark and the spec's own save.
   *
   * The never-read paths are dropped before the warnings are derived, as the
   * explorer drops them from its listing: a path no surface reads is not one to
   * offer a person for their scope. They are dropped from the tracked list
   * alone: `perbo index` reads the whole tree and has no never-read filter of
   * its own, so what keeps them off the screen is `impactReport` naming nothing
   * outside that list — inside a warning's sentence as much as in its path.
   */
  private async impactView(id: string): Promise<ImpactView> {
    const session = this.editing.read(id);
    const repo = this.repository(session.repoId);
    const tracked = (await this.trackedFiles(repo)).filter((path) => !isNeverReadPath(path));
    const spec =
      session.specSlug === null
        ? null
        : readSpecText(
            safePath(
              repo,
              ...`${specFolder(repo)}/${session.specSlug}/spec.md`.split("/"),
            ),
          ).markdown;
    const report = impactReport({
      scope: session.form.draft.paths,
      tracked,
      spec,
      index: await this.symbolIndex(repo),
    });
    return { ...report, readAt: new Date().toISOString() };
  }

  /**
   * The interview's argv, built from the registered repository and this
   * planning's own records and from nothing a renderer sent (ADR-0023 §4).
   *
   * `--spec` is derived from the repository's spec folder and the slug the
   * session recorded, and judged where it lands rather than as it is spelled:
   * `safePath` refuses a symlink on the way and anything outside the checkout,
   * and it is the same string the command is then given, so what was checked is
   * what it acts on. `--session` appears only once an interview has reported
   * one, `--model` is the model this planning drafts with, and `--provider` is
   * the session it runs on, which is this planning's drafting choice.
   */
  private interviewArgv(
    repo: RegisteredRepository,
    session: EditingSession,
  ): string[] {
    const models = TaskModelsSchema.strip().parse(session.form.models);
    if (session.specSlug === null)
      throw new Error(INTERVIEW_NEEDS_A_TITLE);
    const spec = `${specFolder(repo)}/${session.specSlug}`;
    safePath(repo, ...spec.split("/"));
    const provider = interviewProviderFor(models);
    return [
      "interview",
      "--spec",
      spec,
      ...interviewSessionArgs(session, provider),
      "--model",
      models.executorModel,
      "--provider",
      provider,
    ];
  }

  /** Whether this planning has a live interview, and the conversation it holds. */
  private interviewStatus(id: string): InterviewStatus {
    const session = this.editing.read(id);
    return {
      id,
      running: this.interviews.has(id),
      interview: session.interviewSession,
      conversation: session.conversation,
    };
  }

  /**
   * Append one line of the conversation and push it to the renderer as it
   * arrives, or say only what is running where there is no line to add.
   *
   * The record is saved by the append itself, so the change is pushed without
   * a second write.
   *
   * Two things can stop a line landing, and they are answered differently. A
   * session that has gone while its interview was speaking takes the line with
   * it: there is nowhere left for it to land. A line the record will not hold
   * is said as a note instead of being dropped, because the person is watching
   * the chat for it — what the line carries is clipped where it is read
   * ({@link ../host/records.ts}), so this is the belt rather than the route.
   */
  private converse(id: string, line: InterviewEntry["line"] | null): InterviewEntry | null {
    const at = new Date().toISOString();
    let entry: InterviewEntry | null = null;
    if (line !== null) {
      try {
        entry = this.editing.converse(id, line, at);
      } catch (error) {
        try {
          entry = this.editing.converse(
            id,
            { kind: "note", text: `A line of the interview could not be recorded: ${redact(error instanceof Error ? error.message : String(error))}`.slice(0, 12_000) },
            at,
          );
        } catch {
          return null;
        }
      }
    }
    this.changed(false, {
      kind: "interview",
      sessionId: id,
      running: this.interviews.has(id),
      entry,
      asking: this.askingOf(id),
    });
    return entry;
  }

  /** The asking this planning is putting, or null where it holds none or has gone. */
  private askingOf(id: string): { entry: number; answered: number } | null {
    try {
      return this.editing.read(id).asking;
    } catch {
      return null;
    }
  }

  /**
   * Say what the asking is now, with no line to add.
   *
   * The dock reads it off this stream rather than off the session, which the
   * editor refuses to re-read while a save of its own is in flight: a card that
   * waited for that would come and go with whether the person was saving.
   */
  private askingChanged(id: string): void {
    this.changed(false, {
      kind: "interview",
      sessionId: id,
      running: this.interviews.has(id),
      entry: null,
      asking: this.askingOf(id),
    });
  }

  /**
   * Start the interview beside this planning, or answer with the one already
   * running: one session, one interview.
   */
  private startInterview(id: string): InterviewStatus {
    if (this.interviews.has(id)) return this.interviewStatus(id);
    const session = this.editing.read(id);
    const repo = this.repository(session.repoId);
    const args = this.interviewArgv(repo, session);
    let stderr = "";
    const child = this.cliChild(args, repo, {
      onLine: (line) => this.relay(id, line),
      // What the chat shows comes off the events; stderr is the same refusals
      // in prose, and is kept only to say why a session that never started did
      // not start.
      onStderr: (text) => {
        stderr = (stderr + text).slice(-4000);
      },
      onClose: ({ code, stopped }) => {
        this.interviews.delete(id);
        this.converse(
          id,
          code === 0 || stopped
            ? null
            : {
                kind: "note",
                text: `The interview stopped with code ${String(code)}.${
                  stderr.trim() ? ` ${stderr.trim()}` : ""
                }`,
              },
        );
      },
      onError: (error) => {
        this.interviews.delete(id);
        this.converse(id, { kind: "note", text: redact(error.message).slice(0, 12_000) });
      },
    });
    this.interviews.set(id, { repoId: repo.id, child });
    // Nothing is said yet: the interview's own `started` event is what says it
    // is there, and until then the only honest word is that it is starting,
    // which is what `running` on this change carries.
    this.converse(id, null);
    return this.interviewStatus(id);
  }

  /**
   * One line of the interview's stdout, as the chat shows it.
   *
   * A line that does not parse is reported as one that did not parse: the line
   * itself is never relayed, because a host that passed unparsed output through
   * would be relaying whatever wrote it rather than the protocol it declared.
   */
  private relay(id: string, line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.converse(id, {
        kind: "note",
        text: "The interview wrote a line this build could not read: it is not JSON.",
      });
      return;
    }
    const parsed = InterviewEventSchema.safeParse(raw);
    if (!parsed.success) {
      // The reason is the child's text like any other: redacted, and clipped,
      // because a line refused for four hundred fields names all four hundred
      // and a note the record will not hold is the line lost again.
      const why = redact(parsed.error.issues[0]?.message ?? "no reason given").slice(0, 2000);
      this.converse(id, {
        kind: "note",
        text:
          "The interview wrote a line this build could not read: it is not one of the interview's " +
          `events (${why}).`,
      });
      return;
    }
    const event = parsed.data;
    if (event.type === "started") {
      // The protocol caps the id at nothing and the record at 200, so it is
      // clipped here: unclipped, the append throws and the line that carries
      // the session is lost with it.
      const session = event.session_id.slice(0, 200);
      try {
        this.editing.recordInterview(id, session, this.interviewProvider(id));
      } catch {
        // The session's record is where `--session` is read from when the
        // interview is started again, so a planning that has gone takes the
        // conversation with it and there is nothing to say it to.
        return;
      }
      // The id as it was recorded, which is the one a later start continues.
      this.converse(id, {
        kind: "note",
        text: redact(`The session is ${session}, writing ${event.spec} and ${event.adr}.`).slice(
          0,
          2000,
        ),
      });
      return;
    }
    if (event.type === "message") {
      const said = interviewSaid(event.message);
      if (said !== null) this.converse(id, { kind: "said", text: redact(said).slice(0, 12_000) });
      return;
    }
    if (event.type === "refused") {
      this.converse(id, {
        kind: "refused",
        tool: event.tool.slice(0, 200),
        rule: event.rule.slice(0, 200),
        target: event.target === null ? null : redact(event.target).slice(0, 1000),
        reason: redact(event.reason).slice(0, 2000),
      });
      return;
    }
    if (event.type === "tool") {
      const changed = event.ok && (event.tool === "edit_plan" || event.tool === "undo_edit");
      this.converse(id, {
        kind: "tool",
        tool: event.tool.slice(0, 200),
        ok: event.ok,
        detail: redact(event.detail).slice(0, 12_000),
        edit: changed ? this.interviewEdit(id) : null,
      });
      // The plan really moved, so the surfaces reading those records are told,
      // as they are for an edit the Graph pane makes. Nothing else says it: the
      // interview runs `perbo edit` inside its own process rather than as a
      // job of this host's. Said whether or not the card could be drawn,
      // because what moved is the records rather than the card.
      if (changed) this.planChanged(id);
      return;
    }
    if (event.type === "asked") {
      // Clipped the way every other field the session wrote is, and redacted:
      // this is the session's text and the person reads it.
      //
      // Whitespace is flattened on the way through for two reasons a reader
      // would not guess. A label goes back down as the person's turn and, in a
      // group of more than one part, one line of it — so a label with a newline
      // in it would compose an answer the dock could never read back, and the
      // group would be put again for ever. And redaction can empty a field
      // outright (a label that was only escape codes), which the record then
      // refuses for being empty, taking every question in the asking with it;
      // a named placeholder loses one label instead of all of them.
      const said = (text: string, cap: number, empty: string): string => {
        const kept = redact(text).replace(/\s+/g, " ").trim().slice(0, cap).trim();
        return kept.length > 0 ? kept : empty;
      };
      const asked = this.converse(id, {
        kind: "asked",
        groups: event.groups.map((group) => ({
          title: group.title === null ? null : said(group.title, 200, "The interview asks"),
          parts: group.parts.map((part) => ({
            question: said(part.question, 600, "(the question did not survive redaction)"),
            options: part.options.map((option) => ({
              label: said(option.label, 200, "(unreadable answer)"),
              detail: option.detail === null ? null : said(option.detail, 600, "") || null,
              recommended: option.recommended,
            })),
          })),
        })),
      });
      // What the person is being put, from the line it arrived on: recorded
      // rather than counted back out of the turns (D-117).
      if (asked !== null) {
        this.editing.beginAsking(id, asked.n);
        this.askingChanged(id);
      }
      return;
    }
    this.converse(id, { kind: "note", text: `The interview ended: ${redact(event.reason).slice(0, 2000)}.` });
  }

  /**
   * Which provider this planning's interview runs on, which is its drafting
   * choice: the same derivation {@link interviewArgv} sends, read here so the
   * id reported back is recorded as that provider's.
   */
  private interviewProvider(id: string): "claude" | "codex" {
    try {
      return interviewProviderFor(TaskModelsSchema.strip().parse(this.editing.read(id).form.models));
    } catch {
      return "claude";
    }
  }

  /**
   * Say the ticket's records moved, for every surface drawing this plan.
   *
   * The repository is the one this interview was started against rather than
   * the one the session names now: `perbo edit` wrote where the argv pointed,
   * and a session whose repository was changed under a running interview would
   * otherwise have the wrong one told.
   */
  private planChanged(id: string): void {
    try {
      const session = this.editing.read(id);
      if (session.key === null) return;
      const repoId = this.interviews.get(id)?.repoId ?? session.repoId;
      this.changed(true, { kind: "records", repoId, key: session.key });
    } catch {
      // A session that has gone has no plan for anything to be drawing.
    }
  }

  /**
   * The plan edit an `edit_plan` or an `undo_edit` made, read off the ticket's
   * own draft record (D-100) so the chat's card carries an Undo on its number.
   *
   * The edit the command wrote down, not the one the tool said it made: the
   * record is written by `perbo edit`, which is the one path a plan changes
   * through, and the tool's own account of itself is a model's output
   * ([ADR-0023](../../../docs/adr/0023-untrusted-context-boundary.md)).
   */
  private interviewEdit(id: string): InterviewEdit | null {
    try {
      const session = this.editing.read(id);
      if (session.key === null) return null;
      // The repository this interview was started against, which is where
      // `perbo edit` wrote, and the one {@link planChanged} names.
      const repo = this.repository(this.interviews.get(id)?.repoId ?? session.repoId);
      return readLatestDraftEdit(
        ticketPath(repo, session.key, ".draft.json"),
        "interview",
      );
    } catch {
      // No record to read is a card without an undo, not a failed relay.
      return null;
    }
  }

  /**
   * The spec this planning writes, named from the person's first turn where
   * they have not named it in the Spec pane (D-118).
   *
   * The interview is started with `--spec`, so a planning with no slug has
   * nowhere to write. The person's own words name it: a title is cut from the
   * turn, the spec is written, and the slug it mints is recorded exactly as a
   * save from the Spec pane records one. Nothing a model returned reaches the
   * folder, so it stays the person's own parameter (ADR-0023 §4), and the slug
   * still goes through `safePath` where the argv is built.
   *
   * A turn no folder name can come from falls through to the refusal, which
   * asks for the title the message could not give.
   */
  private nameSpecFromTurn(id: string, text: string): void {
    const session = this.editing.read(id);
    if (session.specSlug !== null) return;
    const repo = this.repository(session.repoId);
    let title;
    try {
      title = specTitleFromMessage(text);
    } catch (error) {
      // Only a message that names nothing asks for a title. A spec already at
      // that folder is a different problem and says so in its own words.
      throw new Error(INTERVIEW_NEEDS_A_TITLE, { cause: error });
    }
    const written = writeSpecFile({
      repositoryRoot: repo.path,
      folder: specFolder(repo),
      slug: null,
      text: { ...EMPTY_SPEC_TEXT, title },
      base: EMPTY_SPEC_TEXT,
    });
    this.editing.recordSpec(id, written.slug);
    // The folder is minted once and never moves, so the person is told what it
    // was called while the spec is still empty enough to start again.
    this.converse(id, {
      kind: "note",
      text:
        `Named from your first message: ${written.folder}. The folder keeps this name; ` +
        "the title itself you can change in the Spec pane.",
    });
  }

  /**
   * The person's turn, down the interview's stdin as a `turn` line, after the
   * interview has been started where it is not running: leaving planning mode
   * leaves it running, and a restart starts it again with `--session`, which
   * continues the same conversation (D-102).
   *
   * Validated before it is written, and recorded only once it has been: a turn
   * nothing heard is not part of the conversation.
   */
  private interviewTurn(id: string, text: string): InterviewStatus {
    const turn = InterviewTurnSchema.parse({ type: "turn", text });
    if (!this.interviews.has(id)) {
      this.nameSpecFromTurn(id, turn.text);
      this.startInterview(id);
    }
    const live = this.interviews.get(id);
    if (!live || !live.child.write(encodeInterviewTurn(turn)))
      throw new Error(
        "The interview is not listening. Start it again, then send this once it is running.",
      );
    this.converse(id, { kind: "turn", text: turn.text });
    // Recorded before it is answered, so the asking is judged against a
    // conversation that already holds this turn.
    this.editing.answerAsking(id, turn.text);
    this.askingChanged(id);
    return this.interviewStatus(id);
  }

  /**
   * End the interview's stdin, which is how a session of its own ends; the
   * process group is signalled only for a child still there after that
   * ({@link ../host/process.ts}). It stays listed as running until it has
   * actually gone, so nothing starts a second one over the top of it.
   */
  private stopInterview(id: string): InterviewStatus {
    this.interviews.get(id)?.child.stop();
    return this.interviewStatus(id);
  }

  /**
   * The approach record beside a ticket: the order between its nodes and the
   * spec's No-Gos (D-100). A plan that has never had a graph has none, which is
   * an empty order rather than a failure; a record that does not parse, or that
   * belongs to another plan, is a refusal, because showing a graph with the
   * wrong order is worse than showing none.
   */
  private readApproach(
    repo: RegisteredRepository,
    key: string,
    contract: PlanContract,
  ): GraphEdge[] {
    const path = ticketPath(repo, key, ".approach.json");
    if (!existsSync(path)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      raw = undefined;
    }
    const parsed = ApproachRecordSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(
        `${key}'s approach record could not be read as an order between its nodes. Restore it from version control.`,
      );
    if (parsed.data.plan_id !== contract.plan_id || parsed.data.ticket_id !== contract.ticket_id)
      throw new Error(
        `${key}'s approach record belongs to another plan. Restore it from version control.`,
      );
    return [...parsed.data.edges];
  }

  /**
   * The generated page of each node, read from the spec folder (D-103). Absent
   * for a ticket drafted from an issue, which has no spec to generate from, and
   * for a node whose page has not been written yet.
   */
  private nodePages(
    repo: RegisteredRepository,
    ticket: Ticket,
    nodes: readonly { id: string }[],
  ): Map<string, { path: string; text: string }> {
    const pages = new Map<string, { path: string; text: string }>();
    const spec = ticket.admission.spec;
    if (spec === null) return pages;
    const folder = spec.path.split("/").slice(0, -1).join("/");
    for (const node of nodes) {
      const path = `${folder}/nodes/${node.id}.md`;
      let full: string;
      try {
        full = safePath(repo, ...path.split("/"));
      } catch {
        // A symlink on the way is a page the pane does not show, not a refusal of the graph.
        continue;
      }
      if (!existsSync(full)) continue;
      pages.set(node.id, { path, text: readFileSync(full, "utf8") });
    }
    return pages;
  }

  /**
   * One plan's execution graph as the Graph pane reads it (D-100, D-104): the
   * contract's nodes and criteria, the approach's order, the size over the
   * repository's tracked files, and the log of every edit with its author.
   *
   * Read from the store the CLI writes, never from anything the pane holds:
   * the pane's every edit goes back through `perbo edit`, so this is the only
   * account of what the plan now is. The tracked files stay on this side: the
   * size is counted here, and a listing crosses only through the explorer,
   * which withholds what nothing reads.
   */
  private async graphView(repo: RegisteredRepository, key: string): Promise<GraphView> {
    const ticket = (await this.list(repo)).tickets.find((entry) => entry.key === key);
    if (!ticket) throw new Error("This task is no longer in the repository's ticket store.");
    const { contract, digest } = this.readContract(repo, key);
    const criteria: GraphCriterionView[] = hasAcceptanceCriteria(contract)
      ? contract.acceptance_criteria.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          kind: criterion.expected_verification.kind,
          assertion: criterion.expected_verification.assertion,
          requirement: criterion.requirement_id ?? null,
          manual:
            criterion.expected_verification.kind === "manual"
              ? {
                  reviewer: criterion.expected_verification.manual_reviewer ?? "",
                  reason: criterion.expected_verification.manual_reason ?? "",
                }
              : null,
        }))
      : [];
    const held = new Map(criteria.map((criterion) => [criterion.id, criterion]));
    const nodes = planNodes(contract);
    const pages = this.nodePages(repo, ticket, nodes);
    const files = await this.trackedFiles(repo);
    return {
      key,
      state: ticket.state,
      approved: ticket.approved_at !== null,
      outcome: contract.outcome,
      nodes: nodes.map(
        (node): GraphNodeView => ({
          id: node.id,
          title: node.title,
          criteria: node.criteria.flatMap((id) => {
            const criterion = held.get(id);
            return criterion ? [criterion] : [];
          }),
          paths: [...node.paths],
          page: pages.get(node.id) ?? null,
        }),
      ),
      criteria,
      edges: this.readApproach(repo, key, contract),
      pathsAllowed: [...contract.scope.paths_allowed],
      size: sizeEstimate(
        planSizeCounts({
          nodes,
          criteria: criteria.length,
          paths_allowed: contract.scope.paths_allowed,
          paths_prohibited: contract.scope.paths_prohibited,
          trackedFiles: files,
        }),
      ),
      editCount: ticket.admission.edit_count ?? 0,
      history: readDraftEdits(ticketPath(repo, key, ".draft.json")),
      digest,
      live: await this.liveGraph(repo, ticket, nodes),
    };
  }

  /**
   * What this ticket's own records say about its graph (SCP-317): the sealed
   * change set, the pinned checks narrowed to each node, and the review of
   * this plan with whatever the rounds since it closed.
   *
   * Read here rather than through `perbo inspect`, as `taskSummary` reads the
   * same store: the Graph pane is refreshed after every edit and while a run
   * moves, and this is a read of files the loop already wrote — no job, no
   * write and no subprocess.
   */
  private async liveGraph(
    repo: RegisteredRepository,
    ticket: Ticket,
    nodes: readonly PlanNode[],
  ): Promise<GraphLiveView> {
    const record = readAttempts(
      attemptsPath(repo, ticket.ticket_id),
    );
    const bundles = record.attempts.length
      ? await this.reads.read("bundles:" + repo.id, repo.id, async () =>
          listBundles(bundlesPath(repo)),
        )
      : [];
    return liveGraph({
      nodes: nodes.map((node) => ({ id: node.id, paths: node.paths, criteria: node.criteria })),
      attempts: record.attempts,
      bundles,
      ticketId: ticket.ticket_id,
      planVersion: ticket.plan_version,
      objectsDirectory: objectsPath(repo),
    });
  }

  private readContract(
    repo: RegisteredRepository,
    key: string,
  ): { contract: Detail["contract"]; digest: string } {
    const raw = readFileSync(
      ticketPath(repo, key, ".contract.json"),
      "utf8",
    );
    return {
      contract: PlanContractSchema.parse(JSON.parse(raw)),
      digest: createHash("sha256").update(raw).digest("hex"),
    };
  }
  private assertDigest(
    repo: RegisteredRepository,
    key: string,
    digest: string,
  ): void {
    if (this.readContract(repo, key).digest !== digest)
      throw new Error(
        "The contract changed since you opened it. Refresh and review the latest version before approving or editing.",
      );
  }
  async detail(repoId: string, key: string): Promise<Detail> {
    return this.reads.read("detail:" + repoId + ":" + key, repoId, () =>
      this.readDetail(repoId, key),
    );
  }
  private async readDetail(repoId: string, key: string): Promise<Detail> {
    const repo = this.repository(repoId);
    const list = await this.list(repo);
    const ticket = list.tickets.find((entry) => entry.key === key);
    if (!ticket)
      throw new Error(
        "This task is no longer in the repository's ticket store.",
      );
    const report = ReportSchema.parse(
      JSON.parse(
        requireSuccess(await this.cli(["inspect", key, "--json"], repo)),
      ),
    );
    const principles = principlesPath(repo);
    const limits = effectiveLimits(repo, this.state.settings).limits;
    return {
      ticket,
      ...this.readContract(repo, key),
      attempts: report.attempts.map((attempt) => ({
        id: attempt.attempt_id,
        run: attempt.run,
        round: attempt.round,
        startedAt: attempt.started_at,
        outcome: attempt.outcome,
        termination: `${attempt.termination.reason}: ${attempt.termination.detail}`,
        model: attempt.agent.model,
        costMicros: attempt.cost.micros,
        costBasis: attempt.cost.basis,
        partial: attempt.cost.partial,
        ceilings: attempt.ceilings,
        review: attempt.review,
        reviewDecision: attempt.review_decision,
        changes: attempt.changed_files ?? [],
        checks: judgingChecks(attempt.checks ?? []).map((check) => ({
          name: check.name ?? check.check_id ?? "Check",
          status: check.status,
          detail: [
            check.command,
            check.summary,
            check.detail ??
              (check.output === undefined
                ? null
                : typeof check.output === "string"
                  ? check.output
                  : JSON.stringify(check.output, null, 2)),
          ]
            .filter(Boolean)
            .join("\n\n"),
        })),
        verification: attempt.verification,
        bundles: attempt.bundles,
      })),
      cost: {
        micros: report.total_cost.micros,
        partial:
          report.total_cost.partial > 0 || report.total_cost.unavailable > 0,
        unavailable: report.total_cost.unavailable,
      },
      principles: existsSync(principles)
        ? readFileSync(principles, "utf8").slice(0, 100_000)
        : "",
      verdicts: report.verdicts,
      effective: {
        stallMinutes: limits["attempt_stall_ms"]! / 60_000,
        ticketDollars: limits["ticket_cost_micros"]! / 1_000_000,
      },
      report,
    };
  }
  async providers(): Promise<Provider[]> {
    const probe = async (id: "claude" | "codex"): Promise<Provider> => {
      const base = {
        id,
        name: id === "claude" ? "Claude Code" : "Codex",
        loginCommand: LOGIN_COMMANDS[id].join(" "),
        roles:
          id === "claude"
            ? ["Execution", "Independent review", "Planning"]
            : ["Execution", "Independent review", "Planning"],
      };
      try {
        const result = await this.execute(
          id,
          id === "claude" ? ["auth", "status", "--json"] : ["login", "status"],
          { cwd: this.options.dataDirectory, timeoutMs: 12_000 },
        );
        const logged =
          id === "claude"
            ? z
                .object({
                  loggedIn: z.boolean(),
                  authMethod: z.string().optional(),
                })
                .safeParse(JSON.parse(result.stdout || "{}"))
            : null;
        const authenticated =
          id === "claude"
            ? logged?.success === true && logged.data.loggedIn
            : result.code === 0;
        const subscription =
          id === "claude"
            ? logged?.success === true &&
              /oauth|subscription/i.test(logged.data.authMethod ?? "")
            : /chatgpt/i.test(result.stdout + result.stderr);
        return {
          ...base,
          installed: true,
          authenticated,
          detail: authenticated
            ? subscription
              ? "Signed in with your subscription"
              : "Signed in · credential managed by the CLI"
            : "Installed · sign in through your terminal, then refresh",
        };
      } catch {
        return {
          ...base,
          installed: false,
          authenticated: false,
          detail: "CLI unavailable. Install it, sign in, then refresh.",
        };
      }
    };
    const providers = await Promise.all([probe("claude"), probe("codex")]);
    return [
      ...providers,
      {
        id: "anthropic",
        name: "Anthropic API · optional",
        installed: true,
        authenticated: Boolean(process.env.ANTHROPIC_API_KEY),
        detail: process.env.ANTHROPIC_API_KEY
          ? "Environment credential available · metered API usage"
          : "No ANTHROPIC_API_KEY in the app environment",
        loginCommand: "",
        roles: ["Independent review"],
      },
    ];
  }
  /** The jobs still tracked, in either lane. */
  private liveJobs(): Job[] {
    return [...this.active.values()].map((entry) => entry.job);
  }
  private start(
    repoId: string,
    key: string | null,
    kind: string,
    label: string,
    operation: (job: Job, signal: AbortSignal) => Promise<void>,
    owner?: EditingOwner,
  ): Job {
    const blocking =
      lane(kind) === "exclusive"
        ? exclusiveJob(this.liveJobs())
        : undefined;
    if (blocking) throw new Error(busyMessage(blocking.label));
    const controller = new AbortController();
    const job: Job = {
      id: randomUUID(),
      repoId,
      key,
      kind,
      label,
      state: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      log: "",
      error: null,
      resultKey: null,
      result: null,
      ...(owner ? { editing: owner } : {}),
    };
    // The journal keeps the last forty records, and never drops a live command:
    // cancelling one and saving its editing receipt both need its record.
    this.state.jobs = [
      ...this.state.jobs.slice(0, -39).filter((entry) => this.active.has(entry.id)),
      ...this.state.jobs.slice(-39),
      job,
    ];
    const admits = kind === "draft" || kind === "admit";
    const ahead = admits ? this.admissions.get(repoId) : undefined;
    // Reserve the job's place synchronously, before operation can yield or another IPC request can enter.
    const done = (ahead ?? Promise.resolve())
      .then(() => {
        if (controller.signal.aborted)
          throw new Error("Command cancelled before starting");
        return operation(job, controller.signal);
      })
      .then(() => {
        job.state = controller.signal.aborted ? "cancelled" : "completed";
      })
      .catch((error: unknown) => {
        job.error = redact(
          error instanceof Error ? error.message : String(error),
        );
        job.state = controller.signal.aborted ? "cancelled" : "failed";
      })
      .finally(async () => {
        job.endedAt = new Date().toISOString();
        this.reads.invalidate(repoId);
        try {
          await this.editing.settled(job);
          this.changed(true, {
            kind: "records",
            repoId,
            key: job.resultKey ?? key,
            job,
          });
          this.updatePower();
          await this.notifyOutcome(job);
        } catch (error) {
          job.error = `Could not save the command status: ${redact(String(error))}`;
          job.state = "failed";
          this.changed(false, {
            kind: "records",
            repoId,
            key: job.resultKey ?? key,
            job,
          });
          this.updatePower();
        } finally {
          // Held until the receipt is saved and the outcome told, so a
          // shutdown awaits it; the job is no longer live by then, so it is
          // in nobody's way, and a stop no longer reaches it.
          this.active.delete(job.id);
        }
      });
    this.active.set(job.id, { job, controller, done });
    if (admits) {
      this.admissions.set(repoId, done);
      void done.then(() => {
        if (this.admissions.get(repoId) === done) this.admissions.delete(repoId);
      });
    }
    try {
      if (owner) this.editing.started(owner, job);
      this.changed(true, { kind: "progress", job });
      this.updatePower();
    } catch (error) {
      controller.abort();
      throw error;
    }
    return job;
  }
  private async invoke(
    job: Job,
    repo: RegisteredRepository,
    args: string[],
    signal: AbortSignal,
    allowFailure = false,
  ): Promise<ProcessResult> {
    const result = await this.cli(args, repo, {
      signal,
      timeoutMs: 12 * 60 * 60 * 1000,
      onOutput: (output) => {
        if (job.log === output) return;
        job.log = output;
        this.changed(Date.now() - this.lastSave > 1500, {
          kind: "progress",
          job,
        });
        this.notifyStage(job);
      },
    });
    job.log = redact(
      [result.stderr, result.stdout].filter(Boolean).join("\n"),
    ).slice(-80_000);
    if (!allowFailure) requireSuccess(result);
    if (result.stdout.trim()) {
      try {
        job.result = JSON.parse(result.stdout);
      } catch {
        job.result = null;
      }
    }
    return result;
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
      this.stopInterview(request.id);
      return discarded;
    }
    // The interview docked beside the panes (D-102). Planning-lane work, like
    // the explorer's reads: answered here rather than as a job, so a run is
    // never in its way and it is never in a run's.
    if (request.kind === "interviewStart") {
      const session = this.editing.read(request.id);
      if (session.repoId !== request.repoId)
        throw new Error("This planning belongs to another repository.");
      return this.startInterview(request.id);
    }
    if (request.kind === "interviewTurn")
      return this.interviewTurn(request.id, request.text);
    if (request.kind === "interviewStop") return this.stopInterview(request.id);
    if (request.kind === "snapshot") return this.snapshot();
    if (request.kind === "repositorySnapshot")
      return this.repositorySnapshot(request.repoId);
    // Planning-lane work (D-101): answered here, never as a job, so a run is
    // never in the way of reading a file and a read is never in the way of one.
    if (request.kind === "explorerList")
      return this.explorerList(this.repository(request.repoId));
    if (request.kind === "explorerRead")
      return this.explorerRead(this.repository(request.repoId), request.path);
    if (request.kind === "symbolIndex")
      return this.exportedNames(this.repository(request.repoId));
    if (request.kind === "providers") return this.providers();
    if (request.kind === "login") {
      const command = LOGIN_COMMANDS[request.provider];
      if (!this.options.io.openTerminal)
        throw new Error(
          `Run ${command.join(" ")} in your terminal, then refresh the connection.`,
        );
      await this.options.io.openTerminal(command);
      return null;
    }
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
      this.preferencesChanged();
      this.options.io.applyTheme?.(request.settings.theme);
      this.updatePower();
      return request.settings;
    }
    if (request.kind === "specRead") return this.specView(request.id);
    if (request.kind === "impactRead") return this.impactView(request.id);
    if (request.kind === "usage") return this.usage();
    if (request.kind === "cancel") {
      const entry = this.active.get(request.jobId);
      // A finished job stays tracked while its receipt is saved; it is not one
      // a stop can reach, and marking it stopping would leave it there for good.
      if (!entry || !isLive(entry.job)) throw new Error("That command is no longer active.");
      entry.job.state = "stopping";
      entry.controller.abort();
      this.changed(true, { kind: "progress", job: entry.job });
      return null;
    }
    const repo = this.repository(request.repoId);
    if (request.kind === "forgetRepository") {
      if (heldRepository(this.liveJobs(), repo.id))
        throw new Error(
          "Wait for the commands running in this repository to finish before disconnecting it.",
        );
      forgetRepository(this.state, repo.id);
      this.changed(true, { kind: "repositories" });
      this.preferencesChanged(false);
      return null;
    }
    if (request.kind === "graphRead") return this.graphView(repo, request.key);
    // Every edit the Graph pane makes is this command (D-100): applied to a
    // copy, validated whole and recorded with its author by the CLI, which is
    // also what the interview's edits go through. The pane writes nothing.
    if (request.kind === "graphEdit" || request.kind === "graphUndo")
      return this.start(
        repo.id,
        request.key,
        request.kind,
        request.kind === "graphUndo" ? "Undo a plan edit" : "Change the plan's graph",
        async (job, signal) => {
          await this.invoke(job, repo, graphEditArgs(request.key, request), signal);
          job.resultKey = request.key;
        },
      );
    if (request.kind === "detail") return this.detail(repo.id, request.key);
    if (request.kind === "taskSummary")
      return this.taskSummary(repo.id, request.key);
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
      this.changed(true, { kind: "records", repoId: repo.id, key: null });
      this.preferencesChanged();
      return null;
    }
    if (request.kind === "archive") {
      const list = await this.list(repo);
      const keys = [...new Set(request.keys)];
      if (keys.some((key) => !list.tickets.some((ticket) => ticket.key === key)))
        throw new Error("A ticket to file is not in the repository's ticket store.");
      setArchived(this.state, repo.id, keys, request.archived);
      this.preferencesChanged();
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
      this.changed(true, { kind: "records", repoId: repo.id, key: null });
      return null;
    }
    if (request.kind === "rename") {
      this.readContract(repo, request.key);
      this.state.titles[repo.id + ":" + request.key] = request.title;
      this.preferencesChanged();
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
      return this.start(
        repo.id,
        null,
        request.kind,
        request.writeConfig
          ? "Save repository configuration"
          : "Check repository readiness",
        async (job, signal) => {
          const path = writePrivate(
            this.options.dataDirectory,
            `doctor-${job.id}.json`,
            JSON.stringify(doctorConfig(this.state.settings)),
          );
          await this.invoke(job, repo, doctorArgs(path, request.writeConfig), signal);
        },
      );
    if (request.kind === "specSave") {
      const session = this.editing.read(request.id);
      if (session.repoId !== repo.id)
        throw new Error("This planning belongs to another repository.");
      let written;
      try {
        written = writeSpecFile({
          repositoryRoot: repo.path,
          folder: specFolder(repo),
          slug: session.specSlug,
          text: { title: request.title, ...request.sections },
          base: { title: request.base.title, ...request.base.sections },
        });
      } catch (error) {
        // A section the interview or the Impact pane wrote since this writer
        // read the file is not an error a person can only read: the file comes
        // back with the refusal, so the pane shows both texts and neither
        // side's words are lost (SCP-321). Nothing was written.
        //
        // The file is read again rather than rebuilt from the refusal, which
        // carries the five sections and not the requirement ids or the nodes
        // behind them. A file that moved once more in between refuses the next
        // save as well, so nothing is overwritten either way.
        if (error instanceof SpecConflict)
          return {
            view: this.specView(request.id),
            conflicting: [...error.conflicting],
          } satisfies SpecSaveReply;
        throw error;
      }
      this.editing.recordSpec(request.id, written.slug);
      this.refreshNodePages(repo, request.id, written.path);
      return { view: this.specView(request.id), conflicting: [] } satisfies SpecSaveReply;
    }
    if (request.kind === "generatePlan" || request.kind === "startOver")
      return this.start(
        repo.id,
        request.kind === "startOver" ? request.key : null,
        "draft",
        request.kind === "startOver"
          ? "Draft this plan again from the spec"
          : "Draft a plan from the spec",
        async (job, signal) => {
          const session = this.editing.read(request.id);
          if (session.repoId !== repo.id)
            throw new Error("This planning belongs to another repository.");
          if (session.specSlug === null)
            throw new Error("Write the spec before generating a plan from it.");
          await this.invoke(
            job,
            repo,
            admitFromSpecArgs(
              `${specFolder(repo)}/${session.specSlug}/spec.md`,
              request.kind === "startOver" ? request.key : null,
              request.models?.draftingProvider ?? this.state.settings.draftingProvider,
              request.models?.executorModel ?? this.state.settings.executorModel,
            ),
            signal,
          );
          this.recordAdmitted(job, repo, request.models);
        },
        owner,
      );
    if (request.kind === "draft" || request.kind === "admit")
      return this.start(
        repo.id,
        null,
        request.kind,
        request.kind === "draft"
          ? "Draft a task contract"
          : "Save task contract",
        async (job, signal) => {
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
          await this.invoke(job, repo, args, signal);
          this.recordAdmitted(job, repo, request.models);
        },
        owner,
      );
    if (request.kind === "edit")
      return this.start(
        repo.id,
        request.key,
        request.kind,
        "Update task contract",
        async (job, signal) => {
          this.assertDigest(repo, request.key, request.digest);
          assertEditable(this.readContract(repo, request.key).contract);
          await this.invoke(job, repo, editArgs(request.key, request.draft), signal);
          job.resultKey = request.key;
          if (request.models) {
            this.state.taskModels[repo.id + ":" + request.key] = request.models;
            this.preferencesChanged();
          }
        },
        owner,
      );
    if (request.kind === "sync")
      return this.start(
        repo.id,
        request.key,
        request.kind,
        "Refresh delivery from GitHub",
        async (job, signal) => {
          await this.invoke(job, repo, syncArgs(request.key), signal);
        },
      );
    if (request.kind === "principle")
      return this.start(
        repo.id,
        request.key,
        request.kind,
        "Record a product decision",
        async (job, signal) => {
          await this.invoke(job, repo, principleArgs(request.answer), signal);
        },
      );
    if (request.kind === "verdict")
      return this.start(
        repo.id,
        request.key,
        request.kind,
        "Record finding feedback",
        async (job, signal) => {
          await this.invoke(
            job,
            repo,
            verdictArgs(request, this.state.settings.name || "Local user"),
            signal,
          );
        },
      );
    if (request.kind === "run" || request.kind === "decide")
      return this.start(
        repo.id,
        request.key,
        request.kind,
        "Run engineering loop",
        async (job, signal) => {
          this.assertDigest(repo, request.key, request.digest);
          const resumeFrom = request.kind === "run" ? request.resumeFrom : null;
          if (resumeFrom)
            assertResumable(await this.detail(repo.id, request.key), resumeFrom);
          if (request.kind === "decide") {
            await this.invoke(job, repo, principleArgs(request.answer), signal);
            if (signal.aborted) return;
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
            await this.invoke(job, repo, approveArgs(request.key), signal);
          if (signal.aborted) return;
          await this.invoke(job, repo, runArgs(request.key, path, resumeFrom), signal);
        },
      );
    const unreachable: never = request;
    throw new Error(`Unsupported request ${String(unreachable)}`);
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
      this.preferencesChanged();
    }
  }
  /** What a module reading a ticket's records is given, so it never reads the store twice over. */
  private ticketRecords(): TicketRecords {
    return {
      list: (repo) => this.list(repo),
      contract: (repo, key) => this.readContract(repo, key),
    };
  }
  private async taskSummary(repoId: string, key: string): Promise<TaskSummary> {
    return this.reads.read(
      "summary:" + repoId + ":" + key,
      repoId,
      async () => {
        const repo = this.repository(repoId);
        const ticket = (await this.list(repo)).tickets.find(
          (entry) => entry.key === key,
        );
        if (!ticket)
          throw new Error(
            "This task is no longer in the repository's ticket store.",
          );
        const record = readAttempts(
          attemptsPath(repo, ticket.ticket_id),
        );
        const bundles = record.attempts.length
          ? await this.reads.read("bundles:" + repoId, repoId, async () =>
              listBundles(bundlesPath(repo)),
            )
          : [];
        return summariseTicket({
          ticket,
          attempts: record.attempts,
          attemptsError: record.error,
          bundles,
          objectsDirectory: objectsPath(repo),
        });
      },
    );
  }
  /** The month's ledger from retained attempts, and each provider's own account of its plan (S6E). */
  private async usage(): Promise<UsageReport> {
    const records: { ticket: Ticket; attempts: StoredAttempt[] }[] = [];
    const notes: string[] = [];
    for (const repo of this.state.repositories) {
      try {
        this.repository(repo.id);
        for (const ticket of (await this.list(repo)).tickets) {
          const record = readAttempts(
            attemptsPath(repo, ticket.ticket_id),
          );
          if (record.error)
            notes.push(`${repo.name} · ${ticket.key}: ${record.error}`);
          records.push({ ticket, attempts: record.attempts });
        }
      } catch (error) {
        notes.push(`${repo.name}: ${redact(String(error))}`);
      }
    }
    const settings = this.state.settings;
    const roleOf = (
      id: "claude-cli" | "codex-cli" | "anthropic",
    ): string | null =>
      [
        settings.executorProvider === id && "default executor",
        settings.reviewerProvider === id && "default reviewer",
      ]
        .filter(Boolean)
        .join(" · ") || null;
    const providers = await this.providers();
    const signedIn = (id: Provider["id"]): boolean =>
      providers.find((provider) => provider.id === id)?.authenticated ?? false;
    const codex = signedIn("codex")
      ? await (this.options.usageProbe ?? codexUsage)()
      : {
          plan: null,
          windows: null,
          detail: "Codex is not signed in on this machine.",
        };
    return {
      readAt: new Date().toISOString(),
      ledger: ledgerFor(records, currentMonth()),
      providers: [
        {
          id: "claude",
          name: "Claude Code",
          role: roleOf("claude-cli"),
          plan: null,
          windows: null,
          detail: signedIn("claude")
            ? "Claude Code reports a limit only when a run meets one; there is no window to read without spending a turn."
            : "Claude Code is not signed in on this machine.",
        },
        { id: "codex", name: "Codex", role: roleOf("codex-cli"), ...codex },
        {
          id: "anthropic",
          name: "Anthropic API",
          role: roleOf("anthropic"),
          plan: null,
          windows: null,
          detail: signedIn("anthropic")
            ? "Metered API usage; the API reports no plan window."
            : "No API key in the app environment.",
        },
      ],
      notes,
    };
  }
  private power: PowerState = { holding: false, detail: null, since: null };
  /** AFK mode (S6F): the machine is held awake only while a run or decision is live, and only as the settings allow. */
  updatePower(): void {
    const afk = this.state.settings.afk;
    const running = this.liveJobs().find(
      (job) => ["run", "decide"].includes(job.kind) && isLive(job),
    );
    const onBattery = this.options.io.onBattery?.() ?? false;
    const hold = Boolean(
      afk.holdSleep && running && !(afk.releaseOnBattery && onBattery),
    );
    const detail = hold
      ? `Holding sleep now — ${running?.key ?? "a run"} is running.`
      : running && afk.holdSleep
        ? "Released on battery power."
        : null;
    if (hold === this.power.holding && detail === this.power.detail) return;
    this.power = {
      holding: hold,
      detail,
      since: hold
        ? this.power.holding
          ? this.power.since
          : new Date().toISOString()
        : null,
    };
    this.options.io.holdSleep?.(hold, afk.displaySleep);
    this.options.changed({
      kind: "power",
      power: this.power,
      sequence: ++this.sequence,
    });
  }
  /** Called by the host when the machine moves between mains and battery. */
  powerChanged(): void {
    this.updatePower();
  }
  private readonly stages = new Map<string, string>();
  private notify(title: string, body: string): void {
    this.options.io.notify(title, body, {
      silent: !this.state.settings.notifySound,
    });
  }
  private notifyStage(job: Job): void {
    if (
      !this.state.settings.notifyOn.stage ||
      !["run", "decide"].includes(job.kind)
    )
      return;
    const observed = runnerProgress(job.log);
    if (!observed || this.stages.get(job.id) === observed.title) return;
    this.stages.set(job.id, observed.title);
    this.notify(
      `${job.key ?? "Task"} · ${observed.title}`,
      "The loop moved to a new stage.",
    );
  }
  /** The four moments a person asked to be interrupted for, read from the recorded outcome rather than the process exit. */
  private async notifyOutcome(job: Job): Promise<void> {
    this.stages.delete(job.id);
    const on = this.state.settings.notifyOn;
    if (!["run", "decide"].includes(job.kind) || !job.key) return;
    const repo = this.state.repositories.find(
      (entry) => entry.id === job.repoId,
    );
    if (!repo) return;
    let ticket: Ticket | undefined;
    try {
      ticket = (await this.list(repo)).tickets.find(
        (entry) => entry.key === job.key,
      );
    } catch {
      return;
    }
    if (!ticket) return;
    const reason = readAttempts(
      attemptsPath(repo, ticket.ticket_id),
    ).attempts.at(-1)?.termination?.reason;
    if (on.ceiling && isEarlyStop(reason))
      this.notify(
        reason === "stalled"
          ? `${ticket.key} stopped: the agent went quiet`
          : `${ticket.key} stopped at a ceiling`,
        reason === "stalled"
          ? "No tool activity for the stall window, so the loop stopped it. Nothing was lost — " +
              "open the task to see what it had done and recover."
          : "The loop stopped and nothing was lost. Open the task to raise the ceiling or recover.",
      );
    else if (on.decision && ticket.state === "changes_requested")
      this.notify(
        `${ticket.key} needs a decision`,
        "The loop is paused until you answer.",
      );
    else if (
      on.review &&
      job.state === "completed" &&
      ["pr_open", "ready", "merged"].includes(ticket.state)
    )
      this.notify(
        `${ticket.key} · review finished`,
        ticket.delivery.pull_request_url
          ? "The pull request is open. The merge is yours."
          : "The result is ready to review.",
      );
    else if (on.review && job.state === "failed")
      this.notify(
        `${ticket.key} · the loop stopped`,
        job.error ?? "Open the task to inspect the cause.",
      );
  }
  async shutdown(): Promise<void> {
    for (const live of this.interviews.values()) live.child.stop();
    this.interviews.clear();
    const running = [...this.active.values()];
    for (const entry of running) entry.controller.abort();
    await Promise.all(running.map((entry) => entry.done));
  }
}
