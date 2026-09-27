import {
  failedChecks,
  oneLine,
  type CostBasis,
  type ExecutionAttempt,
  type GithubCredential,
  type PlanContractWithCriteria,
  type ReviewArtifact,
} from "@perbo/contracts";
import {
  deliveredChecksSection,
  editPullRequestBody,
  pullRequestBody,
  readDeliveredChecks,
  type DeliveredChecksReading,
  type createPullRequest,
} from "../../delivery.js";
import { githubCredential } from "../../github-credential.js";
import type { LoopMergeOutcome } from "../../merge.js";
import type { TicketRunConfig } from "./config.js";
import type { LoopPorts } from "./context.js";
import type { Decline } from "../../declines.js";
import type { Ledger } from "./ledger.js";
import type { RoundState } from "./state.js";

/**
 * Publishing what a run decided (SCP-200, SCP-202).
 */

/** The longest pull-request title GitHub takes. */
export const PULL_REQUEST_TITLE_LIMIT = 256;

/**
 * The pull request's title: the ticket's key and the first whole sentence of
 * the outcome, or the key alone where that does not fit GitHub's limit. The
 * whole outcome is the body's Outcome section either way, so nothing is cut.
 */
export function pullRequestTitle(key: string, outcome: string): string {
  const flat = oneLine(outcome);
  const sentence = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  const title = `${key}: ${sentence}`;
  return title.length <= PULL_REQUEST_TITLE_LIMIT ? title : key;
}

/** The pull request a run publishes to, as `createPullRequest` reports it. */
export type PullRequestRef = Awaited<ReturnType<typeof createPullRequest>>;

/** What one closure verification cost, as the pull request body adds it up. */
export interface VerificationCost {
  cost_micros: number;
  cost_basis: CostBasis;
}

/** What reached GitHub, and what the run records of it. */
export interface Delivery {
  pull_request: PullRequestRef | null;
  /** SCP-202: what the post-approval merge step did, where one ran. */
  merge: LoopMergeOutcome | null;
  /** What the checks on the published head said, where there was one. */
  delivery_checks: DeliveredChecksReading | null;
  /** SCP-200: the credential path this run published through. */
  github_credential: GithubCredential | null;
  /** SCP-192: the base tip the branch is level with when the run ends. */
  merged_base: string | null;
  /** The run's detail, which a red check on the published head adds to. */
  detail: string;
}

/** Everything publishing reaches the world through, and what it publishes. */
interface PublishArgs {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  /**
   * Where the branch is and the base its change set is measured against: a
   * run's round state, or the checkout a retained branch is published from
   * (D-NEW-publish-a-retained-branch-later).
   */
  state: Pick<RoundState, "baseCommit"> & {
    workspace: Pick<RoundState["workspace"], "path" | "branch" | "base_commit">;
  };
  rootAttemptId: string;
  push: LoopPorts["push"];
  merge: LoopPorts["merge"];
  clock: () => Date;
  wait: (ms: number) => Promise<void>;
  progress: (message: string) => void;
}

/**
 * Push the branch, open the pull request and take the merge step (SCP-202,
 * D-077).
 *
 * The merge step is the same one `perbo sync --merge` calls and it decides on
 * the switch first, so a repository that merges by hand reaches no further
 * than that.
 */
export async function publish(
  args: PublishArgs & {
    /**
     * The attempts the change was made by, oldest first: this run's, or where
     * a person's decisions delivered it without a round, the run whose change
     * the review judged (D-132).
     */
    attempts: readonly ExecutionAttempt[];
    /** What each closure verification of those attempts cost, which the body adds up. */
    verificationCosts: readonly VerificationCost[];
    /** D-065: the findings those attempts declined, which the body leaves for the person. */
    declines: readonly Decline[];
    open: LoopPorts["open"];
    /** The review that judged the change; the pull request body states it. */
    finalReview: ReviewArtifact;
    /** What the run decided, which a red check on the head adds to. */
    detail: string;
    onPullRequest: ((pull_request: PullRequestRef) => void) | undefined;
  },
): Promise<Delivery> {
  const { config, contract, state, clock, progress } = args;
  let delivery_checks: DeliveredChecksReading | null = null;
  let detail = args.detail;
  const merged_base = state.baseCommit === state.workspace.base_commit ? null : state.baseCommit;
  // SCP-200: the runner holds the credential and performs both steps, so
  // the path is read from the runner's own environment. The preflight in
  // front of this run already refused a machine that has neither.
  const github_credential = githubCredential();
  await args.push({ worktree: state.workspace.path, branch: state.workspace.branch, onProgress: progress });
  const body = pullRequestBody({
    contract,
    attempt: args.attempts[args.attempts.length - 1]!,
    review: args.finalReview,
    attempts: [...args.attempts],
    // Where the work came from, so the person merging reads it here
    // rather than going back to the ticket for it.
    source: config.ticket_source,
    verification_costs: args.verificationCosts,
    declines: args.declines,
    // SCP-202: the closing line says which of the two merges this pull
    // request is waiting for, from the switch that decides it.
    merge: config.merge,
  });
  const pull_request = await args.open({
    worktree: state.workspace.path,
    branch: state.workspace.branch,
    base_ref: config.base_ref,
    title: pullRequestTitle(config.ticket_key, contract.outcome),
    body,
  });
  progress(`pull request ${pull_request.url}`);
  args.onPullRequest?.(pull_request);

  // SCP-202, D-077: the last mile. The step is the same one `perbo sync
  // --merge` calls and it decides on the switch first, so a repository
  // that merges by hand reaches no further than that. The six conditions
  // are read against the pull request as it is now — which, seconds after
  // it opened, is a pull request whose checks have not run and which no
  // separate review run has approved, so the ordinary answer here is a
  // stop, and the merge happens on a later `perbo sync --merge`.
  //
  // A stop leaves `outcome` alone: the change was approved and the pull
  // request is open, and what is missing is a condition of the merge.
  const merge = await args.merge({
    mode: config.merge,
    repository_root: config.repository_root,
    branch: state.workspace.branch,
    pull_request_number: pull_request.number,
    base_ref: config.base_ref,
    state_root: config.state_root,
    ticket_key: config.ticket_key,
    paths_allowed: contract.scope.paths_allowed,
    attempt_id: args.attempts[args.attempts.length - 1]?.attempt_id ?? args.rootAttemptId,
    now: clock(),
  });
  progress(merge.merged ? `merged: ${merge.detail}` : `not merged — ${merge.detail}`);

  // The checks on the head, read here and not earlier: the merge step
  // decides on a pull request seconds old, and reading first would hand it
  // a different pull request than the one it has always decided on. The
  // reading is still before anything records the delivery — that happens
  // on the result this returns.
  //
  // Nothing here throws: the pull request is open, and a run that lost its
  // whole record because `gh` could not answer one more question would be
  // the worse outcome.
  try {
    delivery_checks = await readDeliveredChecks({
      worktree: state.workspace.path,
      branch: state.workspace.branch,
      boundMs: config.delivery_checks_bound_ms,
      now: clock,
      sleep: args.wait,
      onProgress: progress,
    });
    const failed = failedChecks(delivery_checks.checks);
    progress(
      `checks on the head: ${delivery_checks.state}` +
        (delivery_checks.checks.length === 0
          ? " — none reported"
          : ` — ${delivery_checks.checks
              .map((check) => `${check.name} ${check.conclusion}`)
              .join(", ")}`),
    );
    if (failed.length > 0) {
      // The outcome stays what the review decided: the change was
      // approved and a check on the head went red, and those are two
      // different facts. The line a person reads carries both.
      detail =
        `${detail}; the head's checks failed: ` +
        failed.map((check) => `${check.name} (${check.conclusion})`).join(", ");
    }
    // Below what the body already holds, never over it.
    const edited = await editPullRequestBody({
      worktree: state.workspace.path,
      branch: state.workspace.branch,
      body: `${body}\n${deliveredChecksSection(delivery_checks)}\n`,
    });
    if (!edited.edited) {
      progress(
        `the pull request body still does not state the checks: ${edited.detail || "gh refused"}`,
      );
    }
  } catch (error) {
    progress(
      `the checks on the head could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { pull_request, merge, delivery_checks, github_credential, merged_base, detail };
}

/**
 * SCP-227: a re-levelled branch is pushed and its merge step read.
 *
 * The pull request already exists — the branch is at `pr_open` — so it is
 * found rather than opened, and its body is left as it is.
 */
export async function publishRelevel(
  args: PublishArgs & {
    ledger: Ledger;
    existing: LoopPorts["existing"];
    /** The attempt the ticket's record ends on, which the merge step is taken under. */
    continuesPreviousRun: string | null;
    /** What the run decided; a re-level's publishing does not change it. */
    detail: string;
  },
): Promise<Delivery> {
  const { config, contract, state, ledger, clock, progress } = args;
  let merge: LoopMergeOutcome | null = null;
  let delivery_checks: DeliveredChecksReading | null = null;
  const merged_base = state.baseCommit === state.workspace.base_commit ? null : state.baseCommit;
  const github_credential = githubCredential();
  await args.push({ worktree: state.workspace.path, branch: state.workspace.branch, onProgress: progress });
  const pull_request = await args.existing({ worktree: state.workspace.path, branch: state.workspace.branch });
  if (pull_request === null) {
    progress(`no open pull request on ${state.workspace.branch}: the re-level is pushed and nothing else is read`);
  } else {
    progress(`pull request ${pull_request.url}`);
    merge = await args.merge({
      mode: config.merge,
      repository_root: config.repository_root,
      branch: state.workspace.branch,
      pull_request_number: pull_request.number,
      base_ref: config.base_ref,
      state_root: config.state_root,
      ticket_key: config.ticket_key,
      paths_allowed: contract.scope.paths_allowed,
      attempt_id: ledger.last()?.attempt_id ?? args.continuesPreviousRun ?? args.rootAttemptId,
      now: clock(),
    });
    progress(merge.merged ? `merged: ${merge.detail}` : `not merged — ${merge.detail}`);
    try {
      delivery_checks = await readDeliveredChecks({
        worktree: state.workspace.path,
        branch: state.workspace.branch,
        boundMs: config.delivery_checks_bound_ms,
        now: clock,
        sleep: args.wait,
        onProgress: progress,
      });
      progress(`checks on the head: ${delivery_checks.state}`);
    } catch (error) {
      progress(
        `the checks on the head could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    pull_request,
    merge,
    delivery_checks,
    github_credential,
    merged_base,
    detail: args.detail,
  };
}
