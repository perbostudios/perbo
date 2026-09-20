import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  runCorpus,
  type HarnessOptions,
  type HarnessResult,
} from "../src/harness.js";
import { main } from "../src/main.js";
import { summariseCorpus } from "../src/summarise.js";
import { sampleDir } from "./sample-fixtures.js";

/**
 * SCP-191's follow-up: `execFile` in `packages/evaluation/src/harness.ts`
 * carried no `timeout`, so a hung spawned reviewer in a corpus run was bounded
 * only by whatever called the harness — a calling test's own timeout, or
 * nothing at all in a real `--run`. This suite proves the harness now bounds
 * it itself: a reviewer that never exits is actually killed, at a deadline the
 * harness itself enforces, and the killed review reads as `partial: "timeout"`
 * naming that deadline; a run that lost reviews to it is refused by the same
 * completeness rule any other incomplete run is refused by, not a new one; and
 * the deadline is visible on the command line and in the run manifest.
 */

const scratchDirectory = scratchDirectories("perbo-review-timeout-test-");
const scratch = scratchDirectory();

let runs = 0;
function runIsolatedCorpus(options: HarnessOptions): Promise<HarnessResult> {
  runs += 1;
  return runCorpus({
    corpusDir: sampleDir,
    artifactsDir: join(scratch, `artifacts-${runs}`),
    ...options,
  });
}

/**
 * A reviewer that never exits, so a test can prove the harness's own kill
 * deadline rather than trusting whatever called the harness (here, vitest's
 * own test timeout) to save it.
 *
 * `setInterval` rather than `await new Promise(() => {})`: Node detects an
 * unsettled top-level await in an ES module and force-exits the process with
 * its own diagnostic well before a several-second deadline would fire, which
 * would end up testing that diagnostic instead of the kill this suite exists
 * to prove.
 */
function hangingStub(): string {
  const path = join(scratch, "stub-hanging.mjs");
  writeFileSync(path, "setInterval(() => {}, 1_000_000);\n");
  return path;
}

/** A reviewer that answers instantly with a valid, unremarkable artifact. */
function instantStub(): string {
  const path = join(scratch, "stub-instant.mjs");
  writeFileSync(
    path,
    `import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const contract = JSON.parse(readFileSync(at("--contract"), "utf8"));
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
  coverage: (contract.acceptance_criteria ?? []).map((c) => ({
    criterion_id: c.id,
    status: "met",
    verification_strength: "directly_verified",
    evidence: null,
    note: null,
  })),
  findings: [],
  scope_deviation: {
    files_outside_scope: [],
    files_in_prohibited_paths: [],
    files_exempt_as_generated: [],
    within_expansion_budget: true,
    expansion_budget_files: contract.scope.expansion_budget_files,
  },
  decision: "approve",
  confidence: 0.9,
  cost_micros: 100000,
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
process.stdout.write(JSON.stringify(artifact));
`,
  );
  return path;
}

/**
 * Every test below spawns a real process and waits out a real, short kill
 * deadline, so each needs its own bound rather than vitest's five-second
 * default — the same reasoning `harness.test.ts`'s `RUN_TIMEOUT_MS` states for
 * itself. Nothing here waits on a stub to answer; the slowest path is a cold
 * spawn plus a one-second deadline plus process teardown, which comfortably
 * fits inside this even on a loaded machine.
 */
const RUN_TIMEOUT_MS = 30_000;

describe("a reviewer that never exits is killed at the harness's own deadline", () => {
  it("kills it and records the fixture's result as partial: timeout, naming the deadline", async () => {
    const result = await runIsolatedCorpus({
      cliPath: hangingStub(),
      repeats: 1,
      concurrency: 1,
      filter: "req-001",
      reviewTimeoutMs: 1_000,
    });
    expect(result.runs).toHaveLength(1);
    const record = result.runs[0]!;
    expect(record.artifact).toBeNull();
    expect(record.score).toBeNull();
    expect(record.partial).toBe("timeout");
    expect(record.failure).toContain("1000ms");
    expect(record.failure).toMatch(/killed/);
    // The harness actually waited out the deadline before returning, rather
    // than failing immediately for some other reason.
    expect(record.wall_ms).toBeGreaterThanOrEqual(500);
  }, RUN_TIMEOUT_MS);

  it("has no unbounded default: a run given no --review-timeout still carries one", () => {
    expect(DEFAULT_REVIEW_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("a run whose only review was killed is not a measurement", () => {
  it("the existing completeness floor already refuses it, rather than a new rule", async () => {
    const result = await runIsolatedCorpus({
      cliPath: hangingStub(),
      repeats: 1,
      concurrency: 1,
      filter: "req-001",
      reviewTimeoutMs: 1_000,
    });
    const summary = summariseCorpus(result, 1);
    expect(summary.completeness.point).toBe(0);
    expect(summary.not_a_measurement).toMatch(/completeness 0% is below the 90% floor/);
    for (const metric of summary.metrics) {
      expect(
        metric.meets,
        `${metric.name} must report no verdict over a run a killed review made incomplete`,
      ).toBeNull();
    }
  }, RUN_TIMEOUT_MS);
});

describe("the review deadline is visible on the command line", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints in --help, with its default", async () => {
    const said: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      said.push(String(chunk));
      return true;
    });
    // `--help` calls `process.exit(0)` from inside argument parsing; mocked so
    // this test's own process survives asking for it.
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await main(["--corpus", sampleDir, "--help"]);

    expect(exit).toHaveBeenCalledWith(0);
    const usage = said.join("");
    expect(usage).toContain("--review-timeout");
    expect(usage).toContain(`${DEFAULT_REVIEW_TIMEOUT_MS / 1000}`);
    expect(usage).toMatch(/partial: timeout/);
  });
});

describe("the review deadline is recorded in the run manifest", () => {
  it("carries the value --review-timeout named on the command line, in milliseconds", async () => {
    const out = join(scratch, "manifest-run");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = await main(
        [
          "--corpus",
          sampleDir,
          "--run",
          "--repeats",
          "1",
          "--concurrency",
          "1",
          "--filter",
          "req-001",
          "--provider",
          "claude-cli",
          "--out",
          out,
          "--review-timeout",
          "120",
        ],
        { cliPath: instantStub() },
      );
      expect(code).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }

    const manifest = JSON.parse(readFileSync(join(out, "run-manifest.json"), "utf8")) as {
      review_timeout_ms: number;
    };
    expect(manifest.review_timeout_ms).toBe(120_000);
  }, RUN_TIMEOUT_MS);

  it("refuses a --review-timeout that is not a positive number of seconds", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(
        main(["--corpus", sampleDir, "--review-timeout", "0"]),
      ).rejects.toThrow(/--review-timeout requires a positive number of seconds/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
