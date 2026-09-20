import {
  findingKey,
  hasAcceptanceCriteria,
  redactCredentials,
  type CheckResult,
  type Finding,
  type NodeReview,
  type PlanContract,
  type PlanContractWithCriteria,
  type ReviewArtifact,
  type SecretIndex,
} from "@perbo/contracts";
import {
  isRemediableFamily,
  redactReviewArtifact,
  remediableFindings,
  verdictSchemas,
  type runReview,
} from "@perbo/review";
import { createModel, type Model } from "@perbo/model";
import type { BundleStore } from "../bundle.js";
import type { TicketRunConfig } from "./config.js";

/**
 * The independent review of a round, and the bundle it is recorded in.
 */

export const countDirectlyVerified = (review: ReviewArtifact | null): number =>
  review?.coverage.filter((entry) => entry.verification_strength === "directly_verified").length ?? 0;

/**
 * What made an incomplete review incomplete, and whether the executor can be
 * asked about it.
 *
 * The artifact carries no field joining a `cannot_determine` criterion to the
 * finding that caused it, so the join is the two things it does carry: the
 * finding's `criterion_id` and its routing. A finding routed `remediable`, in a
 * family the executor may be handed, **cites** a criterion when it names that
 * criterion; a finding that names no criterion at all is a fact about the whole
 * change — a check that failed, a file nothing could read — and so cites every
 * criterion the review could not resolve.
 *
 * A criterion no such finding cites is `unexplained`: either nothing was filed
 * against it, or what was filed stops for a person. One of those is enough for
 * the whole verdict to be a person's, because a round that closes the others
 * still leaves that criterion unjudged.
 */
export function incompleteReviewCauses(review: ReviewArtifact): {
  /** The criteria the review could not resolve, in the order it listed them. */
  unresolved: string[];
  /** The findings that cite them, deduplicated, in the order the review filed them. */
  causes: Finding[];
  /** The criteria no remediable finding cites. */
  unexplained: string[];
} {
  const unresolved = review.coverage
    .filter((entry) => entry.status === "cannot_determine")
    .map((entry) => entry.criterion_id);
  const routable = remediableFindings(review.findings).filter((finding) =>
    isRemediableFamily(finding.rule_id),
  );
  const causes = new Map<string, Finding>();
  const unexplained: string[] = [];
  for (const criterion_id of unresolved) {
    const cites = routable.filter(
      (finding) => finding.criterion_id === criterion_id || finding.criterion_id === null,
    );
    if (cites.length === 0) {
      unexplained.push(criterion_id);
      continue;
    }
    for (const finding of cites) causes.set(finding.key, finding);
  }
  return { unresolved, causes: [...causes.values()], unexplained };
}

/**
 * One review's bundle, written the same way wherever a review is taken: at
 * round 0, at the re-review of an incomplete verdict, and at a re-level's
 * fresh review of the merged change set (SCP-227).
 */
export function writeReviewBundle(args: {
  bundles: BundleStore;
  contract: PlanContractWithCriteria;
  secrets: SecretIndex;
  clock: () => Date;
  review: ReviewArtifact;
  outcome: Awaited<ReturnType<typeof runReview>>;
  /** The graph's per-node reviews, recorded beside `review` (D-107); empty for a flat plan. */
  node_reviews: NodeReview[];
  sealed: { excluded_paths: string[] };
  round: number;
  remediation_available: boolean;
}): void {
  const { bundles, contract, secrets, clock, review, outcome: reviewOutcome, node_reviews, sealed, round } = args;
  bundles.write({
    kind: "review",
    subject_id: review.review_id,
    ticket_id: contract.ticket_id,
    inputs: {
      // The target the verdict states, which is the key every reader joins
      // a review to its attempt by — `perbo inspect` among them. Copied,
      // never restated from the seal: what a bundle records as reviewed is
      // what the review says it reviewed.
      changeset_id: review.target.id,
      base_commit: review.target.base_commit,
      head_commit: review.target.head_commit,
      decision: review.decision,
      remediation_round: round,
      remediation_available: args.remediation_available,
    },
    context_manifest: review.context_manifest,
    versions: {
      code: "stage-2",
      prompt: review.model.prompt_version,
      policy: "blocking-matrix-v2",
      model: review.model.model_id,
      tool: review.model.provider,
    },
    usage: {
      input_tokens: review.model.input_tokens,
      output_tokens: review.model.output_tokens,
      cost_micros: review.cost_micros,
      cost_basis: review.model.cost_basis,
      wall_clock_ms: review.latency_ms,
    },
    artifacts: [
      // D-063: the artifact is redacted on the way out, not in memory. The
      // reviewer's own output stays intact for scoring; what is persisted,
      // replayed and read by a person has the credential removed.
      {
        name: "review.json",
        media_type: "application/json",
        body: JSON.stringify(redactReviewArtifact(review).artifact, null, 2),
      },
      // D-107: each reviewed node's own artifact, redacted the same way.
      {
        name: "node-reviews.json",
        media_type: "application/json",
        body: JSON.stringify(
          node_reviews.map((entry) => ({
            node_id: entry.node_id,
            review: entry.review ? redactReviewArtifact(entry.review).artifact : null,
          })),
          null,
          2,
        ),
      },
      { name: "reviewer-system-prompt.txt", media_type: "text/plain", body: reviewOutcome.bundle.system_prompt },
      // A rejected verdict is the reviewer's own output and is kept beside
      // the accepted one, so a person can read what was returned rather
      // than only why it was refused. Redacted the same way review.json is.
      ...reviewOutcome.bundle.rejected_verdicts.map((rejected) => ({
        name: `rejected-verdict-${rejected.attempt}.json`,
        media_type: "application/json",
        body: redactCredentials(
          JSON.stringify(
            { attempt: rejected.attempt, kind: rejected.kind, reason: rejected.reason, verdict: rejected.input },
            null,
            2,
          ),
        ).text,
      })),
    ],
    errors: review.error ? [{ kind: review.error.kind, message: review.error.message }] : [],
    transitions: [
      { at: clock().toISOString(), from: "VERIFYING", to: "INDEPENDENT_REVIEW", reason: review.decision },
    ],
    retention: { class: "replay_retained", expires_at: null },
    secrets,
    excluded_paths: sealed.excluded_paths,
    deterministic: false,
    model_version_pinned: true,
    now: clock(),
  });
}

/**
 * A check that failed once and passed on its own, as a finding.
 *
 * Advisory and non-blocking: the re-run is the measurement, and it passed. The
 * finding exists so the round says a suite was unstable rather than saying
 * nothing, and so the tests that were unstable are named where a person reads
 * them.
 */
export function flakyCheckFindings(checks: readonly CheckResult[]): Finding[] {
  return checks
    .filter((check) => check.flaky === true)
    .map((check) => {
      const rule_id = `check.${check.kind}_flaky`;
      const named = check.failing_tests ?? [];
      return {
        key: findingKey({ rule_id, criterion_id: null, file: null, symbol: check.name }),
        rule_id,
        source: "deterministic" as const,
        criterion_id: null,
        severity: "advisory" as const,
        blocking: false,
        blocking_reason:
          "a check that failed once and passed when its own tests were run alone is not " +
          "evidence against the change",
        confidence: null,
        file: null,
        line: null,
        symbol: check.name,
        statement:
          `The ${check.name} check failed and then passed when it was run again on its own` +
          `${named.length === 0 ? "" : `: ${named.join("; ")}`}. ` +
          "The gate is not closed on it; the suite is unstable and a person may want to look.",
        status: "open" as const,
        outcome: "unknown" as const,
        row: null,
        closure: null,
        direction: null,
        caused_by_change: null,
        routing: "advisory" as const,
        waiver: null,
      };
    });
}

/**
 * The reviewer transport.
 *
 * The submit schema is built from **this** plan's criteria and this change
 * set's checks, so the tool schema itself cannot express a criterion the plan
 * does not have. The model id is pinned by configuration, never sniffed from
 * the repository.
 */
export function reviewerModel(
  config: TicketRunConfig,
  contract: PlanContractWithCriteria,
  checks: readonly CheckResult[],
): Model {
  const schema = verdictSchemas(
    contract.acceptance_criteria.map((criterion) => criterion.id),
    [...checks.map((check) => check.check_id), "check_scope", "check_agent_config"],
  ).toolInputSchema;
  return createModel(config.reviewer_provider, {
    submitSchema: schema,
    modelId: config.reviewer_model,
  });
}

/**
 * `reviewGraph`'s `modelFor` hands back whatever contract a node or the
 * overall call is reviewing under, typed as broadly as `ReviewInput.contract`
 * is. Every one `reviewerModel` is ever actually asked to build a schema for
 * carries criteria — a node's own, narrowed, or the ticket's own contract,
 * already `PlanContractWithCriteria` — so this narrows without discarding a
 * P0 contract it should never see, falling back to the ticket's own only to
 * keep the type total.
 */
export function contractWithCriteria(
  contract: PlanContract,
  ticketContract: PlanContractWithCriteria,
): PlanContractWithCriteria {
  return hasAcceptanceCriteria(contract) ? contract : ticketContract;
}
