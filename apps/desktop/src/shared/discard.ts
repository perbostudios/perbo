import type { Ticket } from "@perbo/contracts";

/**
 * Why a piece of work stays where a delete was asked for, in the words the host
 * and the sample host both answer in (D-129), so a person meets one sentence
 * for one refusal whichever adapter answered.
 */

/**
 * A command running for this ticket — its run, a decision on it, its
 * publication — may be writing what the delete would remove. Another ticket's
 * run does not hold it (D-129).
 */
export const DELETE_WAITS_FOR_TICKET_COMMAND =
  "Wait for the command running for this ticket — its run, a decision on it or its publication — to finish before deleting it.";

/** The ticket asked about is not among the repository's tickets. */
export const DELETE_TICKET_GONE = "This task is no longer in the repository's ticket store.";

/**
 * Why a planning thrown away leaves the plan drafted from its spec: another
 * planning curates it, by the spec it writes or the ticket it holds, and it is
 * that planning's to throw away.
 */
export const ANOTHER_PLANNING_HOLDS = "Another planning holds this plan.";

/**
 * Whether a ticket's pull request is open (D-129): the ticket is at `pr_open`,
 * or its delivery record says `gh` last saw its pull request open — an
 * escalated run publishes (D-065) and leaves the ticket at `changes_requested`
 * with one, and a re-run that failed keeps the one an earlier round opened.
 * Neither delete nor Plan it again reaches such a ticket. Only a sync reads
 * that record again, so the stopped page offers one while it reads open
 * (`deletePullRequestOpen` names it).
 */
export const pullRequestOpen = (ticket: Pick<Ticket, "state" | "delivery">): boolean =>
  ticket.state === "pr_open" || ticket.delivery.state === "open";

/**
 * The one stage a delete, and Plan it again, does not reach: the pull request
 * is on GitHub, a record this machine does not own. Named by its number where
 * the record holds one, with the way to read it again once it is closed or
 * merged: Refresh from GitHub, on the stopped page and the review page.
 */
export const deletePullRequestOpen = (ticket: Pick<Ticket, "key" | "delivery">): string =>
  `${ticket.key}'s pull request${ticket.delivery.pull_request_number === null ? "" : ` #${ticket.delivery.pull_request_number}`} ` +
  "is open, and that is a record this machine does not own. Close or merge it on GitHub, then Refresh from " +
  "GitHub; the work can be deleted or planned again after that.";
