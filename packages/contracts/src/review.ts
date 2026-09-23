import { createHash } from "node:crypto";
import { z } from "zod";
import { CheckResultSchema } from "./check.js";
import { SealedCommitSchema } from "./changeset.js";
import { ContextItemSchema } from "./context.js";
import { ReviewCostBasisSchema } from "./cost.js";
import {
  ChangeSetIdSchema,
  CheckIdSchema,
  CommitShaSchema,
  CriterionIdSchema,
  NodeIdSchema,
  PlanIdSchema,
  ReviewIdSchema,
} from "./ids.js";
import { PlanLevelSchema } from "./plan.js";

/**
 * The review artifact (docs/04, SCP-011). Immutable, versioned, and pinned to a
 * plan version and a `(base_commit, head_commit)` pair.
 */

export const COVERAGE_STATUSES = ["met", "not_met", "cannot_determine"] as const;
export const CoverageStatusSchema = z.enum(COVERAGE_STATUSES);
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/**
 * How a criterion was established, not whether it was. The executor authors the
 * tests the criteria refer to, so without this a mock the executor also wrote
 * satisfies the contract and every deterministic check stays green.
 */
export const VERIFICATION_STRENGTHS = ["directly_verified", "proxy", "asserted_only"] as const;
export const VerificationStrengthSchema = z.enum(VERIFICATION_STRENGTHS);
export type VerificationStrength = (typeof VERIFICATION_STRENGTHS)[number];

export const EVIDENCE_TYPES = [
  "test_result",
  "check_result",
  "source_assertion",
  "artifact",
  "metric",
  "manual",
] as const;
export const EvidenceTypeSchema = z.enum(EVIDENCE_TYPES);

export const EvidenceSchema = z.strictObject({
  type: EvidenceTypeSchema,
  /** A check id where one applies, otherwise a repository-relative reference. */
  ref: z.string().min(1).nullable(),
  /** The specific assertion. An unnamed assertion cannot be `directly_verified`. */
  assertion: z.string().min(1).nullable(),
  location: z
    .strictObject({
      file: z.string().min(1),
      line: z.number().int().min(1).nullable(),
      symbol: z.string().min(1).nullable(),
    })
    .nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * `CriterionEvidenceBinding` — produced during review, never part of the plan.
 * The contract says what must be proven; this records what actually proved it.
 */
export const CriterionEvidenceBindingSchema = z.strictObject({
  criterion_id: CriterionIdSchema,
  status: CoverageStatusSchema,
  verification_strength: VerificationStrengthSchema,
  evidence: EvidenceSchema.nullable(),
  note: z.string().nullable().default(null),
  /**
   * Always null since D-061: a remediation round is verified rather than
   * reviewed again, so no review ever grades evidence written in answer to a
   * finding, and nothing stamps this. Retained so artifacts written under
   * SCP-094's second-review design still parse.
   */
  authored_in_response_to: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
});
export type CriterionEvidenceBinding = z.infer<typeof CriterionEvidenceBindingSchema>;

export const SEVERITIES = ["blocker", "major", "minor", "advisory"] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_SOURCES = ["deterministic", "semantic"] as const;
export const FindingSourceSchema = z.enum(FINDING_SOURCES);
export type FindingSource = (typeof FINDING_SOURCES)[number];

export const WaiverSchema = z.strictObject({
  rule_id: z.string().min(1),
  repository_id: z.string().min(1),
  authorised_by: z.string().min(1),
  granted_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  reason: z.string().min(1),
  audit_id: z.string().min(1),
});
export type Waiver = z.infer<typeof WaiverSchema>;

/**
 * The blocking matrix's outcomes, including the fifth (D-051, SCP-094).
 *
 * `remediable` is not a softer `blocking`. The gate stays closed; what changes
 * is who is asked to close it — the executor, in a new attempt whose evidence
 * is then graded independently, rather than a person who cannot adjudicate
 * "the suite mocks the module under test".
 */
export const FINDING_ROUTINGS = ["blocks", "escalates", "remediable", "advisory", "waived"] as const;
export const FindingRoutingSchema = z.enum(FINDING_ROUTINGS);
export type FindingRouting = (typeof FINDING_ROUTINGS)[number];

/**
 * The rows of the blocking matrix. The vocabulary lives here rather than in the
 * review package because the row that fired is recorded on the finding, and a
 * reader who wants to know why a finding went where it did should not have to
 * parse it back out of an English sentence.
 *
 * Recording it is also what makes a routing rule **measurable against its
 * predecessor on the same reviews**: with the row, the rule family, the
 * confidence and the reviewer's `closure` answer all on the record, the matrix
 * is a pure function of things the artifact already carries, and a stored run
 * can be scored under a rule that did not exist when it was produced.
 */
export const BLOCKING_ROWS = [
  "deterministic",
  "contract",
  "verification_strength",
  "semantic_high_risk",
  "semantic_ordinary",
] as const;
export const BlockingRowSchema = z.enum(BLOCKING_ROWS);
export type BlockingRow = (typeof BLOCKING_ROWS)[number];

/**
 * Who can close a finding, asked of the reviewer as structured output (D-051).
 *
 * The vocabulary is here, with the finding it is recorded on; the question's
 * wording and the schema that constrains the answer stay in the review package,
 * because those are prompt surface and this is contract surface.
 *
 * `human` is the conservative value, not `unclear`. Under
 * [D-056](../../../docs/11-open-decisions.md) `unclear` routes to the executor,
 * so a transport that cannot supply an answer must fall back to `human` to keep
 * producing the pre-routing behaviour.
 */
export const CLOSURE_AUTHORITIES = ["executor", "human", "unclear"] as const;
export const ClosureAuthoritySchema = z.enum(CLOSURE_AUTHORITIES);
export type ClosureAuthority = (typeof CLOSURE_AUTHORITIES)[number];

/**
 * Whether a finding has a direction, asked of the reviewer as structured
 * output (D-064).
 *
 * `negative` — a defect, weakness or risk: it should not be that way, so
 * fixing it needs no product decision. `neutral` — observable behaviour the
 * specification does not describe: no correct direction exists, and whether
 * the software should do it is a product question. The wording was validated
 * on a human first: the owner classified the whole blocking-on-clean
 * population under it, blind (stage-3-scp111-result.md).
 *
 * The vocabulary is here, with the finding the answer is recorded on; the
 * question's wording stays in the review package as prompt surface. `unsure`
 * is the conservative value: under D-064 only an affirmative `negative` opens
 * the fix-and-notify path, so a transport that cannot supply an answer must
 * fall back to a value that keeps the pre-D-064 gate.
 */
export const FINDING_DIRECTIONS = ["negative", "neutral", "unsure"] as const;
export const FindingDirectionSchema = z.enum(FINDING_DIRECTIONS);
export type FindingDirection = (typeof FINDING_DIRECTIONS)[number];

/**
 * Which statement of the routing rule produced an artifact's outcomes.
 *
 * `d051` is the rule Stage 2 measured: only an affirmative `executor` routes,
 * and the contract row never routes at all. `d056` is the widened rule, where
 * `human` is the only dispositive answer and the contract row routes on the
 * coverage entry's own closure. `d064` is notify-and-fix: a finding with a
 * direction — negative, per the reviewer's structured answer, or negative by
 * construction on the contract and verification rows — routes to the executor
 * while rounds remain, whatever the closure answer; a neutral or unclassified
 * finding keeps the `d056` outcome and stops, and `security.*`/`context.*`
 * stop regardless of direction, per the owner's 2026-08-30 ruling. Stamped on
 * the artifact for the same reason `prompt_version` is: a number that moved
 * between two runs should say which of the things that changed was the rule.
 *
 * `d065` is the attempt as the discriminator: every stopping finding on a
 * routable row goes to the executor — whatever the direction or closure
 * answer — and the executor either finds the established practice and fixes,
 * or declares that no determinable practice exists, which is what stops for a
 * person. The up-front classification `d064` gated on is recorded but decides
 * nothing; the stop is discovered by trying.
 */
export const ROUTING_POLICIES = ["d051", "d056", "d064", "d065", "d066", "d067", "d068", "d069"] as const;
export const RoutingPolicySchema = z.enum(ROUTING_POLICIES);
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

/**
 * `routing` is derived from `blocking` when it is absent, so an artifact
 * written before D-051 stays readable and stays scoreable. A plain
 * `.default("advisory")` would be worse than nothing here: it would silently
 * relabel every blocking finding in a Stage 1 artifact as advisory.
 *
 * `row` has no such derivation and defaults to `null`: an artifact written
 * before the row was recorded cannot have it reconstructed, and inventing one
 * would make a re-scored number look like a measurement.
 */
const withDerivedRouting = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if ("routing" in record) return record;
  return { ...record, routing: record.blocking === true ? "blocks" : "advisory" };
};

export const FindingSchema = z.preprocess(
  withDerivedRouting,
  z.strictObject({
    /** `sha256(rule_id | criterion_id | file | symbol)`. Carries resolution across runs. */
    key: z.string().regex(/^[0-9a-f]{64}$/),
    rule_id: z.string().min(1),
    source: FindingSourceSchema,
    criterion_id: CriterionIdSchema.nullable(),
    severity: SeveritySchema,
    blocking: z.boolean(),
    /**
     * Which row of the blocking matrix decided `blocking`. Recorded so the
     * decision is auditable as a lookup rather than inferred from a number.
     */
    blocking_reason: z.string().min(1),
    /**
     * Which outcome the matrix produced. `blocking` stays a boolean because it is
     * what the merge gate reads; `routing` is what the loop reads, and the two
     * disagree on exactly one value: a `remediable` finding is real, is not
     * blocking, and has somewhere to go.
     */
    routing: FindingRoutingSchema,
    /**
     * The row that fired, structured. `null` only on an artifact written before
     * the row was recorded — never on one this code produced.
     */
    row: BlockingRowSchema.nullable().default(null),
    /**
     * The reviewer's own answer to "who can close this", kept beside the outcome
     * it produced. `null` where the question does not apply: a deterministic
     * finding is not asked — it is never routed, but for a legibility finding
     * the change itself caused, which d068 routes on `caused_by_change`, and a
     * pinned check the change itself broke, which d069 routes the same way.
     */
    closure: ClosureAuthoritySchema.nullable().default(null),
    /**
     * The reviewer's answer to "does this finding have a direction" (D-064),
     * kept beside the outcome for the same replayability reason as `closure`.
     * `null` on artifacts written before the question existed, on
     * deterministic findings (nothing is asked), and on the contract and
     * verification rows, whose direction is negative by construction rather
     * than by answer.
     */
    direction: FindingDirectionSchema.nullable().default(null),
    /**
     * For a `legibility.*` finding: whether the illegible bytes are on a line or
     * in a file this change added or modified, which is what lets d068 route it
     * to the executor. For a `check.*` finding: whether the check ran and failed
     * on a tree whose base passed the workspace's verify command at
     * provisioning (verify may run fewer checks than the pinned set), which is
     * what lets d069 route it. `null` on every other finding, on a check that
     * did not run, and on artifacts written before the question existed.
     */
    caused_by_change: z.boolean().nullable().default(null),
    /** `null` for deterministic findings: a measurement has no confidence term. */
    confidence: z.number().min(0).max(1).nullable(),
    file: z.string().min(1).nullable(),
    line: z.number().int().min(1).nullable(),
    symbol: z.string().min(1).nullable(),
    statement: z.string().min(1),
    status: z.enum(["open", "resolved", "waived"]),
    outcome: z.enum(["fixed", "dismissed", "waived", "superseded", "unknown"]),
    waiver: WaiverSchema.nullable(),
  }),
);
export type Finding = z.infer<typeof FindingSchema>;

/**
 * `hash(rule_id | criterion_id | file | symbol)`. Absent parts are the empty
 * string so a finding without a symbol still gets a stable key.
 */
export function findingKey(parts: {
  rule_id: string;
  criterion_id?: string | null;
  file?: string | null;
  symbol?: string | null;
}): string {
  const joined = [
    parts.rule_id,
    parts.criterion_id ?? "",
    parts.file ?? "",
    parts.symbol ?? "",
  ].join("|");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

export const IndependenceSchema = z.strictObject({
  context_builder: z.string().min(1),
  executor_narrative_visible: z.literal(false),
  executor_transcript_visible: z.literal(false),
  separate_process: z.boolean(),
  model_family: z.enum(["same", "different"]),
  grounded_in: z.array(z.string().min(1)),
});
export type Independence = z.infer<typeof IndependenceSchema>;

/**
 * A model assertion discarded because a deterministic check measured the same
 * thing (ADR-0023 §3). Recording the override is half the control: an
 * unrecorded discard is indistinguishable from the model never claiming it.
 */
export const DeterministicOverrideSchema = z.strictObject({
  check_id: CheckIdSchema,
  check_name: z.string().min(1),
  measured_status: z.string().min(1),
  asserted_status: z.string().min(1),
  discarded: z.string().min(1),
});
export type DeterministicOverride = z.infer<typeof DeterministicOverrideSchema>;

export const ScopeDeviationSchema = z.strictObject({
  files_outside_scope: z.array(z.string().min(1)),
  files_in_prohibited_paths: z.array(z.string().min(1)),
  files_exempt_as_generated: z.array(z.string().min(1)),
  within_expansion_budget: z.boolean(),
  expansion_budget_files: z.number().int().min(0),
});
export type ScopeDeviation = z.infer<typeof ScopeDeviationSchema>;

export const REVIEW_DECISIONS = [
  "approve",
  "changes_requested",
  "escalate",
  "remediable",
  "error",
  "incomplete",
] as const;
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const VERDICT_REJECTION_KINDS = ["malformed_verdict", "unknown_criterion_id"] as const;
export const VerdictRejectionKindSchema = z.enum(VERDICT_REJECTION_KINDS);
export type VerdictRejectionKind = (typeof VERDICT_REJECTION_KINDS)[number];

/**
 * A verdict the plan could not accept, with the reason the review gave for
 * rejecting it. `attempt` counts from 1 in the order the verdicts were
 * returned; there are at most two, because the reviewer is asked to correct a
 * rejected verdict exactly once (SCP-165).
 */
export const RejectedVerdictSchema = z.strictObject({
  attempt: z.number().int().min(1),
  kind: VerdictRejectionKindSchema,
  reason: z.string().min(1),
});
export type RejectedVerdict = z.infer<typeof RejectedVerdictSchema>;

export const ReviewErrorSchema = z.strictObject({
  kind: z.enum([
    "provider_unavailable",
    "budget_exhausted",
    "timeout",
    "malformed_verdict",
    "unknown_criterion_id",
    /**
     * Every verdict the reviewer submitted was one the plan could not accept.
     * Distinct from a provider outage: the transport worked and the model
     * answered — what it answered could not be used.
     */
    "verdict_rejected",
    "internal",
  ]),
  message: z.string().min(1),
  attempts: z.number().int().min(0),
  unresolved_criteria: z.array(CriterionIdSchema),
  /**
   * The files the reviewer had last asked to read when this error ended the
   * review, oldest first, or empty where it failed before reading anything.
   *
   * It is here because a stop that says only `provider_unavailable` gives a
   * re-run nothing to do differently: AYO-33's review died on the one file in
   * the change set carrying a NUL byte, the note could not say which, and a
   * re-run over the same sealed commit would have died the same way (SCP-188).
   * Paths only — never any of what was read. Defaulted so an artifact written
   * before it parses.
   */
  reading: z.array(z.string().min(1)).default([]),
});
export type ReviewError = z.infer<typeof ReviewErrorSchema>;

export const REVIEW_ARTIFACT_SCHEMA_VERSION = 1;

export const ReviewArtifactSchema = z.strictObject({
  schema_version: z.literal(REVIEW_ARTIFACT_SCHEMA_VERSION),
  review_id: ReviewIdSchema,
  /**
   * The review this one continued, where an earlier attempt ended in `error` or
   * `incomplete` and only its unresolved criteria were re-run.
   */
  resumed_from: ReviewIdSchema.nullable().default(null),
  created_at: z.iso.datetime(),
  target: z.strictObject({
    type: z.literal("changeset"),
    id: ChangeSetIdSchema,
    base_commit: CommitShaSchema,
    head_commit: CommitShaSchema,
    /**
     * Commits of the range that were sealed before the attempt this review
     * judges, oldest first, each naming the attempt that sealed it where that
     * record is on hand. The runner fills it in; the reviewer neither sees it
     * nor is told which commits are new. Defaulted so an artifact written
     * before it parses.
     */
    prior_commits: z.array(SealedCommitSchema).default([]),
  }),
  plan_id: PlanIdSchema,
  plan_version: z.number().int().positive(),
  planned_risk: PlanLevelSchema,
  actual_risk: PlanLevelSchema,
  /** `actual_risk` exceeded `planned_risk`: the stronger policy applies before publication. */
  escalated: z.boolean(),

  independence: IndependenceSchema,
  context_manifest: z.array(ContextItemSchema),
  checks: z.array(CheckResultSchema),
  overrides: z.array(DeterministicOverrideSchema),

  coverage: z.array(CriterionEvidenceBindingSchema),
  findings: z.array(FindingSchema),
  scope_deviation: ScopeDeviationSchema,
  /**
   * Verdicts this plan could not accept, oldest first. A review that reached an
   * acceptable verdict on the retry still records the rejected one; a review
   * where both were rejected carries `error.kind` `verdict_rejected` and no
   * verdict at all. Defaulted so an artifact written before SCP-165 parses.
   */
  rejected_verdicts: z.array(RejectedVerdictSchema).default([]),

  decision: ReviewDecisionSchema,
  /**
   * Which statement of the routing rule produced the outcomes above. Defaulted
   * to `d051` so a Stage 2 artifact read back reports the rule it actually ran
   * under rather than the current one.
   */
  routing_policy: RoutingPolicySchema.default("d051"),
  /**
   * Always null since D-061, for the same reason as
   * `coverage[].authored_in_response_to`: there is no second review to grade a
   * remediation attempt. Retained so earlier artifacts still parse.
   */
  remediation: z
    .strictObject({
      round: z.number().int().min(1),
      max_rounds: z.number().int().min(1),
      responds_to_review_id: ReviewIdSchema,
      addressed_finding_keys: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
    })
    .nullable()
    .default(null),
  confidence: z.number().min(0).max(1).nullable(),
  cost_micros: z.number().int().min(0),
  latency_ms: z.number().int().min(0),
  model: z.strictObject({
    provider: z.string().min(1),
    model_id: z.string().min(1),
    prompt_version: z.string().min(1),
    /** Total logical input, including cache reads and cache writes. */
    input_tokens: z.number().int().min(0),
    /** Subsets of input_tokens, retained so provider accounting is auditable. */
    cache_read_input_tokens: z.number().int().min(0).default(0),
    cache_creation_input_tokens: z.number().int().min(0).default(0),
    output_tokens: z.number().int().min(0),
    /**
     * A zero cost is ambiguous without this field: it can mean a real
     * zero-dollar transport or that the transport exposes no dollar measure.
     * Historical artifacts default to the estimate they were produced with.
     */
    cost_basis: ReviewCostBasisSchema.default("provider_list_estimate"),
  }),
  error: ReviewErrorSchema.nullable(),
});
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;

/**
 * One node's review, recorded beside the combined artifact (D-107). `review`
 * is null where the node held no file inside its paths to review on its own.
 */
export const NodeReviewSchema = z.strictObject({
  node_id: NodeIdSchema,
  review: ReviewArtifactSchema.nullable(),
});
export type NodeReview = z.infer<typeof NodeReviewSchema>;

/**
 * A ticket's per-node reviews, recorded as their own artifact beside the
 * combined one. A bundle written before D-107's per-node review existed
 * carries no such artifact at all; the two places that read one back
 * (`readNodeReviews` in the runner, the inspect reader) both take that as
 * `[]` before this schema is ever reached, rather than parsing anything.
 */
export const NodeReviewsSchema = z.array(NodeReviewSchema);

/**
 * docs/04, "Review CLI contract".
 *
 * `2` and `3` are separate because they fail differently: a caller checking
 * only for `2` merges changes whose review never ran.
 */
export const EXIT_CODES = {
  approve: 0,
  usage_or_input_error: 1,
  gate_closed: 2,
  did_not_complete: 3,
} as const;

export function exitCodeForDecision(decision: ReviewDecision): number {
  switch (decision) {
    case "approve":
      return EXIT_CODES.approve;
    // `remediable` exits 2 because the gate is closed. A caller that merges on
    // it would be merging a change whose missing evidence was never written —
    // which is the same defect as merging on an absent review, one step later.
    case "changes_requested":
    case "escalate":
    case "remediable":
      return EXIT_CODES.gate_closed;
    case "error":
    case "incomplete":
      return EXIT_CODES.did_not_complete;
  }
}

/**
 * Who the review hands the change to next.
 *
 * The loop has always computed this — it is what decides whether a round is
 * spent on the executor or a person is shown the findings — but it computed it
 * inside itself, over a ticket. `perbo review` on a pull request nobody
 * admitted routes the same change the same way with no loop to run it, so the
 * mapping lives here beside `exitCodeForDecision`, which is the other thing
 * every caller derives from a decision.
 *
 * `pass` rather than `approve`: it names what happens to the change, not what
 * the reviewer said about it, and nothing in this product merges anything.
 */
export const REVIEW_ROUTES = ["executor", "human", "pass"] as const;
export const ReviewRouteSchema = z.enum(REVIEW_ROUTES);
export type ReviewRoute = (typeof REVIEW_ROUTES)[number];

export interface ReviewRouting {
  decision: ReviewRoute;
  /** One sentence: why this change went where it did. */
  reason: string;
}

/**
 * `remediable_findings` is the count that survived the caller's own filter —
 * the routable families (`security.*` and `context.*` are never handed to an
 * executor, D-064). A `remediable` decision with none left is a person's, for
 * the reason the loop gives: quoting attacker-authored text into an executor
 * brief is the laundering path the trust tiers exist to prevent.
 */
export function routeForReview(input: {
  decision: ReviewDecision;
  remediable_findings: number;
}): ReviewRouting {
  switch (input.decision) {
    case "approve":
      return { decision: "pass", reason: "every criterion was met and nothing blocks" };
    case "remediable":
      return input.remediable_findings > 0
        ? {
            decision: "executor",
            reason:
              `${input.remediable_findings} finding(s) can be closed by the executor: the ` +
              "evidence is missing rather than the change being wrong",
          }
        : {
            decision: "human",
            reason: "the findings that closed the gate are not ones an executor may be handed",
          };
    case "changes_requested":
      return { decision: "human", reason: "a blocking finding stands against the change" };
    case "escalate":
      return { decision: "human", reason: "the review escalated: a person decides" };
    case "incomplete":
      return {
        decision: "human",
        reason: "the review could not resolve every criterion, so the change is unjudged (D-057)",
      };
    case "error":
      return { decision: "human", reason: "the review did not complete" };
  }
}
