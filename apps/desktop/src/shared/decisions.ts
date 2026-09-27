import { z } from "zod";
import {
  answersReview,
  decidable,
  decisionChoicesFor,
  leftToPrinciple,
  loopOnRecord,
  NOTHING_TRIED,
  owedAnswers,
  routedToPerson,
  type DecisionChoice,
  type HistoryRow,
  type LoopOnReview,
  type RecordedBundle,
} from "@perbo/contracts/browser";
import type { Finding, ReviewArtifact, Ticket } from "@perbo/contracts";
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
 * `remediable` is here only once a run ended stalled or exhausted on the
 * review (`routedToPerson`, from `settled.loop`): until then the executor is
 * answering it, and after it every one a round did not close is the person's.
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
 * A finding the executor declined (`leftToPrinciple`) is not asked at all: a
 * principle is its answer, added with `perbo principle add` (D-065), and the
 * stopped page names it and that command.
 *
 * A finding the last round's verification left open on its deterministic
 * evidence — a check the round failed, or a scope it widened — is asked with
 * that verification's sentence after the reason it stopped, as a sentence of
 * its own: it is what the round was judged on, and it names the round itself.
 * Every context is written as sentences, so the questions on one page read
 * alike.
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
  settled: SettledFindings = NOTHING_SETTLED,
): DecisionQuestion[] {
  const decides = (finding: Pick<Finding, "key" | "status" | "routing">): boolean =>
    review != null && decidable(review, settled.loop) && routedToPerson(finding, settled.loop);
  return (review?.findings ?? [])
    .filter(
      (finding) =>
        finding.status === "open" &&
        !leftToPrinciple(finding, settled.loop) &&
        (decides(finding)
          ? !settled.keys.has(finding.key)
          : routedToPerson(finding, settled.loop) || finding.closure === "human"),
    )
    .map((finding) => ({
      id: finding.key,
      title: finding.statement,
      context: [
        finding.blocking_reason ?? "",
        settled.refusal?.open.has(finding.key) ? settled.refusal.sentence : "",
      ]
        .filter((text) => text.trim().length > 0)
        .map(asSentence)
        .join(" "),
      choices: decides(finding) ? decisionChoicesFor(finding.rule_id) : [],
    }));
}

/**
 * The questions a run of the ticket would start without an answer to, as the
 * loop reads them (`owedAnswers`), whatever the branch holds: the host keeps
 * those whose branch is still at the commit judged (`owedOnBranch`), which the
 * loop refuses, the host refuses before starting one, and the contract page
 * offers the questions for instead of Start the loop.
 */
export function owedQuestions(
  review: Parameters<typeof decisionQuestions>[0],
  settled: SettledFindings = NOTHING_SETTLED,
): DecisionQuestion[] {
  if (review == null) return [];
  const owed = new Set(owedAnswers({ review, loop: settled.loop, answers: settled.answers }));
  return decisionQuestions(review, settled).filter((question) => owed.has(question.id));
}

/** Text as a sentence that stands on its own: a capital first, and a stop at the end where it has none. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

const AnsweredSchema = z.object({
  review: z.object({ ticket_id: z.string(), reference: z.string() }),
  finding_key: z.string(),
  decision: z.literal("decide"),
  choice: z.enum(["approach", "let_it_decide", "ship_as_is"]),
  decided_at: z.string(),
  superseded_at: z.null(),
});
const VerifiedSchema = z.object({
  open_keys: z.array(z.string()),
  deterministic_failure: z.string().nullable(),
});

/** What the answers and the rounds since the ticket's last review say of its findings. */
export interface SettledFindings {
  /** The findings settled without another answer. */
  keys: ReadonlySet<string>;
  /**
   * The deterministic failure the last verification since the review stopped
   * on, in its own words, with the findings it left open; null where it
   * stopped on none.
   */
  refusal: { sentence: string; open: ReadonlySet<string> } | null;
  /** What the loop has done on the review (`loopOnRecord`), which says who each finding is asked of. */
  loop: LoopOnReview;
  /** Each standing answer that answers the review (`answersReview`), by finding. */
  answers: ReadonlyMap<string, DecisionChoice>;
}

/** A review nothing has settled or tried. */
const NOTHING_SETTLED: SettledFindings = { keys: new Set(), refusal: null, loop: NOTHING_TRIED, answers: new Map() };

/**
 * The findings of the ticket's last review that are settled without another
 * answer (D-132): shipped as it is by
 * a standing answer that answers that review, or closed by a round after it,
 * as the loop reads the record (`loopOnRecord`) — which also says whether the
 * loop has finished trying it. Which answers answer the review is
 * `answersReview`, the loop's rule, against the review's own bundle — the one
 * whose subject is its id — and the time it was recorded, as the loop reads
 * it; only the ticket's own answers are read, as `perbo run` reads them. The
 * review is immutable, so this is read beside it, and so is the deterministic
 * failure the last round since it was refused on.
 */
export function settledFindings(detail: {
  ticket: Pick<Ticket, "ticket_id" | "history">;
  attempts: readonly AttemptView[];
  verdicts: readonly unknown[];
}): SettledFindings {
  const at = detail.attempts.findLastIndex((attempt) => attempt.review !== null);
  const review = detail.attempts[at]?.review;
  if (review === undefined || review === null) return NOTHING_SETTLED;
  const verified = detail.attempts.slice(at + 1).flatMap((attempt) => {
    const parsed = VerifiedSchema.safeParse(attempt.verification);
    return parsed.success ? [parsed.data] : [];
  });
  return settledOnRecord({
    ticket_id: detail.ticket.ticket_id,
    review_id: review.review_id,
    bundles: detail.attempts.flatMap((attempt) => attempt.bundles),
    history: detail.ticket.history,
    verdicts: detail.verdicts,
    verification: verified.at(-1) ?? null,
  });
}

/**
 * `settledFindings` from the records themselves: the review's id, the
 * ticket's bundles and rows, the verdicts record's rows, and the last closure
 * verification since the review where it is read. The host reads Home's
 * questions through this from the files the loop wrote, and the loop page
 * through `settledFindings` from the report, so the two ask alike.
 */
export function settledOnRecord(input: {
  ticket_id: string;
  review_id: string;
  bundles: readonly RecordedBundle[];
  history: readonly HistoryRow[];
  verdicts: readonly unknown[];
  verification: { open_keys: readonly string[]; deterministic_failure: string | null } | null;
}): SettledFindings {
  const onRecord = loopOnRecord({ review_id: input.review_id, bundles: input.bundles, history: input.history });
  if (onRecord === null) return NOTHING_SETTLED;
  const answered = input.verdicts.flatMap((row) => {
    const parsed = AnsweredSchema.safeParse(row);
    if (!parsed.success) return [];
    const { review: named, decided_at } = parsed.data;
    if (named.ticket_id !== input.ticket_id) return [];
    // A decision names a review by its id, or the ticket or its pull request.
    const review_id = named.reference.startsWith("rev_") ? named.reference : null;
    return answersReview({ decided_at, review_id }, { review_id: input.review_id, recorded_at: onRecord.reviewed_at })
      ? [parsed.data]
      : [];
  });
  const shipped = answered.filter((row) => row.choice === "ship_as_is").map((row) => row.finding_key);
  const last = input.verification;
  return {
    keys: new Set([...shipped, ...onRecord.loop.closed]),
    refusal:
      last === null || last.deterministic_failure === null
        ? null
        : { sentence: last.deterministic_failure, open: new Set(last.open_keys) },
    loop: onRecord.loop,
    answers: new Map(answered.map((row) => [row.finding_key, row.choice])),
  };
}

/**
 * The questions a ticket's record puts to the person: its last review's, as
 * the decision card asks them. The card, the wheel, the page's title and
 * Home's colour all read this, so a pause is never one with nothing to ask.
 */
export function questionsOnRecord(detail: {
  ticket: Pick<Ticket, "ticket_id" | "history">;
  attempts: readonly AttemptView[];
  verdicts: readonly unknown[];
}): DecisionQuestion[] {
  const review = detail.attempts.findLast((attempt) => attempt.review !== null)?.review;
  return decisionQuestions(review, settledFindings(detail));
}

/**
 * The questions a run of the ticket would start without an answer to, as its
 * record puts them (`owedQuestions`): the sample host's `Detail.owed`, whose
 * branches never move. The desktop's host reads the branch too (`owedOnBranch`).
 */
export function owedOnRecord(detail: Parameters<typeof questionsOnRecord>[0]): DecisionQuestion[] {
  const review = detail.attempts.findLast((attempt) => attempt.review !== null)?.review;
  return owedQuestions(review, settledFindings(detail));
}
