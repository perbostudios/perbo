import { z } from "zod";

/**
 * A provider's usage limit that ended a run, and whose it was
 * ([D-NEW-pass-a-limited-loop-on](../../../docs/11-open-decisions.md)).
 *
 * A usage limit belongs to a connection — every model a Claude Code login, a
 * Codex login, an OpenCode login or an Anthropic API key reaches — and not to
 * one model, so what a person carries the work on with is another connection.
 * Nothing about the plan or the work stands in the way of carrying on: the
 * work is sealed on the branch and in its execution bundle, and the next
 * attempt starts from it on whichever connection the person chooses.
 */

/** The two roles a provider's limit can stop: the executor's attempt, or the review of its work. */
export const USAGE_LIMIT_ROLES = ["executor", "reviewer"] as const;
export const UsageLimitRoleSchema = z.enum(USAGE_LIMIT_ROLES);
export type UsageLimitRole = (typeof USAGE_LIMIT_ROLES)[number];

/**
 * The limit a run stopped on, as the runner recorded it on the attempt it
 * stopped after.
 *
 * `provider` is the connection in the run configuration's words
 * (`claude-cli`, `codex-cli`, `opencode-cli`, `anthropic`) and `model` the
 * model that connection was running, both from the runner's own records: the
 * run configuration for the executor, the refused review's own artifact for
 * the reviewer. `until` is the instant the provider's stated reset names, and
 * `quoted` the provider's own sentence it was read from.
 */
export const UsageLimitSchema = z.strictObject({
  role: UsageLimitRoleSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  until: z.iso.datetime(),
  zone: z.string().min(1),
  quoted: z.string().min(1),
});
export type UsageLimit = z.infer<typeof UsageLimitSchema>;

/**
 * The limit a run ended on, and whether the run had already waited for one
 * reset of it before it ended.
 */
export type UsageLimitStop = UsageLimit & {
  /**
   * True where the run sat out the reset the provider stated and was refused
   * again after it: the stated reset has passed, and the limit is what the
   * provider said once more.
   */
  waited: boolean;
};

/** The fields of an attempt record the answer is read from. */
export interface UsageLimitAttempt {
  termination: { reason: string };
  wait: { until: string; zone: string; quoted: string } | null;
  usage_limit: UsageLimit | null;
}

/** The fields of that attempt's review the answer is read from, where one is on record. */
export interface UsageLimitReview {
  decision: string;
  error: { kind: string } | null;
  model: { provider: string; model_id: string };
}

/**
 * Whether the run that recorded `attempt` as its last one ended on a
 * provider's usage limit, and whose: the one rule the stopped page and the
 * CLI both read.
 *
 * It reads the attempt's recorded termination, its wait and its usage limit,
 * and the review's recorded decision and error kind — typed fields the runner
 * wrote — and never a log line, a termination's detail or anything a model
 * wrote (ADR-0023). Two records say it:
 *
 * - `usage_limit`, which the runner writes where a provider's stated reset
 *   ended the run: an executor's attempt refused with a reset past
 *   `wait_for_provider_ms`, or refused again with one after a retry; a review
 *   refused with one it did not wait for.
 * - a review that parked on a stated reset (`wait`, on the attempt it was
 *   judging) and was refused again after it, ending `review_failed`. That
 *   attempt was already written to the ticket's record when the run parked,
 *   and a record on disk is never rewritten, so the wait and the refused
 *   review are what say it.
 *
 * An executor's attempt parked on a reset is not a stop: the run went on to
 * the next attempt, whose own record answers.
 */
export function usageLimitStop(
  attempt: UsageLimitAttempt,
  review: UsageLimitReview | null,
): UsageLimitStop | null {
  const executorEnded = attempt.termination.reason === "transport_unavailable";
  const limit = attempt.usage_limit;
  if (limit !== null) {
    // The role and the termination agree, or the record says two things and
    // neither is read.
    if ((limit.role === "executor") !== executorEnded) return null;
    return { ...limit, waited: false };
  }
  if (
    !executorEnded &&
    attempt.wait !== null &&
    review !== null &&
    review.decision === "error" &&
    review.error?.kind === "provider_unavailable"
  ) {
    return {
      role: "reviewer",
      provider: review.model.provider,
      model: review.model.model_id,
      until: attempt.wait.until,
      zone: attempt.wait.zone,
      quoted: attempt.wait.quoted,
      waited: true,
    };
  }
  return null;
}

/** Whether the limit still holds at `now`: the provider's stated reset has not yet passed. */
export const usageLimitHolds = (limit: Pick<UsageLimit, "until">, now: Date): boolean =>
  Date.parse(limit.until) > now.getTime();
