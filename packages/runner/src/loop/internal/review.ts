import {
  findingKey,
  hasAcceptanceCriteria,
  oneLine,
  redactCredentials,
  spokenLine,
  type CheckResult,
  type Finding,
  type NodeReview,
  type PlanContract,
  type PlanContractWithCriteria,
  type ExecutionAttempt,
  type ReviewArtifact,
  type SealedCommit,
  type SecretIndex,
  type VerifiedCommit,
} from "@perbo/contracts";
import {
  isRemediableFamily,
  redactReviewArtifact,
  remediableFindings,
  reviewGraph,
  verdictSchemas,
  type runReview,
} from "@perbo/review";
import { createModel, type Model } from "@perbo/model";
import type { BundleStore } from "../../bundle.js";
import type { SealResult } from "../../seal.js";
import type { TicketRunConfig } from "./config.js";
import type { LoopPorts } from "./context.js";
import type { Ledger } from "./ledger.js";
import type { RoundState, Step } from "./state.js";

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
/** What a round's independent review is routed against. */
export interface ReviewFacts {
  review: ReviewArtifact;
  /** Whether the round this review judged was answering an incomplete verdict. */
  answeringIncomplete: boolean;
  round: number;
  remediationRound: number;
  maxRounds: number;
  /** The repository's limits file, so a stop at the cap names where to raise it. */
  configPath: string;
}

/**
 * What the round's verdict comes to: a stop, or the remediation round it buys.
 *
 * Every round that is reviewed rather than verified ends here, so the whole
 * ladder from an approval to a person being asked is one function of the
 * artifact and the rounds already spent.
 */
export function routeReview(facts: ReviewFacts): Step {
  const { review, answeringIncomplete, remediationRound, maxRounds, configPath } = facts;
  if (review.decision === "approve") {
    return {
      next: "stop",
      end: { outcome: "approved", detail: "the gate is open" },
      carry: { reviewingAgain: false },
    };
  }
  if (review.decision === "error") {
    // Neither an outage nor a rejected verdict is a judgement of the
    // change. Recording either as `changes_requested` would move the ticket
    // on the strength of a provider being down or a reviewer mis-filling a
    // form. The reason is on the detail, and both are on it when a verdict
    // was rejected twice.
    //
    // A review that stopped at the transport also says what it was reading.
    // A note carrying only `provider_unavailable` gives a re-run nothing to
    // do differently: AYO-33 died on the one file in its change set holding
    // a NUL byte, could not say which, and a re-run over the same sealed
    // commit would have died the same way (SCP-188). A verdict the plan
    // could not accept implicates no file and names none.
    const atTheTransport =
      review.error?.kind === "provider_unavailable" ||
      review.error?.kind === "timeout" ||
      review.error?.kind === "budget_exhausted";
    const reading = review.error?.reading ?? [];
    return {
      next: "stop",
      end: {
        outcome: "review_failed",
        detail:
          `review_failed: ${review.error?.kind ?? "unknown"} — ` +
          `${review.error?.message ?? "the review did not complete"}` +
          (!atTheTransport
            ? ""
            : reading.length > 0
              ? ` (reading ${reading.join(", ")})`
              : " (no file named: the review had read nothing when the transport failed)"),
      },
      carry: { reviewingAgain: false },
    };
  }
  if (review.decision === "incomplete") {
    // D-057: a review that could not resolve every criterion has not judged
    // the change, and nothing here can judge it in the reviewer's place.
    //
    // Who is asked next depends on why it could not. Where every criterion
    // it could not resolve hangs on a finding the executor may be handed,
    // the executor is asked first: that is one round against a cause the
    // product already routes, and the re-review after it reaches its own
    // verdict. Where any of them hangs on something else, or no round is
    // left, a person is asked at once — a round cannot make that criterion
    // judgeable, and spending one only delays the person.
    const { unresolved, causes, unexplained } = incompleteReviewCauses(review);
    const criteria = unresolved.join(", ") || "no criterion resolved";
    const tooLarge = review.findings.find(
      (finding) => finding.rule_id === "changeset.too_large_to_review",
    );
    if (tooLarge) {
      // A review handed no diff read nothing, so there is no cause on it to
      // route: the size is the cause, and it is a person's.
      return {
        next: "stop",
        end: {
          outcome: "escalated",
          detail:
            `incomplete_escalated: the change set was withheld from review: ${tooLarge.statement} — ` +
            "split the change or raise the cap; a person decides",
        },
        carry: { reviewingAgain: false, incompleteReview: "incomplete_escalated" },
      };
    }
    if (answeringIncomplete) {
      return {
        next: "stop",
        end: {
          outcome: "escalated",
          detail:
            `incomplete_remediated: the re-review after ${remediationRound} remediation round(s) was ` +
            `still incomplete (${criteria}), so the change is still unjudged and a person decides`,
        },
        carry: { reviewingAgain: false },
      };
    }
    if (unexplained.length > 0) {
      return {
        next: "stop",
        end: {
          outcome: "escalated",
          detail:
            `incomplete_escalated: the review was incomplete (${criteria}) and ` +
            `${unexplained.join(", ")} rests on nothing the executor may be handed, so no ` +
            "remediation round can make it judgeable; a person decides",
        },
        carry: { reviewingAgain: false, incompleteReview: "incomplete_escalated" },
      };
    }
    if (remediationRound >= maxRounds) {
      return {
        next: "stop",
        end: {
          outcome: "escalated",
          detail:
            `incomplete_escalated: the review was incomplete (${criteria}) on ${causes.length} ` +
            `finding(s) the executor could have closed, but ${maxRounds} remediation round(s) ` +
            `are already spent — raise max_remediation_rounds or ` +
            `limits.limits.remediation_rounds in ${configPath}; a person decides`,
        },
        carry: { reviewingAgain: false, incompleteReview: "incomplete_escalated" },
      };
    }
    return {
      next: "advance",
      kind: "remediate",
      remediation: true,
      say:
        `the review could not resolve ${criteria} and ${causes.length} finding(s) it routed to ` +
        "the executor are why; remediating those and reviewing again",
      carry: {
        incompleteReview: "incomplete_remediated",
        openFindings: causes,
        reviewingAgain: true,
      },
    };
  }
  if (review.decision === "remediable") {
    const routed = remediableFindings(review.findings).filter((finding) =>
      isRemediableFamily(finding.rule_id),
    );
    if (routed.length === 0) {
      // Quoting attacker-authored text into an executor brief is the
      // laundering path the trust tiers exist to prevent; a routed set
      // made entirely of never-remediated families goes to a person.
      return {
        next: "stop",
        end: {
          outcome: "escalated",
          detail: "the findings that closed the gate are not ones the executor may be handed",
        },
        carry: { reviewingAgain: false },
      };
    }
    if (remediationRound < maxRounds) {
      return {
        next: "advance",
        kind: "remediate",
        remediation: true,
        carry: { openFindings: routed, reviewingAgain: false },
      };
    }
  }
  return {
    next: "stop",
    end: {
      outcome:
        review.decision === "remediable"
          ? "remediation_exhausted"
          : review.decision === "escalate"
            ? "escalated"
            : "changes_requested",
      detail: `review ${review.decision} after ${facts.round + 1} attempt(s)`,
    },
    carry: { reviewingAgain: false },
  };
}

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
 * What a round prints of the findings its review left open, for whoever
 * watches the run, in the order the review on record lists them: each
 * redacted as the artifact is and folded to one line. A finding the reviewer
 * filed is its own words, on a line marked as the reviewer's; one the runner
 * or the review's own checks state (`source: "deterministic"`), such as a
 * flaky check, is the runner's own line, `finding: …`, and never passes for
 * the reviewer's words. Words to show, never read back.
 */
export function openFindingLines(findings: readonly Finding[], secrets: SecretIndex): string[] {
  return findings.flatMap((finding) => {
    if (finding.status !== "open") return [];
    const words = redactCredentials(secrets.redact(finding.statement).text).text;
    if (finding.source === "deterministic") {
      const flat = oneLine(words);
      return flat === "" ? [] : [`finding: ${flat}`];
    }
    const said = spokenLine("reviewer", words);
    return said === null ? [] : [said];
  });
}

/**
 * The reviewer transport.
 *
 * The submit schema is built from **this** plan's criteria and this change
 * set's checks, so the tool schema itself cannot express a criterion the plan
 * does not have. The model id and the effort are pinned by configuration,
 * each sent only where one is configured, and neither sniffed from the
 * repository.
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
    effort: config.reviewer_effort,
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

/** What the round's independent review came to, and the state it leaves. */
export interface Reviewed {
  state: RoundState;
  step: Step;
  /**
   * D-057: an incomplete verdict is a person's, and only a round that can make
   * its criteria judgeable takes it off them. So the run carries the
   * escalation from here even where the round it routes advances.
   */
  escalated: boolean;
}

/**
 * Review the round's change set independently, and route the verdict.
 *
 * Round 0's review is the one independent review; a later round carries one
 * only where it answered a verdict that could not resolve every criterion.
 */
export async function reviewRound(args: {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  state: RoundState;
  ledger: Ledger;
  bundles: BundleStore;
  attempt: ExecutionAttempt;
  sealed: SealResult;
  /** The whole-change results the reviewer's model choice and the flake findings read. */
  gating: CheckResult[];
  /** Every check result, including each node's own (D-107). */
  checks: CheckResult[];
  /** The commits the branch carried into this attempt, stated on the review's target. */
  priorCommits: SealedCommit[];
  /** What measured the contract's base commit, where anything did. */
  baseVerification: VerifiedCommit | null;
  maxRounds: number;
  configPath: string;
  secrets: SecretIndex;
  review: LoopPorts["review"];
  clock: () => Date;
  progress: (message: string) => void;
}): Promise<Reviewed> {
  const { config, contract, sealed, clock, progress } = args;
  let state = args.state;
  // The independent review: round 0's, and the re-review of a round that
  // answered an incomplete verdict. Its inputs are the plan, the change
  // set, the checks and the files it selects — and nothing about the
  // attempt that produced them.
  progress(`review round ${state.round}`);
  // A verdict the plan cannot accept is the reviewer's error, not the
  // executor's: the review asks once for a correction and, failing that,
  // records `review_failed` with the reasons (SCP-165). The change set is
  // sealed either way and stays on the branch.
  const graphOutcome = await reviewGraph(
    {
      contract,
      diff: sealed.diff,
      // The sealed form: its file list is complete whatever the diff's
      // size, and a withheld diff is refused rather than reviewed.
      changeset: sealed.changeset ?? undefined,
      // The full pinned set: whole-change and, on a graphed plan, every
      // node's own run beside it (D-107). reviewGraph narrows this to
      // each node's own results and to wholeChangeChecks for the overall
      // call, which is what `gating` already is for a flat plan.
      checks: args.checks,
      repoDir: state.workspace.path,
      model: reviewerModel(config, contract, args.gating),
      head_commit: sealed.head_commit ?? undefined,
      remediationAvailable: state.remediationRound < args.maxRounds,
      // Whether the contract's base commit passed the workspace's verify
      // command (d069 reads a pinned check failing now as the change's own
      // breakage). It is the ticket's answer, measured on the attempt that
      // provisioned at the base and read back from the record by every
      // attempt after it, so an attempt continuing over commits an earlier
      // one sealed is not told its own predecessor's breakage is the base's.
      // Verify may run fewer checks than the pinned set, and a base merged up
      // mid-run is not re-verified: a wrong reading costs one round, which the
      // verifier's own run of the checks then stops. Undefined where nothing
      // has measured the base, which the review reads as unknown.
      baseVerified: args.baseVerification === null ? undefined : args.baseVerification.verified,
      onProgress: progress,
    },
    args.review,
    { modelFor: (nodeContract, nodeChecks) => reviewerModel(config, contractWithCriteria(nodeContract, contract), nodeChecks) },
  );
  const reviewOutcome = graphOutcome.overall;

  // The artifact is the review as written. Provenance stamping belonged to
  // the retired second-review design; artifacts that carry a remediation
  // block remain readable.
  //
  // The target's provenance is the runner's to state: the reviewer judged
  // the whole range and was told nothing about which of its commits came
  // from which attempt.
  //
  // A check that failed and passed alone on the re-run is recorded
  // `passed`, so the reviewer's own `check.*` finding has nothing to fire
  // on. The flake is still the round's to report, so the runner states it
  // here as its own advisory finding: deterministic, never blocking, and
  // naming the tests.
  //
  // The combined view (D-107): a graphed plan's gate reads the overall
  // review and every reviewed node's together, so a node-local blocking
  // finding closes the gate exactly as a whole-change one does. A flat
  // plan's combined view is the overall artifact itself.
  const review: ReviewArtifact = {
    ...graphOutcome.combined,
    target: { ...graphOutcome.combined.target, prior_commits: args.priorCommits },
    findings: [...graphOutcome.combined.findings, ...flakyCheckFindings(args.gating)],
  };
  for (const line of openFindingLines(review.findings, args.secrets)) progress(line);
  const nodeReviewsThisRound: NodeReview[] = graphOutcome.nodes.map((entry) => ({
    node_id: entry.node_id,
    review: entry.outcome?.artifact ?? null,
  }));

  writeReviewBundle({
    bundles: args.bundles,
    contract,
    secrets: args.secrets,
    clock,
    review,
    outcome: reviewOutcome,
    node_reviews: nodeReviewsThisRound,
    sealed,
    round: state.round,
    remediation_available: state.remediationRound < args.maxRounds,
  });

  state = { ...state, finalReview: review, nodeReviews: nodeReviewsThisRound };
  args.ledger.addRound({
    round: state.round,
    kind: state.kind,
    attempt: args.attempt,
    superseded_attempts: state.superseded,
    review,
    node_reviews: nodeReviewsThisRound,
    verification: null,
    checks: args.checks,
    remediable_findings: remediableFindings(review.findings).length,
    directly_verified: countDirectlyVerified(review),
    declines: [],
  });

  // The round that answered an incomplete verdict has now been judged, so
  // whatever this review routes next is a closure for the verifier.
  const answeringIncomplete = state.reviewingAgain;
  const step = routeReview({
    review,
    answeringIncomplete,
    round: state.round,
    remediationRound: state.remediationRound,
    maxRounds: args.maxRounds,
    configPath: args.configPath,
  });
  return { state, step, escalated: review.decision === "incomplete" };
}
