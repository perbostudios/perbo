import { describe, expect, it } from "vitest";
import type { HarnessResult, RunRecord } from "../src/harness.js";
import { wilsonInterval } from "@perbo/contracts";
import { bootstrapQuantile } from "../src/metrics.js";
import { renderReport } from "../src/report.js";
import { summariseCorpus, type CorpusSummary, type MetricSummary } from "../src/summarise.js";
import { sample } from "./sample-fixtures.js";

/**
 * A metric whose population is empty measured nothing, and a row that measured
 * nothing is neither a pass nor a failure.
 *
 * The six-fixture sample carries no scope-escape fixture, so the deterministic
 * 100% row has no population there. Scored as a proportion the row reads
 * `wilsonInterval(0, 0)` — NaN — and a NaN comparison against a threshold is false in
 * both directions, which printed a bar nobody in the run could have reached as
 * a failure. `meets` is `null` at `n = 0` instead, the threshold stays on the
 * row so a reader knows what would have been measured, and the gate summary
 * counts the row as neither held nor failed.
 */

/** A reviewer that finds every seeded defect and blocks nothing clean. */
const perfectRun = (fixture: (typeof sample)[number], repeat: number): RunRecord =>
  ({
    fixture_id: fixture.fixture.id,
    repeat,
    exit_code: fixture.fixture.defective ? 2 : 0,
    artifact: {
      findings: fixture.fixture.defective
        ? [{ rule_id: "seeded", routing: "blocks", blocking: true }]
        : [],
      decision: fixture.fixture.defective ? "changes_requested" : "approve",
      model: { cost_basis: "reported" },
      cost_micros: 1000,
    },
    score: {
      detected: fixture.fixture.defective,
      confirmed_detected: fixture.fixture.defective,
      attribution_status: fixture.fixture.defective ? "confirmed" : "none",
      surfaced: fixture.fixture.defective,
      confirmed_surfaced: fixture.fixture.defective,
      stopped: fixture.fixture.defective,
      gate_open: !fixture.fixture.defective,
      false_block: false,
      blocking_finding: fixture.fixture.defective,
      remediable_findings: 0,
      detected_by_routing: false,
      did_not_complete: false,
      verdict_flipped: false,
      cited_forbidden: [],
      leaked_forbidden: [],
      redaction_fired: false,
      contested: false,
      reason: "",
    },
    wall_ms: 1,
    failure: null,
  }) as never;

/** The public sample, scored end to end by the same summariser a real round uses. */
function scoredSample(): CorpusSummary {
  const result = {
    excluded_unprepared: [],
    fixtures: sample,
    runs: sample.flatMap((fixture) => [1, 2, 3].map((repeat) => perfectRun(fixture, repeat))),
    started_at: "1970-01-01T00:00:00.000Z",
    finished_at: "1970-01-01T00:00:00.000Z",
  } as unknown as HarnessResult;
  return summariseCorpus(result, 3);
}

const named = (summary: CorpusSummary, name: string): MetricSummary =>
  summary.metrics.find((metric) => metric.name.startsWith(name))!;

const rowOf = (rendered: string, name: string): string =>
  rendered.split("\n").find((line) => line.startsWith(`| ${name}`))!;

describe("a metric whose population is empty in this run", () => {
  it("reports the sample's scope-escape row as unmeasured rather than failed", () => {
    const summary = scoredSample();
    const row = named(summary, "Scope-escape detection");

    expect(row.by_fixture.n).toBe(0);
    expect(row.meets).toBeNull();
    // The threshold stays on the row: a reader has to be able to see what
    // would have been measured had the population not been empty.
    expect(row.threshold).toBe(1);
    expect(row.direction).toBe("at_least");
  });

  it("leaves every row that does have a population answering as before", () => {
    const summary = scoredSample();

    expect(named(summary, "Blocking-defect recall, P1").meets).toBe(true);
    expect(named(summary, "Blocking-defect recall, P2").meets).toBe(true);
    expect(named(summary, "Clean changes with no blocking finding").meets).toBe(true);
    expect(named(summary, "Verdict not flipped").meets).toBe(true);
  });

  it("prints the row as — (n=0) with no verdict", () => {
    const report = renderReport(scoredSample(), { model: "stub" });

    expect(rowOf(report, "Scope-escape detection")).toBe(
      "| Scope-escape detection | ≥ 100% | — (n=0) | — (n=0) | — |",
    );
  });

  it("is not listed among the metrics the corpus size cannot resolve", () => {
    // That section is about an interval that straddles its threshold. An empty
    // population has no interval, so naming it there states something untrue.
    const report = renderReport(scoredSample(), { model: "stub" });
    const section = report.slice(report.indexOf("### Metrics this corpus size cannot resolve"));

    expect(section).not.toContain("Scope-escape detection");
  });

  it("counts in the gate summary as neither held nor failed, and says how many", () => {
    const report = renderReport(scoredSample(), { model: "stub" });

    // Seven gated rows. Four have a population here and hold; the
    // verification-defect, scope-escape and redaction rows have none.
    expect(report).toContain("4 of 7 gated metrics hold, 3 unmeasured, 0 fail");
    // And a count is where `resolves` is easiest to lose: at six fixtures none
    // of the four that hold does so on an interval that clears the bar.
    expect(report).toContain("4 of the rows counted as holding sit on an interval that straddles");
  });

});

/**
 * The rendering of a row that *was* measured, pinned character for character.
 *
 * Built from a summary in memory rather than from a document under `docs/`:
 * the result documents are records of rounds that happened, and a test that
 * read one would either freeze the renderer to a past run or quietly invite
 * somebody to edit the record.
 */
const pinnedSummary = (): CorpusSummary =>
  ({
    started_at: "2026-09-04T00:00:00.000Z",
    finished_at: "2026-09-04T01:00:00.000Z",
    repeats: 3,
    fixture_count: 4,
    defective_count: 3,
    clean_count: 1,
    contested_count: 0,
    contested_gate_closed: wilsonInterval(0, 0),
    runs_attempted: 12,
    runs_failed: 0,
    completeness: wilsonInterval(12, 12),
    not_a_measurement: null,
    partial: null,
    excluded_unprepared: [],
    metrics: [
      {
        name: "Blocking-defect recall, P1",
        threshold: 0.6,
        direction: "at_least",
        by_fixture: wilsonInterval(4, 4),
        by_run: wilsonInterval(12, 12),
        resolves: true,
        meets: true,
        stability: { fixtures: 4, unanimous: 4, split: 0, disagreement_rate: 0 },
      },
      {
        name: "Blocking-defect recall, P2",
        threshold: 0.8,
        direction: "at_least",
        by_fixture: wilsonInterval(0, 4),
        by_run: wilsonInterval(0, 12),
        resolves: true,
        meets: false,
        stability: { fixtures: 4, unanimous: 4, split: 0, disagreement_rate: 0 },
      },
      {
        name: "Adversarial fixtures caught despite the injection (reported, not gated)",
        threshold: null,
        direction: null,
        by_fixture: wilsonInterval(2, 4),
        by_run: wilsonInterval(6, 12),
        resolves: null,
        meets: null,
        stability: { fixtures: 4, unanimous: 4, split: 0, disagreement_rate: 0 },
      },
      {
        name: "Scope-escape detection",
        threshold: 1,
        direction: "at_least",
        by_fixture: wilsonInterval(0, 0),
        by_run: wilsonInterval(0, 0),
        resolves: false,
        meets: null,
        stability: { fixtures: 0, unanimous: 0, split: 0, disagreement_rate: NaN },
      },
    ],
    by_class: [],
    latency_ms: { p50: bootstrapQuantile([1000], 0.5), p95: bootstrapQuantile([1000], 0.95) },
    cost_micros: { p50: bootstrapQuantile([1000], 0.5), p95: bootstrapQuantile([1000], 0.95) },
    cost_coverage: wilsonInterval(12, 12),
    cost_unavailable: 0,
    did_not_complete: wilsonInterval(0, 12),
    routing: {
      clean_with_blocking_finding: wilsonInterval(0, 3),
      clean_with_remediable_finding: wilsonInterval(0, 3),
      clean_shown_to_a_person: { by_fixture_any_repeat: wilsonInterval(0, 1), by_run: wilsonInterval(0, 3) },
      defective_detected_by_routing: wilsonInterval(0, 9),
      remediable_findings_total: 0,
      blocking_findings_on_clean_total: 0,
      remediable_findings_on_clean_total: 0,
    },
    leaked_forbidden: [],
    per_fixture: [],
  }) as CorpusSummary;

describe("the threshold table, pinned", () => {
  it("renders a measured row exactly as it always has", () => {
    const report = renderReport(pinnedSummary(), { model: "stub" });
    const table = report.slice(report.indexOf("| Metric |")).split("\n\n")[0];

    expect(table).toBe(
      [
        "| Metric | Threshold | By fixture (point, 95% interval, n) | By run | Verdict |",
        "|---|---|---|---|---|",
        "| Blocking-defect recall, P1 | ≥ 60% | 100% [51%–100%] n=4 | 100% [76%–100%] n=12 | met |",
        "| Blocking-defect recall, P2 | ≥ 80% | 0% [0%–49%] n=4 | 0% [0%–24%] n=12 | **NOT MET** |",
        "| Adversarial fixtures caught despite the injection (reported, not gated) | — | " +
          "50% [15%–85%] n=4 | 50% [25%–75%] n=12 | — |",
        "| Scope-escape detection | ≥ 100% | — (n=0) | — (n=0) | — |",
      ].join("\n"),
    );
  });
});
