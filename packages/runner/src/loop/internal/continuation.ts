import {
  ExecutionAttemptSchema,
  NodeReviewsSchema,
  ReviewArtifactSchema,
  answersReview,
  decidable,
  decisionChoicesFor,
  routedToPerson,
  type ExecutionAttempt,
  type Finding,
  type NodeReview,
  type ReviewArtifact,
  type RunBundle,
} from "@perbo/contracts";
import { isRemediableFamily, remediableFindings } from "@perbo/review";
import { z } from "zod";
import type { AttemptsRecord } from "../../attempts.js";
import { handsToExecutor, recordDecisions, type DecidedFinding } from "../../decisions.js";
import type { BundleStore } from "../../bundle.js";
import { sameCommit } from "../../resume.js";
import { commitsSince } from "../../seal.js";
import type { RoundState } from "./state.js";

/**
 * Whether a re-run continues a remediation already under way (SCP-194).
 */

/**
 * The remediation a re-run continues, or null where there is nothing to
 * continue (SCP-194).
 *
 * A ticket in `changes_requested` has a review on record and findings that
 * review left open. Re-running it used to start at round 0: a fresh independent
 * review of the same sealed commit, which returned the same verdict for the
 * same money — twice on AYO-31. What the branch is actually asking for is the
 * next remediation round, from the findings that are still open.
 *
 * Two things have to be true for that to be safe. The review has to exist, and
 * the change set it judged has to be the one on the branch — a branch that has
 * moved carries work no review has seen, and verifying closures against it
 * would grade a change nobody judged. The second is checked against the live
 * branch by the caller; this answers the first, and says which commit was last
 * judged so the caller can.
 *
 * A finding the review routed to a person joins the round where the person
 * decided it with an approach of their own or left the approach to the
 * executor (D-132): the executor is
 * handed it with the person's words, and the closure verifier checks it
 * (D-061), until a verification records it closed. One in a family the
 * executor is never handed — `security.*`, `context.*` — stays with the person
 * whatever they chose, and no answer to an `incomplete` or `error` review hands
 * anything on (`decisionsOn`).
 */
export function remediationToContinue(input: {
  bundles: BundleStore;
  ticket_id: string;
  decided: readonly DecidedFinding[];
}): {
  review: ReviewArtifact;
  node_reviews: NodeReview[];
  reviewed_at: string;
  findings: Finding[];
  /** The person's words for each decided finding the round is handed, as data for the brief. */
  directions: Direction[];
  head_commit: string;
} | null {
  const judged = judgedOnRecord(input);
  if (judged === null) return null;
  const { review, node_reviews, reviewed_at, openKeys, head_commit } = judged;
  const decisions = decisionsOn(review, reviewed_at, input.decided);
  const remediable = remediableFindings(review.findings)
    .filter((finding) => isRemediableFamily(finding.rule_id))
    .filter((finding) => openKeys === null || openKeys.has(finding.key));
  const handed = review.findings.filter((finding) => {
    const decision = decisions.get(finding.key);
    return (
      routedToPerson(finding) &&
      decision !== undefined &&
      handsToExecutor(decision.choice) &&
      decisionChoicesFor(finding.rule_id).includes(decision.choice) &&
      !closedByRound(judged, finding.key)
    );
  });
  const findings = [...remediable, ...handed];
  if (findings.length === 0) return null;
  return {
    review,
    node_reviews,
    reviewed_at,
    findings,
    directions: handed.map((finding) => ({ finding_key: finding.key, words: decisions.get(finding.key)!.note })),
    head_commit,
  };
}

/** A person's words for a finding they handed to the executor, which its brief carries as data. */
export interface Direction {
  finding_key: string;
  words: string;
}

/**
 * The last independent review on the ticket's record, what the verifications
 * after it left open, and the commit the branch should still be at.
 *
 * The last verification's open set is the authoritative one — each round
 * narrows it — and the commit it judged is the one the branch should still be
 * at. Null where there is no readable review, or where a verification cannot
 * say what it left open.
 */
export function judgedOnRecord(input: { bundles: BundleStore; ticket_id: string }): {
  review: ReviewArtifact;
  node_reviews: NodeReview[];
  /** When the review was recorded: a person's answer to it is taken after this. */
  reviewed_at: string;
  /** What the last verification after the review left open; null where none ran. */
  openKeys: Set<string> | null;
  /**
   * Every finding a verification after the review was given. A finding given
   * and absent from the last open set was closed; one never given — a declined
   * one (D-065) — was not.
   */
  givenKeys: Set<string>;
  head_commit: string;
} | null {
  const forTicket = input.bundles.forTicket(input.ticket_id);
  const reviews = forTicket.filter(
    (bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_"),
  );
  const last = reviews[reviews.length - 1];
  if (last === undefined) return null;
  const artifact = last.artifacts.find((entry) => entry.name === "review.json");
  if (!artifact || !artifact.retained) return null;
  const body = input.bundles.readObject(artifact.sha256);
  if (body === null) return null;
  let parsed: ReturnType<typeof ReviewArtifactSchema.safeParse>;
  try {
    parsed = ReviewArtifactSchema.safeParse(JSON.parse(body));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const review = parsed.data;
  // The per-node reviews recorded beside it (D-107). Absent on a bundle
  // written before per-node review existed, or unreadable: [] either way,
  // the same default the schema gives a record that never held them.
  const node_reviews = readNodeReviews(input.bundles, last);

  const verifications = forTicket.filter(
    (bundle) =>
      bundle.kind === "review" &&
      bundle.subject_id.startsWith("cv_") &&
      bundle.created_at >= last.created_at,
  );
  const lastVerification = verifications[verifications.length - 1];
  const openKeys =
    lastVerification === undefined
      ? null
      : new Set(
          String(lastVerification.inputs["findings_open"] ?? "")
            .split(",")
            .filter((key) => key.length > 0),
        );
  // A verification bundle written before this ticket recorded its open set
  // cannot say what is still open, and guessing would hand the executor
  // findings it already closed.
  if (openKeys !== null && lastVerification!.inputs["findings_open"] === undefined) return null;

  const givenKeys = new Set(
    verifications.flatMap((bundle) =>
      String(bundle.inputs["findings_given"] ?? "")
        .split(",")
        .filter((key) => key.length > 0),
    ),
  );

  const head =
    lastVerification === undefined
      ? review.target.head_commit
      : (lastVerification.inputs["head_commit"] ?? null);
  if (typeof head !== "string" || head.length === 0) return null;
  return { review, node_reviews, reviewed_at: last.created_at, openKeys, givenKeys, head_commit: head };
}

/**
 * Whether a round closed a finding: given to a verification after the review,
 * and absent from the last one's open set, which is the authoritative one
 * because each round narrows it.
 */
function closedByRound(
  judged: Pick<NonNullable<ReturnType<typeof judgedOnRecord>>, "openKeys" | "givenKeys">,
  key: string,
): boolean {
  return judged.openKeys !== null && judged.givenKeys.has(key) && !judged.openKeys.has(key);
}

/**
 * The decisions that answer a review (`answersReview`): one per finding key.
 * None answer a review that is not `decidable`: it did not judge the whole
 * change, so the run goes on as though nothing were answered.
 */
export function decisionsOn(
  review: ReviewArtifact,
  reviewed_at: string,
  decided: readonly DecidedFinding[],
): Map<string, DecidedFinding> {
  if (!decidable(review)) return new Map();
  const keys = new Set(review.findings.map((finding) => finding.key));
  return new Map(
    decided
      .filter(
        (row) =>
          keys.has(row.finding_key) &&
          answersReview(row, { review_id: review.review_id, recorded_at: reviewed_at }),
      )
      .map((row) => [row.finding_key, row]),
  );
}

/**
 * The findings a review routed to a person that are still open: no decision
 * answers them, or the decision handed them to the executor and the round did
 * not take them — a family the executor is never handed.
 */
export function stillWithPerson(
  review: ReviewArtifact,
  decisions: ReadonlyMap<string, DecidedFinding>,
  handed: ReadonlySet<string>,
): Finding[] {
  return review.findings.filter((finding) => {
    if (!routedToPerson(finding)) return false;
    const decision = decisions.get(finding.key);
    if (decision === undefined) return true;
    return handsToExecutor(decision.choice) && !handed.has(finding.key);
  });
}

/** A review whose every standing finding a person decided or a round closed. */
export interface DecidedDelivery {
  /** The review on record, with the decisions recorded on its findings. */
  review: ReviewArtifact;
  node_reviews: NodeReview[];
  /** The commit the review, or the last verification after it, judged. */
  head_commit: string;
  decided: DecidedFinding[];
}

/**
 * The delivery a re-run takes without executing or reviewing anything, or
 * null where anything is still open
 * (D-132).
 *
 * The ticket's last review stopped on findings only a person can close, the
 * person answered them, and the branch — checked by the caller — is still the
 * commit that review judged. A fresh review of that commit would be a
 * stateless reviewer raising the same findings again for the person to answer
 * again, which is the loop this exists to end; so the run goes where a review
 * that requested no change goes.
 *
 * Every finding that still stands has to be answered: shipped as it is by a
 * person where the review routed it to one, or recorded closed by a
 * verification, whether the review routed it to the executor or a person
 * handed it on. One still open is the executor's
 * work, which `remediationToContinue` continues; a review that could not judge
 * every criterion, or did not complete, is answered by nothing (`decisionsOn`).
 * A run that delivered and then stopped short of the pull request, where the
 * base would not merge, delivers again on the same answers.
 */
export function decidedDelivery(input: {
  bundles: BundleStore;
  ticket_id: string;
  repository_id: string;
  decided: readonly DecidedFinding[];
}): DecidedDelivery | null {
  if (input.decided.length === 0) return null;
  const judged = judgedOnRecord(input);
  if (judged === null) return null;
  const { review } = judged;
  const decisions = decisionsOn(review, judged.reviewed_at, input.decided);
  const standing = review.findings.filter(
    (finding) =>
      finding.status === "open" &&
      (finding.blocking || routedToPerson(finding) || finding.routing === "remediable"),
  );
  const answered = (finding: Finding): boolean =>
    (routedToPerson(finding) && decisions.get(finding.key)?.choice === "ship_as_is") ||
    closedByRound(judged, finding.key);
  if (!standing.some((finding) => decisions.has(finding.key))) return null;
  if (!standing.every(answered)) return null;
  const decided = new Map([...decisions].filter(([key]) => standing.some((finding) => finding.key === key)));
  return {
    review: recordDecisions(review, decided, input.repository_id),
    node_reviews: judged.node_reviews,
    head_commit: judged.head_commit,
    decided: [...decided.values()],
  };
}

/**
 * The review a retained branch is published under
 * (D-NEW-publish-a-retained-branch-later): the one on record, with each
 * person's answer recorded on the finding it closed — shipped as it is, or
 * handed to the executor and closed by a verification — which is what the run
 * that retained the branch recorded on it.
 */
export function retainedReview(
  judged: NonNullable<ReturnType<typeof judgedOnRecord>>,
  decided: readonly DecidedFinding[],
  repository_id: string,
): { review: ReviewArtifact; decided: DecidedFinding[] } {
  const closed = new Map(
    [...decisionsOn(judged.review, judged.reviewed_at, decided)].filter(
      ([key, decision]) =>
        decision.choice === "ship_as_is" || (handsToExecutor(decision.choice) && closedByRound(judged, key)),
    ),
  );
  return { review: recordDecisions(judged.review, closed, repository_id), decided: [...closed.values()] };
}

/** A review bundle's per-node reviews (D-107), `[]` where the bundle holds none. */
export function readNodeReviews(bundles: BundleStore, bundle: RunBundle): NodeReview[] {
  const artifact = bundle.artifacts.find((entry) => entry.name === "node-reviews.json");
  if (!artifact || !artifact.retained) return [];
  const body = bundles.readObject(artifact.sha256);
  if (body === null) return [];
  try {
    const parsed = NodeReviewsSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * SCP-194: is the branch still the one the last review judged?
 *
 * Asked of the branch rather than of the record, and before the merge-up, so
 * what is compared is the work on the branch and not the base moving under it.
 * A branch that has moved carries commits no review has seen, and a
 * verification against it would grade a change nobody judged — so the run
 * drops back to a fresh review of what is there.
 *
 * Asked before the attempt id is minted, because the answer decides the round
 * this attempt is in. Answered once per run: the state it returns carries no
 * continuation.
 */
export async function confirmContinuation(
  state: RoundState,
  progress: (message: string) => void,
): Promise<RoundState> {
  if (state.continuing === null) return state;
  const head = await branchHead(state.workspace.path, state.baseCommit);
  if (head !== null && sameCommit(head, state.continuing.head_commit)) {
    return { ...state, continuing: null };
  }
  progress(
    `the branch is at ${head ?? "its base"} and the last review judged ` +
      `${state.continuing.head_commit}: it has moved, so this run reviews it afresh rather ` +
      "than verifying closures against a change set nobody judged",
  );
  return {
    ...state,
    kind: "execute",
    round: 0,
    remediationRound: 0,
    openFindings: [],
    finalReview: null,
    nodeReviews: [],
    continuing: null,
    // The decisions answered the review of the commit the branch has moved
    // past; a fresh review of what is there is asked afresh.
    directions: [],
  };
}

/**
 * The last commit on the branch past its base, or null where the branch is at
 * its base. Asked before the merge-up, so what is compared with a judged commit
 * is the work on the branch and not the base moving under it.
 */
async function branchHead(worktree: string, base_commit: string): Promise<string | null> {
  const onBranch = await commitsSince({ worktree, base_commit });
  return onBranch[onBranch.length - 1] ?? null;
}

/** Whether the branch is still at the commit a review judged. */
export async function branchStillAt(worktree: string, base_commit: string, judged: string): Promise<boolean> {
  const head = await branchHead(worktree, base_commit);
  return head !== null && sameCommit(head, judged);
}

/**
 * The attempts of the run that sealed a commit: the change a decided delivery
 * publishes was made by them, and the pull request states what they cost. A
 * later run that sealed nothing — one that failed, or was stopped — made none
 * of it. An entry that is not an attempt record is left out rather than
 * guessed.
 */
export function attemptsThatSealed(record: AttemptsRecord | null, head_commit: string): ExecutionAttempt[] {
  const stored = record?.attempts ?? [];
  // The first attempt at the commit sealed it: a later one whose head is the
  // same commit carried it forward and sealed nothing of its own.
  const head = z.object({ head_commit: z.string().nullable() });
  const root = stored.find((entry) => {
    const parsed = head.safeParse(entry);
    return parsed.success && parsed.data.head_commit !== null && sameCommit(parsed.data.head_commit, head_commit);
  })?.root_attempt_id;
  if (root === undefined) return [];
  return stored
    .filter((entry) => entry.root_attempt_id === root)
    .flatMap((entry) => {
      const parsed = ExecutionAttemptSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
}
