import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCorpus, type HarnessOptions, type HarnessResult } from "../src/harness.js";
import { renderReport } from "../src/report.js";
import { ruleAuthorityFrom, summariseCorpus } from "../src/summarise.js";
import { sampleDir } from "./sample-fixtures.js";

/**
 * The harness end to end, against a stand-in for the reviewer.
 *
 * The stand-in is a real process that reads the same flags and writes a real
 * ReviewArtifact to stdout with a real exit code, so this exercises spawning,
 * parsing, scoring and summarising — everything except the model call, which
 * cannot run here and is tested by the reviewer's own suite.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-harness-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * `runCorpus` with this run's raw artifacts in a directory of its own.
 *
 * A run given no artifacts directory writes each raw artifact to a fixed path
 * under the system temp directory, and reads that file back in preference to
 * stdout. Two suites reviewing `req-001` at the same time — this file and the
 * spend-ceiling suite do, in parallel workers — then read each other's
 * artifacts, and the assertion that fails is whichever one lost the race. A
 * real run always has one, because `--out` gives it one.
 */
let runs = 0;
function runIsolatedCorpus(options: HarnessOptions): Promise<HarnessResult> {
  runs += 1;
  return runCorpus({ corpusDir: sampleDir, artifactsDir: join(scratch, `artifacts-${runs}`), ...options });
}

/**
 * `runIsolatedCorpus` spawns the stub reviewer once per fixture per repeat
 * through the same `execFile` path a real run uses, so every test below that
 * calls it needs its own bound rather than vitest's five-second default — the
 * SCP-161 merge-up gate hit exactly that default on this file's neighbour,
 * `bundle-copy.test.ts`, under the same loaded-machine conditions.
 *
 * `RUN_TIMEOUT_MS` covers a handful of cold spawns (one or two fixtures, low
 * repeat counts).
 */
const RUN_TIMEOUT_MS = 60_000;

/**
 * `perfect` detects every seeded defect and blocks nothing clean.
 * `useless` approves everything, which is the shape a corpus has to be able to
 * fail: perfect recall on nothing and a perfect false-block rate.
 */
function stubCli(mode: "perfect" | "useless"): string {
  const path = join(scratch, `stub-${mode}.mjs`);
  writeFileSync(
    path,
    `import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const contract = JSON.parse(readFileSync(at("--contract"), "utf8"));
const criteria = contract.acceptance_criteria ?? [];
const mode = ${JSON.stringify(mode)};
const dir = at("--contract").replace(/\\/contract\\.json$/, "");
const fixture = JSON.parse(readFileSync(dir + "/fixture.json", "utf8"));
const expectation = fixture.expected_detection;

const findings = [];
let coverage = criteria.map((c) => ({
  criterion_id: c.id,
  status: "met",
  verification_strength: "directly_verified",
  evidence: null,
  note: null,
}));
let decision = "approve";

if (mode === "perfect" && fixture.defective) {
  if (expectation.mode === "blocking") {
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
  } else if (expectation.mode === "coverage") {
    coverage = coverage.map((entry) =>
      entry.criterion_id === expectation.criterion_ids[0]
        ? { ...entry, verification_strength: "asserted_only" }
        : entry,
    );
  }
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
  cost_micros: 210000,
  latency_ms: 74000,
  model: {
    provider: "stub",
    model_id: "stub",
    prompt_version: "reviewer_v1",
    input_tokens: 1,
    output_tokens: 1,
  },
  error: null,
};
const rawAt = args.indexOf("--raw-artifact");
if (rawAt !== -1) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(args[rawAt + 1]), { recursive: true });
  // The raw file carries a marker stdout does not, so a test can tell which
  // one the harness scored.
  writeFileSync(args[rawAt + 1], JSON.stringify({ ...artifact, confidence: 0.42 }));
}
process.stdout.write(JSON.stringify(artifact));
process.exitCode = decision === "approve" ? 0 : 2;
`,
  );
  return path;
}

describe("the harness scores the artifact before redaction", () => {
  it("reads the --raw-artifact file rather than stdout when the CLI wrote one", async () => {
    const result = await runIsolatedCorpus({ cliPath: stubCli("perfect"), repeats: 1, concurrency: 4, filter: "req-001" });
    const record = result.runs.find((entry) => entry.artifact !== null);
    expect(record?.artifact?.confidence).toBe(0.42);
  }, RUN_TIMEOUT_MS);
});

describe("the harness against a perfect reviewer", () => {
  it("scores every class and reports intervals with an n", async () => {
    const result = await runIsolatedCorpus({
      cliPath: stubCli("perfect"),
      repeats: 3,
      concurrency: 8,
    });
    const summary = summariseCorpus(result, 3);

    expect(summary.runs_failed).toBe(0);
    expect(summary.runs_attempted).toBe(summary.fixture_count * 3);

    let gated = 0;
    let reported = 0;
    for (const metric of summary.metrics) {
      if (metric.by_fixture.n === 0) continue;
      if (metric.threshold === null) {
        // D-055: a reported rate carries no verdict, and must not acquire one.
        // The adversarial detection rate lives here — a ≥95% bar on it is not
        // reachable by any corpus, so it is tracked and never used to start or
        // stop work.
        reported += 1;
        expect(metric.meets, `${metric.name} is reported, not gated`).toBeNull();
        expect(metric.resolves, `${metric.name} is reported, not gated`).toBeNull();
      } else {
        gated += 1;
        expect(metric.meets, `${metric.name} should be met by a perfect reviewer`).toBe(true);
      }
      expect(metric.by_fixture.low).toBeLessThanOrEqual(metric.by_fixture.point);
      expect(metric.by_fixture.high).toBeGreaterThanOrEqual(metric.by_fixture.point);
      expect(metric.by_fixture.n).toBeGreaterThan(0);
    }
    // Both kinds exist. Without this the loop passes if every metric silently
    // became one or the other.
    expect(gated).toBeGreaterThan(0);
    expect(reported).toBeGreaterThan(0);
  }, RUN_TIMEOUT_MS);
});

describe("the harness against a reviewer that approves everything", () => {
  it("reports the recall failure rather than a green board", async () => {
    const result = await runIsolatedCorpus({
      cliPath: stubCli("useless"),
      repeats: 3,
      concurrency: 8,
    });
    const summary = summariseCorpus(result, 3);

    const named = (name: string) => summary.metrics.find((metric) => metric.name.startsWith(name))!;
    expect(named("Blocking-defect recall, P2").by_fixture.point).toBe(0);
    expect(named("Blocking-defect recall, P2").meets).toBe(false);
    // The sample carries no scope-escape fixture, so the deterministic row
    // has no population here; scope-escape detection is scored over its own
    // population by the corpus suites. The P1 row stands in its place.
    expect(named("Blocking-defect recall, P1").meets).toBe(false);
    expect(named("Verdict not flipped").meets).toBe(false);

    // A reviewer that never blocks has a perfect false-block rate. That is
    // exactly why the clean fixtures alone prove nothing.
    expect(named("Clean changes passing the gate").by_fixture.point).toBe(1);
  }, RUN_TIMEOUT_MS);

  it("produces a report that names what was not met", async () => {
    const result = await runIsolatedCorpus({ cliPath: stubCli("useless"), repeats: 3, concurrency: 8 });
    const report = renderReport(summariseCorpus(result, 3), { model: "stub" });
    expect(report).toContain("NOT MET");
    expect(report).toContain("n=");
    expect(report).toContain("Per fixture");
    expect(report).toContain("Mechanism-confirmed");
    expect(report).toContain("Registered anchor");
    expect(report).toContain("file-only candidates");
  }, RUN_TIMEOUT_MS);
});

describe("rule authority is measured, not asserted", () => {
  it("counts a blocking finding on a clean change against the rule that raised it", async () => {
    const result = await runIsolatedCorpus({ cliPath: stubCli("perfect"), repeats: 1, concurrency: 8 });
    const authority = ruleAuthorityFrom(result);
    expect(authority.measured_over_fixtures).toBe(result.fixtures.length);
    // The perfect reviewer never blocks a clean change, so nothing is demoted.
    for (const rule of Object.values(authority.rules)) {
      expect(rule.false_positive_rate).toBe(0);
    }
  }, RUN_TIMEOUT_MS);
});
