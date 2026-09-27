import type { Finding, ReviewArtifact } from "./review.js";
import { gateClosedNote } from "./retained.js";
import type { RunBundle } from "./runbundle.js";
import type { TicketHistoryEntry } from "./ticket.js";

/**
 * A person's answer to a finding the review routed to them
 * (D-132): which findings take one,
 * and which answers each takes. Here, and browser-safe, because three readers
 * have to agree on it: `perbo verdict --decide`, which records an answer; the
 * loop, which acts on it; and the desktop's decision screen, which asks for it.
 */

/**
 * What a person chose for a finding routed to them. `approach` is their own
 * direction and `let_it_decide` leaves the approach to the executor within the
 * approved contract and scope: both hand the finding to the executor for a
 * remediation round. `ship_as_is` closes it as it stands.
 */
export const DECISION_CHOICES = ["approach", "let_it_decide", "ship_as_is"] as const;
export type DecisionChoice = (typeof DECISION_CHOICES)[number];

/** The words a choice carries where the person typed none. */
export const DECISION_WORDS: Record<Exclude<DecisionChoice, "approach">, string> = {
  let_it_decide:
    "Choose an approach within the approved contract and scope; keep the choice in the task record.",
  ship_as_is: "Ship it as it is: the change is delivered unchanged for this finding.",
};

/**
 * The families the executor is never handed (D-065): a test in `@perbo/runner`
 * holds each one unremediable, and every other family the reviewer names
 * remediable, under `isRemediableFamily` in `@perbo/review`.
 */
export const NEVER_HANDED_FAMILIES = ["context", "security"] as const;

/**
 * The outcomes a run ends on once the executor has shown it cannot close what
 * it left open: a round that closed none of what it was given, or the rounds
 * or the money the ticket allows spent.
 */
export const FINISHED_TRYING = ["remediation_stalled", "remediation_exhausted"] as const;

/**
 * What the loop has done on one review since it was recorded, which decides
 * who is asked about a finding it routed to the executor.
 */
export interface LoopOnReview {
  /**
   * Whether a run since the review ended on one of `FINISHED_TRYING`, as the
   * ticket's own row for that run records it (`gateClosedNote`).
   */
  finished: boolean;
  /**
   * The findings a closure verification since the review recorded closed: the
   * last verification given each one left it out of its open set.
   */
  closed: ReadonlySet<string>;
}

/** The part of a ticket's row the loop's end is read from. */
export type HistoryRow = Pick<TicketHistoryEntry, "at" | "note">;

/** A review nothing has run on since: no round verified, no run ended. */
export const NOTHING_TRIED: LoopOnReview = { finished: false, closed: new Set() };

/**
 * What the loop has done on a review, from the ticket's rows and the closure
 * verifications recorded since the review, in the order they were recorded,
 * each with the findings it was given and the ones it left open. A finding's
 * status is its last verification's: a round given only some of the open
 * findings says nothing about the rest.
 */
export function loopOnReview(input: {
  reviewed_at: string;
  history: readonly HistoryRow[];
  verifications: readonly { given: readonly string[]; open: readonly string[] }[];
}): LoopOnReview {
  const since = Date.parse(input.reviewed_at);
  const endings = FINISHED_TRYING.map((outcome) => gateClosedNote(outcome));
  const closed = new Set<string>();
  for (const verification of input.verifications) {
    for (const key of verification.given) closed.add(key);
    for (const key of verification.open) closed.delete(key);
  }
  return {
    finished: input.history.some((row) => Date.parse(row.at) >= since && endings.includes(row.note)),
    closed,
  };
}

/** The part of a bundle the loop's record on a review is read from. */
export type RecordedBundle = Pick<RunBundle, "kind" | "subject_id" | "created_at" | "inputs">;

/**
 * What the loop has done on a review, read off the ticket's bundles — the
 * review's own, whose `created_at` is when it was recorded, and every closure
 * verification (`cv_…`) recorded at or after it, in order — and the ticket's
 * rows. The loop, `perbo verdict`, `perbo options` and the desktop read it
 * here, so a finding put to the person in one is put to them in all. Null
 * where the review's bundle is not among them, or where a verification does
 * not record what it left open, which cannot say what is still open.
 */
export function loopOnRecord(input: {
  review_id: string;
  bundles: readonly RecordedBundle[];
  history: readonly HistoryRow[];
}): { reviewed_at: string; verifications: RecordedBundle[]; loop: LoopOnReview } | null {
  const recorded = input.bundles.findLast((bundle) => bundle.kind === "review" && bundle.subject_id === input.review_id);
  if (recorded === undefined) return null;
  const verifications = input.bundles
    .filter(
      (bundle) =>
        bundle.kind === "review" && bundle.subject_id.startsWith("cv_") && bundle.created_at >= recorded.created_at,
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (verifications.some((bundle) => bundle.inputs["findings_open"] === undefined)) return null;
  const keysOf = (value: unknown): string[] =>
    typeof value === "string" ? value.split(",").filter((key) => key.length > 0) : [];
  return {
    reviewed_at: recorded.created_at,
    verifications,
    loop: loopOnReview({
      reviewed_at: recorded.created_at,
      history: input.history,
      verifications: verifications.map((bundle) => ({
        given: keysOf(bundle.inputs["findings_given"]),
        open: keysOf(bundle.inputs["findings_open"]),
      })),
    }),
  };
}

/**
 * Whether a finding is a person's to answer: open, and routed `blocks` or
 * `escalates`, or routed `remediable` on a review the loop has finished trying
 * and not closed by a round (D-132). The routing is the policy's answer to who
 * is asked while the executor is still trying; once a run ended on
 * `FINISHED_TRYING` every finding it left open is the person's, because the
 * executor has shown it cannot close it alone. The reviewer's `closure` does
 * not decide it, and one routed `advisory` closes no gate.
 */
export function routedToPerson(
  finding: Pick<Finding, "key" | "status" | "routing">,
  loop: LoopOnReview,
): boolean {
  if (finding.status !== "open") return false;
  if (finding.routing === "blocks" || finding.routing === "escalates") return true;
  return finding.routing === "remediable" && loop.finished && !loop.closed.has(finding.key);
}

/**
 * Whether a review's findings routed to a person take one of the three
 * answers: a review that judged every criterion and stopped for a person, or
 * one that routed its findings to the executor and that the loop has finished
 * trying. An `incomplete` or `error` review did not judge the whole change, so
 * an answer to it would deliver a change nobody finished judging: its findings
 * are asked for a principle only, as any other finding a person is asked
 * about, and a run goes on as though none of them were answered.
 */
export function decidable(review: Pick<ReviewArtifact, "decision">, loop: LoopOnReview): boolean {
  return (
    review.decision === "changes_requested" ||
    review.decision === "escalate" ||
    (review.decision === "remediable" && loop.finished)
  );
}

/**
 * Whether an answer answers a review: taken at or after the review was
 * recorded — its bundle's `created_at`, which the loop reads — because a person
 * can only answer what they were shown, and naming that review where the
 * person named one by its id. An earlier answer on the same key answered an
 * earlier review of another change set.
 */
export function answersReview(
  answer: { decided_at: string; review_id: string | null },
  review: { review_id: string; recorded_at: string },
): boolean {
  return (
    Date.parse(answer.decided_at) >= Date.parse(review.recorded_at) &&
    (answer.review_id === null || answer.review_id === review.review_id)
  );
}

/** The answers a finding of this rule takes: only shipping it as it is, where the executor is never handed its family. */
export function decisionChoicesFor(rule_id: string): readonly DecisionChoice[] {
  const family = rule_id.split(".")[0] ?? "";
  return (NEVER_HANDED_FAMILIES as readonly string[]).includes(family) ? ["ship_as_is"] : DECISION_CHOICES;
}
