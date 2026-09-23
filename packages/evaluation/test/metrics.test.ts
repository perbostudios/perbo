import { describe, expect, it } from "vitest";
import { wilsonInterval } from "@perbo/contracts";
import {
  bootstrapQuantile,
  majority,
  percentile,
  resolvesAgainst,
  stability,
} from "../src/metrics.js";
import { renderReport } from "../src/report.js";
import type { CorpusSummary } from "../src/summarise.js";

describe("the Wilson interval the corpus reports", () => {
  it("brackets the point estimate", () => {
    const result = wilsonInterval(15, 24);
    expect(result.point).toBeCloseTo(0.625, 5);
    expect(result.low).toBeLessThan(result.point);
    expect(result.high).toBeGreaterThan(result.point);
  });

  it("stays inside [0, 1] at the extremes, where the normal approximation does not", () => {
    for (const [successes, n] of [
      [0, 10],
      [10, 10],
      [1, 3],
    ] as const) {
      const result = wilsonInterval(successes, n);
      expect(result.low).toBeGreaterThanOrEqual(0);
      expect(result.high).toBeLessThanOrEqual(1);
    }
  });

  it("narrows as n grows", () => {
    const small = wilsonInterval(15, 24);
    const large = wilsonInterval(150, 240);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it("reports nothing for an empty sample rather than zero", () => {
    expect(Number.isNaN(wilsonInterval(0, 0).point)).toBe(true);
  });
});

describe("whether a threshold is resolved", () => {
  // This is the whole of D-050: at the staged size a recall estimate carries an
  // interval wide enough to straddle 0.60, and a number that straddles its
  // threshold is not a gate.
  it("is false when the interval straddles the threshold", () => {
    const straddling = wilsonInterval(15, 24); // 0.625, interval roughly 0.42–0.79
    expect(straddling.low).toBeLessThan(0.6);
    expect(straddling.high).toBeGreaterThan(0.6);
    expect(resolvesAgainst(straddling, 0.6, "at_least")).toBe(false);
  });

  it("is true when the interval sits wholly above the threshold", () => {
    expect(resolvesAgainst(wilsonInterval(240, 240), 0.6, "at_least")).toBe(true);
  });

  it("is true when the interval sits wholly below the threshold", () => {
    expect(resolvesAgainst(wilsonInterval(0, 40), 0.6, "at_least")).toBe(true);
  });

  it("handles an at-most threshold in the same way", () => {
    expect(resolvesAgainst(wilsonInterval(0, 40), 0.25, "at_most")).toBe(true);
    expect(resolvesAgainst(wilsonInterval(3, 10), 0.25, "at_most")).toBe(false);
  });
});

describe("percentiles", () => {
  it("interpolates", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });

  it("bootstraps the same interval twice, so a reported number is reproducible", () => {
    const values = [100, 120, 140, 900, 160, 180, 200, 220];
    const first = bootstrapQuantile(values, 0.95);
    const second = bootstrapQuantile(values, 0.95);
    expect(first).toEqual(second);
    expect(first.low).toBeLessThanOrEqual(first.point);
    expect(first.high).toBeGreaterThanOrEqual(first.point);
  });
});

describe("stability across repeats", () => {
  it("counts a fixture whose repeats disagreed", () => {
    const result = stability([
      [true, true, true],
      [true, false, true],
      [false, false, false],
    ]);
    expect(result.fixtures).toBe(3);
    expect(result.split).toBe(1);
    expect(result.disagreement_rate).toBeCloseTo(1 / 3, 6);
  });

  it("takes a strict majority, so two of three counts and one of three does not", () => {
    expect(majority([true, true, false])).toBe(true);
    expect(majority([true, false, false])).toBe(false);
    expect(majority([true, false])).toBe(false);
  });
});

describe("a run that lost most of its sample", () => {
  /** The last cell of the one metric row, which is the verdict. */
  const verdictCell = (rendered: string): string => {
    const row = rendered
      .split("\n")
      .find((line) => line.startsWith("| Clean changes passing the gate"));
    if (!row) throw new Error(`no metric row in:\n${rendered}`);
    const cells = row.split("|").map((cell) => cell.trim());
    return cells[cells.length - 2]!;
  };

  // Returned with the declared type and no cast. The cast hid a `stability`
  // shape that does not exist — three required fields missing and one invented
  // — so any new required field on CorpusSummary was silently `undefined` here.
  const summary = (attempted: number, withArtifact: number): CorpusSummary => ({
      started_at: "2026-08-28T00:00:00.000Z",
      finished_at: "2026-08-28T01:00:00.000Z",
      repeats: 3,
      fixture_count: 3,
      defective_count: 2,
      clean_count: 1,
      contested_count: 0,
      contested_gate_closed: wilsonInterval(0, 0),
      runs_attempted: attempted,
      runs_failed: attempted - withArtifact,
      completeness: wilsonInterval(withArtifact, attempted),
      excluded_unprepared: [],
      metrics: [
        {
          name: "Clean changes passing the gate (false blocks ≤ 25%)",
          threshold: 0.75,
          direction: "at_least",
          by_fixture: wilsonInterval(1, 1),
          by_run: wilsonInterval(1, 1),
          // `resolves: true` so `verdict()` can actually return "met". With
          // false it returns "**met, but unresolved**" in both branches, and
          // the assertion below could not fail either way.
          resolves: true,
          meets: true,
          stability: { fixtures: 1, unanimous: 1, split: 0, disagreement_rate: 0 },
        },
      ],
      by_class: [],
      latency_ms: { p50: bootstrapQuantile([1], 0.5), p95: bootstrapQuantile([1], 0.95) },
      cost_micros: { p50: bootstrapQuantile([1], 0.5), p95: bootstrapQuantile([1], 0.95) },
      cost_coverage: wilsonInterval(1, 1),
      cost_unavailable: 0,
      did_not_complete: wilsonInterval(0, 1),
      routing: {
        clean_with_blocking_finding: wilsonInterval(0, 1),
        clean_with_remediable_finding: wilsonInterval(0, 1),
        clean_shown_to_a_person: {
          by_fixture_any_repeat: wilsonInterval(0, 1),
          by_run: wilsonInterval(0, 1),
        },
        defective_detected_by_routing: wilsonInterval(0, 1),
        remediable_findings_total: 0,
        blocking_findings_on_clean_total: 0,
        remediable_findings_on_clean_total: 0,
      },
      leaked_forbidden: [],
      per_fixture: [],
      // No cast. It hid a `stability` shape that does not exist — three
      // required fields missing and one invented — so any new required field on
      // CorpusSummary would have been silently `undefined` in every test here.
    });

  it("refuses to call any threshold met, and says so before the table", () => {
    // The shape of the run that produced this rule: 64 of 270 artifacts, a full
    // threshold table above, and the loss named underneath it.
    const rendered = renderReport(summary(270, 64), { model: "m" });
    expect(rendered.startsWith("# INVALID RUN")).toBe(true);
    expect(rendered).toContain("206 of 270 runs produced no artifact");
    expect(rendered).toContain("**invalid run**");
    // The verdict cell, not the word anywhere on the page: `toContain("met")`
    // was satisfied by "metric" in the D-050 paragraph below the table.
    expect(verdictCell(rendered)).toBe("**invalid run**");
  });

  it("reports normally once enough of the sample survived", () => {
    const rendered = renderReport(summary(270, 260), { model: "m" });
    expect(rendered).not.toContain("INVALID RUN");
    expect(verdictCell(rendered)).toBe("met");
  });

  it("puts the floor where a lost tenth is still reportable and a lost fifth is not", () => {
    expect(renderReport(summary(100, 90), { model: "m" })).not.toContain("INVALID RUN");
    expect(renderReport(summary(100, 80), { model: "m" })).toContain("INVALID RUN");
  });

  it("does not apply the dollar threshold when no completed artifact has a dollar basis", () => {
    const unavailable = summary(3, 3);
    unavailable.cost_micros = {
      p50: bootstrapQuantile([], 0.5),
      p95: bootstrapQuantile([], 0.95),
    };
    unavailable.cost_unavailable = 3;
    unavailable.cost_coverage = wilsonInterval(0, 3);
    const rendered = renderReport(unavailable, { model: "gpt-5.6-terra" });
    expect(rendered).toContain("| Review cost | — | — | not measured |");
    expect(rendered).toContain("Dollar cost unavailable for **3** completed review(s)");
    expect(rendered).not.toContain("$0.000");
  });

  it("does not report dollar quantiles for a mixed priced and unavailable run", () => {
    const mixed = summary(3, 3);
    mixed.cost_micros = {
      p50: bootstrapQuantile([], 0.5),
      p95: bootstrapQuantile([], 0.95),
    };
    mixed.cost_unavailable = 1;
    mixed.cost_coverage = wilsonInterval(2, 3);

    const rendered = renderReport(mixed, { model: "mixed" });
    expect(rendered).toContain("| Review cost | — | — | not measured |");
    expect(rendered).toContain("2/3 completed reviews");
    expect(rendered).toContain("priced subset is not used for dollar quantiles");
  });
});
