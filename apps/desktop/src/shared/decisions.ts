import { z } from "zod";
import { answersReview, decidable, decisionChoicesFor, routedToPerson } from "@perbo/contracts/browser";
import type { Finding, ReviewArtifact } from "@perbo/contracts";
import type { AttemptView, DecisionQuestion } from "./protocol.js";

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
 *
 * A finding `routedToPerson` on a `decidable` review — the predicates `perbo
 * verdict --decide` and the loop read too — takes one of the answers that
 * finding takes, recorded on it by the question's id, the finding's key: the
 * person's approach or one left to the executor, which hands it to a
 * remediation round, or the change shipped as it is, which settles it; a
 * `security.*` or `context.*` finding takes only the last
 * (D-132). Such a finding in
 * `settled` is not asked again. Every other question takes no choice: its
 * answer is recorded as a principle for the executor (D-065) and nothing else.
 */
export function decisionQuestions(
  review:
    | (Pick<ReviewArtifact, "decision"> & {
        findings: readonly Pick<
          Finding,
          "key" | "rule_id" | "status" | "routing" | "closure" | "statement" | "blocking_reason"
        >[];
      })
    | null
    | undefined,
  settled: ReadonlySet<string> = new Set(),
): DecisionQuestion[] {
  const decides = (finding: Pick<Finding, "status" | "routing">): boolean =>
    review != null && decidable(review) && routedToPerson(finding);
  return (review?.findings ?? [])
    .filter(
      (finding) =>
        finding.status === "open" &&
        (decides(finding)
          ? !settled.has(finding.key)
          : routedToPerson(finding) || finding.closure === "human"),
    )
    .map((finding) => ({
      id: finding.key,
      title: finding.statement,
      context: finding.blocking_reason ?? "",
      options: [],
      choices: decides(finding) ? decisionChoicesFor(finding.rule_id) : [],
    }));
}

const ShippedSchema = z.object({
  review: z.object({ reference: z.string() }),
  finding_key: z.string(),
  decision: z.literal("decide"),
  choice: z.literal("ship_as_is"),
  decided_at: z.string(),
  superseded_at: z.null(),
});
const VerifiedSchema = z.object({
  open_keys: z.array(z.string()),
  per_finding: z.array(z.object({ finding_key: z.string() })),
});

/**
 * The findings of the ticket's last review that are settled without another
 * answer (D-132): shipped as it is by
 * a standing answer that answers that review, or closed by a round after it —
 * given to a verification and absent from the last one's open set. Which
 * answers answer the review is `answersReview`, the loop's rule, against the
 * review's own bundle — the one whose subject is its id — and the time it was
 * recorded, as the loop reads it. The review is immutable, so this is read
 * beside it.
 */
export function settledFindings(detail: { attempts: readonly AttemptView[]; verdicts: readonly unknown[] }): Set<string> {
  const at = detail.attempts.findLastIndex((attempt) => attempt.review !== null);
  const review = detail.attempts[at]?.review;
  if (review === undefined || review === null) return new Set();
  const recorded = detail.attempts[at]!.bundles.find(
    (bundle) => bundle.kind === "review" && bundle.subject_id === review.review_id,
  );
  if (recorded === undefined) return new Set();
  const shipped = detail.verdicts.flatMap((row) => {
    const parsed = ShippedSchema.safeParse(row);
    if (!parsed.success) return [];
    const { review: named, finding_key, decided_at } = parsed.data;
    // A decision names a review by its id, or the ticket or its pull request.
    const review_id = named.reference.startsWith("rev_") ? named.reference : null;
    return answersReview({ decided_at, review_id }, { review_id: recorded.subject_id, recorded_at: recorded.created_at })
      ? [finding_key]
      : [];
  });
  const verified = detail.attempts.slice(at + 1).flatMap((attempt) => {
    const parsed = VerifiedSchema.safeParse(attempt.verification);
    return parsed.success ? [parsed.data] : [];
  });
  const open = new Set(verified.at(-1)?.open_keys ?? []);
  const closed = verified
    .flatMap((verification) => verification.per_finding.map((row) => row.finding_key))
    .filter((key) => !open.has(key));
  return new Set([...shipped, ...closed]);
}
