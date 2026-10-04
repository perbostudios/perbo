import { join } from "node:path";
import {
  ExecutionAttemptSchema,
  NodeReviewsSchema,
  ReviewArtifactSchema,
  answersReview,
  attemptsFileName,
  decidable,
  decisionChoicesFor,
  declinesOnRecord,
  judgedCommit,
  loopOnRecord,
  owedAnswers,
  routedToPerson,
  type ExecutionAttempt,
  type Finding,
  type LoopOnReview,
  type NodeReview,
  type PlanContract,
  type ReviewArtifact,
  type RunBundle,
  type HistoryRow,
  type RecordedDecline,
  sameCommit,
} from "@perbo/contracts";
import { isRemediableFamily, remediableFindings } from "@perbo/review";
import { git, ticketBranchStillAt } from "@perbo/workspace";
import { z } from "zod";
import { lastAttemptBranch, readAttemptsRecord, type AttemptsRecord } from "../../attempts.js";
import { handsToExecutor, recordDecisions, type DecidedFinding } from "../../decisions.js";
import { BundleStore } from "../../bundle.js";
import { changedPathsBetween, commitsSince } from "../../seal.js";
import type { TicketRunConfig } from "./config.js";
import type { EarlierAnswer, RoundState } from "./state.js";

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
 * A finding routed to a person (`routedToPerson`) joins the round where the
 * person decided it with an approach of their own or left the approach to the
 * executor (D-132): the executor is handed it with the person's words, and the
 * closure verifier checks it (D-061), until a verification records it closed.
 * One in a family the executor is never handed — `security.*`, `context.*` —
 * stays with the person whatever they chose, and no answer to an `incomplete`
 * or `error` review hands anything on (`decisionsOn`). Once a run ended on
 * `FINISHED_TRYING`, every finding it left open is the person's, so a round
 * after it is the one their answers scope, and none where they gave none
 * (`answersOwed`).
 */
export function remediationToContinue(input: {
  bundles: BundleStore;
  ticket_id: string;
  decided: readonly DecidedFinding[];
  history: readonly HistoryRow[];
  declines: readonly RecordedDecline[];
}): {
  review: ReviewArtifact;
  node_reviews: NodeReview[];
  reviewed_at: string;
  /** What the loop has done on the review, which says who each finding is asked of. */
  loop: LoopOnReview;
  findings: Finding[];
  /** The person's words for each decided finding the round is handed, as data for the brief. */
  directions: Direction[];
  head_commit: string;
} | null {
  const judged = judgedOnRecord(input);
  if (judged === null) return null;
  const { review, node_reviews, reviewed_at, openKeys, loop, head_commit } = judged;
  const decisions = decisionsOn(review, reviewed_at, input.decided, loop);
  const remediable = remediableFindings(review.findings)
    .filter((finding) => isRemediableFamily(finding.rule_id))
    .filter((finding) => openKeys === null || openKeys.has(finding.key))
    .filter((finding) => !routedToPerson(finding, loop));
  const handed = review.findings.filter((finding) => {
    const decision = decisions.get(finding.key);
    return (
      routedToPerson(finding, loop) &&
      decision !== undefined &&
      handsToExecutor(decision.choice) &&
      decisionChoicesFor(finding.rule_id).includes(decision.choice) &&
      !loop.closed.has(finding.key)
    );
  });
  const findings = [...remediable, ...handed];
  if (findings.length === 0) return null;
  return {
    review,
    node_reviews,
    reviewed_at,
    loop,
    findings,
    directions: handed.map((finding) => ({ finding_key: finding.key, words: decisions.get(finding.key)!.note })),
    head_commit,
  };
}

/**
 * A person's answers to the last review on record, each with the finding as
 * that review stated it (D-132): what a run that reviews afresh — its branch
 * moved past the commit that review judged — carries into its executor's
 * first brief as data. Empty where no answer stands on that review, or none
 * is readable.
 */
export function answersBefore(input: {
  bundles: BundleStore;
  ticket_id: string;
  decided: readonly DecidedFinding[];
  history: readonly HistoryRow[];
  declines: readonly RecordedDecline[];
}): EarlierAnswer[] {
  if (input.decided.length === 0) return [];
  const judged = judgedOnRecord(input);
  if (judged === null) return [];
  const decisions = decisionsOn(judged.review, judged.reviewed_at, input.decided, judged.loop);
  return judged.review.findings.flatMap((finding) => {
    const decision = decisions.get(finding.key);
    return decision === undefined
      ? []
      : [{ finding_key: finding.key, statement: finding.statement, choice: decision.choice, words: decision.note }];
  });
}

/** A person's words for a finding they handed to the executor, which its brief carries as data. */
export interface Direction {
  finding_key: string;
  words: string;
}

/**
 * The last independent review on the ticket's record, what the verifications
 * after it left open, what the loop has done on it, and the commit the branch
 * should still be at.
 *
 * A finding's status is the one the last verification given it recorded
 * (`loopOnReview`): each round narrows what it is given, and a round scoped to
 * a person's answers says nothing of the findings it was not given. Whether
 * the loop has finished trying is read from the ticket's rows, which the
 * caller hands in. The commit the branch should still be at is the last one a
 * verification judged, or the review's where none did: a round the scope rule
 * refused (SCP-194) records the commit it refused under a key of its own and
 * judged no tree, and the runner puts the branch back at the commit this
 * names (`restoreJudgedCommit`). Null where there is no readable review, or
 * where a verification cannot say what it left open.
 */
export function judgedOnRecord(input: {
  bundles: BundleStore;
  ticket_id: string;
  history: readonly HistoryRow[];
  /** The declines the ticket's attempts record (`declinesOfRecord`). */
  declines: readonly RecordedDecline[];
}): {
  review: ReviewArtifact;
  node_reviews: NodeReview[];
  /** When the review was recorded: a person's answer to it is taken after this. */
  reviewed_at: string;
  /**
   * What the verifications after the review left open: every finding one was
   * given or left open that a later one did not close. Null where none ran; a
   * finding never given — a declined one (D-065) — is not in it.
   */
  openKeys: Set<string> | null;
  /** What the loop has done on the review: whether it finished trying, and what it closed. */
  loop: LoopOnReview;
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

  const onRecord = loopOnRecord({
    review_id: review.review_id,
    bundles: forTicket,
    history: input.history,
    declines: input.declines,
  });
  if (onRecord === null) return null;
  const { verifications, loop } = onRecord;
  const keysOf = (value: unknown): string[] =>
    String(value ?? "")
      .split(",")
      .filter((key) => key.length > 0);
  const openKeys =
    verifications.length === 0
      ? null
      : new Set(
          verifications
            .flatMap((bundle) => [...keysOf(bundle.inputs["findings_given"]), ...keysOf(bundle.inputs["findings_open"])])
            .filter((key) => !loop.closed.has(key)),
        );

  const head = judgedCommit(review.target.head_commit, verifications);
  if (head === null) return null;
  return { review, node_reviews, reviewed_at: last.created_at, openKeys, loop, head_commit: head };
}

/**
 * The decisions that answer a review (`answersReview`): one per finding key.
 * None answer a review that is not `decidable`: one that did not judge the
 * whole change, or that routed its findings to the executor while the loop is
 * still trying, so the run goes on as though nothing were answered.
 */
export function decisionsOn(
  review: ReviewArtifact,
  reviewed_at: string,
  decided: readonly DecidedFinding[],
  loop: LoopOnReview,
): Map<string, DecidedFinding> {
  if (!decidable(review, loop)) return new Map();
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
 * The findings routed to a person that are still open: no decision answers
 * them, or the decision handed them to the executor and the round did not take
 * them — a family the executor is never handed.
 */
export function stillWithPerson(
  review: ReviewArtifact,
  decisions: ReadonlyMap<string, DecidedFinding>,
  handed: ReadonlySet<string>,
  loop: LoopOnReview,
): Finding[] {
  return review.findings.filter((finding) => {
    if (!routedToPerson(finding, loop)) return false;
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
 * person where it is routed to one (`routedToPerson`), or recorded closed by a
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
  history: readonly HistoryRow[];
  /** The declines the ticket's attempts record (`declinesOfRecord`). */
  declines: readonly RecordedDecline[];
}): DecidedDelivery | null {
  if (input.decided.length === 0) return null;
  const judged = judgedOnRecord(input);
  if (judged === null) return null;
  const { review, loop } = judged;
  const decisions = decisionsOn(review, judged.reviewed_at, input.decided, loop);
  const standing = review.findings.filter(
    (finding) =>
      finding.status === "open" &&
      (finding.blocking || routedToPerson(finding, loop) || finding.routing === "remediable"),
  );
  const answered = (finding: Finding): boolean =>
    (routedToPerson(finding, loop) && decisions.get(finding.key)?.choice === "ship_as_is") ||
    loop.closed.has(finding.key);
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
 * The findings of the ticket's last review a run would start without an
 * answer to (`owedAnswers`), with the commit the review, or the last
 * verification after it, judged: a branch that has moved past it is reviewed
 * afresh, and the caller asks the branch. Null where a run has what it needs.
 */
export function answersOwed(input: {
  bundles: BundleStore;
  ticket_id: string;
  decided: readonly DecidedFinding[];
  history: readonly HistoryRow[];
  /** The declines the ticket's attempts record (`declinesOfRecord`). */
  declines: readonly RecordedDecline[];
}): { findings: Finding[]; head_commit: string } | null {
  const judged = judgedOnRecord(input);
  if (judged === null) return null;
  const { review, loop } = judged;
  const decisions = decisionsOn(review, judged.reviewed_at, input.decided, loop);
  const owed = new Set(
    owedAnswers({
      review,
      loop,
      answers: new Map([...decisions].map(([key, decision]) => [key, decision.choice])),
    }),
  );
  const findings = review.findings.filter((finding) => owed.has(finding.key));
  return findings.length === 0 ? null : { findings, head_commit: judged.head_commit };
}

/**
 * A run refused because the person owes answers to findings its last review's
 * loop finished trying (`answersOwed`). Raised before anything is provisioned,
 * executed or paid for; its message is the one sentence the person reads.
 */
export class AnswersOwedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswersOwedError";
  }
}

/**
 * Refuse a run that owes a person's answers (`answersOwed`), with the sentence
 * that says how to give them, before anything is provisioned: the command
 * asks it before it moves the ticket, and the loop again under the run lock.
 * The branch the ticket's records name is read in the checkout itself
 * (`ticketBranchStillAt`, which the desktop's host reads too): one whose tip
 * is no longer the commit the review, or the last verification after it,
 * judged carries work nobody judged, and that run reviews it afresh. An
 * explicit `--resume-from` names the attempt whose work the run carries on,
 * which a fresh review then judges, and a re-level merges the base into an
 * open pull request's branch: neither is refused here.
 */
export async function refuseOwedAnswers(input: {
  config: Pick<
    TicketRunConfig,
    | "bundle_root"
    | "retain_context"
    | "state_root"
    | "repository_root"
    | "ticket_key"
    | "delivery_branch"
    | "resume_from"
    | "relevel"
  >;
  contract: Pick<PlanContract, "ticket_id" | "outcome">;
  decided: readonly DecidedFinding[];
  history: readonly HistoryRow[];
}): Promise<void> {
  const { config, contract } = input;
  if (config.resume_from !== null || config.relevel) return;
  const attempts = readAttemptsRecord(join(config.state_root, attemptsFileName(contract.ticket_id)));
  const owed = answersOwed({
    bundles: new BundleStore({ root: config.bundle_root, retainContext: config.retain_context }),
    ticket_id: contract.ticket_id,
    decided: input.decided,
    history: input.history,
    declines: declinesOfRecord(attempts),
  });
  if (owed === null) return;
  const judged = await ticketBranchStillAt({
    resolveCommit: (ref) => git.resolveCommit(config.repository_root, ref),
    recorded: { delivery: config.delivery_branch, attempt: lastAttemptBranch(attempts) },
    ticket_key: config.ticket_key,
    ticket_id: contract.ticket_id,
    outcome: contract.outcome,
    commit: owed.head_commit,
  });
  if (!judged) return;
  throw new AnswersOwedError(answersOwedSentence(config.ticket_key, owed.findings));
}

/**
 * The sentence a run owed answers is refused with: which ticket, which
 * findings, and the commands that answer them.
 */
export function answersOwedSentence(ticket_key: string, findings: readonly Pick<Finding, "key">[]): string {
  return (
    `${ticket_key}'s last run finished trying and left ${findings.length} finding(s) for you to answer ` +
    `(${findings.map((finding) => finding.key.slice(0, 12)).join(", ")}), none of them handed to the ` +
    `executor, so this run does not start: answer each with \`perbo verdict ${ticket_key} --decide ` +
    "<finding> --choice approach|let-it-decide|ship-as-is`, and `perbo options " +
    `${ticket_key} --finding <finding>\` offers answers to pick`
  );
}

/**
 * The review a retained branch is published under
 * (D-136): the one on record, with each
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
    [...decisionsOn(judged.review, judged.reviewed_at, decided, judged.loop)].filter(
      ([key, decision]) =>
        decision.choice === "ship_as_is" || (handsToExecutor(decision.choice) && judged.loop.closed.has(key)),
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
 * The runner never leaves the branch at a commit it refused: a refused round
 * is put back at the judged commit (`restoreJudgedCommit`), so a person's
 * answers continue here. A branch that has moved otherwise — a commit made
 * outside the run — carries commits no review has seen, and a verification
 * against it would grade a change nobody judged, so the run drops back to a
 * fresh review of what is there, the person's answers to the earlier review
 * carried into its brief as data (`answersBefore`).
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
    // The change set the judged commit holds is what the first round's
    // widening is measured against (SCP-194), as a later round's is against
    // the round before it: only a path this round adds is a widening.
    return {
      ...state,
      continuing: null,
      previousChangedPaths: await changedPathsBetween({
        worktree: state.workspace.path,
        base_commit: state.baseCommit,
        head_commit: head,
      }),
    };
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

/**
 * Puts the ticket's branch back at the commit last judged, after the runner
 * refused a round's work (SCP-194): the review's commit, or the last one a
 * closure verification judged (`judgedOnRecord`). The refused work stays on
 * the record — its diff in the attempt's bundle and its commit as the
 * refusal's `refused_head_commit` — and the branch never ends at a commit the
 * runner rejected, so a person's answers to that review act on the branch
 * the next run finds rather than on a fresh review of work nobody judged.
 *
 * Only the worktree's own branch, the ticket's, is moved, only backwards along
 * its own line, and only by argv git (ADR-0023). Returns the commit it is back
 * at, or null where the record names none or the branch is not the ticket's or
 * does not carry that commit, which it leaves where it is.
 */
export async function restoreJudgedCommit(args: {
  worktree: string;
  branch: string;
  bundles: BundleStore;
  ticket_id: string;
}): Promise<string | null> {
  const judged = judgedOnRecord({ bundles: args.bundles, ticket_id: args.ticket_id, history: [], declines: [] });
  if (judged === null) return null;
  const on = await git.run(args.worktree, ["symbolic-ref", "--short", "HEAD"], RESTORE_CALL);
  if (on.code !== 0 || on.stdout.trim() !== args.branch) return null;
  const head = await git.head(args.worktree, RESTORE_CALL);
  if (head === null) return null;
  if (sameCommit(head, judged.head_commit)) return head;
  if (!(await git.isAncestor(args.worktree, judged.head_commit, head, RESTORE_CALL))) return null;
  await git.runOrThrow(args.worktree, ["reset", "--hard", judged.head_commit], RESTORE_CALL);
  return judged.head_commit;
}

const RESTORE_CALL = { timeoutMs: 120_000 };

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

/**
 * The declines a ticket's attempts record (`declinesOnRecord`), read from its
 * attempts record: an entry that does not parse as an attempt with its start
 * time adds none.
 */
export function declinesOfRecord(record: AttemptsRecord | null): RecordedDecline[] {
  const Declining = z.object({
    created_at: z.string(),
    declines: z.array(z.object({ finding_key: z.string(), reason: z.string() })).optional(),
  });
  return declinesOnRecord(
    (record?.attempts ?? []).flatMap((entry) => {
      const parsed = Declining.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}
