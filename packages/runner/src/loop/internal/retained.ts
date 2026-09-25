import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  attemptsFileName,
  hasAcceptanceCriteria,
  type GithubCredential,
  type PlanContract,
  type RetainedBranch,
  type ReviewArtifact,
} from "@perbo/contracts";
import { git, isAttemptBranch } from "@perbo/workspace";
import { readAttemptsRecord, sealedByAttempt } from "../../attempts.js";
import { BundleStore } from "../../bundle.js";
import type { DecidedFinding } from "../../decisions.js";
import type { DeliveredChecksReading } from "../../delivery.js";
import { acquireRunLock } from "../../lock.js";
import type { LoopMergeOutcome } from "../../merge.js";
import { RunRefusedError } from "../../refusal.js";
import { sameCommit } from "../../resume.js";
import type { TicketRunConfig } from "./config.js";
import { resolvePorts, type LoopPorts } from "./context.js";
import { attemptsThatSealed, judgedOnRecord, retainedReview } from "./continuation.js";
import { publish, type PullRequestRef } from "./deliver.js";
import { branchLine } from "./relevel.js";

/**
 * Publishing a branch a run retained without publishing
 * (D-NEW-publish-a-retained-branch-later).
 *
 * A run that ended `approved` or `escalated` with publishing off left its
 * branch on this machine and opened nothing. A person's press publishes it
 * later, through the same delivery a publishing run ends in — the push, the
 * pull request opened with the review on record, the merge step and the
 * reading of the head's checks — without executing or reviewing anything
 * again. So the branch has to be exactly what that review judged: it is still
 * the commit the review, or the last verification after it, judged; every
 * commit on its own line is one the loop made; and the base has not moved past
 * it. Anything else is refused and said, before anything is pushed.
 */

export interface RetainedPublishRequest {
  config: TicketRunConfig;
  contract: PlanContract;
  /**
   * The branch the ticket's last run retained and how the ticket records that
   * run's end, or why there is none, read from the ticket as it stands
   * (`retainedBranch` in `@perbo/contracts`). Read under the run lock, so a run of the ticket
   * that started and ended after the person pressed is judged by what it
   * left, not by what the ticket said before.
   */
  retained: () => RetainedBranch;
  /** The person's answers on record, which the review is published with. */
  decided?: readonly DecidedFinding[];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
  /** Called the moment the pull request opens, as a run's is. */
  onPullRequest?: (pull_request: PullRequestRef) => void;
  /**
   * Writes the delivery onto the ticket's record. Awaited while the run lock
   * is still held, so no run of the ticket can start between the pull request
   * opening and the record saying so.
   */
  recordDelivery?: (published: RetainedPublishResult) => void | Promise<void>;
  /** Injected by tests: a stand-in for the push, the pull request and the merge step. */
  hooks?: Partial<Pick<LoopPorts, "push" | "open" | "merge">>;
}

export interface RetainedPublishResult {
  ticket_id: string;
  branch: string;
  /** How the ticket records the end of the run whose branch this is. */
  outcome: "approved" | "escalated";
  /** The review the pull request states, with the person's answers recorded on it. */
  final_review: ReviewArtifact;
  pull_request: PullRequestRef;
  merge: LoopMergeOutcome | null;
  delivery_checks: DeliveredChecksReading | null;
  github_credential: GithubCredential | null;
  detail: string;
  decided: DecidedFinding[];
}

const CALL = { timeoutMs: 120_000 };

/**
 * Push a retained branch, open its pull request and record the delivery, under
 * the ticket's run lock, so a run of the same ticket cannot move the branch
 * under it or start before the record says the pull request is open.
 */
export async function publishRetained(args: RetainedPublishRequest): Promise<RetainedPublishResult> {
  const clock = args.now ?? (() => new Date());
  const lock = acquireRunLock({
    state_root: args.config.state_root,
    ticket_id: args.contract.ticket_id,
    ticket_key: args.config.ticket_key,
    now: clock(),
  });
  try {
    const published = await publishLocked(args, clock);
    await args.recordDelivery?.(published);
    return published;
  } finally {
    lock.release();
  }
}

async function publishLocked(args: RetainedPublishRequest, clock: () => Date): Promise<RetainedPublishResult> {
  const { config } = args;
  const key = config.ticket_key;
  const progress = args.onProgress ?? (() => undefined);
  const refuse = (what: string): never => {
    throw new RunRefusedError({
      message: `${what}. Nothing was pushed`,
      findings: [],
      repository_root: config.repository_root,
    });
  };
  const retained = args.retained();
  if (retained.refusal !== null) refuse(retained.refusal);
  const branch = retained.branch!;
  const outcome = retained.outcome!;
  if (!hasAcceptanceCriteria(args.contract)) {
    throw new Error(
      `plan ${args.contract.plan_id} is ${args.contract.level}, which has no acceptance criteria: ` +
        "no review judged it, so there is nothing to publish its branch under",
    );
  }
  const contract = args.contract;
  if (!isAttemptBranch(branch)) refuse(`${branch} is not a branch the loop minted`);

  const bundles = new BundleStore({ root: config.bundle_root, retainContext: config.retain_context });
  const attemptsPath = join(config.state_root, attemptsFileName(contract.ticket_id));
  const prior = readAttemptsRecord(attemptsPath);
  const judged = judgedOnRecord({ bundles, ticket_id: contract.ticket_id });
  if (judged === null) refuse(`no review of ${key} is on record, so there is nothing to publish its branch under`);
  const { head_commit } = judged!;
  const attempts = attemptsThatSealed(prior, head_commit);
  const sealer = attempts[attempts.length - 1];
  if (sealer === undefined) {
    refuse(
      `no attempt on ${key}'s record sealed ${head_commit}, the commit its review judged, so there is ` +
        "no run to open the pull request under",
    );
  }
  // D-065: what the run's executor declined, as each attempt sealed it. An
  // escalated run may have ended on a decline, and an attempt whose record
  // does not say what it declined leaves the pull request unable to list what
  // is the person's to decide.
  if (outcome === "escalated") {
    const unsaid = attempts.filter((attempt) => attempt.remediation_round > 0 && attempt.declines === undefined);
    if (unsaid.length > 0) {
      refuse(
        `${key}'s run ended escalated, and the record of ${unsaid.map((attempt) => attempt.attempt_id).join(", ")} ` +
          "does not say which findings its executor declined, so the pull request cannot list what is yours " +
          `to decide. \`perbo run --ticket ${key} --publish\` judges what is there`,
      );
    }
  }
  const declines = attempts.flatMap((attempt) => attempt.declines ?? []);
  // What each closure verification of the run's attempts cost, from its
  // bundle: the figure the run itself added to the pull request's cost.
  const verified = new Set(attempts.map((attempt) => `cv_${attempt.attempt_id}`));
  const verificationCosts = bundles
    .forTicket(contract.ticket_id)
    .filter((bundle) => bundle.kind === "review" && verified.has(bundle.subject_id))
    .map((bundle) => ({ cost_micros: bundle.usage.cost_micros, cost_basis: bundle.usage.cost_basis }));

  const head = await git.resolveCommit(config.repository_root, `refs/heads/${branch}`, CALL);
  if (head === null) refuse(`${branch}, the branch ${key}'s run retained, is not in this checkout`);
  if (!sameCommit(head!, head_commit)) {
    refuse(
      `${branch} is at ${head!.slice(0, 12)} and ${key}'s review judged ${head_commit.slice(0, 12)}: the ` +
        `branch has moved past what the run judged. \`perbo run --ticket ${key} --publish\` judges what ` +
        "is there",
    );
  }

  // Every commit on the branch's own line past the base the run started from
  // carries the trailer of an attempt on the record, or is a commit the record
  // sealed. The trailer is trusted as written, as a re-level trusts it.
  const onRecord = new Set(
    (prior?.attempts ?? []).flatMap((attempt) => [attempt.attempt_id, ...(attempt.root_attempt_id ? [attempt.root_attempt_id] : [])]),
  );
  const sealed = sealedByAttempt(prior);
  const line = await branchLine(config.repository_root, `${sealer!.base_commit}..${head}`, CALL);
  if (!line.whole) {
    refuse(
      `what ${branch} carries past ${sealer!.base_commit.slice(0, 12)} could not be listed whole, so ` +
        "whether the loop made all of it cannot be said",
    );
  }
  const foreign = line.commits.filter(
    (commit) => !sealed.has(commit.sha) && !commit.attempts.some((attempt) => onRecord.has(attempt)),
  );
  if (foreign.length > 0) {
    refuse(
      `${branch} carries ${foreign.length} commit${foreign.length === 1 ? "" : "s"} the loop did not make: ` +
        foreign.map((commit) => `${commit.sha.slice(0, 12)} ${commit.subject}`).join("; ") +
        "; the loop neither drops nor publishes what it did not make",
    );
  }

  // The base as the loop reads it: the local ref, which the queue fetches.
  const tip = await git.resolveCommit(config.repository_root, config.base_ref, CALL);
  if (tip === null) {
    refuse(`${config.base_ref} names no commit in this checkout, so whether it moved past what the run judged cannot be read`);
  }
  if (!(await git.isAncestor(config.repository_root, tip!, head!, CALL))) {
    refuse(
      `${config.base_ref} has moved to ${tip!.slice(0, 12)}, which ${branch} does not carry: the base has ` +
        `moved past what the run judged. \`perbo run --ticket ${key} --publish\` merges it up and judges the result`,
    );
  }

  const { review, decided } = retainedReview(judged!, args.decided ?? [], contract.scope.repository_id);
  const ports = resolvePorts(config, args.hooks);
  const detail =
    `${branch} is still at ${head_commit.slice(0, 12)}, the commit the review judged, and carries ` +
    `${config.base_ref} at ${tip!.slice(0, 12)}: published without executing or reviewing again`;
  progress(detail);
  const delivery = await publish({
    config,
    contract,
    state: {
      workspace: { path: config.repository_root, branch, base_commit: sealer!.base_commit },
      baseCommit: sealer!.base_commit,
    },
    attempts,
    verificationCosts,
    declines,
    rootAttemptId: sealer!.attempt_id,
    finalReview: review,
    detail,
    push: ports.push,
    open: ports.open,
    merge: ports.merge,
    onPullRequest: args.onPullRequest,
    clock,
    wait: args.sleep ?? ((ms: number) => setTimeout(ms)),
    progress,
  });
  return {
    ticket_id: contract.ticket_id,
    branch,
    outcome,
    final_review: review,
    pull_request: delivery.pull_request!,
    merge: delivery.merge,
    delivery_checks: delivery.delivery_checks,
    github_credential: delivery.github_credential,
    detail: delivery.detail,
    decided,
  };
}
