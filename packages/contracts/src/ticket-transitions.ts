/**
 * The ticket lifecycle's rows, apart from the rest of `ticket.ts` because they
 * import nothing of Node: the desktop's sample host walks a ticket along the
 * same rows `transition` does, from `@perbo/contracts/browser`.
 */
import type { Ticket, TicketState } from "./ticket.js";

/**
 * The transitions Stage 3 can drive, as data.
 *
 * A table rather than a switch, for the same reason the blocking matrix is a
 * lookup: an illegal transition should be a missing row that can be printed,
 * not a branch somebody forgot to write.
 */
export interface TicketTransition {
  from: TicketState;
  to: TicketState;
  /**
   * SCP-206: a row only some records may take, decided from the record itself
   * rather than from the evidence a caller holds.
   *
   * Guarding on the record keeps the reconciler's own refusal intact: a loop
   * ticket whose evidence disagrees with itself still cannot be walked to a
   * state no unguarded row reaches, because the guard says nothing about
   * evidence and everything about which arm the row belongs to — or, for the
   * one row a single step of the loop takes, about the note that step writes.
   */
  when?: (ticket: Pick<Ticket, "delivery">, note: string) => boolean;
}

/**
 * D-083: the guard both rows off `pr_open` besides the merge are written under
 * — the delivery record saying `gh` reports this pull request closed.
 *
 * What each row records is a pull request that closed, so a record still
 * reporting it open has no business on either. Guarding on the record rather
 * than on evidence a caller holds is the same device the arm row uses: it says
 * nothing about who is asking and everything about which records may go there.
 */
const pullRequestIsClosed = (ticket: Pick<Ticket, "delivery">): boolean =>
  ticket.delivery.state === "closed";

/**
 * How the row a decided delivery writes begins: the one note that takes a
 * ticket from `provisioning` to `pr_open`
 * (D-132).
 */
export const DECIDED_DELIVERY_NOTE = "every finding the review routed to a person is decided";

export const TICKET_TRANSITIONS: ReadonlyArray<TicketTransition> = [
  { from: "plan_review", to: "ready" },
  { from: "plan_review", to: "cancelled" },
  { from: "ready", to: "provisioning" },
  { from: "ready", to: "cancelled" },
  // SCP-008 criterion 5: the queue's two rows. A ticket waits while a
  // dependency is unmerged or a ticket ahead of it holds a scope it reaches,
  // and is ready again when that is no longer so. Nothing runs from `blocked`;
  // a person running it by hand reopens it to `ready` first, which is their
  // decision to override the queue.
  { from: "ready", to: "blocked" },
  // D-103: a run refuses to start a ticket whose spec has been edited since
  // the contract was approved from it, or whose spec names code the repository
  // no longer has, and leaves the ticket here. Nothing goes the other way: the
  // contract was approved against a statement that has changed, and an
  // approved contract is immutable (ADR-0016), so the work is admitted again.
  { from: "ready", to: "plan_invalid" },
  { from: "blocked", to: "ready" },
  { from: "blocked", to: "cancelled" },
  { from: "provisioning", to: "executing" },
  { from: "provisioning", to: "failed" },
  { from: "executing", to: "verifying" },
  { from: "executing", to: "failed" },
  { from: "executing", to: "cancelled" },
  // SCP-206: the registered comparison arm reaches a pull request with no
  // independent review of its own — that absence is the property under
  // measurement — so its record has to be able to reach `pr_open` without
  // claiming one. Guarded on the record's arm rather than on the evidence, so
  // the reconciler's refusal for a loop ticket stands exactly where it stood,
  // and so `escapes`, which needs a merged record, can see this arm at all.
  {
    from: "executing",
    to: "pr_open",
    when: (ticket) => ticket.delivery.arm === "direct",
  },
  { from: "verifying", to: "independent_review" },
  { from: "verifying", to: "failed" },
  { from: "independent_review", to: "pr_open" },
  // D-132: a run that finds every
  // finding the last review routed to a person decided, on the commit that
  // review judged, executes and reviews nothing and goes where an approval
  // goes. Only the row that run writes takes it, so nothing that reconciles
  // evidence can reach `pr_open` from here without a review behind it.
  {
    from: "provisioning",
    to: "pr_open",
    when: (_ticket, note) => note.startsWith(DECIDED_DELIVERY_NOTE),
  },
  { from: "independent_review", to: "changes_requested" },
  // An attempt can terminate after its review — a ceiling reached on a
  // remediation round, or repository-supplied agent configuration found on
  // handover. Without this row the ticket had nowhere legal to go and was left
  // claiming `independent_review` for a run that did not complete.
  { from: "independent_review", to: "failed" },
  { from: "changes_requested", to: "ready" },
  { from: "changes_requested", to: "cancelled" },
  { from: "failed", to: "ready" },
  { from: "pr_open", to: "merged" },
  // D-083: a pull request GitHub closed without merging. `closed` is what the
  // record settles at, and `changes_requested` is where a D-073 CHANGES
  // REQUESTED verdict on that pull request puts it instead — the verdict is
  // the fact about the review, and mergeability a fact about a branch a closed
  // pull request no longer has. `perbo sync` is the only path onto either.
  { from: "pr_open", to: "closed", when: pullRequestIsClosed },
  { from: "pr_open", to: "changes_requested", when: pullRequestIsClosed },
  // What `failed` admits, and for the same reason: the work can be run again.
  // Nothing else — a closed pull request is not handed off, because there is
  // no open pull request left on the branch to hand off.
  { from: "closed", to: "ready" },
  // A `failed` ticket's branch carries a pull request. Two things put one
  // there — SCP-157's person finishing what the loop could not, and the loop's
  // own pull request from an earlier round outliving a re-run that failed —
  // and this row is both. `handOff` and `resumeAtPullRequest` below are the
  // only paths that take it; each refuses without pull-request evidence, which
  // this table has no way to check, and each records which of the two it was.
  { from: "failed", to: "pr_open" },
];
