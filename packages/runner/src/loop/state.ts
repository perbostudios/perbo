import type {
  CheckResult,
  ExecutionAttempt,
  Finding,
  IncompleteReviewPath,
  NodeReview,
  ReviewArtifact,
} from "@perbo/contracts";
import { attemptId as makeAttemptId } from "@perbo/contracts";
import type { ClosureVerification } from "@perbo/review";
import type { Workspace } from "@perbo/workspace";
import type { Decline } from "../declines.js";
import type { remediationToContinue } from "./continuation.js";

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

/**
 * How a run ended.
 *
 * Every one of these is a fact about the change or about the run, never about
 * the machinery: what a person is being asked for is different in each, and
 * `detail` says which files, which limit or which finding it turns on.
 */
export type RunOutcome =
  | "approved"
  | "changes_requested"
  | "escalated"
  | "remediation_exhausted"
  /**
   * SCP-194: a remediation round closed none of the findings it was given, so
   * the next round would be the same brief against the same evidence. The
   * detail names the keys still open. Distinct from `remediation_exhausted`,
   * which is a run that was still closing findings when it ran out of rounds
   * or of budget — the two ask a person for different things.
   */
  | "remediation_stalled"
  | "no_changes"
  | "terminated"
  /**
   * SCP-192: the branch cannot reach the base it would be merged into, and
   * the round that was given the conflict did not resolve it. Not a judgement
   * of the change either — the change set stays on its branch, and the detail
   * names the files a person or a re-run has to reconcile.
   */
  | "base_conflict"
  /**
   * The review itself did not complete: a provider outage, or every verdict
   * the reviewer returned being one the plan could not accept. Neither is a
   * judgement of the change, and the change set stays on its branch.
   */
  | "review_failed"
  /** SCP-227: a re-level run found the branch already level with its base. Nothing was done or paid for. */
  | "level"
  /**
   * SCP-227: a re-level run merged the base's tip into the branch and the
   * result stands — the checks pass and the base touched nothing in the
   * contract's scope, or a fresh review approved the merged change set. The
   * branch is pushed and the merge step read; no pull request is opened.
   */
  | "relevelled";

/** How a run ended, and what a person reads to know why. */
export interface RunEnd {
  outcome: RunOutcome;
  detail: string;
}

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

/**
 * The conflict a `resolve_conflict` round was started for, and where in the
 * round it was found.
 *
 * `before_executor` is what the loop returns to once the resolution lands. A
 * conflict found before the executor — a re-run whose sealed commits no longer
 * merge — spends its round on the resolution and the ticket's own brief
 * follows it. One found after the seal interrupted a round that had already
 * done its work, and what follows the resolution is the judgement that round
 * was heading for.
 */
export interface ConflictInterruption {
  tip: string;
  paths: string[];
  before_executor: boolean;
  /**
   * What the round was for before the conflict took it over. A run continuing
   * a remediation goes back to that remediation, not to the ticket's own brief
   * (SCP-194).
   */
  resume_kind: RoundKind;
}

/** The remediation a run continues, as `remediationToContinue` reports it. */
export type Continuation = NonNullable<ReturnType<typeof remediationToContinue>>;

/**
 * What one round of a run hands the next.
 *
 * Replaced rather than mutated, so a phase is given a state and asked what it
 * does with it: everything that survives a round is here, and everything a
 * round makes for itself is not.
 */
export interface RoundState {
  /**
   * The round, and with `transportRetry` and `ceilingContinuation` the attempt
   * within it.
   *
   * It advances explicitly rather than through a `for` header, because a round
   * can end in more than one way: it moves on when the round is answered, and
   * it stays where it is for the one further attempt a transport failure buys
   * (SCP-172), for an attempt a ceiling cut (SCP-193), or for the resolution of
   * a base conflict found before the executor (SCP-192).
   */
  readonly round: number;
  /**
   * How many **remediation** rounds have run (SCP-194).
   *
   * Separate from `round`, which counts every round the loop takes. A
   * `resolve_conflict` round is not remediation — its whole task is making the
   * branch mergeable again, and counting it would spend a ticket's rounds on
   * the base having moved. So the cap and the progress rule are read against
   * this, and the executor's brief says which remediation round it is in terms
   * of this.
   */
  readonly remediationRound: number;
  /** What this round is for; see `RoundKind`. */
  readonly kind: RoundKind;
  /**
   * The round the ticket's own brief runs in. Zero, unless a conflict found
   * before the executor spent round 0 on the resolution — which is also the
   * round a `--resume-from` diff belongs to.
   */
  readonly executeRound: number;
  /**
   * 0 for a round's own attempt and 1 for the one further attempt a transport
   * failure buys. It is the whole retry budget: a second consecutive transport
   * failure is the run's answer rather than a third attempt.
   */
  readonly transportRetry: number;
  /**
   * SCP-193: how many attempts of this round a ceiling already cut.
   *
   * A cost or iteration ceiling ends an attempt with its work sealed onto the
   * branch, and the next attempt of the same round starts over those commits —
   * SCP-164's re-run, inside one run. It is a separate counter from
   * `transportRetry` because the two are different budgets: the transport one
   * is a single retry per round, and this one runs until the ticket budget is
   * reached.
   */
  readonly ceilingContinuation: number;
  /**
   * The attempts of the current round that ended before it was answered, held
   * until the round has an attempt to record them against.
   */
  readonly superseded: ExecutionAttempt[];
  /** Provisioned once per round; a retry runs in the round's own worktree. */
  readonly workspace: Workspace;
  /**
   * SCP-192: the base the change set is measured against.
   *
   * `workspace.base_commit` is where the worktree was cut, and it does not
   * move. This does: every time the loop merges the base branch's tip into the
   * attempt's branch, the change set the checks, the review and the pull
   * request read becomes the branch against that tip. A verdict is bound to a
   * base, so the base has to be the one a person would merge into.
   */
  readonly baseCommit: string;
  /**
   * The routed findings still open, set by round 0's review and narrowed by
   * each verification. Only remediable families ever enter it.
   */
  readonly openFindings: Finding[];
  readonly finalReview: ReviewArtifact | null;
  /** The graph's per-node reviews beside `finalReview` (D-107); empty for a flat plan. */
  readonly nodeReviews: NodeReview[];
  /**
   * Whether the round now running answers a review that could not resolve every
   * criterion.
   *
   * What such a round produces is judged by a new review rather than by a
   * closure verification: the criteria are what has to be judged, and verifying
   * that one finding is closed says nothing about them. Cleared the moment that
   * review is in, so a round the re-review then routes is verified like any
   * other.
   */
  readonly reviewingAgain: boolean;
  /** Which way an incomplete review reached its end; see `TicketRunResult`. */
  readonly incompleteReview: IncompleteReviewPath | null;
  /** Filled after each round's checks; excluded from the next round's seal. */
  readonly checkArtifacts: string[];
  /**
   * The change set the round before this one sealed, by path (SCP-194).
   *
   * What a widening is measured against: a remediation round given a scope
   * escape is asked to bring the change set back inside the contract's globs,
   * and one that added files instead went the other way.
   */
  readonly previousChangedPaths: string[];
  readonly conflict: ConflictInterruption | null;
  /**
   * SCP-194: the remediation this run continues, where the record holds one.
   *
   * Read before the first round so its brief is the right one — the ticket's
   * own outcome, or the findings its last review left open. Whether the branch
   * is still at the commit that review judged is checked against the branch
   * itself, in the first round; null once that check has run.
   */
  readonly continuing: Continuation | null;
}

/** What one round hands the next beyond the counters and the round's own kind. */
type Carry = Partial<
  Pick<
    RoundState,
    | "openFindings"
    | "finalReview"
    | "nodeReviews"
    | "reviewingAgain"
    | "incompleteReview"
    | "conflict"
    | "executeRound"
    | "baseCommit"
  >
>;

/**
 * What a round's routing tells the loop to do next.
 *
 * `stop` ends the run, `advance` moves to the next round, `retry` buys one
 * more attempt of this one, and `reenter` keeps the round where it is and
 * changes what it is for. A routing function returns one of these rather than
 * acting, so what a round comes to can be asked of it directly.
 */
export type Step =
  | { next: "stop"; end: RunEnd; carry?: Carry }
  | {
      next: "retry";
      /**
       * Which budget bought the attempt: the transport's single retry
       * (SCP-172), or a ceiling continuation against the ticket's budget
       * (SCP-193).
       */
      counter: "transport" | "ceiling";
      superseded: ExecutionAttempt;
    }
  | {
      next: "advance";
      kind: RoundKind;
      remediation: boolean;
      carry?: Carry;
      /** What the loop tells the person before taking the step. */
      say?: string;
    }
  | { next: "reenter"; conflict: ConflictInterruption };

/** The step that ends a run, for a routing function that returns only that. */
export type Stop = Extract<Step, { next: "stop" }>;

/** The state the first round of a run enters with. */
export function initialRoundState(workspace: Workspace, continuing: Continuation | null): RoundState {
  return {
    round: continuing === null ? 0 : 1,
    remediationRound: continuing === null ? 0 : 1,
    kind: continuing === null ? "execute" : "remediate",
    executeRound: 0,
    transportRetry: 0,
    ceilingContinuation: 0,
    superseded: [],
    workspace,
    baseCommit: workspace.base_commit,
    openFindings: continuing?.findings ?? [],
    finalReview: continuing?.review ?? null,
    nodeReviews: continuing?.node_reviews ?? [],
    reviewingAgain: false,
    incompleteReview: null,
    checkArtifacts: [],
    previousChangedPaths: [],
    conflict: null,
    continuing,
  };
}

/**
 * The state after one step. Pure: what the step's own effects are — the wait a
 * retry sits out, the record a round leaves — is the loop's.
 */
export function applyStep(state: RoundState, step: Step): RoundState {
  if (step.next === "stop") {
    return { ...state, ...step.carry };
  }
  if (step.next === "reenter") {
    return { ...state, kind: "resolve_conflict", conflict: step.conflict };
  }
  if (step.next === "retry") {
    return {
      ...state,
      superseded: [...state.superseded, step.superseded],
      // The transport's one retry is about consecutive transport failures, and
      // a ceiling is not one: the next attempt starts with that budget whole.
      transportRetry: step.counter === "transport" ? state.transportRetry + 1 : 0,
      ceilingContinuation:
        step.counter === "ceiling" ? state.ceilingContinuation + 1 : state.ceilingContinuation,
    };
  }
  return {
    ...state,
    round: state.round + 1,
    remediationRound: step.remediation ? state.remediationRound + 1 : state.remediationRound,
    kind: step.kind,
    // The next round's retry budget and its superseded attempts are its own: a
    // transport failure sat out in this round buys nothing there.
    transportRetry: 0,
    ceilingContinuation: 0,
    superseded: [],
    ...step.carry,
  };
}
