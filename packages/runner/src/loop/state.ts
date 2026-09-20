import type {
  CheckResult,
  ExecutionAttempt,
  NodeReview,
  ReviewArtifact,
} from "@perbo/contracts";
import { attemptId as makeAttemptId } from "@perbo/contracts";
import type { ClosureVerification } from "@perbo/review";
import type { Decline } from "../declines.js";

/**
 * What one round of a run hands the next.
 *
 * The loop's own state, kept apart from the phases that read it so that a
 * phase can be given a state and asked what it does with it.
 */

/**
 * What a round was for (SCP-192).
 *
 * `execute` is the ticket, `remediate` answers routed findings, and
 * `resolve_conflict` does one thing only: make a branch that has stopped
 * merging into its base mergeable again. The third is a round like the others —
 * a new attempt, sealed, checked and judged — and it is here rather than
 * inferred from the round number because a reader counting remediation rounds
 * must not count it as one.
 */
export type RoundKind = "execute" | "remediate" | "resolve_conflict";

export interface RoundRecord {
  round: number;
  kind: RoundKind;
  attempt: ExecutionAttempt;
  /**
   * Attempts of this same round that ended before `attempt` was started,
   * oldest first, and empty where the round took one attempt.
   *
   * Two things put an attempt here: a transport failure the loop sat out
   * (SCP-172), and a ceiling the run continued past (SCP-193). Neither answered
   * the round, and both were paid for.
   *
   * They live here rather than as records of their own because `rounds` holds
   * exactly one entry per round: a reader counting rounds counts entries, and
   * neither an outage nor a ceiling must turn one round into two. Every attempt
   * in here is also on the ticket's attempts record and priced into the run's
   * cost, so nothing is hidden by being nested.
   */
  superseded_attempts: ExecutionAttempt[];
  /**
   * The review that judged this round, where one did.
   *
   * Round 0's is the one independent review. A later round carries one only
   * where it was answering a review that could not resolve every criterion:
   * nothing about that is a closure to verify, so the round is reviewed again
   * and the verdict is the new review's.
   */
  review: ReviewArtifact | null;
  /**
   * Each reviewed node's own artifact beside the round's combined review
   * (D-107): `null` for a node with no file inside its paths this round,
   * empty for a flat plan.
   */
  node_reviews: NodeReview[];
  /** A round that answered routed findings: the closure verification (D-061). */
  verification: ClosureVerification | null;
  checks: CheckResult[];
  remediable_findings: number;
  directly_verified: number;
  /** D-065: findings the executor declared no-determinable-practice for, with reasons. */
  declines: Decline[];
}

/**
 * The id of one attempt of one round.
 *
 * Round 0's first attempt is the run's root, which is what the worktree, the
 * branch and the attempts record are all keyed by, so it keeps that id
 * exactly. Everything after it is minted from the root and the position — the
 * round, the ceiling continuation within it and the transport retry within
 * that — so the same run never mints one id twice and a reader can see from the
 * seed which attempt it is looking at.
 */
export function attemptIdFor(position: {
  root: string;
  round: number;
  transport_retry: number;
  ceiling_continuation: number;
}): string {
  if (position.round === 0 && position.transport_retry === 0 && position.ceiling_continuation === 0) {
    return position.root;
  }
  const seeded = position.ceiling_continuation === 0 ? "" : `|continue|${position.ceiling_continuation}`;
  const retry = position.transport_retry === 0 ? "" : `|transport|${position.transport_retry}`;
  return makeAttemptId(`${position.root}|round|${position.round}${seeded}${retry}`);
}
