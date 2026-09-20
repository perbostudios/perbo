import {
  ReviewArtifactSchema,
  type Finding,
  type ReviewArtifact,
} from "@perbo/contracts";

/**
 * Typed builders for the loop's own tests.
 *
 * A phase test states one fact, so each builder carries a whole valid value
 * and takes an override for the field under test. They are parsed through the
 * schemas rather than asserted into shape, so a builder that has drifted from
 * a contract fails here rather than in the phase.
 */

export const finding = (overrides: Partial<Finding> = {}): Finding => ({
  key: "f".repeat(64),
  rule_id: "test.missing_for_criterion",
  source: "semantic",
  criterion_id: "ac_1",
  severity: "major",
  blocking: false,
  blocking_reason: "verification: routed to the executor",
  routing: "remediable",
  row: null,
  closure: null,
  direction: null,
  caused_by_change: null,
  confidence: 0.9,
  file: "src/feature.ts",
  line: 1,
  symbol: "total",
  statement: "No test exercises total(); nothing establishes ac_1.",
  status: "open",
  outcome: "unknown",
  waiver: null,
  ...overrides,
});

export function review(overrides: {
  review_id?: string;
  decision?: ReviewArtifact["decision"];
  findings?: Finding[];
  head_commit?: string;
  coverage?: Array<{
    criterion_id: string;
    status: "met" | "not_met" | "cannot_determine";
    verification_strength?: "directly_verified" | "proxy" | "asserted_only";
  }>;
} = {}): ReviewArtifact {
  return ReviewArtifactSchema.parse({
    schema_version: 1,
    review_id: overrides.review_id ?? "rev_0000000000000001",
    created_at: "2026-08-27T00:00:00.000Z",
    target: {
      type: "changeset",
      id: "cs_0000000000000001",
      base_commit: "abc1234",
      head_commit: overrides.head_commit ?? "def5678",
    },
    plan_id: "plan_stage2",
    plan_version: 1,
    planned_risk: "P1",
    actual_risk: "P1",
    escalated: false,
    independence: {
      context_builder: "reviewer_v2",
      executor_narrative_visible: false,
      executor_transcript_visible: false,
      separate_process: true,
      model_family: "same",
      grounded_in: ["plan.acceptance_criteria", "diff", "check_results", "selected_files"],
    },
    context_manifest: [],
    checks: [],
    overrides: [],
    coverage: (overrides.coverage ?? [{ criterion_id: "ac_1", status: "met" as const }]).map(
      (entry) => ({
        criterion_id: entry.criterion_id,
        status: entry.status,
        verification_strength: entry.verification_strength ?? "asserted_only",
        evidence: null,
        note: null,
      }),
    ),
    findings: overrides.findings ?? [],
    scope_deviation: {
      files_outside_scope: [],
      files_in_prohibited_paths: [],
      files_exempt_as_generated: [],
      within_expansion_budget: true,
      expansion_budget_files: 2,
    },
    decision: overrides.decision ?? "approve",
    confidence: 0.9,
    cost_micros: 1000,
    latency_ms: 100,
    model: {
      provider: "stub",
      model_id: "stub",
      prompt_version: "reviewer_v2",
      input_tokens: 1,
      output_tokens: 1,
    },
    error: null,
  });
}
