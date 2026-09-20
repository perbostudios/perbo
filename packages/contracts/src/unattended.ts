import { wilsonInterval, type WilsonInterval } from "./wilson.js";
import type { DeliveryArm, Ticket } from "./ticket.js";

/**
 * Unattended merges (SCP-196; the bar D-076 proposes): of the tickets that
 * merged, how many did so from a pull request the loop opened, with every
 * commit on it carrying the loop's own attempt trailer.
 *
 * `delivery.opened_by` (SCP-173/176) already says whether the loop opened the
 * pull request; what this module adds is the second half — whether a person's
 * commit reached it anyway, which `opened_by` alone cannot say because a hand
 * finish (day four's five of five) lands its commits on the same branch the
 * loop opened the pull request from. `commits_outside_loop`, read at
 * `perbo sync` time from `gh pr view --json commits`, is that answer per
 * ticket; `unattendedMergeStatus` combines the two into one verdict, and
 * `summariseUnattendedMerges` is the live share `perbo stops` prints.
 */

/** The trailer `sealChangeSet` and `mergeUp` write into every commit they make. */
const LOOP_ATTEMPT_TRAILER = /^Attempt: \S+/m;

/**
 * SCP-206: the trailer the direct arm is told to put on every commit it makes.
 *
 * The loop's own trailer is written by the runner, which is why it can be
 * relied on; this one is written by the agent because nothing else can write
 * it — the arm commits for itself. So a commit without it reads as outside the
 * arm, which is the honest reading: nothing else on that commit can show it was
 * the arm's, and guessing would be the fabrication the whole measure avoids.
 */
export const DIRECT_ARM_COMMIT_TRAILER = "Arm: direct";
const DIRECT_ARM_TRAILER = /^Arm: direct\s*$/m;

/**
 * Whether a commit's own message carries the trailer of the arm that claims it.
 *
 * Never a check of who git records as the commit's author: an arm pushes under
 * a credential that can read as a person's, and a commit it made is its own
 * regardless of whose name is on it. The message is the one place that fact is
 * first-hand, and each arm has its own trailer because a commit from one arm
 * must never count for the other.
 */
export function commitCarriesArm(message: string, arm: DeliveryArm): boolean {
  return arm === "direct" ? DIRECT_ARM_TRAILER.test(message) : LOOP_ATTEMPT_TRAILER.test(message);
}

/** The loop's name for {@link commitCarriesArm}, kept for the callers that read it. */
export function commitCarriesLoopAttempt(message: string): boolean {
  return commitCarriesArm(message, "loop");
}

/** When a ticket's history says it reached `merged`, or null if it never did. */
export function mergedAt(ticket: Pick<Ticket, "history">): string | null {
  const rows = ticket.history.filter((row) => row.to === "merged");
  return rows.length > 0 ? (rows[rows.length - 1]?.at ?? null) : null;
}

export const UNATTENDED_MERGE_STATUSES = ["unattended", "attended", "unknown"] as const;
export type UnattendedMergeStatus = (typeof UNATTENDED_MERGE_STATUSES)[number];

/**
 * One merged ticket's answer.
 *
 * `unattended` needs both facts to agree: the loop opened the pull request
 * and no commit on it carries a person's work. `attended` is either the
 * opposite fact on its own — a hand-off pull request never counts, whatever
 * its commits turn out to say — or the loop's pull request with a commit
 * outside it. `unknown` is a ticket that has not merged, or one that has but
 * where a fact needed to answer is itself undecided: a legacy delivery record
 * with no `opened_by`, or a merge `perbo sync` has not read the commits of
 * yet. `unknown` is excluded from the share's denominator the same way an
 * unanswered stop is excluded from precision — undecided is not a third kind
 * of "no".
 */
export function unattendedMergeStatus(ticket: Pick<Ticket, "state" | "delivery">): UnattendedMergeStatus {
  if (ticket.state !== "merged") return "unknown";
  if (ticket.delivery.opened_by === "hand_off") return "attended";
  // SCP-206: `loop` and `direct` are the same fact about two arms — the arm's
  // own automation opened this pull request — and the registration reads both
  // by one rule: merged from that arm's own pull request, every commit on it
  // one that arm sealed. `commits_outside_loop` answers the second half for
  // whichever arm the record names, because `sync` judged it by that arm's own
  // trailer.
  if (ticket.delivery.opened_by !== "loop" && ticket.delivery.opened_by !== "direct") {
    return "unknown";
  }
  if (ticket.delivery.commits_outside_loop === null) return "unknown";
  return ticket.delivery.commits_outside_loop ? "attended" : "unattended";
}

export interface UnattendedMergesSummary {
  /** Every ticket in the population, merged or not. */
  tickets: number;
  merged: number;
  unattended: number;
  attended: number;
  /** Merged, but the answer is not yet decided — excluded from `share`. */
  unknown: number;
  /** unattended / (unattended + attended) — D-076's bar reads this. */
  share: WilsonInterval;
}

/** D-076's live number, over whatever population of tickets is handed in. */
export function summariseUnattendedMerges(
  tickets: readonly Pick<Ticket, "state" | "delivery">[],
): UnattendedMergesSummary {
  let merged = 0;
  let unattended = 0;
  let attended = 0;
  let unknown = 0;
  for (const ticket of tickets) {
    const status = unattendedMergeStatus(ticket);
    if (status === "unknown" && ticket.state !== "merged") continue;
    merged += 1;
    if (status === "unattended") unattended += 1;
    else if (status === "attended") attended += 1;
    else unknown += 1;
  }
  return {
    tickets: tickets.length,
    merged,
    unattended,
    attended,
    unknown,
    share: wilsonInterval(unattended, unattended + attended),
  };
}
