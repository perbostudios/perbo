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
  /**
   * The findings the executor declined since the review (D-065) that no later
   * verification closed, each with every reason it gave for them since the
   * review, in order: the executor has said it cannot close them alone.
   */
  declined: ReadonlyMap<string, readonly string[]>;
  /**
   * The findings a round since the review was given and the runner refused
   * (SCP-194: it widened the change set instead of narrowing it) that no later
   * verification closed: the executor has shown it cannot close them within
   * the contract alone.
   */
  refused: ReadonlySet<string>;
}

/** The part of a ticket's row the loop's end is read from. */
export type HistoryRow = Pick<TicketHistoryEntry, "at" | "note">;

/** A review nothing has run on since: no round verified, no run ended. */
export const NOTHING_TRIED: LoopOnReview = { finished: false, closed: new Set(), declined: new Map(), refused: new Set() };

/** A finding an attempt declined (D-065), with the reason it gave and when that attempt started. */
export interface RecordedDecline {
  finding_key: string;
  reason: string;
  at: string;
}

/**
 * The declines the ticket's attempts record (`ExecutionAttempt.declines`),
 * each at the time its attempt started. An attempt whose record does not say
 * what it declined adds none.
 */
export function declinesOnRecord(
  attempts: readonly { created_at: string; declines?: readonly { finding_key: string; reason: string }[] | undefined }[],
): RecordedDecline[] {
  return attempts.flatMap((attempt) =>
    (attempt.declines ?? []).map((decline) => ({ finding_key: decline.finding_key, reason: decline.reason, at: attempt.created_at })),
  );
}

/**
 * What the loop has done on a review, from the ticket's rows, and the closure
 * verifications and the executor's declines recorded since the review, in the
 * order of their times: each verification with the findings it was given and
 * the ones it left open, each decline with its finding and reason. A finding's
 * status is the last one recorded for it: a round given only some of the open
 * findings says nothing about the rest, a decline makes a finding the
 * person's, and it stays theirs until a later verification closes it.
 */
export function loopOnReview(input: {
  reviewed_at: string;
  history: readonly HistoryRow[];
  verifications: readonly { at: string; given: readonly string[]; open: readonly string[]; refused: boolean }[];
  declines: readonly RecordedDecline[];
}): LoopOnReview {
  const since = Date.parse(input.reviewed_at);
  const endings = FINISHED_TRYING.map((outcome) => gateClosedNote(outcome));
  const closed = new Set<string>();
  const declined = new Map<string, string[]>();
  const refused = new Set<string>();
  const events = [
    ...input.verifications.map((verification) => ({ at: Date.parse(verification.at), verification, decline: null })),
    ...input.declines
      .filter((decline) => Date.parse(decline.at) >= since)
      .map((decline) => ({ at: Date.parse(decline.at), verification: null, decline })),
  ].sort((left, right) => left.at - right.at);
  for (const { verification, decline } of events) {
    if (decline !== null) {
      closed.delete(decline.finding_key);
      declined.set(decline.finding_key, [...(declined.get(decline.finding_key) ?? []), decline.reason]);
      continue;
    }
    for (const key of verification!.given) closed.add(key);
    for (const key of verification!.open) closed.delete(key);
    for (const key of verification!.given) {
      if (verification!.refused && !closed.has(key)) refused.add(key);
      // Closed by a round, it is no longer declined or refused; left open, it is still the person's.
      if (closed.has(key)) {
        declined.delete(key);
        refused.delete(key);
      }
    }
  }
  return {
    finished: input.history.some((row) => Date.parse(row.at) >= since && endings.includes(row.note)),
    closed,
    declined,
    refused,
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
  /** The declines the ticket's attempts record (`declinesOnRecord`). */
  declines: readonly RecordedDecline[];
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
        at: bundle.created_at,
        given: keysOf(bundle.inputs["findings_given"]),
        open: keysOf(bundle.inputs["findings_open"]),
        refused: bundle.inputs["refused_head_commit"] !== undefined,
      })),
      declines: input.declines,
    }),
  };
}

/**
 * Whether a finding is a person's to answer: open, and routed `blocks` or
 * `escalates`, or routed `remediable`, not closed by a round, and one the loop
 * has finished trying (D-132): a run since the review ended on
 * `FINISHED_TRYING`, the executor declined it (D-065), or the runner refused the
 * round given it for widening the change set (SCP-194), and no later round
 * closed it. The routing is the policy's answer to who is asked while the
 * executor is still trying; once it has shown it cannot close a finding alone,
 * the finding is the person's. The reviewer's `closure` does
 * not decide it, and one routed `advisory` closes no gate.
 */
export function routedToPerson(
  finding: Pick<Finding, "key" | "status" | "routing">,
  loop: LoopOnReview,
): boolean {
  if (finding.status !== "open") return false;
  if (finding.routing === "blocks" || finding.routing === "escalates") return true;
  return (
    finding.routing === "remediable" &&
    !loop.closed.has(finding.key) &&
    (loop.finished || loop.declined.has(finding.key) || loop.refused.has(finding.key))
  );
}

/**
 * The findings a run would start without an answer to (D-132), by key: once the
 * loop finished trying on the review (`triedOn`), those routed to the person,
 * one the executor declined included, that no round closed and no standing
 * answer the finding takes answers, where none is handed to the executor and
 * none is still the executor's to close. Empty where a run has what it needs:
 * a round on what was handed on or is still the executor's, or a delivery on
 * answers. Another run on them unanswered is the same brief against the same
 * evidence, paid for again, with the same questions at its end, so it is
 * refused before anything starts, and the desktop does not offer it.
 * `answers` holds each standing answer that answers the review
 * (`answersReview`).
 */
export function owedAnswers(input: {
  review: Pick<ReviewArtifact, "decision"> & {
    findings: readonly Pick<Finding, "key" | "status" | "routing" | "rule_id">[];
  };
  loop: LoopOnReview;
  answers: ReadonlyMap<string, DecisionChoice>;
}): string[] {
  const { review, loop, answers } = input;
  if (!triedOn(loop) || !decidable(review, loop)) return [];
  const open = review.findings.filter((finding) => finding.status === "open" && !loop.closed.has(finding.key));
  const stillTrying = open.some((finding) => finding.routing === "remediable" && !routedToPerson(finding, loop));
  const taken = (finding: (typeof open)[number]): DecisionChoice | null => {
    const choice = answers.get(finding.key);
    return choice !== undefined && decisionChoicesFor(finding.rule_id).includes(choice) ? choice : null;
  };
  const person = open.filter((finding) => routedToPerson(finding, loop));
  const handed = person.some((finding) => {
    const choice = taken(finding);
    return choice === "approach" || choice === "let_it_decide";
  });
  if (stillTrying || handed) return [];
  return person.filter((finding) => taken(finding) === null).map((finding) => finding.key);
}

/**
 * Whether a review's findings routed to a person take one of the three
 * answers: a review that judged every criterion and stopped for a person, or
 * one that routed its findings to the executor and that the loop has finished
 * trying — a run since ended stalled or exhausted, or the executor declined a
 * finding of it, or the runner refused a round given one, that no round closed
 * since. An `incomplete` or `error` review did not judge the whole change, so
 * an answer to it would deliver a change nobody finished judging: its findings
 * are asked for a principle only, as any other finding a person is asked
 * about, and a run goes on as though none of them were answered.
 */
export function decidable(review: Pick<ReviewArtifact, "decision">, loop: LoopOnReview): boolean {
  return (
    review.decision === "changes_requested" ||
    review.decision === "escalate" ||
    (review.decision === "remediable" && triedOn(loop))
  );
}

/**
 * Whether the loop has finished trying on a review: a run since it ended on
 * `FINISHED_TRYING`, or the executor declined a finding of it (D-065), or the
 * runner refused a round given one (SCP-194), that no round closed since.
 */
function triedOn(loop: LoopOnReview): boolean {
  return loop.finished || loop.declined.size > 0 || loop.refused.size > 0;
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

/**
 * The commit a review, or the last closure verification after it, judged:
 * what the ticket's branch has to be at for a run to act on that record
 * rather than review the branch afresh. A round the scope rule refused
 * (SCP-194) records the commit it refused under a key of its own and judged no
 * tree, so it is passed over. Null where the verification that judged last
 * records no commit.
 */
export function judgedCommit(review_head: string, verifications: readonly Pick<RecordedBundle, "inputs">[]): string | null {
  const last = verifications.findLast((bundle) => bundle.inputs["refused_head_commit"] === undefined);
  const head = last === undefined ? review_head : (last.inputs["head_commit"] ?? null);
  return typeof head === "string" && head.length > 0 ? head : null;
}

/** The answers a finding of this rule takes: only shipping it as it is, where the executor is never handed its family. */
export function decisionChoicesFor(rule_id: string): readonly DecisionChoice[] {
  const family = rule_id.split(".")[0] ?? "";
  return (NEVER_HANDED_FAMILIES as readonly string[]).includes(family) ? ["ship_as_is"] : DECISION_CHOICES;
}
