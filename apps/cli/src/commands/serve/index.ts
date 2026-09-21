import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_MERGE_MODE,
  EXIT_CODES,
  LimitExceededError,
  MergeModeSchema,
  TicketKeySchema,
  TicketStateSchema,
  WaitSchema,
  assertWithinLimits,
  limitFor,
  transition,
  withReconciliation,
  withWaits,
  type LimitsTable,
  type MergeMode,
  type Ticket,
  type TicketState,
  type Wait,
} from "@perbo/contracts";
import { MODEL_PROVIDERS } from "@perbo/model";
import { RunRefusedError, ServeLockedError, acquireServeLock, liveRunLocks } from "@perbo/runner";
import {
  QUEUE_HOLDING_STATES,
  queueOrder,
  waitsFor,
  type Scheduled,
} from "../../scheduling.js";
import { startEndpoint, type RunningEndpoint } from "../../endpoint/index.js";
import { CommandFailedError, gh, git } from "@perbo/workspace";
import { admitDraft, defaultAdmission, type DraftProvider } from "../admit.js";
import { UsageError } from "../../usage-error.js";
import {
  parseArgv,
  switchFlag,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../../command-line/grammar.js";
import { effectiveLimits, readRepoConfig, requireBase, resolveBase } from "../run/index.js";
import type { Streams } from "../../streams.js";
import type { NarratedCommand } from "../../command-line/table.js";
import { narratedStreams } from "../../streams.js";
import type { CommandContext } from "../../command.js";
import { derivedBranch, isStranded, sync } from "../sync.js";
import { listTickets, readContract, readTicket, storeDir, writeTicket } from "../../store/tickets.js";
import { describeWaits } from "./waits.js";

/**
 * `perbo serve` — the queue over one store (SCP-008 criterion 5, SCP-227).
 *
 * One process that outlives a run, and does five things on a tick, in this
 * order:
 *
 * 1. **Fetches the base ref**, and nothing else. The runner still fetches
 *    nothing; a merge somebody made in the browser is noticed here, by the
 *    one process that is allowed to ask.
 * 2. **Reads every open pull request** through `perbo sync`, and — under
 *    `merge: "loop"` and only then — asks the first one in queue order to
 *    merge, under every one of D-077's conditions. A ticket a killed run left
 *    mid-state, with no live run inside it, is reconciled the same way.
 * 3. **Decides who waits.** For every ticket that is ready or blocked, in queue
 *    order: the `depends_on` keys a person wrote, and the scope of every ticket
 *    ahead of it that still holds a place — by its globs until it has sealed,
 *    by the paths it changed afterwards. A wait moves the ticket to `blocked`
 *    with the reason on its record; the end of one moves it back. Set
 *    arithmetic over approved records, no model anywhere (ADR-0011).
 * 4. **Starts runs**, as child `perbo run --ticket` processes, up to
 *    `concurrent_local_attempts` minus whatever is already running — including
 *    a run a person started by hand. The run is the unit every measurement is
 *    taken on and it stays that; this only decides when it starts.
 * 5. **Drafts one labelled tracker issue** into `plan_review`, where the
 *    repository names a tracker: the one model call a tick makes, through the
 *    same `admit --from` a person types. The store says what was drafted;
 *    nothing is written to the issue, and nothing is approved.
 *
 * Pipelining is the throughput: the next ticket starts when the previous one's
 * process ends at `pr_open`, not when it merges. Nothing here merges under the
 * default `merge: "person"`, and nothing here approves anything.
 */

export interface ServeArgs {
  repo: string;
  store: string | null;
  /** Typed once, for every run this queue starts: the flag that reaches an external repository. */
  publish: boolean;
  /** One tick, then wait for the runs it started, then exit. */
  once: boolean;
  intervalMs: number;
  /** One JSON document per tick on stdout, and nothing else there. */
  json: boolean;
  /** Host no tool endpoint. The queue runs the same; sessions have nothing to read. */
  noEndpoint: boolean;
}

const DEFAULT_INTERVAL_MS = 60_000;

/** `1500`, `5s`, `2m`, `1h`: milliseconds, or a count with one unit letter. */
function parseInterval(raw: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (match === null) throw new UsageError(`--interval takes milliseconds or a count with s, m or h (got '${raw}')`);
  const count = Number(match[1]);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? "ms"]!;
  const ms = count * unit;
  if (ms <= 0) throw new UsageError("--interval must be positive");
  return ms;
}

const SERVE_FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--publish": switchFlag(),
  "--once": switchFlag(),
  "--interval": valueFlag(),
  "--json": switchFlag(),
  "--no-endpoint": switchFlag(),
} satisfies FlagTable;

const SERVE_GRAMMAR: Grammar<typeof SERVE_FLAGS> = {
  command: "serve",
  flags: SERVE_FLAGS,
  positionals: {
    min: 0,
    max: 0,
    refusal:
      "serve takes no ticket key: it runs the queue over the whole store, " +
      "e.g. perbo serve --once --json",
  },
  afterDoubleDash: "positionals",
};

export function parseServeArgs(argv: readonly string[]): ServeArgs {
  const line = parseArgv(SERVE_GRAMMAR, argv);
  const interval = line.flags["--interval"];
  return {
    repo: line.flags["--repo"] ?? ".",
    store: line.flags["--store"] ?? null,
    // Publication authority is a person's own flag, typed here and carried on
    // every run this queue starts (D-079). Nothing else on the line can set
    // it: a value is a value, whatever it is shaped like.
    publish: line.flags["--publish"] === true,
    once: line.flags["--once"] === true,
    intervalMs: interval === undefined ? DEFAULT_INTERVAL_MS : parseInterval(interval),
    json: line.flags["--json"] === true,
    noEndpoint: line.flags["--no-endpoint"] === true,
  };
}

/**
 * Every process the queue would start, as functions, so a test can hand in
 * fakes that record what they were asked and the queue's decisions can be read
 * without a coding agent, a network or a `gh` login behind them.
 */
export interface ServeDeps {
  /** Start `perbo run` with `argv` as a child, and resolve when it exits. Each line says which stream it came from. */
  spawnRun: (input: {
    key: string;
    argv: string[];
    cwd: string;
    onLine: (line: string, stream?: "stdout" | "stderr") => void;
  }) => Promise<{ code: number | null }>;
  /** `git fetch origin <base_ref>` in the checkout. */
  fetchBase: (input: { repository_root: string; base_ref: string }) => Promise<{ ok: boolean; detail: string }>;
  /** `perbo sync <key> [--merge]`, in this process. Returns sync's own exit code. */
  sync: (input: { key: string; merge: boolean; onLine: (line: string) => void }) => Promise<number>;
  /** The paths a sealed branch changed against the base, or null where git cannot say. */
  sealedPaths: (input: {
    repository_root: string;
    base_ref: string;
    branch: string;
  }) => Promise<readonly string[] | null>;
  /** The runs alive under the state root right now, whoever started them. */
  liveRuns: (state_root: string) => ReadonlyArray<{ ticket_key: string }>;
  /**
   * The base's tip, and whether a branch is behind it: `git merge-base
   * --is-ancestor <tip> <branch>` in the checkout. Null where either ref
   * cannot be read.
   */
  baseState: (input: {
    repository_root: string;
    base_ref: string;
    branch: string;
  }) => Promise<{ tip: string; behind: boolean } | null>;
  /** The open issues carrying the label, through `gh`, or why they could not be read. */
  listIssues: (input: {
    repository: string;
    label: string;
  }) => Promise<{ ok: true; issues: ReadonlyArray<{ number: number; title: string }> } | { ok: false; detail: string }>;
  /** `perbo admit --from <reference> --json`, in this process: admit's exit code and the key it wrote, if it wrote one. */
  draft: (input: {
    reference: string;
    provider: DraftProvider | null;
    model: string | null;
    onLine: (line: string) => void;
  }) => Promise<{ code: number; key: string | null }>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

const GIT_TIMEOUT_MS = 120_000;

/** The deps as the program runs them, pointed at one store. */
export function processDeps(target: { repo: string; store: string | null; cwd: string }): ServeDeps {
  return {
  spawnRun({ argv, cwd, onLine }) {
    return new Promise((resolveExit) => {
      // The same entry point this process was started from, so the child is
      // the same build — bundled or not — with the same `run` command.
      const child = spawn(process.execPath, [process.argv[1]!, ...argv], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const buffers = { stdout: "", stderr: "" } as Record<"stdout" | "stderr", string>;
      const feed = (stream: "stdout" | "stderr", chunk: Buffer) => {
        buffers[stream] += chunk.toString("utf8");
        const lines = buffers[stream].split("\n");
        buffers[stream] = lines.pop() ?? "";
        for (const line of lines) if (line.trim().length > 0) onLine(line, stream);
      };
      child.stdout?.on("data", (chunk: Buffer) => feed("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => feed("stderr", chunk));
      child.on("error", (error) => {
        onLine(`could not start: ${error.message}`);
        resolveExit({ code: null });
      });
      child.on("close", (code) => {
        for (const stream of ["stdout", "stderr"] as const) {
          if (buffers[stream].trim().length > 0) onLine(buffers[stream], stream);
        }
        resolveExit({ code });
      });
    });
  },

  async fetchBase({ repository_root, base_ref }) {
    const result = await git.run(repository_root, ["fetch", "--quiet", "origin", base_ref], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return result.code === 0
      ? { ok: true, detail: `fetched ${base_ref}` }
      : { ok: false, detail: (result.stderr || result.stdout).trim().split("\n").slice(0, 2).join("; ").slice(0, 300) };
  },

  async sync({ key, merge, onLine }) {
    // Built as values, as the draft below is: a key the queue read out of the
    // store is an argument, and there is no line here for it to become part of.
    const lines = lineStreams(onLine);
    return sync(
      { mode: "ticket", target: { repo: target.repo, store: target.store }, key, merge },
      {
        cwd: target.cwd,
        now: new Date(),
        diagnostics: lines,
        stdout: lines.stdout,
        isTTY: lines.isTTY,
      },
    );
  },

  async sealedPaths({ repository_root, base_ref, branch }) {
    const call = { timeoutMs: GIT_TIMEOUT_MS };
    try {
      const base = await git.mergeBase(repository_root, base_ref, branch, call);
      if (base === null) return null;
      return await git.changedPaths(repository_root, base, branch, call);
    } catch (error) {
      // A read that did not finish, and one whose answer was too large to hold
      // whole: a list short by the paths that were cut is shaped exactly like
      // the whole of one, and the queue would read it as two tickets sharing
      // nothing while they share a file.
      if (!(error instanceof CommandFailedError)) throw error;
      return null;
    }
  },

  liveRuns(state_root) {
    return liveRunLocks(state_root);
  },

  async baseState({ repository_root, base_ref, branch }) {
    const call = { timeoutMs: GIT_TIMEOUT_MS };
    try {
      const tip = await git.resolveCommit(repository_root, base_ref, call);
      if (tip === null) return null;
      // The branch as the pull request has it — the remote-tracking ref the
      // push moved — rather than the local branch, which a re-level judged
      // short of pushing leaves carrying a merge commit nobody can see.
      const remote = `refs/remotes/origin/${branch}`;
      const ref = (await git.resolveCommit(repository_root, remote, call)) === null ? branch : remote;
      if ((await git.resolveCommit(repository_root, ref, call)) === null) return null;
      return { tip, behind: !(await git.isAncestor(repository_root, tip, ref, call)) };
    } catch (error) {
      // A read that did not finish says nothing about where the branch stands.
      if (!(error instanceof CommandFailedError)) throw error;
      return null;
    }
  },

  async listIssues({ repository, label }) {
    const result = await gh.run(
      target.cwd,
      ["issue", "list", "--repo", repository, "--label", label, "--state", "open", "--limit", "100", "--json", "number,title"],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0]?.slice(0, 300) || "gh failed" };
    }
    // An answer larger than the read holds arrives as a list of issues shaped
    // exactly like the whole of one, short by the issues that were cut.
    if (result.truncated) {
      return { ok: false, detail: "gh said more than this read holds, and only the tail of it arrived" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      return { ok: false, detail: "gh did not return JSON" };
    }
    const parsed = z.array(z.object({ number: z.number().int().positive(), title: z.string() })).safeParse(raw);
    return parsed.success ? { ok: true, issues: parsed.data } : { ok: false, detail: "gh did not return a list of issues" };
  },

  async draft({ reference, provider, model, onLine }) {
    const lines = lineStreams(onLine);
    // Built as values, as the endpoint builds them: the reference is an
    // argument, never a line, and a draft has no approval to set (D-072).
    const defaults = defaultAdmission({ repo: target.repo, store: target.store });
    try {
      const report = await admitDraft(
        {
          ...defaults,
          from: reference,
          ...(provider === null ? {} : { provider }),
          model,
        },
        { cwd: target.cwd, now: new Date(), diagnostics: lines },
      );
      return { code: EXIT_CODES.approve, key: report.key };
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      onLine(`draft refused: ${error.message}`);
      return { code: EXIT_CODES.usage_or_input_error, key: null };
    }
  },

  sleep(ms, signal) {
    return new Promise((resolveSleep) => {
      if (signal.aborted) return resolveSleep();
      const timer = setTimeout(done, ms);
      function done() {
        signal.removeEventListener("abort", done);
        clearTimeout(timer);
        resolveSleep();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  },
  };
}

/** As long as a reason on a ticket's record may be: the queue's own bound on what it keeps of a child's words. */
const REASON_LIMIT = 300;

/**
 * What a run that completed said, from the record it writes to stdout when
 * that is a pipe (`run --json`'s document): its outcome and detail as one
 * line. Null where the stdout is not such a record.
 */
function runDocumentAnswer(stdout: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = z.object({ outcome: z.string().min(1), detail: z.string() }).safeParse(raw);
  return parsed.success ? `${parsed.data.outcome} — ${parsed.data.detail}` : null;
}

/** Tracker text on one line of this queue's stderr: line breaks and control characters become spaces, and it is cut short. */
const oneLine = (text: string): string =>
  Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 || code === 0x85 || code === 0x2028 || code === 0x2029 ? " " : char;
  })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 120);

/**
 * `.perbo/config.json`'s `tracker`: the repository whose open issues carrying
 * `draft_label` the queue drafts from, and the drafting provider and model
 * where the command's defaults are not wanted. Absent, the queue drafts nothing.
 */
export const TrackerConfigSchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/, "owner/repo"),
  draft_label: z.string().min(1),
  provider: z.enum(MODEL_PROVIDERS).optional(),
  model: z.string().min(1).optional(),
});
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

function repositoryTracker(repoConfig: Record<string, unknown> | null, configPath: string): TrackerConfig | null {
  const raw = repoConfig?.["tracker"];
  if (raw === undefined || raw === null) return null;
  const parsed = TrackerConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new UsageError(
    `${configPath} sets 'tracker' to something this cannot read (` +
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "tracker"}: ${issue.message}`).join("; ") +
      '). It takes { "repository": "owner/repo", "draft_label": "<label>" }, and optionally "provider" and "model"',
  );
}

/** Streams that hand every complete line to one callback. */
function lineStreams(onLine: (line: string) => void): Streams {
  let pending = "";
  const write = (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim().length > 0) onLine(line);
  };
  return { stdout: write, stderr: write, isTTY: false };
}

export const SERVE_TICK_SCHEMA_VERSION = 1;

/** What one tick decided, and the whole of what `--json` prints for it. */
export const ServeTickSchema = z.strictObject({
  schema_version: z.literal(SERVE_TICK_SCHEMA_VERSION),
  tick: z.number().int().positive(),
  at: z.iso.datetime(),
  store: z.string().min(1),
  base_ref: z.string().min(1),
  fetch: z.strictObject({ ok: z.boolean(), detail: z.string() }),
  /** Every pull request read this tick, and whether the read asked for the merge. */
  synced: z.array(z.strictObject({ key: TicketKeySchema, merge: z.boolean(), code: z.number().int() })),
  /** Every ticket holding a place, in queue order, with what it waits on. */
  queue: z.array(
    z.strictObject({ key: TicketKeySchema, state: TicketStateSchema, waits_on: z.array(WaitSchema) }),
  ),
  started: z.array(TicketKeySchema),
  /** The open branches whose re-level was started this tick, before any new start. */
  relevelled: z.array(TicketKeySchema),
  /** The tracker issue drafted this tick, with the key admit wrote for it (null where it wrote none) and admit's exit code. At most one. */
  drafted: z.array(z.strictObject({ reference: z.string().min(1), key: TicketKeySchema.nullable(), code: z.number().int() })),
  /** Runs alive after the starts, and the ceiling they are counted against. */
  running: z.number().int().min(0),
  capacity: z.number().int().min(0),
});
export type ServeTick = z.infer<typeof ServeTickSchema>;

interface Queue {
  dir: string;
  /** Where `serve` was run from, so a relative `--repo` means the same thing to every run it starts. */
  cwd: string;
  repository_root: string;
  state_root: string;
  base_ref: string;
  mode: MergeMode;
  limits: LimitsTable;
  capacity: number;
  args: ServeArgs;
  deps: ServeDeps;
  streams: Streams;
  clock: () => Date;
  /** Runs this queue started and has not seen exit, by key. */
  children: Map<string, Promise<{ code: number | null }>>;
  lastFetchDetail: string | null;
  /** Said once: a branch is behind and this queue may not push. */
  saidNotPublishing: boolean;
  tick: number;
  /** The endpoint's pause: nothing new starts, everything is still read. */
  paused: boolean;
  lastTick: ServeTick | null;
  /** Where labelled issues are drafted from, or null: this queue drafts nothing. */
  tracker: TrackerConfig | null;
  /** Every issue this process asked a model to draft, once each, whatever came of it. */
  draftAttempted: Set<string>;
  /** Said once: the issues could not be listed. */
  lastListDetail: string | null;
}

function repositoryMergeMode(repoConfig: Record<string, unknown> | null, configPath: string): MergeMode {
  const raw = repoConfig?.["merge"];
  if (raw === undefined) return DEFAULT_MERGE_MODE;
  const parsed = MergeModeSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new UsageError(`${configPath} sets 'merge' to ${JSON.stringify(raw)}; it must be "person" or "loop"`);
}

/** The scope a ticket's contract admits, or null where the store holds no contract for it. */
function scopeOf(dir: string, ticket: Ticket): Scheduled["scope"] {
  try {
    const contract = readContract(dir, ticket.key);
    return { paths_allowed: contract.scope.paths_allowed, generated_paths: contract.scope.generated_paths };
  } catch {
    return null;
  }
}

const holdsPlace = (state: TicketState): boolean =>
  (QUEUE_HOLDING_STATES as readonly TicketState[]).includes(state);

/**
 * Why a blocked ticket is ready again, from what it was last waiting on: the
 * dependency that merged, or the ticket ahead that no longer holds its place.
 */
function releasedNote(previous: readonly Wait[], byKey: Map<string, Ticket>): string {
  if (previous.length === 0) return "no longer waits on anything";
  return previous
    .map((wait) => {
      const now = byKey.get(wait.key);
      return now === undefined ? `${wait.key} is not in this store` : `${wait.key} ${now.state}`;
    })
    .join(", ");
}

async function runTick(queue: Queue): Promise<ServeTick> {
  const { deps, streams, args, dir } = queue;
  queue.tick += 1;
  const at = queue.clock();
  const say = (line: string) => streams.stderr(`${line}\n`);
  const child = (key: string) => (line: string) => streams.stderr(`  [${key}] ${line}\n`);

  // 1. The base, from the one process allowed to fetch it.
  const fetch = await deps.fetchBase({ repository_root: queue.repository_root, base_ref: queue.base_ref });
  if (!fetch.ok && fetch.detail !== queue.lastFetchDetail) {
    say(`fetch of ${queue.base_ref} failed: ${fetch.detail} — reading the local ref until it succeeds`);
  }
  queue.lastFetchDetail = fetch.ok ? null : fetch.detail;

  // 2. Every open pull request, and every ticket a dead run left mid-state.
  const live = new Set<string>([
    ...deps.liveRuns(queue.state_root).map((lock) => lock.ticket_key),
    ...queue.children.keys(),
  ]);
  // Under `loop`, each open pull request is asked to merge in queue order
  // until one does; the ones behind a merge that landed are left for the next
  // tick, because the base has just moved under them. A merge that stopped on
  // one of D-077's conditions holds nobody else back — the queue would
  // otherwise starve behind the one pull request waiting on its review.
  const synced: ServeTick["synced"] = [];
  let merging = queue.mode === "loop";
  for (const ticket of queueOrder(listTickets(dir))) {
    const open = ticket.state === "pr_open";
    const stranded = isStranded(ticket.state) && !live.has(ticket.key);
    if (!open && !stranded) continue;
    // A paused queue asks nobody to merge: the pause is "start nothing new",
    // and a merge landing moves the base under every open branch.
    const merge = open && merging && !queue.paused;
    let code: number;
    try {
      code = await deps.sync({ key: ticket.key, merge, onLine: child(ticket.key) });
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      child(ticket.key)(`sync refused: ${error.message}`);
      code = EXIT_CODES.usage_or_input_error;
    }
    if (merge && code === EXIT_CODES.approve) merging = false;
    synced.push({ key: ticket.key, merge, code });
  }

  // 3. Who waits, decided against the store as the syncs left it — and against
  // the runs alive now, not at the start of the tick: a run a person started
  // during the syncs above holds its ticket from this moment.
  for (const lock of deps.liveRuns(queue.state_root)) live.add(lock.ticket_key);
  const tickets = queueOrder(listTickets(dir));
  const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  const scheduled: Scheduled[] = tickets.map((ticket) => ({ ticket, scope: scopeOf(dir, ticket) }));
  const sealed = new Map<string, readonly string[] | null>();
  for (const entry of scheduled) {
    if (entry.ticket.state !== "pr_open") continue;
    // The branch the ticket's records name, or the one the runner would derive
    // for it from its key, its id and the approved outcome.
    let branch: string;
    try {
      branch = entry.ticket.delivery.branch ?? derivedBranch(dir, entry.ticket.key, entry.ticket);
    } catch {
      continue;
    }
    sealed.set(
      entry.ticket.key,
      await deps.sealedPaths({ repository_root: queue.repository_root, base_ref: queue.base_ref, branch }),
    );
  }
  const sealedPathsOf = (holder: Scheduled) => sealed.get(holder.ticket.key) ?? null;

  const queued: ServeTick["queue"] = [];
  const ready: Ticket[] = [];
  for (const entry of scheduled) {
    const { ticket } = entry;
    if (!holdsPlace(ticket.state)) continue;
    // A ticket a run is inside is that run's to write: it moves the ticket
    // itself, and a record written here between its read and its write
    // would erase the state it just recorded.
    if ((ticket.state !== "ready" && ticket.state !== "blocked") || live.has(ticket.key)) {
      queued.push({ key: ticket.key, state: ticket.state, waits_on: ticket.scheduling.waits_on });
      continue;
    }
    const waits = waitsFor(entry, scheduled, sealedPathsOf);
    const unchanged = JSON.stringify(waits) === JSON.stringify(ticket.scheduling.waits_on);
    let decided = unchanged ? ticket : withWaits(ticket, waits, at);
    if (waits.length > 0 && ticket.state === "ready") {
      decided = transition(decided, "blocked", describeWaits(waits), at);
      say(`${ticket.key} blocked: ${describeWaits(waits)}`);
    } else if (waits.length === 0 && ticket.state === "blocked") {
      decided = transition(decided, "ready", releasedNote(ticket.scheduling.waits_on, byKey), at);
      say(`${ticket.key} ready: ${releasedNote(ticket.scheduling.waits_on, byKey)}`);
    }
    // Written only where the reading changed, so a queue idling over a store
    // does not touch a file a minute for every ticket in it — and only over
    // the record as it was read: a run that moved the ticket in the meantime
    // owns it, and the queue's reading is stale by definition.
    if (decided !== ticket) {
      const current = readTicket(dir, ticket.key);
      if (current.state !== ticket.state || current.updated_at !== ticket.updated_at) {
        say(`${ticket.key} moved to ${current.state} while the queue was deciding; leaving it to the run`);
        decided = current;
      } else {
        writeTicket(dir, decided);
      }
    }
    byKey.set(ticket.key, decided);
    queued.push({ key: decided.key, state: decided.state, waits_on: decided.scheduling.waits_on });
    if (decided.state === "ready") ready.push(decided);
  }

  // The runs alive now, once more: the sealed-path reads above are git
  // calls that take seconds, and a run a person started during them holds
  // its ticket — starting it again here would race that run for the record.
  for (const lock of deps.liveRuns(queue.state_root)) live.add(lock.ticket_key);
  let running = live.size;
  /** The one call that gates every start here, in the limits table's own words. */
  const room = (key: string): boolean => {
    try {
      assertWithinLimits(queue.limits, "concurrent_local_attempts", running + 1);
      return true;
    } catch (error) {
      if (!(error instanceof LimitExceededError)) throw error;
      if (error.reason !== "limit_exceeded") say(`not starting ${key}: ${error.message}`);
      return false;
    }
  };

  // 3b. Every open branch behind the base is re-levelled, before anything new
  // starts: the pull requests waiting to merge are the queue's head, and one
  // that has fallen behind cannot merge. A re-level that did not level the
  // branch is not tried again at the same base tip — the round that came back
  // to the same conflict has answered — and only a queue allowed to push
  // re-levels at all.
  const relevelled: string[] = [];
  for (const entry of scheduled) {
    if (queue.paused) break;
    const { ticket } = entry;
    if (ticket.state !== "pr_open" || live.has(ticket.key)) continue;
    // Only the loop's own pull requests: a direct arm's or a person's hand-off
    // is not the loop's to re-level, and a re-level recorded on it would read
    // as the loop's work in the measurement.
    if (ticket.delivery.arm !== "loop" || ticket.delivery.opened_by === "hand_off") continue;
    let branch: string;
    try {
      branch = ticket.delivery.branch ?? derivedBranch(dir, ticket.key, ticket);
    } catch {
      continue;
    }
    const base = await deps.baseState({ repository_root: queue.repository_root, base_ref: queue.base_ref, branch });
    if (base === null) continue;
    if (!base.behind) {
      if (ticket.scheduling.reconciliation !== null) {
        writeTicket(dir, withReconciliation(readTicket(dir, ticket.key), null));
      }
      continue;
    }
    if (!args.publish) {
      if (!queue.saidNotPublishing) {
        say(`${ticket.key} is behind ${queue.base_ref}; start serve with --publish to re-level open branches`);
        queue.saidNotPublishing = true;
      }
      continue;
    }
    if (ticket.scheduling.reconciliation?.base_tip === base.tip) continue;
    if (!room(ticket.key)) break;
    const tip = base.tip;
    const argv = [
      "run",
      "--ticket",
      ticket.key,
      "--relevel",
      "--repo",
      args.repo,
      ...(args.store ? ["--store", args.store] : []),
      "--publish",
    ];
    // What the re-level answered is kept with its exit code, so `list` says
    // why and not only that: a refusal's `error:` line, or the outcome and
    // detail of the record a run that completed writes to its stdout — never
    // merely the last line, which is a diagnostic hint or the record's
    // closing brace.
    let errorLine: string | null = null;
    let lastLine: string | null = null;
    const stdout: string[] = [];
    const relay = child(ticket.key);
    const exit = deps
      .spawnRun({
        key: ticket.key,
        argv,
        cwd: queue.cwd,
        onLine: (line, stream) => {
          lastLine = line;
          if (stream === "stdout") stdout.push(line);
          if (line.startsWith("error: ")) errorLine = line.slice("error: ".length);
          relay(line);
        },
      })
      .then((result) => {
        queue.children.delete(ticket.key);
        const said: string | null = errorLine ?? runDocumentAnswer(stdout.join("\n")) ?? lastLine;
        const record =
          result.code === 0
            ? null
            : {
                base_tip: tip,
                exit_code: result.code ?? -1,
                at: queue.clock().toISOString(),
                reason: said === null ? null : said.slice(0, REASON_LIMIT),
              };
        try {
          const after = readTicket(dir, ticket.key);
          if (JSON.stringify(after.scheduling.reconciliation) !== JSON.stringify(record)) {
            writeTicket(dir, withReconciliation(after, record));
          }
          say(
            `${ticket.key} re-level exited ${result.code ?? "on a signal"}; ${ticket.key} is ${after.state}` +
              (record === null
                ? ""
                : `, and the queue tries again once ${queue.base_ref} moves past ${tip.slice(0, 12)}`),
          );
        } catch (error) {
          say(`${ticket.key} re-level exited ${result.code ?? "on a signal"}; its record could not be read: ${error instanceof Error ? error.message : String(error)}`);
        }
        return result;
      });
    queue.children.set(ticket.key, exit);
    live.add(ticket.key);
    running += 1;
    relevelled.push(ticket.key);
    say(`re-levelling ${ticket.key}: perbo ${argv.join(" ")}`);
  }

  // 4. Starts, up to the ceiling, counting every run alive whoever started it.
  const started: string[] = [];
  for (const ticket of ready) {
    if (queue.paused) break;
    if (live.has(ticket.key)) continue;
    if (!room(ticket.key)) break;
    const argv = [
      "run",
      "--ticket",
      ticket.key,
      "--repo",
      args.repo,
      ...(args.store ? ["--store", args.store] : []),
      ...(args.publish ? ["--publish"] : []),
    ];
    const exit = deps
      .spawnRun({ key: ticket.key, argv, cwd: queue.cwd, onLine: child(ticket.key) })
      .then((result) => {
        queue.children.delete(ticket.key);
        let state: string = "unknown";
        try {
          state = readTicket(dir, ticket.key).state;
        } catch {
          // The record is what it is; the exit line still says the run ended.
        }
        say(`${ticket.key} run exited ${result.code ?? "on a signal"}; ${ticket.key} is now ${state}`);
        return result;
      });
    queue.children.set(ticket.key, exit);
    live.add(ticket.key);
    running += 1;
    started.push(ticket.key);
    say(`started ${ticket.key}: perbo ${argv.join(" ")}`);
  }

  // 5. One labelled tracker issue, drafted into plan_review: the one call a
  // tick makes to a model, and the only thing here that costs. An issue the
  // store already holds a ticket from is not drafted again, and one this
  // process has tried is not tried again while it runs — the store, not this
  // process's memory, is the record of what was drafted, and a draft that
  // failed is for a person to look at rather than for the queue to pay for
  // every tick. Nothing is written to the issue.
  const drafted: ServeTick["drafted"] = [];
  const tracker = queue.tracker;
  if (tracker !== null && !queue.paused) {
    const listed = await deps.listIssues({ repository: tracker.repository, label: tracker.draft_label });
    if (!listed.ok) {
      if (listed.detail !== queue.lastListDetail) {
        say(`could not list ${tracker.draft_label} issues in ${tracker.repository}: ${listed.detail}`);
      }
      queue.lastListDetail = listed.detail;
    } else {
      queue.lastListDetail = null;
      // Held by reference, case aside: GitHub reads `Owner/Repo#4` and
      // `owner/repo#4` as one issue, and so does this.
      const held = new Set<string>();
      for (const ticket of listTickets(dir)) {
        if (typeof ticket.source.reference === "string") held.add(ticket.source.reference.toLowerCase());
      }
      const next = [...listed.issues]
        .sort((a, b) => a.number - b.number)
        .map((issue) => ({ ...issue, reference: `${tracker.repository}#${issue.number}` }))
        .find((issue) => !held.has(issue.reference.toLowerCase()) && !queue.draftAttempted.has(issue.reference));
      if (next !== undefined) {
        queue.draftAttempted.add(next.reference);
        // One line, whatever the title holds: a title is tracker text, and a
        // newline in it would forge a line of this queue's own.
        say(`drafting ${next.reference}: ${oneLine(next.title)}`);
        const result = await deps.draft({
          reference: next.reference,
          provider: tracker.provider ?? null,
          model: tracker.model ?? null,
          onLine: child(next.reference),
        });
        drafted.push({ reference: next.reference, key: result.key, code: result.code });
        say(
          result.code === 0 && result.key !== null
            ? `drafted ${next.reference} as ${result.key}; nothing runs until it is approved`
            : `draft of ${next.reference} exited ${result.code}; not tried again while this queue runs`,
        );
      }
    }
  }

  queue.lastTick = ServeTickSchema.parse({
    schema_version: SERVE_TICK_SCHEMA_VERSION,
    tick: queue.tick,
    at: at.toISOString(),
    store: dir,
    base_ref: queue.base_ref,
    fetch,
    synced,
    queue: queued,
    started,
    relevelled,
    drafted,
    running,
    capacity: queue.capacity,
  });
  return queue.lastTick;
}

function summarise(tick: ServeTick): string {
  const waiting = tick.queue.filter((entry) => entry.state === "blocked").length;
  const readyCount = tick.queue.filter((entry) => entry.state === "ready").length;
  return (
    `tick ${tick.tick}: ${tick.fetch.ok ? `fetched ${tick.base_ref}` : `fetch failed`}; ` +
    `${tick.synced.length} synced${tick.synced.some((entry) => entry.merge) ? " (one asked to merge)" : ""}; ` +
    `${tick.relevelled.length} re-levelled; ${tick.started.length} started; ${tick.drafted.length} drafted; ` +
    `${tick.running}/${tick.capacity} running; `+
    `${readyCount} ready; ${waiting} blocked`
  );
}

/** What a test replaces in a queue: its processes, its clock, and how it is stopped. */
export interface ServeCommandDeps {
  /** Every process the queue would start. The real ones unless a caller names its own. */
  processes: ServeDeps;
  /** What time it is, asked once a tick. A live clock unless a caller names its own. */
  clock: () => Date;
  /** Stops the loop between ticks. The program wires SIGINT and SIGTERM to it. */
  signal: AbortSignal;
  /** Start paused, as the endpoint's `queue_pause` leaves a queue. */
  paused: boolean;
}

/** What a queue is given: where it runs, what it says as it goes, and its processes. */
export type ServeContext = CommandContext & {
  stdout(chunk: string): void;
  isTTY: boolean;
} & Partial<ServeCommandDeps>;

/**
 * `perbo serve`, over typed input.
 *
 * It answers while it works — one line a decision, or one JSON document a tick
 * under `--json` — and runs until it is stopped, so there is no record to hand
 * back.
 */
export async function serve(args: ServeArgs, context: ServeContext): Promise<number> {
  const streams = narratedStreams(context);
  const repository_root = resolve(context.cwd, args.repo);
  const dir = storeDir(repository_root, args.store);
  const configPath = join(dir, "config.json");
  const repoConfig = readRepoConfig(dir);

  let base: ReturnType<typeof requireBase>;
  let mode: MergeMode;
  let limits: LimitsTable;
  let tracker: TrackerConfig | null;
  try {
    base = requireBase(resolveBase(repository_root, repoConfig?.["base_ref"], { publish: args.publish }), {
      repository_root,
      configPath,
    });
    mode = repositoryMergeMode(repoConfig, configPath);
    limits = effectiveLimits(repoConfig, configPath);
    tracker = repositoryTracker(repoConfig, configPath);
  } catch (error) {
    if (error instanceof UsageError) {
      streams.stderr(`error: ${error.message}\n`);
      return EXIT_CODES.usage_or_input_error;
    }
    if (error instanceof RunRefusedError) {
      streams.stderr(`error: the queue did not start — ${error.message}\n`);
      for (const finding of error.findings) streams.stderr(`  ${finding.reason}: ${finding.detail}\n`);
      return EXIT_CODES.did_not_complete;
    }
    throw error;
  }

  const state_root = join(dir, "state");
  let lock;
  try {
    lock = acquireServeLock({ state_root, repository_root, now: context.now });
  } catch (error) {
    if (!(error instanceof ServeLockedError)) throw error;
    streams.stderr(`error: ${error.message}\n`);
    return EXIT_CODES.usage_or_input_error;
  }

  const deps =
    context.processes ?? processDeps({ repo: args.repo, store: args.store, cwd: context.cwd });

  const controller = new AbortController();
  const stop = () => controller.abort();
  const signal = context.signal ?? controller.signal;
  if (context.signal === undefined) {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }

  const capacity = limitFor(limits, "concurrent_local_attempts");
  const queue: Queue = {
    dir,
    cwd: context.cwd,
    repository_root,
    state_root,
    base_ref: base.base_ref,
    mode,
    limits,
    capacity,
    args,
    deps,
    streams,
    clock: context.clock ?? (() => new Date()),
    children: new Map(),
    lastFetchDetail: null,
    saidNotPublishing: false,
    tick: 0,
    paused: context.paused ?? false,
    lastTick: null,
    tracker,
    draftAttempted: new Set(),
    lastListDetail: null,
  };

  streams.stderr(
    `serving ${dir}: base ${base.base_ref} (${base.from}), merge ${mode}, ` +
      `up to ${capacity} run${capacity === 1 ? "" : "s"} at once` +
      (args.once ? ", one tick" : `, every ${Math.round(args.intervalMs / 1000)}s`) +
      (args.publish ? ", publishing" : "") +
      (tracker === null ? "" : `, drafting '${tracker.draft_label}' issues from ${tracker.repository}`) +
      "\n",
  );

  let endpoint: RunningEndpoint | null = null;
  try {
    // The tool endpoint, hosted for as long as the queue is: a session of the
    // person's reads the store and the queue through it, and can admit, edit
    // and sync — never approve, publish or merge (`endpoint/internal/tools.ts`).
    if (!args.noEndpoint) {
      endpoint = await startEndpoint({
        dir,
        cwd: context.cwd,
        repo: args.repo,
        store: args.store,
        queue: {
          state: () => ({ paused: queue.paused, tick: queue.lastTick }),
          pause: () => {
            queue.paused = true;
          },
          resume: () => {
            queue.paused = false;
          },
        },
        now: queue.clock,
      });
      streams.stderr(`endpoint ${endpoint.url} (\`perbo mcp\` prints the block a session pastes; \`perbo agent\` launches one)\n`);
    }


    for (;;) {
      const tick = await runTick(queue);
      if (args.json) streams.stdout(`${JSON.stringify(tick)}\n`);
      else streams.stderr(`${summarise(tick)}\n`);
      if (args.once || signal.aborted) break;
      await deps.sleep(args.intervalMs, signal);
      if (signal.aborted) break;
    }
    if (queue.children.size > 0) {
      streams.stderr(
        `waiting for ${queue.children.size} run${queue.children.size === 1 ? "" : "s"} to finish: ` +
          `${[...queue.children.keys()].join(", ")}\n`,
      );
      await Promise.all(queue.children.values());
    }
  } finally {
    if (context.signal === undefined) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    if (endpoint !== null) await endpoint.close();
    lock.release();
  }
  return EXIT_CODES.approve;
}

/** `perbo serve`, over its own line. */
export const serveCommandLine: NarratedCommand<
  ServeArgs,
  Record<string, never>,
  ServeCommandDeps
> = {
  kind: "narrated",
  name: "serve",
  grammars: [SERVE_GRAMMAR],
  grammarFor: () => SERVE_GRAMMAR,
  read: (argv) => ({ input: parseServeArgs(argv), output: {} }),
  run: (input, _output, context) => serve(input, context),
};
