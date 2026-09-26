import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { pooled, runCorpus, type HarnessResult } from "../src/harness.js";
import { main } from "../src/main.js";
import { SAMPLE_AUTHORED_IDS, sampleDir } from "./sample-fixtures.js";
import { NO_ARTIFACT, SpendLedger, type SpendObservation } from "../src/spend.js";
import { summariseCorpus } from "../src/summarise.js";

/**
 * The spend ceiling as an enforced control.
 *
 * Everything here runs the real harness against a real process that reports a
 * real price: the stand-in reviewer writes a valid artifact costing exactly
 * $1.00, transport-reported, and appends its own fixture id to a log file the
 * moment it starts. The log is the evidence — a review that was never launched
 * cannot have written a line — so the assertions are about what was spawned,
 * not about which function the harness called.
 */

const scratchDirectory = scratchDirectories("perbo-spend-test-");
const scratch = scratchDirectory();
afterEach(() => vi.restoreAllMocks());

/** The sample's five prepared, authored fixtures. Substrings, as `--filter` takes them. */
const FIVE = [...SAMPLE_AUTHORED_IDS];
const FILTER = FIVE.join(",");
/** What a run that stops after two never reaches: the last three in id order. */
const LAST_THREE = FIVE.slice(2);
const DOLLAR = 1_000_000;

/**
 * A stand-in reviewer that costs `costMicros` per review and logs every launch.
 *
 * It answers like the `perfect` stub in harness.test.ts — it blocks on the
 * seeded defect — so the runs it produces score, and a summary over them would
 * clear every threshold it has an n for.
 *
 * The log carries a `start` line and a `done` line per review, so it records
 * not only what was launched but whether two launches overlapped: a `start`
 * between another review's `start` and its `done` is a review that did not wait
 * for it. `holdMs` widens that window past anything process startup can blur.
 */
function stubCli(name: string, logPath: string, costMicros = DOLLAR, holdMs = 0): string {
  const path = join(scratch, `stub-${name}.mjs`);
  writeFileSync(
    path,
    `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const contract = JSON.parse(readFileSync(at("--contract"), "utf8"));
const dir = at("--contract").replace(/\\/contract\\.json$/, "");
const fixture = JSON.parse(readFileSync(dir + "/fixture.json", "utf8"));
// Written before anything else can fail: this file is the record of what was
// launched, and it must not depend on the review succeeding.
appendFileSync(${JSON.stringify(logPath)}, "start " + fixture.id + "\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});

const expectation = fixture.expected_detection;
const criteria = contract.acceptance_criteria ?? [];
const findings = [];
let coverage = criteria.map((c) => ({
  criterion_id: c.id,
  status: "met",
  verification_strength: "directly_verified",
  evidence: null,
  note: null,
}));
let decision = "approve";

if (fixture.defective && expectation.mode === "blocking") {
  decision = "changes_requested";
  findings.push({
    key: "b".repeat(64),
    rule_id: expectation.rule_prefixes[0] ? expectation.rule_prefixes[0] + "x" : "criterion.not_met",
    source: "semantic",
    criterion_id: expectation.criterion_ids[0] ?? null,
    severity: "blocker",
    blocking: true,
    blocking_reason: "contract",
    confidence: 0.9,
    file: expectation.files[0] ?? null,
    line: 1,
    symbol: null,
    statement: "seeded defect",
    status: "open",
    outcome: "unknown",
    waiver: null,
  });
  coverage = coverage.map((entry) =>
    entry.criterion_id === expectation.criterion_ids[0] ? { ...entry, status: "not_met" } : entry,
  );
} else if (fixture.defective && expectation.mode === "coverage") {
  coverage = coverage.map((entry) =>
    entry.criterion_id === expectation.criterion_ids[0]
      ? { ...entry, verification_strength: "asserted_only" }
      : entry,
  );
}

const artifact = {
  schema_version: 1,
  review_id: "rev_" + Math.random().toString(16).slice(2, 10),
  resumed_from: null,
  created_at: new Date(0).toISOString(),
  target: { type: "changeset", id: "cs_stub", base_commit: contract.base.base_commit, head_commit: "d4e5f6a" },
  plan_id: contract.plan_id,
  plan_version: contract.version,
  planned_risk: contract.level,
  actual_risk: contract.level,
  escalated: false,
  independence: {
    context_builder: "reviewer_v1",
    executor_narrative_visible: false,
    executor_transcript_visible: false,
    separate_process: true,
    model_family: "same",
    grounded_in: [],
  },
  context_manifest: [],
  checks: [],
  overrides: [],
  coverage,
  findings,
  scope_deviation: {
    files_outside_scope: [],
    files_in_prohibited_paths: [],
    files_exempt_as_generated: [],
    within_expansion_budget: true,
    expansion_budget_files: contract.scope.expansion_budget_files,
  },
  decision,
  confidence: 0.9,
  // The price this run is bounded against, as the transport reports it.
  cost_micros: ${costMicros},
  latency_ms: 1000,
  model: {
    provider: "stub",
    model_id: "stub",
    prompt_version: "reviewer_v1",
    input_tokens: 1,
    output_tokens: 1,
    cost_basis: "transport_reported",
  },
  error: null,
};
const rawAt = args.indexOf("--raw-artifact");
if (rawAt !== -1) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(args[rawAt + 1]), { recursive: true });
  writeFileSync(args[rawAt + 1], JSON.stringify(artifact));
}
appendFileSync(${JSON.stringify(logPath)}, "done " + fixture.id + "\\n");
process.stdout.write(JSON.stringify(artifact));
process.exitCode = decision === "approve" ? 0 : 2;
`,
  );
  return path;
}

/**
 * A stand-in reviewer that starts, logs the launch and dies without writing an
 * artifact — a crash, a timeout, a transport that hung up. The money it may
 * already have cost is not recoverable from anything it left behind.
 */
function crashingCli(name: string, logPath: string): string {
  const path = join(scratch, `stub-${name}.mjs`);
  writeFileSync(
    path,
    `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const dir = args[args.indexOf("--contract") + 1].replace(/\\/contract\\.json$/, "");
const fixture = JSON.parse(readFileSync(dir + "/fixture.json", "utf8"));
appendFileSync(${JSON.stringify(logPath)}, "start " + fixture.id + "\\n");
process.stderr.write("the transport hung up\\n");
process.exit(1);
`,
  );
  return path;
}

/**
 * A stand-in reviewer that logs its launch, writes something that is not JSON
 * to `--raw-artifact` and exits cleanly.
 *
 * `--raw-artifact` is the file the harness reads back in preference to stdout,
 * and reading it throws out of the task rather than returning a record: the one
 * way a review reaches the pool as a rejection rather than as a result.
 */
function garblingCli(name: string, logPath: string): string {
  const path = join(scratch, `stub-${name}.mjs`);
  writeFileSync(
    path,
    `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const dir = args[args.indexOf("--contract") + 1].replace(/\\/contract\\.json$/, "");
const fixture = JSON.parse(readFileSync(dir + "/fixture.json", "utf8"));
appendFileSync(${JSON.stringify(logPath)}, "start " + fixture.id + "\\n");
const raw = args[args.indexOf("--raw-artifact") + 1];
mkdirSync(dirname(raw), { recursive: true });
writeFileSync(raw, "{ not an artifact");
`,
  );
  return path;
}

/** Every line the stand-in reviewers wrote, in the order they wrote it. */
function trace(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

/** The fixtures a reviewer process was spawned for, in launch order. */
function launches(logPath: string): string[] {
  return trace(logPath)
    .filter((line) => line.startsWith("start "))
    .map((line) => line.slice("start ".length));
}

/**
 * One ceiling-stopped run, shared by the launch assertions and the summary
 * ones so the same stopped run is the subject of both.
 *
 * $1.00 a review against a $2.50 ceiling, `--concurrency 2`. The first launches against nothing; the second is held, because a
 * ledger that has seen no price has nothing to reserve the first at. When the
 * first reports, the projection is $1.00 settled plus one review at $1.00 —
 * $2.00, admitted. The next projects $1.00 settled plus the one in flight plus
 * one more, $3.00, and is refused. Two launched, three never, $2.00 spent.
 */
let stopped: HarnessResult;
const stoppedLog = join(scratch, "stopped-launches.log");

beforeAll(async () => {
  writeFileSync(stoppedLog, "");
  stopped = await runCorpus({
    corpusDir: sampleDir,
    cliPath: stubCli("dollar", stoppedLog),
    repeats: 1,
    concurrency: 2,
    filter: FILTER,
    maxSpendMicros: 2.5 * DOLLAR,
  });
}, 120_000);

describe("a ceiling stops the harness before the next review is launched", () => {
  it("launches two of five reviews at $1.00 each under a $2.50 ceiling", () => {
    expect(stopped.fixtures).toHaveLength(5);

    const launched = launches(stoppedLog);
    expect(launched).toHaveLength(2);
    for (const never of LAST_THREE) {
      expect(launched.some((id) => id.startsWith(never))).toBe(false);
    }

    // Everything launched finished and was scored: a review in flight when the
    // ceiling is reached is paid for, so it is awaited rather than discarded.
    expect(stopped.runs).toHaveLength(2);
    for (const record of stopped.runs) {
      expect(record.artifact, `${record.fixture_id} produced an artifact`).not.toBeNull();
      expect(record.score, `${record.fixture_id} was scored`).not.toBeNull();
    }
    expect(stopped.runs.map((record) => record.fixture_id).sort()).toEqual(launched.sort());
  });

  it("records the run as partial, naming the ceiling and what never ran", () => {
    const partial = stopped.partial;
    expect(partial?.partial).toBe(true);
    expect(partial?.ceiling).toBe("$2.50");
    expect(partial?.completed).toBe(2);
    expect(partial?.planned).toBe(5);
    expect(partial?.not_run.map((id) => id.slice(0, 7))).toEqual(LAST_THREE);
    expect(partial?.reason).toContain("$2.50");
    // The reservation is what keeps this under the ceiling rather than over it:
    // the review still in flight when the last refusal was taken had already
    // been counted against the projection that refused.
    expect(partial?.spent).toBe("$2.00");
    expect(partial?.spent_micros).toBeLessThanOrEqual(2.5 * DOLLAR);
  });

  it("runs the whole population when the ceiling is above what it costs", async () => {
    const log = join(scratch, "unbounded-launches.log");
    writeFileSync(log, "");
    const result = await runCorpus({
      corpusDir: sampleDir,
      cliPath: stubCli("dollar-roomy", log),
      repeats: 1,
      concurrency: 2,
      filter: FILTER,
      maxSpendMicros: 50 * DOLLAR,
    });
    expect(launches(log)).toHaveLength(5);
    expect(result.runs).toHaveLength(5);
    expect(result.partial ?? null).toBeNull();
  }, 120_000);
});

/** One review the transport priced at `micros`. */
const spend = (label: string, micros = DOLLAR): SpendObservation => ({
  label,
  cost_micros: micros,
  cost_basis: "transport_reported",
});

describe("the projection reserves for the reviews already in flight", () => {
  it("projects the settled total plus one review per review in flight, plus one more", () => {
    // $1.00 settled, $1.00 the last price seen, and two more reviews running
    // that nothing has been charged for yet.
    const ledger = new SpendLedger(2.5 * DOLLAR);
    ledger.launch();
    ledger.settle(spend("#0"));
    ledger.launch();
    ledger.launch();

    expect(ledger.totalMicros).toBe(DOLLAR);
    expect(ledger.inFlightReviews).toBe(2);
    // $1.00 settled + (2 in flight + 1 next) × $1.00.
    expect(ledger.projectedMicros).toBe(4 * DOLLAR);

    const refused = ledger.admit();
    expect(refused.verdict).toBe("stop");
    expect(refused.verdict === "stop" && refused.reason).toContain("$4.00");
    expect(refused.verdict === "stop" && refused.reason).toContain("$2.50");

    // The same ledger once the two in flight are done and charged nothing: the
    // three dollars of difference were all reservation, and without it the
    // ledger admits the next review at $1.00 settled plus one at $1.00.
    ledger.settle(null);
    ledger.settle(null);
    expect(ledger.inFlightReviews).toBe(0);
    expect(ledger.projectedMicros).toBe(2 * DOLLAR);
    expect(ledger.admit().verdict).toBe("admit");
  });
});

describe("the launch decision does not depend on how the reviews interleave", () => {
  /**
   * The worst case for the reservation: four workers deciding against a ledger
   * nothing has settled into yet. Whatever order the turns fall in, the
   * guarantee is the ceiling plus at most one review — $2.50 plus one $1.00
   * review — and the run may not launch a third. With no price yet the ledger
   * has nothing to reserve at, so it holds every worker but the first until
   * that one settles.
   */
  const yields = async (turns: number): Promise<void> => {
    for (let turn = 0; turn < turns; turn += 1) {
      // A macrotask every fourth turn, so the tasks do not all settle inside
      // one drain of the microtask queue.
      if (turn % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
      else await Promise.resolve();
    }
  };

  it("launches at most two reviews and spends at most $3.50 on every one of fifty runs", async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const where = `attempt ${attempt}`;
      const ledger = new SpendLedger(2.5 * DOLLAR);
      const launched: number[] = [];
      const tasks = Array.from({ length: 5 }, (_unused, index) => async () => {
        launched.push(index);
        // A different number of turns on every task and every attempt, so the
        // fifty runs are fifty orderings rather than one repeated.
        await yields((attempt * 7 + index * 3) % 6);
        return spend(`#${index}`);
      });

      const outcome = await pooled(tasks, 4, {
        admit: () => ledger.admit(),
        launch: () => ledger.launch(),
        settle: (observation) => ledger.settle(observation),
      });

      expect(launched.length, where).toBeLessThanOrEqual(2);
      expect(launched.length, where).toBeGreaterThan(0);
      expect(ledger.totalMicros, where).toBeLessThanOrEqual(3.5 * DOLLAR);
      expect(outcome.results.length, where).toBe(launched.length);
      expect(outcome.stopped, where).toContain("$2.50");
      expect(ledger.inFlightReviews, where).toBe(0);
    }
  }, 60_000);
});

describe("a review that throws releases what its launch reserved", () => {
  /** Hands control back `turns` times, so the tasks finish in a known order. */
  const after = async (turns: number): Promise<void> => {
    for (let turn = 0; turn < turns; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  /**
   * The pool driven by a real ledger, so the reservation under test is the one
   * the ceiling reasons about rather than a counter this file keeps.
   */
  const drive = (ledger: SpendLedger, tasks: Array<() => Promise<SpendObservation>>) =>
    pooled(tasks, 2, {
      admit: () => ledger.admit(),
      launch: () => ledger.launch(),
      settle: (observation) => ledger.settle(observation),
      fail: (index) =>
        ledger.settle({ label: `#${index}`, cost_micros: 0, cost_basis: NO_ARTIFACT }),
    });

  it("awaits the review still in flight, releases the reservation, and throws", async () => {
    // One review has already reported $1.00, so the ledger has a price to
    // reserve at and lets two go at once.
    const ledger = new SpendLedger(10 * DOLLAR);
    ledger.launch();
    ledger.settle(spend("#seed"));
    const finished: string[] = [];
    const tasks = [
      async (): Promise<SpendObservation> => {
        await after(1);
        throw new Error("the transport hung up");
      },
      async (): Promise<SpendObservation> => {
        await after(4);
        finished.push("#1");
        return spend("#1");
      },
      async (): Promise<SpendObservation> => {
        finished.push("#2");
        return spend("#2");
      },
    ];

    await expect(drive(ledger, tasks)).rejects.toThrow("the transport hung up");

    // The review that was running when the other one threw was awaited rather
    // than abandoned — it has been paid for — and the third was never launched.
    expect(finished).toEqual(["#1"]);
    expect(ledger.totalMicros).toBe(2 * DOLLAR);
    // No reservation outlived its review: a leaked one would bound every later
    // decision at a review that is not running.
    expect(ledger.inFlightReviews).toBe(0);
    // And the failure is spend nobody can see, which is a ceiling that can no
    // longer be enforced rather than a review that was free.
    expect(ledger.unobservedReviews).toHaveLength(1);
    expect(ledger.admit().verdict).toBe("stop");
  });

  it("wakes the worker parked with nothing to reserve at", async () => {
    // No price anywhere, so the second worker parks the moment the first review
    // is launched: only a settlement can change the answer it is waiting for.
    // If a failure is not one of those, this pool never comes home.
    const ledger = new SpendLedger(10 * DOLLAR);
    const tasks = [
      async (): Promise<SpendObservation> => {
        await after(2);
        throw new Error("the transport hung up");
      },
      async (): Promise<SpendObservation> => spend("#1"),
    ];

    await expect(drive(ledger, tasks)).rejects.toThrow("the transport hung up");
    expect(ledger.inFlightReviews).toBe(0);
  }, 10_000);

  it("surfaces a review the harness could not read at all", async () => {
    const log = join(scratch, "garbled-launches.log");
    writeFileSync(log, "");

    // The real harness, against a reviewer whose artifact cannot be parsed: the
    // task throws, and with no price observed the second worker is parked at
    // that moment. The run has to end in that error rather than in the parked
    // worker's sleep.
    await expect(
      runCorpus({
        corpusDir: sampleDir,
        cliPath: garblingCli("garbled", log),
        repeats: 1,
        concurrency: 2,
        filter: FILTER,
        artifactsDir: join(scratch, "garbled-artifacts"),
        maxSpendMicros: 50 * DOLLAR,
      }),
    ).rejects.toThrow(/JSON/i);
    expect(launches(log)).toHaveLength(1);
  }, 120_000);
});

describe("the ceiling is a bound the projection may reach, not cross", () => {
  it("admits a next review that projects exactly to the ceiling, and refuses one micro above", () => {
    const exact = new SpendLedger(3 * DOLLAR);
    exact.settle(spend("#0"));
    exact.settle(spend("#1"));
    expect(exact.projectedMicros).toBe(3 * DOLLAR);
    expect(exact.admit().verdict).toBe("admit");

    const below = new SpendLedger(3 * DOLLAR - 1);
    below.settle(spend("#0"));
    below.settle(spend("#1"));
    expect(below.admit().verdict).toBe("stop");
  });
});

describe("a ceiling with no price yet holds the second review rather than guessing", () => {
  it("admits the first, holds the second, and admits it once the first settles", () => {
    const ledger = new SpendLedger(2.5 * DOLLAR);

    expect(ledger.reviewPriceMicros).toBeNull();
    expect(ledger.admit().verdict).toBe("admit");
    ledger.launch();

    // Held, not stopped: the run is not partial, it simply has nothing to
    // reserve the review in flight at until that review reports.
    const held = ledger.admit();
    expect(held.verdict).toBe("wait");
    expect(held.verdict === "wait" && held.reason).toContain("no review has reported a price");

    ledger.settle(spend("#0"));
    expect(ledger.admit().verdict).toBe("admit");
  });
});

describe("a ceiling that cannot be enforced names what it could not price", () => {
  it("names three whole, then how many more (D-NEW-nothing-shown-is-cut)", () => {
    const ledger = new SpendLedger(50 * DOLLAR);
    for (const label of ["#0", "#1", "#2", "#3", "#4"]) {
      ledger.launch();
      ledger.settle({ label, cost_micros: 0, cost_basis: "unavailable" });
    }
    const stopped = ledger.admit();
    expect(stopped.verdict).toBe("stop");
    expect(stopped.verdict === "stop" && stopped.reason).toMatch(/#2 \([^)]*\) and 2 more\), so the/);
  });
});

describe("a ceiling stops when it cannot see what a launched review cost", () => {
  it("stops after the first review that produced no artifact to price", async () => {
    const log = join(scratch, "crash-bounded.log");
    writeFileSync(log, "");
    const result = await runCorpus({
      corpusDir: sampleDir,
      cliPath: crashingCli("crash-bounded", log),
      repeats: 1,
      concurrency: 2,
      filter: FILTER,
      maxSpendMicros: 50 * DOLLAR,
    });

    // One was launched — the second worker had no price to reserve the first
    // at and waited for it — and it could not be priced, so the ledger stopped
    // there. The reported total is $0.00 and that is exactly why: it is not a
    // bound on what the transport charged for the one that ran.
    expect(launches(log)).toHaveLength(1);
    expect(result.partial?.partial).toBe(true);
    expect(result.partial?.spent).toBe("$0.00");
    expect(result.partial?.reason).toContain("cannot be enforced");
    expect(result.partial?.reason).toContain("no artifact");
    expect(result.partial?.not_run).toHaveLength(4);
  }, 120_000);

  it("runs the whole population when no ceiling is in force", async () => {
    const log = join(scratch, "crash-unbounded.log");
    writeFileSync(log, "");
    const result = await runCorpus({
      corpusDir: sampleDir,
      cliPath: crashingCli("crash-unbounded", log),
      repeats: 1,
      concurrency: 2,
      filter: FILTER,
    });

    // The stop above is the ceiling's doing, not the harness refusing to
    // tolerate a failing reviewer: unbounded, all five still run and all five
    // are recorded as failures.
    expect(launches(log)).toHaveLength(5);
    expect(result.runs).toHaveLength(5);
    expect(result.runs.every((record) => record.failure !== null)).toBe(true);
    expect(result.partial ?? null).toBeNull();
  }, 120_000);
});

describe("summariseCorpus refuses to mark a threshold met on a partial run", () => {
  it("marks nothing met, and cites the ceiling that stopped the run", () => {
    const summary = summariseCorpus(stopped, 1);

    for (const metric of summary.metrics) {
      expect(metric.meets, `${metric.name} on a partial run`).toBeNull();
      expect(metric.resolves, `${metric.name} on a partial run`).toBeNull();
    }
    expect(summary.not_a_measurement).toContain("$2.50");
    expect(summary.not_a_measurement).toContain("spend ceiling");
    expect(summary.partial?.partial).toBe(true);

    // The subset it did complete is not the reason: the same runs, with the
    // partial marker taken off, clear every threshold they have an n for. The
    // completeness floor is untouched — these reviews all produced artifacts.
    const asIfComplete = summariseCorpus({ ...stopped, partial: null }, 1);
    expect(asIfComplete.not_a_measurement).toBeNull();
    const gated = asIfComplete.metrics.filter(
      (metric) => metric.threshold !== null && metric.by_fixture.n > 0,
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const metric of gated) {
      expect(metric.meets, `${metric.name} without the partial marker`).toBe(true);
    }
  });
});

describe("a ceiling-stopped run says so in runs.json and in report.md", () => {
  it("writes the ceiling, the completed count and the fixtures that never ran", async () => {
    const out = join(scratch, "ceiling-run");
    const log = join(scratch, "cli-launches.log");
    mkdirSync(out, { recursive: true });
    writeFileSync(log, "");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await main(
      [
        "--corpus",
        sampleDir,
        "--run",
        "--repeats",
        "1",
        "--concurrency",
        "2",
        "--filter",
        FILTER,
        "--provider",
        "claude-cli",
        "--max-spend",
        "$2.50",
        "--out",
        out,
      ],
      { cliPath: stubCli("cli-dollar", log) },
    );

    // A run that did not measure its population does not exit 0.
    expect(code).not.toBe(0);
    expect(launches(log)).toHaveLength(2);

    const runs = JSON.parse(readFileSync(join(out, "runs.json"), "utf8")) as Record<string, unknown>;
    expect(runs.partial).toBe(true);
    expect(runs.ceiling).toBe("$2.50");
    expect(runs.completed).toBe(2);
    expect(runs.not_run_reviews).toHaveLength(3);
    const notRun = runs.not_run as string[];
    expect(notRun.map((id) => id.slice(0, 7))).toEqual(LAST_THREE);
    expect((runs.runs as unknown[]).length).toBe(2);

    const report = readFileSync(join(out, "report.md"), "utf8");
    expect(report).toContain("$2.50");
    expect(report).toContain("2 of 5");
    for (const id of notRun) expect(report).toContain(id);
    expect(report).toContain("PARTIAL RUN");
    // And no verdict is offered on it.
    expect(report).not.toMatch(/\| met \|/);
  }, 180_000);
});

describe("a run under a ceiling with no price yet holds its second review", () => {
  /** A fresh out directory and a zeroed launch log. */
  function fresh(name: string): { out: string; log: string } {
    const out = join(scratch, name);
    const log = join(scratch, `${name}.log`);
    mkdirSync(out, { recursive: true });
    writeFileSync(log, "");
    return { out, log };
  }

  async function bounded(out: string, log: string): Promise<number> {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    return main(
      [
        "--corpus",
        sampleDir,
        "--run",
        "--repeats",
        "1",
        "--concurrency",
        "4",
        "--filter",
        FILTER,
        "--provider",
        "claude-cli",
        "--max-spend",
        "2.50",
        "--out",
        out,
      ],
      // Each review holds for two seconds, so two reviews that overlap are
      // visible as an overlap in the log rather than as a race: on a loaded
      // machine (SCP-246) spawning the second review's process can itself take
      // a second or more, and a shorter hold let the first review's own
      // process finish before the second ever started.
      { cliPath: stubCli(`priced-${out.length}-${log.length}`, log, DOLLAR, 2_000) },
    );
  }

  it("until the first settles", async () => {
    const { out, log } = fresh("ceiling-unpriced");
    await bounded(out, log);

    // The same two reviews, one after the other: with nothing to reserve the
    // first review at, the ledger will not let a second go beside it.
    const lines = trace(log);
    expect(launches(log)).toHaveLength(2);
    expect(lines.slice(0, 2), lines.join(" / ")).toEqual([lines[0], `done ${lines[0]?.slice(6)}`]);

    const runs = JSON.parse(readFileSync(join(out, "runs.json"), "utf8")) as Record<string, unknown>;
    expect(runs.completed).toBe(2);
    expect(runs.spent).toBe("$2.00");
  }, 180_000);
});
