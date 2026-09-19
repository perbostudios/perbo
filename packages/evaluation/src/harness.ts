import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ReviewArtifactSchema, type ReviewArtifact } from "@perbo/contracts";
import { captureExecutedBundle, type ExecutedBundle } from "./bundle.js";
import { loadCorpus, type LoadedFixture } from "./corpus.js";
import { scoreRun, type RunScore } from "./score.js";
import {
  ADMIT,
  formatUsd,
  NO_ARTIFACT,
  SpendLedger,
  type Admission,
  type SpendObservation,
} from "./spend.js";

const run = promisify(execFile);

/**
 * The harness's own kill deadline for a spawned review, unless a caller states
 * one with {@link HarnessOptions.reviewTimeoutMs}.
 *
 * Sized off docs/04-ticket-workspace-and-review.md's own review-latency
 * budget: "Latency matters more than cost. Review runs after the agent
 * finishes, so four minutes at p95 is tolerable and fifteen is not." A review
 * still running past the point the product's own docs call intolerable is the
 * one this kills, not an arbitrary round number.
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The corpus harness.
 *
 * It spawns the real `perbo` binary once per fixture per repeat. That is the
 * point of SCP-091's "corpus runs and real runs share one code path": a harness
 * that called `runReview` directly would not exercise the argument parsing, the
 * artifact serialisation or the exit codes, which are three of the things the
 * corpus is meant to be able to trust.
 *
 * What it spawns is a single-file bundle of that binary, built into the run's
 * own output directory before the first fixture and executed by every fixture
 * and every repeat. `cliPath` names what is bundled, never what is run: the
 * tree the entry point lives in is the tree a developer keeps rebuilding, and a
 * rebuild used to be able to replace the reviewer halfway through a
 * measurement.
 */

export interface RunRecord {
  fixture_id: string;
  repeat: number;
  exit_code: number;
  artifact: ReviewArtifact | null;
  score: RunScore | null;
  /** Wall clock of the whole process, which is what a user waits for. */
  wall_ms: number;
  failure: string | null;
  /**
   * `"timeout"` when the harness killed this review at its own deadline
   * rather than the reviewer exiting on its own; null otherwise.
   *
   * A killed review carries no artifact — even one that wrote something to
   * stdout before it was killed is not credited, because nothing says the
   * write finished — so it lowers completeness exactly as any other
   * artifact-less run does, and `summariseCorpus`'s existing completeness
   * floor is what decides whether the run is still a measurement.
   */
  partial: "timeout" | null;
}

export interface HarnessOptions {
  /**
   * The reviewer entry point to bundle at run start. It is the source of what
   * is executed and is never itself spawned.
   */
  cliPath: string;
  /**
   * Where the run's own copy of the reviewer is written: `<outDir>/bin/`.
   * Absent — an in-process caller with nowhere to keep results — a scratch
   * directory is used, so the run still executes a snapshot either way.
   */
  outDir?: string | undefined;
  /** Run pinned fixtures whose cache is absent, which always fails. Default false. */
  includeUnprepared?: boolean;
  repeats: number;
  concurrency: number;
  corpusDir?: string | undefined;
  filter?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  artifactsDir?: string | undefined;
  /**
   * How long a spawned review may run before the harness kills it and records
   * the fixture's result as {@link RunRecord.partial} `"timeout"`. Absent,
   * {@link DEFAULT_REVIEW_TIMEOUT_MS}.
   *
   * SCP-199: this `execFile` used to carry no `timeout` at all, so a hung
   * spawned reviewer in a corpus run was bounded only by whatever called the
   * harness — a calling test's own timeout, or nothing. The harness now
   * bounds it itself, whatever is calling it.
   */
  reviewTimeoutMs?: number | undefined;
  /**
   * A ceiling on transport-reported spend, in micro-dollars. The harness
   * launches no review whose projected cost would cross it, and reports the run
   * as partial when that stops it. Absent, nothing is bounded.
   */
  maxSpendMicros?: number | undefined;
  onProgress?: (message: string) => void;
}

async function runOnce(
  entry: LoadedFixture,
  repeat: number,
  options: HarnessOptions,
  bundle: ExecutedBundle,
): Promise<RunRecord> {
  // A pinned fixture whose cache is absent is refused rather than reviewed: a
  // verdict about a repository that is not there would be confident and empty.
  if (!entry.prepared) {
    return {
      fixture_id: entry.fixture.id,
      repeat,
      exit_code: -1,
      artifact: null,
      score: null,
      wall_ms: 0,
      failure: "pins a repository that has not been prepared; run `perbo-corpus prepare`",
      partial: null,
    };
  }
  const rawPath = options.artifactsDir
    ? join(options.artifactsDir, `${entry.fixture.id}.${repeat}.json`)
    : join(tmpdir(), "perbo-corpus-state", "raw", `${entry.fixture.id}.${repeat}.json`);
  mkdirSync(dirname(rawPath), { recursive: true });
  const args = [
    // The run's own copy, never `options.cliPath`.
    bundle.path,
    "review",
    "--contract",
    join(entry.dir, "contract.json"),
    "--diff",
    entry.diffPath,
    "--checks",
    join(entry.dir, "checks.json"),
    "--repo",
    entry.repoDir,
    "--json",
    "--quiet",
    // Resume records go to scratch: a corpus run must not leave state inside
    // the fixture directories, which are checked in.
    "--state",
    join(tmpdir(), "perbo-corpus-state"),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.provider ? ["--provider", options.provider] : []),
    // The artifact before redaction, in a file. stdout is redacted (D-063), and
    // the scorer needs the raw one to tell "never cited" from "redacted".
    "--raw-artifact",
    rawPath,
  ];

  const reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const started = Date.now();
  let stdout: string;
  let exitCode = 0;
  try {
    const result = await run(process.execPath, args, {
      maxBuffer: 64 * 1024 * 1024,
      // The harness's own bound, independent of whatever called it. Node kills
      // the child with `killSignal` if it has not exited by `timeout` and marks
      // the rejected error `killed: true` — SIGKILL rather than the SIGTERM
      // default because a reviewer hung badly enough to need this is not one
      // trusted to notice a polite signal.
      timeout: reviewTimeoutMs,
      killSignal: "SIGKILL",
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; message?: string; killed?: boolean };
    exitCode = typeof failure.code === "number" ? failure.code : -1;
    stdout = failure.stdout ?? "";
    // Checked before the stdout-empty fallback below, and unconditionally: a
    // killed process gets no credit for whatever it had written, because
    // nothing says the write it was killed mid-way through ever finished.
    if (failure.killed === true) {
      return {
        fixture_id: entry.fixture.id,
        repeat,
        exit_code: exitCode,
        artifact: null,
        score: null,
        wall_ms: Date.now() - started,
        failure:
          `the reviewer did not exit within the ${reviewTimeoutMs}ms ` +
          `(${(reviewTimeoutMs / 1000).toFixed(0)}s) review deadline and was killed`,
        partial: "timeout",
      };
    }
    if (stdout.trim() === "") {
      return {
        fixture_id: entry.fixture.id,
        repeat,
        exit_code: exitCode,
        artifact: null,
        score: null,
        wall_ms: Date.now() - started,
        failure: failure.message ?? "the CLI produced no artifact",
        partial: null,
      };
    }
  }
  const wall_ms = Date.now() - started;

  // Prefer the raw file the CLI was asked to write; a CLI that did not write
  // one (an older build, or a run that failed before the reviewer answered)
  // leaves stdout, which is then the redacted artifact and is scored as such.
  const source = existsSync(rawPath) ? readFileSync(rawPath, "utf8") : stdout;
  const parsed = ReviewArtifactSchema.safeParse(JSON.parse(source));
  if (!parsed.success) {
    return {
      fixture_id: entry.fixture.id,
      repeat,
      exit_code: exitCode,
      artifact: null,
      score: null,
      wall_ms,
      failure: `stdout was not a valid ReviewArtifact: ${parsed.error.issues[0]?.message ?? ""}`,
      partial: null,
    };
  }

  // With an artifacts directory the raw file already sits there under the
  // stored name; without one the raw copy stays in scratch.

  return {
    fixture_id: entry.fixture.id,
    repeat,
    exit_code: exitCode,
    artifact: parsed.data,
    score: scoreRun(entry.fixture, parsed.data, exitCode),
    wall_ms,
    failure: null,
    partial: null,
  };
}

/**
 * One finished review: the record that is kept, and what it costs the ceiling.
 *
 * The two travel together because the pool settles the spend the moment the
 * task returns, and it cannot re-derive from a record alone whether the
 * reviewer was ever spawned.
 */
interface Attempt {
  record: RunRecord;
  /** Null only when nothing was spawned, so nothing can have been charged. */
  spend: SpendObservation | null;
}

/**
 * What one attempt contributes to the ceiling.
 *
 * An artifact carries its own price and its own basis. A review that was
 * spawned and produced no artifact — crashed, timed out, wrote nothing
 * parseable — carries neither, and it is recorded as unobservable rather than
 * as free: the transport may have charged for it, and a total that quietly
 * skipped it would not be a bound. An unprepared fixture never reaches a
 * process at all, so it contributes nothing.
 */
function spendOf(entry: LoadedFixture, record: RunRecord): SpendObservation | null {
  const label = `${record.fixture_id} #${record.repeat}`;
  if (record.artifact) {
    return {
      label,
      cost_micros: record.artifact.cost_micros,
      cost_basis: record.artifact.model.cost_basis,
    };
  }
  if (!entry.prepared) return null;
  return { label, cost_micros: 0, cost_basis: NO_ARTIFACT };
}

export interface PoolOutcome<T> {
  /** Results of the tasks that were launched, in task order. */
  results: T[];
  /** Indices never launched, in task order. */
  unlaunched: number[];
  /** Why launching stopped, or null if every task ran. */
  stopped: string | null;
}

export interface PoolHooks<T> {
  /** Asked before each launch; `stop` ends the pool. Default: always admit. */
  admit?: () => Admission;
  /**
   * Told that a task is being launched, synchronously, in the same step as the
   * admission that allowed it. It is what lets the admitter reserve for a task
   * that is running but has not settled — without it, every worker deciding
   * before the first result lands decides against a state that counts none of
   * the work already in flight.
   */
  launch?: () => void;
  /**
   * Told about each finished task, synchronously, before its worker asks to
   * launch another. The pool owns this call rather than the task because the
   * order of the two matters: see below.
   */
  settle?: (result: T) => void;
  /**
   * Told that a launched task threw, in the same place `settle` would have been
   * told about its result. A task that threw still reserved everything the
   * launch reserved — a slot, a price against a ceiling — and a reservation
   * released only on the path where nothing went wrong is a reservation that
   * outlives the run it was bounding. The pool knows the index and the error
   * and nothing else, so the caller is told rather than guessed at.
   */
  fail?: (index: number, error: unknown) => void;
}

/**
 * Run `tasks` with at most `limit` in flight, asking `admit` before each launch.
 *
 * `admit` answering `stop` ends the pool: no further task is launched, and the
 * ones already in flight are awaited rather than abandoned. A review that is
 * running has already been paid for, and throwing its result away would cost
 * the money and lose the measurement.
 *
 * `wait` is the other refusal, and it is not a stop: the worker sleeps until
 * some task settles and asks again. Only a settlement can change the answer, so
 * `wait` with nothing in flight would hang the run forever and is converted to
 * a stop naming the same reason.
 *
 * `launch` and its admission, and `settle` and the next `admit`, each run in one
 * synchronous step with no `await` between them. That is what makes the decision
 * sound under concurrency: a worker asks against a state that already counts
 * every task in flight, never against one that has forgotten the work its peers
 * started in the same turn.
 *
 * A task that rejects is the fourth way a launch can end, and it ends the pool
 * too: `fail` releases what the launch reserved, no further task is launched,
 * the ones in flight are awaited as they are after a `stop`, and the error is
 * thrown once they are all in. Releasing and waking happen on that path exactly
 * as they do on the settling one — a rejection that skipped them would leave
 * every worker parked on `wait` awaiting a settlement that can no longer come.
 */
export async function pooled<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  hooks: PoolHooks<T> = {},
): Promise<PoolOutcome<T>> {
  const admit = hooks.admit ?? (() => ADMIT);
  const launch = hooks.launch ?? (() => undefined);
  const settle = hooks.settle ?? (() => undefined);
  const fail = hooks.fail ?? (() => undefined);
  const results = new Map<number, T>();
  const failures: unknown[] = [];
  let next = 0;
  let running = 0;
  let stopped: string | null = null;

  /**
   * Workers parked on `wait`, woken whenever the state they are waiting on
   * changes. A promise per sleeper is the platform's own condition variable;
   * polling on a timer would make the run's shape depend on a poll interval.
   */
  const sleepers: Array<() => void> = [];
  const wake = (): void => {
    for (const sleeper of sleepers.splice(0)) sleeper();
  };

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      if (stopped !== null || next >= tasks.length) return;
      // Asked before the index is claimed, so a refusal leaves the task
      // unlaunched rather than counted as run.
      const decision = admit();
      if (decision.verdict === "stop") {
        stopped = decision.reason;
        // The sleepers are waiting for a settlement that will now never come.
        wake();
        return;
      }
      if (decision.verdict === "wait") {
        if (running === 0) {
          stopped = decision.reason;
          wake();
          return;
        }
        await new Promise<void>((resolve) => sleepers.push(resolve));
        continue;
      }
      const index = next;
      next += 1;
      running += 1;
      launch();
      // The rejection is caught rather than thrown from here, so that the two
      // endings share one release: `running`, the hooks and `wake` run once,
      // in the same order, whichever way the task ended.
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await tasks[index]!() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      running -= 1;
      if (outcome.ok) {
        results.set(index, outcome.value);
        settle(outcome.value);
      } else {
        failures.push(outcome.error);
        fail(index, outcome.error);
        // A task that threw is a task whose cost and effect nobody can state.
        // Launching more against that is spending after the accounting has
        // stopped, so the pool stops launching and lets the rest come home.
        stopped ??= `task ${index} failed: ${
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        }`;
      }
      wake();
    }
  });
  await Promise.all(workers);
  // Thrown only once every worker is home: the tasks still in flight when the
  // first one threw have been paid for, and awaiting them is what lets the
  // caller's own bookkeeping see them.
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} tasks failed`);
  }
  return {
    results: [...results.keys()].sort((a, b) => a - b).map((index) => results.get(index)!),
    unlaunched: tasks.map((_, index) => index).filter((index) => !results.has(index)),
    stopped,
  };
}

/**
 * A run that stopped short of its population, and everything needed to read it
 * as one: what the ceiling was, how much was spent against it, how many reviews
 * completed, and which reviews never happened.
 *
 * Present only on a run the ceiling stopped. Its presence is what makes every
 * threshold on the run unmeasurable — a stopped run's fixtures are the ones the
 * scheduler reached, which is a prefix of the corpus and not a sample of it.
 */
export interface PartialRun {
  partial: true;
  /** One sentence naming the ceiling and what it stopped. */
  reason: string;
  ceiling_micros: number;
  /** The ceiling as it is quoted to a person, e.g. `$2.50`. */
  ceiling: string;
  spent_micros: number;
  spent: string;
  /** Reviews that were launched and recorded a result. */
  completed: number;
  /** Reviews the population called for. */
  planned: number;
  /** Fixtures no repeat of which was ever launched. */
  not_run: string[];
  /** Every review that was never launched, fixture and repeat. */
  not_run_reviews: Array<{ fixture_id: string; repeat: number }>;
}

export interface HarnessResult {
  /** The reviewer copy every review in this run was spawned against. */
  bundle: ExecutedBundle;
  /** Pinned fixtures skipped because their repository was not cloned. */
  excluded_unprepared: string[];
  fixtures: LoadedFixture[];
  runs: RunRecord[];
  started_at: string;
  finished_at: string;
  /** Set when a spend ceiling stopped the run before its population finished. */
  partial?: PartialRun | null;
}

/**
 * `--filter` semantics, shared by every subcommand that takes one: a
 * comma-separated list of substrings, any of which may match. A named
 * population — the four secret-bearing fixtures, the SCP-112 drivable set — is
 * then one run with one runs.json, rather than several whose rows have to be
 * recombined by hand.
 *
 * This function owns the whole no-filter semantic, so no call site decides it
 * again: `null`/`undefined` means no filter and matches everything, and a
 * blank filter (empty string, whitespace, bare commas) matches NOTHING. The
 * blank case is deliberate: `--filter "$F"` with `F` unset must read as zero
 * fixtures on every path — the dry listing and the run once disagreed on
 * exactly this input, sizing the spend at zero and then running the whole
 * corpus.
 */
export function matchesFilter(fixtureId: string, filter: string | null | undefined): boolean {
  if (filter === null || filter === undefined) return true;
  return filter
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .some((part) => fixtureId.includes(part));
}

/**
 * The one fixture selection the dry listing and `runCorpus` both use, so the
 * "makes N model calls" count and the spend cannot diverge — neither on the
 * filter nor on the pinned-but-unprepared exclusion. A pinned fixture whose
 * repository has not been cloned is excluded rather than run, because running
 * it produces a failure record that looks like a reviewer problem; it is named
 * so a shrunken corpus is never silently a smaller one.
 */
export function selectFixtures(
  entries: LoadedFixture[],
  filter: string | null | undefined,
  includeUnprepared = false,
): { selected: LoadedFixture[]; excluded_unprepared: string[] } {
  const matched = entries.filter((entry) => matchesFilter(entry.fixture.id, filter));
  if (includeUnprepared) return { selected: matched, excluded_unprepared: [] };
  return {
    selected: matched.filter((entry) => entry.prepared),
    excluded_unprepared: matched.filter((entry) => !entry.prepared).map((entry) => entry.fixture.id),
  };
}

export async function runCorpus(options: HarnessOptions): Promise<HarnessResult> {
  // Checked before anything else, for the same reason the bundle is captured
  // before the first spawn: a run whose own review deadline is nonsense must
  // fail having spent nothing, not partway through the population it was
  // supposed to bound.
  const reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  if (!Number.isFinite(reviewTimeoutMs) || reviewTimeoutMs <= 0) {
    throw new Error("a review timeout must be a positive number of milliseconds");
  }
  const all = loadCorpus(options.corpusDir);
  const { selected: fixtures, excluded_unprepared } = selectFixtures(
    all,
    options.filter,
    options.includeUnprepared ?? false,
  );
  if (fixtures.length === 0) throw new Error("no fixtures matched");

  const progress = options.onProgress ?? (() => undefined);
  for (const id of excluded_unprepared) {
    progress(`${id}: excluded — pins a repository that has not been prepared`);
  }

  /**
   * Taken before the first spawn, and thrown from rather than worked around: a
   * run that cannot snapshot its reviewer has not been measured against
   * anything nameable, and it must cost nothing rather than produce numbers.
   */
  const bundle = captureExecutedBundle({
    entry: options.cliPath,
    outDir: options.outDir ?? mkdtempSync(join(tmpdir(), "perbo-corpus-bundle-")),
  });
  progress(`reviewer bundle ${bundle.sha256} (${bundle.bytes} bytes) at ${bundle.path}`);

  const started_at = new Date().toISOString();

  /**
   * The ceiling, if one is in force. Every launch is reserved against it as it
   * happens and every completed review is recorded against it before the worker
   * that ran it asks to launch another, so the decision to spend is taken
   * against the transport's own numbers — and against every review those
   * numbers have not arrived for yet — rather than an estimate made before the
   * run.
   */
  const ledger =
    options.maxSpendMicros === undefined
      ? null
      : new SpendLedger(options.maxSpendMicros);

  const planned: Array<{ fixture_id: string; repeat: number }> = [];
  const tasks: Array<() => Promise<Attempt>> = [];
  for (const entry of fixtures) {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      planned.push({ fixture_id: entry.fixture.id, repeat });
      tasks.push(async () => {
        const record = await runOnce(entry, repeat, options, bundle);
        progress(
          `${record.fixture_id} #${repeat}: exit ${record.exit_code}` +
            `${record.artifact ? ` ${record.artifact.decision}` : ""}` +
            `${
              record.score
                ? ` — ${
                    record.score.attribution_status === "candidate"
                      ? "candidate (file anchor only)"
                      : (record.score.confirmed_detected ?? record.score.detected)
                        ? "detected"
                        : "missed"
                  }`
                : ""
            }` +
            `${record.failure ? ` — ${record.failure}` : ""}`,
        );
        return { record, spend: spendOf(entry, record) };
      });
    }
  }

  const pool = await pooled(tasks, options.concurrency, {
    admit: () => ledger?.admit() ?? ADMIT,
    launch: () => ledger?.launch(),
    settle: (attempt) => ledger?.settle(attempt.spend),
    // A review whose task threw is a review the harness cannot report on: it
    // may have reached the transport, and nothing it left behind says what it
    // cost. That is the same fact as a review that wrote no artifact, and it is
    // recorded the same way — unpriceable spend, not free.
    fail: (index) => {
      const review = planned[index]!;
      ledger?.settle({
        label: `${review.fixture_id} #${review.repeat}`,
        cost_micros: 0,
        cost_basis: NO_ARTIFACT,
      });
    },
  });
  if (pool.stopped !== null) progress(pool.stopped);

  const runs = pool.results.map((attempt) => attempt.record);
  const notRunReviews = pool.unlaunched.map((index) => planned[index]!);
  const ranAtLeastOnce = new Set(runs.map((record) => record.fixture_id));
  const partial: PartialRun | null =
    pool.stopped === null || ledger === null
      ? null
      : {
          partial: true,
          reason: pool.stopped,
          ceiling_micros: ledger.ceilingMicros,
          ceiling: formatUsd(ledger.ceilingMicros),
          spent_micros: ledger.totalMicros,
          spent: formatUsd(ledger.totalMicros),
          completed: runs.length,
          planned: tasks.length,
          not_run: fixtures
            .map((entry) => entry.fixture.id)
            .filter((id) => !ranAtLeastOnce.has(id)),
          not_run_reviews: notRunReviews,
        };

  return {
    bundle,
    fixtures,
    runs,
    excluded_unprepared,
    started_at,
    finished_at: new Date().toISOString(),
    partial,
  };
}
