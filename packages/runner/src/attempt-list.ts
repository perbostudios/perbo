import {
  attemptEnding,
  connectionName,
  ExecutionAttemptSchema,
  type ExecutionAttempt,
  type RunBundle,
} from "@perbo/contracts";
import { runNumbers, type StoredAttempt } from "./attempts.js";

/**
 * Every attempt of a ticket, in the order its record holds them, over all its
 * runs: what the pull request's list of attempts is read from
 * (D-NEW-pass-a-limited-loop-on).
 *
 * Each row is the runner's own records — the attempt on the ticket's record
 * and the review bundles that judged it — and nothing a model wrote
 * (ADR-0023): the executor's connection is the adapter that ran it, its model
 * the one the attempt was invoked with, and a reviewer's connection and model
 * the ones its bundle records.
 */

/** One review of an attempt, as its bundle records it. */
export interface ReviewRow {
  connection: string;
  model: string;
  decision: string;
}

/** One attempt of the ticket. */
export interface AttemptRow {
  attempt_id: string;
  /** Which run of the ticket made it, counting from 1. */
  run: number;
  /** Its remediation round; null where its record could not be read. */
  round: number | null;
  /** The connection and the model that ran the executor; null where its record could not be read. */
  executor: { connection: string; model: string } | null;
  /** How it ended, in Perbo's words (`attemptEnding`). */
  ended: string;
  /** The reviews that judged it, oldest first. */
  reviews: ReviewRow[];
  /**
   * Where the executor ran on another connection or model than the attempt
   * before it, why: the usage limit that ended that attempt's run, or a run
   * started on other models. Null where it ran on the same.
   */
  executorChanged: string | null;
  /** The same for the reviewer, against the review before it. */
  reviewerChanged: string | null;
}

/** The reviews of a ticket's attempts, by the attempt each judged, oldest first. */
function reviewsByAttempt(bundles: readonly RunBundle[]): Map<string, ReviewRow[]> {
  const byAttempt = new Map<string, ReviewRow[]>();
  const reviews = bundles
    // A closure verification is a review bundle too, under `cv_<attempt>`:
    // it verifies findings closed rather than reviewing the change.
    .filter((bundle) => bundle.kind === "review" && !bundle.subject_id.startsWith("cv_"))
    .filter((bundle) => typeof bundle.inputs.attempt_id === "string")
    .sort((one, other) => one.created_at.localeCompare(other.created_at));
  for (const bundle of reviews) {
    const attempt = bundle.inputs.attempt_id as string;
    byAttempt.set(attempt, [
      ...(byAttempt.get(attempt) ?? []),
      {
        connection: connectionName(bundle.versions.tool),
        model: bundle.versions.model,
        decision: typeof bundle.inputs.decision === "string" ? bundle.inputs.decision : "not recorded",
      },
    ]);
  }
  return byAttempt;
}

/** Why the role ran on another connection or model: the limit that ended the attempt before, or the run's own choice. */
function whyChanged(previous: ExecutionAttempt | null, role: "executor" | "reviewer", was: string): string {
  const limit = previous?.usage_limit ?? null;
  return limit !== null && limit.role === role
    ? `another connection or model than ${was}, after the usage limit on ${connectionName(limit.provider)}`
    : `another connection or model than ${was}, as this run was started`;
}

export function attemptList(stored: readonly StoredAttempt[], bundles: readonly RunBundle[]): AttemptRow[] {
  const runs = runNumbers(stored);
  const reviews = reviewsByAttempt(bundles);
  let previous: ExecutionAttempt | null = null;
  let lastExecutor: { connection: string; model: string } | null = null;
  let lastReview: ReviewRow | null = null;
  return stored.map((entry, index) => {
    const parsed = ExecutionAttemptSchema.safeParse(entry);
    const judged = reviews.get(entry.attempt_id) ?? [];
    if (!parsed.success) {
      return {
        attempt_id: entry.attempt_id,
        run: runs[index]!,
        round: null,
        executor: null,
        ended: "its record could not be read",
        reviews: judged,
        executorChanged: null,
        reviewerChanged: null,
      };
    }
    const attempt = parsed.data;
    const executor = { connection: connectionName(attempt.agent.adapter), model: attempt.agent.model };
    const executorChanged =
      lastExecutor !== null && (lastExecutor.connection !== executor.connection || lastExecutor.model !== executor.model)
        ? whyChanged(previous, "executor", `${lastExecutor.connection} · \`${lastExecutor.model}\``)
        : null;
    const first = judged[0];
    const reviewerChanged =
      first !== undefined && lastReview !== null && (lastReview.connection !== first.connection || lastReview.model !== first.model)
        ? whyChanged(previous, "reviewer", `${lastReview.connection} · \`${lastReview.model}\``)
        : null;
    previous = attempt;
    lastExecutor = executor;
    lastReview = judged.at(-1) ?? lastReview;
    return {
      attempt_id: attempt.attempt_id,
      run: runs[index]!,
      round: attempt.remediation_round,
      executor,
      ended: attemptEnding(attempt),
      reviews: judged,
      executorChanged,
      reviewerChanged,
    };
  });
}
