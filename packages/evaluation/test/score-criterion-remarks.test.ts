import { describe, expect, it } from "vitest";
import type { Finding, ReviewArtifact } from "@perbo/contracts";
import { FixtureSchema, type Fixture } from "../src/fixture.js";
import { findingAttribution, scoreRun } from "../src/score.js";

/**
 * D-082 and D-085 (SCP-248, SCP-255). On a criterion anchor, a finding confirms
 * detection when it says the criterion fails or names the mechanism; a remark on
 * how the criterion was evidenced — `criterion.unverified` and every other
 * `criterion.*` remark but `not_met`, and any `evidence.*` finding — is a
 * candidate. A reviewer that gave such an answer on the defective criterion has
 * not found the defect; the executor's work on it is the loop's catch.
 */

const fixture = (expected_detection: Record<string, unknown>): Fixture =>
  FixtureSchema.parse({
    id: "req-001-a-thing",
    class: "requirement_omission",
    defective: true,
    plan_level: "P2",
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
    expected_detection: { mode: "blocking", criterion_ids: ["ac_2"], files: [], rule_prefixes: [], ...expected_detection },
    authored_on: "2026-08-27",
    authored_before_reviewer: true,
  });

const finding = (overrides: Partial<Finding>): Finding => ({
  key: "a".repeat(64),
  rule_id: "criterion.not_met",
  source: "semantic",
  criterion_id: "ac_2",
  severity: "blocker",
  blocking: true,
  blocking_reason: "contract",
  confidence: 0.9,
  file: "packages/a/src/a.ts",
  line: 1,
  symbol: null,
  statement: "x",
  status: "open",
  outcome: "unknown",
  row: "contract",
  closure: "executor",
  direction: "negative",
  caused_by_change: null,
  routing: "blocks",
  waiver: null,
  ...overrides,
});

const artifact = (findings: Finding[]): ReviewArtifact =>
  ({
    schema_version: 1,
    review_id: "rev_test",
    created_at: "2026-09-06T00:00:00.000Z",
    decision: "changes_requested",
    error: null,
    escalated: false,
    findings,
    coverage: [],
    planned_risk: "P2",
    actual_risk: "P2",
    remediation: null,
  }) as unknown as ReviewArtifact;

const anchors = { criterion_ids: ["ac_2"], files: [], rule_prefixes: [] };

describe("a finding on the criterion anchor", () => {
  it("confirms when it says the criterion is not met", () => {
    expect(findingAttribution(finding({ rule_id: "criterion.not_met" }), anchors)).toBe("confirmed");
  });

  it("confirms when a behavioural rule names the criterion", () => {
    expect(findingAttribution(finding({ rule_id: "behaviour.off_by_one" }), anchors)).toBe("confirmed");
  });

  it("is a candidate when it says the criterion was asserted rather than shown", () => {
    expect(findingAttribution(finding({ rule_id: "criterion.unverified" }), anchors)).toBe("candidate");
  });

  it("is a candidate for every other remark on how the criterion was evidenced too", () => {
    for (const rule_id of ["criterion.no_execution_evidence", "criterion.no_test_added", "criterion.weak_discriminator", "evidence.non_discriminating_assertion"]) {
      expect(findingAttribution(finding({ rule_id }), anchors), rule_id).toBe("candidate");
    }
  });

  it("still confirms by rule prefix: a fixture that registers the family expects even the remark", () => {
    // `criterion.unverified` is the one remark the rule demotes on the criterion
    // anchor, so a prefix that admits it is what pins the order: prefix first.
    const withPrefix = { ...anchors, rule_prefixes: ["criterion."] };
    expect(findingAttribution(finding({ rule_id: "criterion.unverified" }), withPrefix)).toBe("confirmed");
  });
});

describe("scoring a blocking-mode fixture", () => {
  it("does not credit a reviewer that called the criterion met and asserted-only", () => {
    const score = scoreRun(
      fixture({}),
      artifact([finding({ rule_id: "criterion.unverified", routing: "remediable", blocking: false })]),
      2,
    );
    expect(score.attribution_status).toBe("candidate");
    expect(score.confirmed_detected).toBe(false);
    // The anchor was named, so the anchor-OR reading still counts it.
    expect(score.detected).toBe(true);
  });

  it("credits a reviewer that said the criterion is not met", () => {
    const score = scoreRun(fixture({}), artifact([finding({ rule_id: "criterion.not_met" })]), 2);
    expect(score.attribution_status).toBe("confirmed");
    expect(score.confirmed_detected).toBe(true);
  });

  it("leaves a coverage-mode fixture alone: it reads coverage entries, not findings", () => {
    const coverage = fixture({ mode: "coverage", criterion_ids: ["ac_2"], statuses: ["not_met"], strengths: ["asserted_only"] });
    const art = {
      ...artifact([finding({ rule_id: "criterion.unverified" })]),
      coverage: [{ criterion_id: "ac_2", status: "met", verification_strength: "asserted_only", evidence: null }],
    } as unknown as ReviewArtifact;
    expect(scoreRun(coverage, art, 2).confirmed_detected).toBe(true);
  });
});
