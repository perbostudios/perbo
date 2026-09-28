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
   * The findings the executor declined in a round since the review (D-065),
   * as each closure verification records them: a principle is the answer to
   * one (`perbo principle add`), and no choice closes it.
   */
  declined: ReadonlySet<string>;
}

/** The part of a ticket's row the loop's end is read from. */
export type HistoryRow = Pick<TicketHistoryEntry, "at" | "note">;

/** A review nothing has run on since: no round verified, no run ended. */
export const NOTHING_TRIED: LoopOnReview = { finished: false, closed: new Set(), declined: new Set() };

/**
 * What the loop has done on a review, from the ticket's rows and the closure
 * verifications recorded since the review, in the order they were recorded,
 * each with the findings it was given, the ones it left open and the ones the
 * round's executor declined. A finding's status is its last verification's: a
 * round given only some of the open findings says nothing about the rest. A
 * decline stands once any round since the review recorded it.
 */
export function loopOnReview(input: {
  reviewed_at: string;
  history: readonly HistoryRow[];
  verifications: readonly { given: readonly string[]; open: readonly string[]; declined: readonly string[] }[];
}): LoopOnReview {
  const since = Date.parse(input.reviewed_at);
  const endings = FINISHED_TRYING.map((outcome) => gateClosedNote(outcome));
  const closed = new Set<string>();
  const declined = new Set<string>();
  for (const verification of input.verifications) {
    for (const key of verification.given) closed.add(key);
    for (const key of verification.open) closed.delete(key);
    for (const key of verification.declined) declined.add(key);
  }
  return {
    finished: input.history.some((row) => Date.parse(row.at) >= since && endings.includes(row.note)),
    closed,
    declined,
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
        declined: keysOf(bundle.inputs["findings_declined"]),
      })),
    }),
  };
}

/**
 * Whether a finding is a person's to answer: open, not declined by the
 * executor, and routed `blocks` or `escalates`, or routed `remediable` on a
 * review the loop has finished trying and not closed by a round (D-132). The
 * routing is the policy's answer to who is asked while the executor is still
 * trying; once a run ended on `FINISHED_TRYING` every finding it left open is
 * the person's, because the executor has shown it cannot close it alone. A
 * finding the executor declined is answered by a principle and by no choice
 * (D-065). The reviewer's `closure` does not decide it, and one routed
 * `advisory` closes no gate.
 */
export function routedToPerson(
  finding: Pick<Finding, "key" | "status" | "routing">,
  loop: LoopOnReview,
): boolean {
  if (finding.status !== "open" || loop.declined.has(finding.key)) return false;
  if (finding.routing === "blocks" || finding.routing === "escalates") return true;
  return finding.routing === "remediable" && loop.finished && !loop.closed.has(finding.key);
}

/**
 * Whether a finding is left to a principle (D-065): open and declined by the
 * executor in a round since the review, which `routedToPerson` never routes to
 * a person. No answer closes it and it is never handed again; it holds no
 * delivery back, and a run that delivers with one open ends `escalated`, the
 * pull request listing it for the person. `perbo principle add` is its answer.
 */
export function leftToPrinciple(finding: Pick<Finding, "key" | "status">, loop: LoopOnReview): boolean {
  return finding.status === "open" && loop.declined.has(finding.key);
}

/**
 * The findings a run would start without an answer to (D-132), by key: once a
 * run since the review finished trying, those routed to the person that no
 * round closed and no standing answer the finding takes answers, where none
 * is handed to the executor and none is still the executor's to close. Empty
 * where a run has what it needs: a round on what was handed on or is still
 * the executor's, or a delivery on answers. Another run on them unanswered is
 * the same brief against the same evidence, paid for again, with the same
 * questions at its end, so it is refused before anything starts, and the
 * desktop does not offer it. `answers` holds each standing answer that
 * answers the review (`answersReview`).
 */
export function owedAnswers(input: {
  review: Pick<ReviewArtifact, "decision"> & {
    findings: readonly Pick<Finding, "key" | "status" | "routing" | "rule_id">[];
  };
  loop: LoopOnReview;
  answers: ReadonlyMap<string, DecisionChoice>;
}): string[] {
  const { review, loop, answers } = input;
  if (!loop.finished || !decidable(review, loop)) return [];
  const open = review.findings.filter((finding) => finding.status === "open" && !loop.closed.has(finding.key));
  const stillTrying = open.some(
    (finding) =>
      finding.routing === "remediable" && !routedToPerson(finding, loop) && !leftToPrinciple(finding, loop),
  );
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
