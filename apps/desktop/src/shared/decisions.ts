import type { ReviewArtifact } from "@perbo/contracts";
import type { DecisionQuestion } from "./protocol.js";

/**
 * The findings a person has to answer before the loop can go on.
 *
 * The rule is about **who can close a finding**, not how severe it is. A
 * `remediable` finding goes back to the executor in a new attempt — the
 * contract is explicit that this "is not a softer `blocking`": the gate stays
 * closed and what changes is who is asked. A `blocks` finding is the other half
 * of that sentence, the one the executor cannot close, and the loop stops
 * rather than running another round when it sees one.
 *
 * So `blocks` is exactly the case this list exists for, and leaving it out has
 * the worst possible shape: the decision overlay renders only where this list
 * is non-empty, so a ticket whose one blocking finding halted the run sits in
 * `changes_requested` with nothing to answer, and the finding that stopped the
 * loop is the finding the app cannot show.
 *
 * `closure: "human"` stays in its own right: the reviewer naming a person as
 * the closer is a direct answer to this question, whatever the routing beside
 * it. `advisory` and `waived` are not here because neither closes a gate, and
 * `remediable` is not here because the executor is already answering it.
 */
export function decisionQuestions(review: ReviewArtifact | null | undefined): DecisionQuestion[] {
  return (review?.findings ?? [])
    .filter(
      (finding) =>
        finding.status === "open" &&
        (finding.routing === "blocks" ||
          finding.routing === "escalates" ||
          finding.closure === "human"),
    )
    .map((finding) => ({
      id: finding.key,
      title: finding.statement,
      context: finding.blocking_reason ?? "",
      options: [],
    }));
}
