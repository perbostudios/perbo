import type { Ticket } from "./ticket.js";

/**
 * The row a run that closed the gate for a person writes, naming its outcome:
 * the ticket's record of how that run ended, which {@link retainedBranch}
 * reads back.
 */
export const gateClosedNote = (outcome: string): string => `the gate closed: ${outcome}`;

/** The branch a ticket's last run retained, or why there is none to publish. */
export type RetainedBranch =
  | { branch: string; outcome: "approved" | "escalated"; refusal: null }
  | { branch: null; outcome: null; refusal: string };

/**
 * D-NEW-publish-a-retained-branch-later: the branch a ticket's last run
 * retained without publishing, and the outcome the ticket records for that
 * run, read from the ticket alone. `perbo run --publish-retained` refuses with
 * `refusal`, and the desktop's merge screen says it.
 *
 * An approved run moves the ticket to `pr_open`; an escalated one to
 * `changes_requested` on the row that names it. Either one's branch is
 * published later only where the ticket records no pull request, and only the
 * loop's own: a direct arm's delivery or a person's hand-off is not the loop's
 * to publish. What the branch itself has to be — the commit the review judged,
 * the loop's commits only, a base that has not moved past it — the runner asks
 * of the branch before it pushes.
 */
export function retainedBranch(ticket: Pick<Ticket, "key" | "state" | "history" | "delivery">): RetainedBranch {
  const { key, delivery } = ticket;
  const refused = (refusal: string): RetainedBranch => ({ branch: null, outcome: null, refusal });
  const last = ticket.history[ticket.history.length - 1];
  const outcome =
    ticket.state === "pr_open"
      ? "approved"
      : ticket.state === "changes_requested" && last?.note === gateClosedNote("escalated")
        ? "escalated"
        : null;
  if (outcome === null) {
    return refused(
      `${key} is ${ticket.state}` +
        (ticket.state === "changes_requested" ? `, and its last run ended ${last?.note ?? "unrecorded"}` : "") +
        ": only a run that ended approved or escalated retains a branch to publish",
    );
  }
  if (delivery.pull_request_url !== null) {
    return refused(`${key} already has its pull request, ${delivery.pull_request_url}`);
  }
  if (delivery.arm !== "loop" || delivery.opened_by === "hand_off") {
    return refused(
      `${key}'s delivery is ${delivery.opened_by === "hand_off" ? "a person's hand-off" : `the ${delivery.arm} arm's`}, ` +
        "which is not the loop's to publish",
    );
  }
  if (delivery.branch === null) return refused(`${key} records no branch, so its run retained nothing to publish`);
  return { branch: delivery.branch, outcome, refusal: null };
}
