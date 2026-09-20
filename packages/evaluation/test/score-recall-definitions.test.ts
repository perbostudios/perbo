import { describe, expect, it } from "vitest";
import type { Finding, ReviewArtifact } from "@perbo/contracts";
import type { LoadedFixture } from "../src/corpus.js";
import { FixtureSchema, type Fixture } from "../src/fixture.js";
import type { HarnessResult, RunRecord } from "../src/harness.js";
import { scoreRun, withRecallDefinitions, withRecallLabels } from "../src/score.js";
import { summariseCorpus } from "../src/summarise.js";

/**
 * SCP-225: the run summary prints both recall readings.
 *
 * The scenario below is one P1 blocking-mode class (`requirement_omission`)
 * with two fixtures: one whose finding matches the seeded criterion
 * (mechanism-confirmed) and one whose finding names only the registered file
 * (a candidate — `docs/evaluation/SCORING.md`'s "file anchor proves locus,
 * not mechanism"). The mechanism reading credits one of two; the anchor-OR
 * reading, which a file-only hit satisfies, credits both — the disagreement
 * `withRecallDefinitions` is built to report rather than hide.
 */

const fixture = (id: string, overrides: Record<string, unknown> = {}): Fixture =>
  FixtureSchema.parse({
    id,
    class: "requirement_omission",
    defective: true,
    plan_level: "P1",
    source: {
      kind: "advisory",
      reference: "x",
      url: ["https://example.com/a"],
      derivation: "reconstructed",
      upstream_licence: "n/a",
      code_copied: false,
    },
    defect: "a thing",
    why_it_is_hard: "because it is the absence of a line rather than a wrong one",
    expected_detection: { mode: "blocking", criterion_ids: ["ac_2"], files: ["a.ts"], rule_prefixes: [] },
    authored_on: "2026-08-27",
    authored_before_reviewer: true,
    ...overrides,
  });

const finding = (overrides: Partial<Finding>): Finding => {
  const blocking = overrides.blocking ?? true;
  return {
    key: "a".repeat(64),
    rule_id: "criterion.not_met",
    source: "semantic",
    criterion_id: "ac_2",
    severity: "blocker",
    blocking,
    blocking_reason: "contract",
    // The routing a blocking matrix produces for this shape, derived the way
    // the contract schema derives it from `blocking`. A test that wants another
    // outcome passes `routing` itself.
    routing: blocking ? "blocks" : "advisory",
    row: null,
    closure: null,
    direction: null,
    caused_by_change: null,
    confidence: 0.9,
    file: "a.ts",
    line: 1,
    symbol: null,
    statement: "x",
    status: "open",
    outcome: "unknown",
    waiver: null,
    ...overrides,
  };
};

const artifact = (overrides: Partial<ReviewArtifact>): ReviewArtifact =>
  ({
    schema_version: 1,
    review_id: "rev_1",
    resumed_from: null,
    created_at: "2026-08-27T10:00:00Z",
    target: { type: "changeset", id: "cs_1", base_commit: "a1b2c3d", head_commit: "d4e5f6a" },
    plan_id: "plan_1",
    plan_version: 1,
    planned_risk: "P1",
    actual_risk: "P1",
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
    coverage: [],
    findings: [],
    scope_deviation: {
      files_outside_scope: [],
      files_in_prohibited_paths: [],
      files_exempt_as_generated: [],
      within_expansion_budget: true,
      expansion_budget_files: 3,
    },
    decision: "approve",
    confidence: 0.9,
    cost_micros: 1000,
    latency_ms: 1000,
    model: {
      provider: "anthropic",
      model_id: "claude-opus-5",
      prompt_version: "reviewer_v1",
      input_tokens: 1,
      output_tokens: 1,
    },
    error: null,
    ...overrides,
  }) as ReviewArtifact;

const loaded = (fx: Fixture): LoadedFixture => ({ fixture: fx }) as never;

const runRecord = (fx: Fixture, review: ReviewArtifact): RunRecord =>
  ({
    fixture_id: fx.id,
    repeat: 1,
    exit_code: 2,
    artifact: review as never,
    score: scoreRun(fx, review, 2),
    wall_ms: 1000,
    failure: null,
  }) as never;

const confirmedFixture = fixture("req-101-confirmed");
const candidateFixture = fixture("req-102-file-only-anchor");

const confirmedReview = artifact({
  decision: "changes_requested",
  findings: [finding({})],
});
// Names the registered file but not the seeded criterion: a candidate under
// attribution v2, which the anchor-OR reading still counts (any registered
// anchor, file included) and the mechanism reading does not.
const candidateReview = artifact({
  decision: "changes_requested",
  findings: [finding({ criterion_id: null, rule_id: "semantic.other" })],
});

const result: HarnessResult = {
  fixtures: [loaded(confirmedFixture), loaded(candidateFixture)],
  runs: [runRecord(confirmedFixture, confirmedReview), runRecord(candidateFixture, candidateReview)],
  started_at: "2026-09-06T00:00:00.000Z",
  finished_at: "2026-09-06T00:05:00.000Z",
  excluded_unprepared: [],
} as never;

const plain = summariseCorpus(result, 1);
const tagged = withRecallDefinitions(plain);

const findRow = (name: string) => tagged.metrics.find((metric) => metric.name === name);

describe("withRecallDefinitions", () => {
  it("confirms the disagreement: the file-only fixture counts for anchor-OR but not mechanism", () => {
    // Sanity on the scorer itself, so the rest of this test is not chasing a
    // fixture-authoring mistake.
    const confirmedScore = result.runs[0]!.score!;
    const candidateScore = result.runs[1]!.score!;
    expect(confirmedScore.confirmed_detected).toBe(true);
    expect(candidateScore.attribution_status).toBe("candidate");
    expect(candidateScore.detected).toBe(true);
    expect(candidateScore.confirmed_detected).toBe(false);
  });

  it("tags the gated P1 row mechanism without changing its name or its measured fields", () => {
    const before = plain.metrics.find((metric) => metric.name === "Blocking-defect recall, P1")!;
    const after = findRow("Blocking-defect recall, P1")!;

    expect(after.name).toBe("Blocking-defect recall, P1");
    expect((after as { definition?: string }).definition).toBe("mechanism");
    // Every measured field is copied, not recomputed: one of two fixtures is
    // mechanism-confirmed.
    expect(after.threshold).toBe(before.threshold);
    expect(after.direction).toBe(before.direction);
    expect(after.by_fixture).toEqual(before.by_fixture);
    expect(after.by_run).toEqual(before.by_run);
    expect(after.resolves).toBe(before.resolves);
    expect(after.meets).toBe(before.meets);
    expect(after.stability).toEqual(before.stability);
    expect(after.by_fixture.point).toBeCloseTo(0.5);
  });

  it("reports the anchor-OR reading of the same population as a new, ungated row", () => {
    const sibling = findRow("Blocking-defect recall, P1 (anchor-OR)")!;
    expect(sibling).toBeDefined();
    expect((sibling as { definition?: string }).definition).toBe("anchor-OR");
    expect(sibling.threshold).toBeNull();
    expect(sibling.direction).toBeNull();
    expect(sibling.resolves).toBeNull();
    expect(sibling.meets).toBeNull();
    // Both fixtures satisfy the anchor-OR reading (the file-only hit included),
    // where the mechanism row above credits only one.
    expect(sibling.by_fixture.point).toBeCloseTo(1);
    expect(sibling.by_fixture.n).toBe(2);
    expect(plain.metrics.some((metric) => metric.name === sibling.name)).toBe(false);
  });

  it("leaves every other gated row's key, threshold and direction untouched", () => {
    for (const name of [
      "Blocking-defect recall, P2",
      "Recall on the verification-defect class",
      "Scope-escape detection",
    ]) {
      const before = plain.metrics.find((metric) => metric.name === name)!;
      const after = findRow(name)!;
      expect(after.name).toBe(before.name);
      expect(after.threshold).toBe(before.threshold);
      expect(after.direction).toBe(before.direction);
      expect(after.by_fixture).toEqual(before.by_fixture);
      expect((after as { definition?: string }).definition).toBe("mechanism");
    }
    // P2 has no observed fixture here, but the sibling is still added: an
    // empty population is n=0, not a reason to omit the row.
    expect(findRow("Blocking-defect recall, P2 (anchor-OR)")).toBeDefined();
  });

  it("does not duplicate the anchor-OR row where by_class already prints one", () => {
    expect(findRow("Recall on the verification-defect class (anchor-OR)")).toBeUndefined();
    expect(findRow("Scope-escape detection (anchor-OR)")).toBeUndefined();

    const verification = tagged.by_class.find((entry) => entry.class === "verification_defect")!;
    expect((verification.summary as { definition?: string }).definition).toBe("mechanism");
    expect((verification.anchor_summary as { definition?: string } | undefined)?.definition).toBe(
      "anchor-OR",
    );

    const scopeEscape = tagged.by_class.find((entry) => entry.class === "scope_escape")!;
    expect((scopeEscape.summary as { definition?: string }).definition).toBe("mechanism");
    expect((scopeEscape.anchor_summary as { definition?: string } | undefined)?.definition).toBe(
      "anchor-OR",
    );
  });

  it("tags the class-level readings for the observed class, and they disagree the same way", () => {
    const entry = tagged.by_class.find((e) => e.class === "requirement_omission")!;
    expect((entry.summary as { definition?: string }).definition).toBe("mechanism");
    expect((entry.anchor_summary as { definition?: string } | undefined)?.definition).toBe("anchor-OR");
    expect(entry.summary.by_fixture.point).toBeCloseTo(0.5);
    expect(entry.anchor_summary!.by_fixture.point).toBeCloseTo(1);
  });

  it("tags the ungated reported recall row without adding a sibling for it", () => {
    const adversarial = findRow("Adversarial fixtures caught despite the injection (reported, not gated)")!;
    expect((adversarial as { definition?: string }).definition).toBe("mechanism");
    expect(
      findRow("Adversarial fixtures caught despite the injection (reported, not gated) (anchor-OR)"),
    ).toBeUndefined();
  });

  it("leaves a non-recall row alone", () => {
    const clean = findRow("Clean changes with no blocking finding (SCP-094)")!;
    expect((clean as { definition?: string }).definition).toBeUndefined();
  });
});

describe("withRecallLabels", () => {
  const labelled = withRecallLabels(tagged);

  it("shows the tag beside the name for a mechanism row, without touching the stored summary", () => {
    const row = labelled.metrics.find((metric) => metric.name === "Blocking-defect recall, P1 (mechanism)");
    expect(row).toBeDefined();
    // The object `withRecallDefinitions` produced — what is written to
    // summary.json and what `regression-delta.mjs` joins rows on — still
    // carries the bare name.
    expect(findRow("Blocking-defect recall, P1")!.name).toBe("Blocking-defect recall, P1");
  });

  it("does not double-suffix a row whose name already carries its tag", () => {
    const sibling = labelled.metrics.find((metric) => metric.name === "Blocking-defect recall, P1 (anchor-OR)");
    expect(sibling).toBeDefined();
    expect(labelled.metrics.some((metric) => metric.name.includes("(anchor-OR) (anchor-OR)"))).toBe(false);
  });
});
