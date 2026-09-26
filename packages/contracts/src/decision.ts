import type { Finding, ReviewArtifact } from "./review.js";

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
 * Whether a finding is a person's to answer: open, and routed `blocks` or
 * `escalates`. The routing is the policy's answer to who is asked; under the
 * routing policies in force the reviewer's `closure` does not decide it, so a
 * finding whose closer it named as a person and that the policy routed
 * `remediable` is the executor's, and one routed `advisory` closes no gate.
 */
export function routedToPerson(finding: Pick<Finding, "status" | "routing">): boolean {
  return finding.status === "open" && (finding.routing === "blocks" || finding.routing === "escalates");
}

/**
 * Whether a review's findings routed to a person take one of the three
 * answers: a review that judged every criterion and stopped for a person.
 * An `incomplete` or `error` review did not judge the whole change, so an
 * answer to it would deliver a change nobody finished judging: its findings
 * are asked for a principle only, as any other finding a person is asked
 * about, and a run goes on as though none of them were answered.
 */
export function decidable(review: Pick<ReviewArtifact, "decision">): boolean {
  return review.decision === "changes_requested" || review.decision === "escalate";
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
