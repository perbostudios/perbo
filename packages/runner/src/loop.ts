import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { withExecutorSkills } from "./skills.js";
import {
  EXECUTION_ATTEMPT_SCHEMA_VERSION,
  ExecutionAttemptSchema,
  admittedWriteGlobs,
  assertProviderEnabled,
  failedChecks,
  hasAcceptanceCriteria,
  isRefusal,
  limitFor,
  limitsForCredential,
  planNodes,
  standingProhibitedPaths,
  wholeChangeChecks,
  type AttemptWait,
  type CredentialClass,
  type ExecutionAttempt,
  type GithubCredential,
  type IncompleteReviewPath,
  type NodeReview,
  type PlanContract,
  type PlanContractWithCriteria,
  type ReviewArtifact,
  type SealedCommit,
  type SecretIndex,
  type VerifiedCommit,
} from "@perbo/contracts";
import {
  cleanup,
  diagnose,
  isGreenfieldVerify,
  materialize,
  provision,
  signableCommit,
  validateManifest,
  git,
  type MaterializedWorkspace,
  type Workspace,
} from "@perbo/workspace";
import {
  PROMPT_VERSION,
  remediableFindings,
  reviewGraph,
} from "@perbo/review";
import {
  lastAttemptBranch,
  lastAttemptId,
  lastExecutorAccount,
  parkedWait,
  readAttemptsRecord,
  recordedBaseVerification,
  rootAttemptId as mintRootAttemptId,
  runsOnRecord,
  specCommitOnRecord,
} from "./attempts.js";
import { Ledger } from "./loop/ledger.js";
import { acquireRunLock, type HeldRunLock } from "./lock.js";
import { executorAccount } from "./account.js";
import { AttemptCeilings } from "./ceilings.js";
import { AgentConfigurationPresentError } from "./adapter.js";
import { BundleStore } from "./bundle.js";
import type { PinnedCheck } from "./checks.js";
import {
  deliveredChecksSection,
  editPullRequestBody,
  pullRequestBody,
  readDeliveredChecks,
  type DeliveredChecksReading,
} from "./delivery.js";
import { githubCredential } from "./github-credential.js";
import { mergeUp, pathsWithConflictMarkers } from "./merge-up.js";
import { sweepWorktree } from "./orphans.js";
import type { LoopMergeOutcome } from "./merge.js";
import type { BriefRecords } from "./brief.js";
import { buildAgentEnvironment, buildPermissionProfile } from "./profile.js";
import {
  EXECUTOR_PROMPT_VERSION,
  RESUMED_EXECUTOR_PROMPT_VERSION,
  conflictPrompt,
  conflictPromptVersion,
  executorPrompt,
  remediationPrompt,
} from "./prompt.js";
import {
  RETAINED_DIFF_ARTIFACT,
  ResumeRefusedError,
  applyRetainedDiff,
  resolveResumeSource,
  resumeNote,
  resumedFromRecord,
  sameCommit,
  type ResumeSource,
} from "./resume.js";
import { RunRefusedError } from "./refusal.js";
import { commitSpec } from "./spec-commit.js";
import { allowedPathsSentence } from "./shell/index.js";
import { parseDeclines } from "./declines.js";
import { readPrinciples, readPrinciplesFile } from "./principles.js";
import { quarantine, release, restoreAny } from "./quarantine.js";
import {
  commitsSince,
  describeRange,
  headCommit,
  sealChangeSet,
  untrackedAfterChecks,
} from "./seal.js";
import { resetInText } from "./transport.js";
import { guardProhibitedPaths, type TicketRunConfig } from "./loop/config.js";
import { withCeilingGuidance } from "./loop/attempt.js";
import { confirmContinuation, remediationToContinue } from "./loop/continuation.js";
import { levelBeforeExecutor, mergeFailedDetail, takeMergeUp } from "./loop/level.js";
import {
  contractWithCriteria,
  countDirectlyVerified,
  flakyCheckFindings,
  reviewerModel,
  routeReview,
  writeReviewBundle,
} from "./loop/review.js";
import { resolvePorts, type LoopPorts } from "./loop/context.js";
import {
  applyStep,
  initialRoundState,
  type RoundRecord,
  type Retry,
  type RunOutcome,
} from "./loop/state.js";
import { routeConflict, routeResolution, routeStopped } from "./loop/route.js";
import { provisionRound } from "./loop/provision.js";
import type { RelevelContext } from "./loop/relevel.js";
import { refuseWidening, routeVerification, verifierModel } from "./loop/verify.js";

/**
 * Contract → worktree → one agent → sealed change set → deterministic checks →
 * independent review → pull request, with remediation in the middle.
 *
 * The remediation step is the point of Stage 2 and it is the step that can
 * quietly undo Stage 1, so three properties are enforced here rather than
 * hoped for:
 *
 * 1. **A remediation round is a new attempt.** New attempt record, new commit,
 *    new `(base, head)` pair. Not a patch to a verdict.
 * 2. **A remediation round is verified, not re-reviewed** (D-061, SCP-101).
 *    There is exactly one independent review, at round 0; what follows a fix
 *    asks one question per routed finding — is it closed in the new change
 *    set — with the pinned checks and the scope computation consulted first
 *    and able only to fail it. A fresh opinion per round is what made the
 *    false-block rate compound (0.44 per draw), and the measured cost of
 *    retiring it is recorded on the decision: findings a later draw would
 *    have surfaced are not surfaced.
 * 3. **Rounds are bounded.** Two by default. When the budget is spent with a
 *    finding still open, a person sees it rather than the loop continuing.
 *
 * What a round judges is the branch's diff against the ticket's base commit,
 * not the delta the executor produced in it. A branch materialised ahead of
 * base carries the commits earlier attempts sealed; the checks, the review and
 * the pull request read `base_commit..HEAD`, and `no_changes` is recorded only
 * where that range is empty.
 *
 * **And that base moves** (SCP-192). Before the executor at round 0, after the
 * seal of every round, and again before the pull request opens, the base
 * branch's current tip is merged into the attempt's branch, and the range every
 * later step reads is measured from the tip rather than from wherever the
 * contract was drafted. A clean merge is a commit on the branch; a conflict is
 * a round of its own, whose only task is the resolution and which is sealed,
 * checked and judged exactly like the round it interrupted; a conflict that
 * survives that round is `base_conflict` with the files named. What this
 * removes is the step that began every hand finish of day four — a person
 * merging the base in before anything else could be done with the branch.
 */

export { resolvePorts, type LoopPorts } from "./loop/context.js";
export { incompleteReviewCauses } from "./loop/review.js";
export { type RoundKind, type RoundRecord, type RunOutcome } from "./loop/state.js";

export {
  BaseSourceSchema,
  MergedTicketContextSchema,
  TicketRunConfigSchema,
  guardProhibitedPaths,
  type BaseSource,
  type TicketRunConfig,
} from "./loop/config.js";

/**
 * What the log of a branch's own line past the pushed tip may say.
 *
 * The commits it names are what a re-level decides on: every one of them is
 * either the loop's own or a person's, and a listing held from its end has
 * lost its oldest — the ones a reset would drop. Past this nothing is read.
 */
const MAX_BRANCH_LOG_BYTES = 64 * 1024 * 1024;

export interface TicketRunResult {
  ticket_id: string;
  workspace: Workspace;
  rounds: RoundRecord[];
  final_review: ReviewArtifact | null;
  /** `final_review`'s per-node artifacts, beside it (D-107); empty for a flat plan. */
  node_reviews: NodeReview[];
  pull_request: { url: string; number: number | null } | null;
  /**
   * SCP-202: what the post-approval merge step did, where a pull request was
   * opened for it to act on. Null where none was — the step has nothing to
   * decide about a run that published nothing.
   *
   * A stop here does not change the run's `outcome`: the change was approved,
   * the pull request is open, and what is missing is a condition of the merge
   * rather than of the change. The stop is routed to a person like any other.
   */
  merge: LoopMergeOutcome | null;
  /**
   * The checks GitHub ran on the head this run published, read before the run
   * returned and before anything recorded the delivery. Null where the run
   * opened no pull request — there is then no head with checks on it.
   *
   * A `checks_failed` reading does not change `outcome`: the review approved
   * the change and the pull request is open, and what failed is a check on the
   * head. The run says which check and what it concluded, and fixes nothing.
   */
  delivery_checks: DeliveredChecksReading | null;
  /**
   * SCP-200: which credential path the push and the pull request went through,
   * where this run published. Null where it did not — the path is a fact about
   * a GitHub-side step, and a run that took none has nothing to say about it.
   */
  github_credential: GithubCredential | null;
  outcome: RunOutcome;
  detail: string;
  /**
   * Which way a review that could not resolve every criterion reached its end,
   * and null where no review of this run was incomplete.
   *
   * `incomplete_remediated` says a remediation round ran on the findings that
   * made those criteria unjudgeable and the re-review reached the verdict
   * above; `incomplete_escalated` says a person was asked without a round,
   * because a criterion had no remediable cause or none was left to spend. Both
   * can end `escalated`, and the difference is what this field is for.
   */
  incomplete_review: IncompleteReviewPath | null;
  /**
   * SCP-192: the base branch tip the attempt's branch is level with when the
   * run ends — and, where one was opened, the tip the pull request opened over.
   * Null where the base never moved under the run, or where nothing merged it.
   */
  merged_base: string | null;
}

export interface TicketRunRequest {
  config: TicketRunConfig;
  contract: PlanContract;
  now?: () => Date;
  /**
   * How the loop waits: before the one attempt it starts after a transport
   * failure, and for the parked hours a provider's own reset time buys
   * (SCP-193). The default is the timer; a test injects its own so the wait is
   * observed rather than served.
   */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
  /**
   * Called the moment the pull request opens, before the merge step and before
   * the attempts are recorded. A caller that keeps its own record of the run
   * writes the URL here rather than from the result, so a run that fell over
   * between the publish and its return still names what it opened.
   */
  onPullRequest?: (pull_request: NonNullable<TicketRunResult["pull_request"]>) => void;
  /** Injected by tests: a stand-in for the agent, the checks and the reviewer. */
  hooks?: Partial<LoopPorts>;
}

/**
 * What a run is bounded by, from its configuration and the limits table.
 *
 * Read once, at the start, so that every ceiling a round is judged against and
 * every sentence that names where to raise one read the same values — a run
 * whose limits changed under it would stop for a reason its own record could
 * not explain.
 */
export interface RunLimits {
  /** The remediation cap: the configured rounds, or the table's, whichever is lower. */
  maxRounds: number;
  /**
   * The loop's own backstop, above every rule inside it.
   *
   * Nothing should reach it: every path through the body breaks or advances,
   * and the rules below — the progress rule, the ticket budget, the round cap —
   * end a run long before this. It is here because a conflict round no longer
   * counts against the remediation cap (SCP-194), so `round` is no longer
   * bounded by `maxRounds` and a `while` that said so would be stating
   * something untrue. A conflict can interrupt each remediation round at most
   * once, plus once before the executor, which is what the arithmetic is.
   */
  roundCeiling: number;
  /** The longest the loop will sit out one provider wait (SCP-193). */
  waitBoundMs: number;
  /** Where a ceiling, a budget or a wait bound is raised. */
  configPath: string;
  /**
   * What one ticket may spend before the loop stops restarting itself, which is
   * nothing unless the executor is billed per token (D-096).
   *
   * The credential is the attempt's own, read from the invocation it recorded:
   * on a subscription the dollar figure is a measure of work and not a bill, so
   * no number of them adds up to a budget.
   */
  ticketBudgetMicros: (credential: CredentialClass) => number | null;
}

export function runLimits(config: TicketRunConfig): RunLimits {
  const maxRounds = Math.min(
    config.max_remediation_rounds,
    limitFor(config.limits, "remediation_rounds"),
  );
  return {
    maxRounds,
    roundCeiling: 2 * maxRounds + 2,
    waitBoundMs: limitFor(config.limits, "wait_for_provider_ms"),
    configPath: join(config.repository_root, ".perbo", "config.json"),
    ticketBudgetMicros: (credential) =>
      limitFor(limitsForCredential(config.limits, credential), "ticket_cost_micros"),
  };
}

/**
 * One run of one ticket, under the ticket's run lock (SCP-193).
 *
 * The lock is taken before anything is read, provisioned or paid for, and
 * released whatever ends the run — including a throw. A second `perbo run` on
 * a ticket this one is still working, or parked on, is refused with the pid and
 * the wait rather than provisioning a second worktree on the same branch and
 * racing this one to the attempts record.
 */
export async function runTicket(args: TicketRunRequest): Promise<TicketRunResult> {
  const lock = acquireRunLock({
    state_root: args.config.state_root,
    ticket_id: args.contract.ticket_id,
    ticket_key: args.config.ticket_key,
    now: (args.now ?? (() => new Date()))(),
  });
  try {
    return await runLockedTicket(args, lock);
  } finally {
    lock.release();
  }
}

async function runLockedTicket(
  args: TicketRunRequest,
  lock: HeldRunLock,
): Promise<TicketRunResult> {
  const { config } = args;
  const clock = args.now ?? (() => new Date());
  const wait = args.sleep ?? ((ms: number) => setTimeout(ms));
  const progress = args.onProgress ?? (() => undefined);
  const ports = resolvePorts(config, args.hooks);
  const agentRunner = ports.agent;
  const reviewRunner = ports.review;
  const verifyRunner = ports.verify;
  const checkRunner = ports.checks;
  const pushBranch = ports.push;
  const openPullRequest = ports.open;
  const mergePullRequest = ports.merge;
  const findPullRequest = ports.existing;

  if (!hasAcceptanceCriteria(args.contract)) {
    throw new Error(
      `plan ${args.contract.plan_id} is ${args.contract.level}, which has no acceptance criteria: ` +
        "there is nothing for an independent review to judge",
    );
  }
  const contract: PlanContractWithCriteria = args.contract;

  assertProviderEnabled(config.limits, "claude-code", config.model);
  // The reviewer's transport is a provider too. Checked here, before any
  // attempt is paid for, so a disabled reviewer stops the run rather than
  // discovering the switch after the executor has spent its budget.
  assertProviderEnabled(
    config.limits,
    config.reviewer_provider,
    config.reviewer_model ?? config.model,
  );
  // Crash recovery before anything else: a journal on disk means some worktree
  // is currently missing the configuration this runner moved out of it.
  for (const restored of restoreAny(config.quarantine_root)) {
    progress(`restored quarantined configuration from ${restored.attempt_id}`);
  }

  const bundles = new BundleStore({ root: config.bundle_root, retainContext: config.retain_context });
  const attemptsPath = join(config.state_root, `${contract.ticket_id}.attempts.json`);
  /**
   * Every attempt of every earlier run, read before this one starts: what this
   * run's attempts are appended to, what attributes the commits already on the
   * branch, and — where nothing else counts the runs — how many there have been.
   */
  const priorAttempts = readAttemptsRecord(attemptsPath);
  // The larger of what the caller counted and what the record holds, then the
  // first number whose root is not on the record. A re-level records its
  // attempts under the number after the record's last run without adding to
  // the caller's count, and a counted run refused after its root was minted
  // leaves a gap the record's count does not see: either way the number the
  // count arrives at can already be taken (SCP-227). Settled before the
  // worktree, the materialization and the agent, so nothing is paid for first.
  const onRecord = new Set(
    (priorAttempts?.attempts ?? []).flatMap((attempt) => {
      const ids = z.object({ attempt_id: z.string(), root_attempt_id: z.string().optional() }).safeParse(attempt);
      return ids.success ? [ids.data.attempt_id, ...(ids.data.root_attempt_id ? [ids.data.root_attempt_id] : [])] : [];
    }),
  );
  const mintRoot = (run: number) =>
    mintRootAttemptId({
      plan_id: contract.plan_id,
      plan_version: contract.version,
      ticket_key: config.ticket_key,
      runs_started: run,
    });
  let runNumber = Math.max(config.runs_started ?? 0, runsOnRecord(priorAttempts) + 1);
  while (onRecord.has(mintRoot(runNumber))) runNumber += 1;
  const rootAttemptId = mintRoot(runNumber);
  /**
   * The previous run's last attempt, which this run's first attempt continues
   * from — the same relation a remediation round has to the round before it.
   */
  const continuesPreviousRun = lastAttemptId(priorAttempts);
  /**
   * D-092: and its account, for a remediation round this run opens with — a
   * re-run of a ticket whose last review left findings open starts one, and
   * its predecessor is on the record rather than in `attempts`.
   */
  const previousRunAccount = lastExecutorAccount(priorAttempts);
  const ledger = new Ledger({ path: attemptsPath, prior: priorAttempts, ticketId: contract.ticket_id });
  if (priorAttempts !== null) {
    progress(
      `run ${runNumber} of ${config.ticket_key}; ${priorAttempts.attempts.length} attempt(s) ` +
        `already on record, continuing ${continuesPreviousRun}`,
    );
  }

  const { configPath, waitBoundMs, ticketBudgetMicros, maxRounds, roundCeiling } = runLimits(config);

  /**
   * SCP-193: a wait a previous process was killed in the middle of.
   *
   * The park is written to the attempts record before the run sleeps, so a
   * `run` typed after that process died reads the instant the provider named
   * and waits out what is left of it. Without this the restart is the thing the
   * park exists to prevent: an attempt started against a session limit that is
   * still in force, which the provider refuses and the run pays for.
   */
  const parked = parkedWait(priorAttempts);
  if (parked !== null) {
    const remaining = Date.parse(parked.until) - clock().getTime();
    if (remaining > waitBoundMs) {
      // The park was recorded under a bound this run no longer has, which only
      // happens when somebody lowered it. Said out loud rather than silently
      // waiting past the new bound or silently ignoring the record.
      progress(
        `${config.ticket_key} is parked until ${parked.until} (${parked.zone}), which is beyond ` +
          `limits.limits.wait_for_provider_ms in ${configPath}; starting now rather than waiting ` +
          "past a bound this configuration does not allow",
      );
    } else if (remaining > 0) {
      progress(
        `${config.ticket_key} was parked on ${parked.reason.replace(/_/g, " ")} until ` +
          `${parked.until} (${parked.zone}); honouring the ${Math.round(remaining / 60_000)} ` +
          "minute(s) still to run",
      );
      lock.parked(parked);
      await wait(remaining);
      lock.parked(null);
    }
  }

  /**
   * SCP-154: the cut attempt this run continues, read before anything is
   * provisioned. A `--resume-from` that cannot be honoured stops the run here,
   * where it has cost nothing, rather than after a worktree and an install.
   */
  const resumeSource: ResumeSource | null =
    config.resume_from === null
      ? null
      : resolveResumeSource({
          bundle_root: config.bundle_root,
          bundle_id: config.resume_from,
          ticket_id: contract.ticket_id,
          base_commit: contract.base.base_commit,
        });

  const checkout = resolve(config.repository_root);
  /**
   * ADR-0025: whether this repository can be materialized at all, answered
   * from the checkout and the contract before anything is provisioned, so a
   * refusal cuts no branch and no worktree.
   *
   * The whole diagnostic, not just the manifest it proposed: where it proposed
   * none, its findings are the only thing that says why, and they are what the
   * refusal carries out to the person.
   */
  const diagnostic =
    config.materialization_manifest === null
      ? await diagnose({ checkout, repository_id: contract.scope.repository_id })
      : null;
  /**
   * Whether the key this checkout signs its commits with can sign one, asked
   * here as well because signing is a property of the checkout rather than of
   * the manifest: a configured manifest skips the diagnostic that would
   * otherwise have asked, and the seal would then be the first thing to find out.
   */
  const signing = config.materialization_manifest === null ? null : await signableCommit(checkout);
  const manifest = config.materialization_manifest ?? diagnostic?.proposed ?? null;
  // The advisories are dropped: what stopped the run is what a person needs to
  // fix, and a report that mixes the two reads as one long complaint.
  const refused = [
    ...(diagnostic?.findings ?? []).filter(isRefusal),
    ...(signing === null ? [] : [signing]),
  ];
  if (!manifest) {
    throw new RunRefusedError({
      message: "this repository cannot be materialized, so no attempt was started",
      findings: refused,
      repository_root: checkout,
    });
  }
  // A refusal the manifest did not depend on. The diagnostic answers a wider
  // question than "is there a manifest" — a repository it refuses is one an
  // attempt cannot finish, whether or not there is something to materialize.
  if (refused.length > 0) {
    throw new RunRefusedError({
      message: "this repository was refused before an attempt started",
      findings: refused,
      repository_root: checkout,
    });
  }
  const invalid = validateManifest(manifest);
  if (invalid.length > 0) {
    throw new RunRefusedError({
      message:
        "the materialization manifest does not describe this checkout, so no attempt was started",
      findings: invalid,
      repository_root: checkout,
    });
  }

  /**
   * Whether the manifest's verify command measures anything. `git status
   * --porcelain` passes on any checkout Git can read, so what it says of a base
   * is no measurement: the base is left unmeasured, the review is told nothing
   * about it, no attempt records an answer, and no answer on record is read
   * back while the verification measures nothing.
   */
  const verifyMeasures = !isGreenfieldVerify(manifest.verify.command);

  /**
   * The branch this ticket already has, which every worktree this run
   * provisions keeps: its delivery record's, then its latest attempt's (D-098).
   */
  const branchesOnRecord = { delivery: config.delivery_branch, attempt: lastAttemptBranch(priorAttempts) };
  const workspace = await provision({
    repository_root: config.repository_root,
    repository_id: contract.scope.repository_id,
    ticket_key: config.ticket_key,
    ticket_id: contract.ticket_id,
    outcome: contract.outcome,
    recorded: branchesOnRecord,
    base_commit: contract.base.base_commit,
    attempt_id: rootAttemptId,
    root: config.worktree_root,
    limits: config.limits,
    now: clock(),
  });
  progress(`worktree ${workspace.path} on ${workspace.branch} at ${workspace.base_commit}`);
  // SCP-227: a re-level judges what the pull request has. A re-level that
  // pushed nothing left its merge commit — and any resolution no review
  // approved — on the local branch, and starting from there would call a
  // branch level that the pull request still shows behind. So the worktree
  // is put back to the pushed ref where one exists and everything the local
  // branch carries past it is the loop's own: a commit whose `Attempt:`
  // trailer names an attempt on the record (every seal and every merge of the
  // base carries one), or a head the record sealed. The trailer is trusted as
  // written: a commit a person gave the loop's trailer is treated as the
  // loop's. A commit a person made on the branch and has not
  // pushed is theirs, not the loop's to drop or to publish, and a branch that
  // diverged from its pull request is not one a merge of the base levels: both
  // are refused with what the branch carries named, for a person to reconcile.
  if (config.relevel) {
    const remote = `refs/remotes/origin/${workspace.branch}`;
    const call = { timeoutMs: 120_000 };
    const tip = await git.resolveCommit(config.repository_root, remote, call);
    if (tip !== null) {
      const local = (await git.head(workspace.path, call)) ?? "";
      if (local !== tip) {
        const ahead = await git.isAncestor(workspace.path, tip, "HEAD", call);
        // The branch's own line past the tip: what a merge brought in from the
        // base is the base's, and is behind the merge's second parent.
        const listed = ahead
          ? await git.run(
              workspace.path,
              [
                "log",
                "--first-parent",
                "--reverse",
                "--format=%H%x1f%s%x1f%(trailers:key=Attempt,valueonly,separator=%x2c)",
                `${tip}..HEAD`,
              ],
              { ...call, maxOutputBytes: MAX_BRANCH_LOG_BYTES },
            )
          : null;
        const carried = (listed?.stdout ?? "")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const [sha = "", subject = "", trailers = ""] = line.split("\x1f");
            const attempts = trailers
              .split(",")
              .map((value) => value.trim())
              .filter((value) => value.length > 0);
            return { sha, subject, attempts };
          });
        const own = (commit: (typeof carried)[number]): boolean =>
          ledger.sealedBy(commit.sha) !== null || commit.attempts.some((attempt) => onRecord.has(attempt));
        const foreign = carried.filter((commit) => !own(commit));
        // A listing held from its end has lost its oldest commits, which are
        // the ones a reset would drop: what cannot be read whole is refused
        // rather than reset over.
        const unread = listed?.truncated === true;
        if (ahead && !unread && foreign.length === 0) {
          await git.run(workspace.path, ["reset", "--hard", tip], call);
          progress(
            `${workspace.branch} carried ${local.slice(0, 12)} locally and the pull request has ` +
              `${tip.slice(0, 12)}; re-levelling from what the pull request has`,
          );
        } else {
          await sweepWorktree({ worktree: workspace.path, onProgress: progress });
          await cleanup({ workspace, root: config.worktree_root, outcome: "failure" }).catch(() => undefined);
          const what = unread
            ? `${workspace.branch} carries more past what the pull request has (${tip.slice(0, 12)}) than ` +
              `${MAX_BRANCH_LOG_BYTES} bytes of log can name`
            : ahead
              ? `${workspace.branch} carries ${foreign.length} commit${foreign.length === 1 ? "" : "s"} the loop did not ` +
                `make past what the pull request has (${tip.slice(0, 12)}): ` +
                foreign.map((commit) => `${commit.sha.slice(0, 12)} ${commit.subject}`).join("; ")
              : `${workspace.branch} has diverged from its pull request: the checkout is at ${local.slice(0, 12)} ` +
                `and the pull request at ${tip.slice(0, 12)}, and neither contains the other`;
          throw new RunRefusedError({
            message: `${what}. Reconcile the branch by hand, then re-level it; the loop neither drops nor publishes what it did not make`,
            findings: [],
            repository_root: config.repository_root,
          });
        }
      }
    }
  }
  // The base the contract pins may be abbreviated; this is the commit the
  // worktree is actually on, and it is what the retained diff has to match.
  if (resumeSource !== null && !sameCommit(resumeSource.base_commit, workspace.base_commit)) {
    await sweepWorktree({ worktree: workspace.path, onProgress: progress });
    await cleanup({ workspace, root: config.worktree_root, outcome: "failure" }).catch(() => undefined);
    throw new ResumeRefusedError(
      resumeSource.bundle_id,
      `${resumeSource.bundle_id}'s ${RETAINED_DIFF_ARTIFACT} was made against ` +
        `${resumeSource.base_commit} and this attempt's worktree is at ${workspace.base_commit}: ` +
        "the base commit has moved, so the diff no longer describes this tree",
    );
  }

  /**
   * D-103: the spec the change is judged against, put on the branch before
   * anything else — before the materialization, before the base is merged up
   * and before the executor is invoked, so it is the branch's first commit
   * past the contract's base and every later step measures a branch that
   * already carries it.
   *
   * A refusal here leaves the worktree swept and removed, as every refusal
   * after provisioning does: nothing has been materialized, nothing has been
   * executed and nothing has been paid for.
   */
  let specCommit: string | null;
  let specPaths: string[];
  try {
    const sealed = await commitSpec({
      worktree: workspace.path,
      repository_root: config.repository_root,
      base_commit: workspace.base_commit,
      ticket_key: config.ticket_key,
      attempt_id: rootAttemptId,
      files: config.spec_files,
      recorded: specCommitOnRecord(priorAttempts),
      onProgress: progress,
    });
    specCommit = sealed.commit;
    specPaths = sealed.paths;
  } catch (error) {
    await sweepWorktree({ worktree: workspace.path, onProgress: progress });
    await cleanup({ workspace, root: config.worktree_root, outcome: "failure" }).catch(() => undefined);
    throw error;
  }
  /** What the change set never lists, whichever round it is (SCP-314). */
  const sealExclusions = specPaths.length === 0 ? {} : { spec_paths: specPaths };

  let materialized: MaterializedWorkspace;
  try {
    materialized = await materialize({
      workspace,
      manifest,
      limits: config.limits,
      warm: false,
      leaseRoot: config.worktree_root,
      onProgress: progress,
    });
  } catch (error) {
    await sweepWorktree({ worktree: workspace.path, onProgress: progress });
    // A cleanup that cannot finish must not replace the failure it is cleaning
    // up after. `cleanup` throws `cleanup_failed` where the worktree survives —
    // a tree neither Git nor a direct removal can delete is one way — and thrown from
    // here it became the only error a person saw, while the reason the run
    // actually stopped was discarded on the line below. The leftover still
    // matters, so it is reported rather than swallowed; it is a second fact
    // about a run that has already failed, not the failure itself.
    await cleanup({ workspace, root: config.worktree_root, outcome: "failure" }).catch(
      (cleanupError: unknown) => {
        progress(
          `warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      },
    );
    throw error;
  }
  const secrets: SecretIndex = materialized.secrets;

  /**
   * The verify this run's own provisioning ran, and the commit it ran at.
   *
   * The worktree starts at the contract's base only when this run created the
   * branch. A run continuing a ticket takes over a branch that already carries
   * commits, so its worktree starts on the ticket's own sealed head and the
   * verify measures that — which is a fact about the ticket's earlier work, not
   * about the base.
   */
  const provisioningHead = await headCommit({ worktree: workspace.path });
  const provisioningVerify: VerifiedCommit | null =
    materialized.verify === null || provisioningHead === null || !verifyMeasures
      ? null
      : { commit: provisioningHead, verified: materialized.verify.code === 0 };

  /**
   * Whether the contract's base commit passes the manifest's verify command:
   * the ticket's answer, and the one the review is told.
   *
   * Measured once, by the attempt that provisions at the base, and read back
   * from the ticket's attempts record by every attempt after it. Where nothing
   * has measured it — a record written before the field existed, a ticket
   * whose branch already carried commits the first time this ran, or a
   * manifest whose verify command measures nothing — the review is told
   * nothing rather than told the base is broken or sound.
   *
   * The base a merge-up moves to mid-run is not re-verified: this answers the
   * commit the contract pins, which is what `caused_by_change` is about.
   */
  const baseVerification: VerifiedCommit | null = !verifyMeasures
    ? null
    : (recordedBaseVerification(priorAttempts, workspace.base_commit) ??
      (provisioningVerify !== null && sameCommit(provisioningVerify.commit, workspace.base_commit)
        ? provisioningVerify
        : null));
  progress(
    baseVerification === null
      ? `nothing has verified ${workspace.base_commit.slice(0, 12)}, so a failing check is ` +
          "attributed to neither the base nor the change"
      : `${workspace.base_commit.slice(0, 12)} ` +
          `${baseVerification.verified ? "passes" : "fails"} the manifest's verify` +
          (provisioningVerify !== null &&
          !sameCommit(provisioningVerify.commit, baseVerification.commit)
            ? `; this attempt provisioned on ${provisioningVerify.commit.slice(0, 12)}, which ` +
              `${provisioningVerify.verified ? "passes" : "fails"} it`
            : ""),
  );

  const profile = buildPermissionProfile({
    worktree: workspace.path,
    provider: config.agent_provider,
    lifecycle_scripts: manifest.install.lifecycle_scripts.policy,
  });

  // The product principles the person has recorded (D-065 option 3). Read from
  // the repository root — the agent cannot write there (.perbo/** is
  // prohibited) — and handed to every brief as data.
  const principles = config.principles_path
    ? readPrinciplesFile(config.principles_path)
    : readPrinciples(config.repository_root);
  let outcome: TicketRunResult["outcome"] = "terminated";
  let detail = "";

  /**
   * SCP-194: the remediation this run continues, where the record holds one.
   *
   * Read before the loop so the first round's brief is the right one — the
   * ticket's own outcome, or the findings its last review left open. An
   * explicit `--resume-from` says what the run is for and is not overridden:
   * that run is continuing a cut attempt's diff, not a review's findings.
   *
   * Whether the branch is still at the commit that review judged is checked in
   * the loop, against the branch itself.
   */
  const continuing =
    resumeSource !== null || config.relevel
      ? null
      : remediationToContinue({ bundles, ticket_id: contract.ticket_id });
  if (continuing !== null) {
    progress(
      `${config.ticket_key}'s last review left ${continuing.findings.length} finding(s) open on ` +
        `${continuing.head_commit}; this run continues remediation from them rather than ` +
        "reviewing that commit again",
    );
  }

  /**
   * Everything one round of this run hands the next, replaced rather than
   * mutated (`RoundState`). Every path through the round body ends in a
   * `break`, or in a `continue` that has taken a `Step`: the round advances,
   * one more attempt of it is bought, or the round is re-entered as the
   * resolution of a base conflict — so the loop cannot spin.
   */
  let state = initialRoundState(workspace, continuing);

  /**
   * What keeps the branch level with its base, and what judges a re-level.
   *
   * Read by the merge-up before the executor and by the judgement a re-level
   * run ends in, neither of which the run changes between rounds.
   */
  const levelling: RelevelContext = {
    config,
    contract,
    bundles,
    materialized,
    profile,
    secrets,
    sealExclusions,
    verifyMeasures,
    ports,
    clock,
    progress,
  };

  /**
   * The outage a retry sits out before the next attempt of the same round.
   *
   * A park is on the record before the sleep, because the whole point of it is
   * that it is long: the wait has to outlive this process, and the lock has to
   * say so while it lasts.
   */
  const waitOut = async (step: Retry): Promise<void> => {
    if (step.wait === null) {
      progress(step.say);
      return;
    }
    if (step.wait.park === null) {
      progress(step.say);
      await wait(step.wait.ms);
      return;
    }
    ledger.flush();
    lock.parked(step.wait.park);
    progress(step.say);
    await wait(step.wait.ms);
    lock.parked(null);
  };

  try {
    while (state.round <= roundCeiling) {
      state = await confirmContinuation(state, progress);

      const entered = await provisionRound({
        config,
        contract,
        ledger,
        state,
        rootAttemptId,
        branchesOnRecord,
        clock,
      });
      state = entered.state;
      const { attemptId: attempt_id, at, previous } = entered;
      const levelled = await levelBeforeExecutor({
        ...levelling,
        state,
        attemptsSoFar: ledger.attempts.length,
        attemptId: attempt_id,
        continuesPreviousRun,
      });
      state = levelled.state;
      /** The base tip this attempt's own branch was merged with, if any. */
      let mergedBase: string | null = levelled.mergedBase;
      if (levelled.step !== null) {
        state = applyStep(state, levelled.step);
        if (levelled.step.next === "stop") {
          outcome = levelled.step.end.outcome;
          detail = levelled.step.end.detail;
          break;
        }
        continue;
      }

      // Read before the executor runs, so a commit the executor makes itself is
      // this attempt's rather than one it inherited. The spec commit is left
      // out: the loop made it before any executor ran, and the change set the
      // review reads does not contain it (D-103).
      const inherited = (
        await commitsSince({ worktree: state.workspace.path, base_commit: state.baseCommit })
      ).filter((sha) => sha !== specCommit);
      const prior_commits: SealedCommit[] = inherited.map((sha) => ({
        sha,
        attempt_id: ledger.sealedBy(sha),
      }));
      if (inherited.length > 0) {
        progress(`branch carries ${inherited.length} commit(s) sealed before this attempt`);
      }

      // A conflict round carries the open findings without being asked to close
      // any of them: it may hand the loop back to the verification that was
      // interrupted, and that verification is about exactly this set.
      const toClose = state.kind === "execute" ? [] : state.openFindings;
      if (state.kind === "remediate" && toClose.length === 0) {
        // Unreachable by construction — round 0 only continues with a
        // non-empty family-filtered set — kept as a guard because reaching it
        // would mean the loop was about to run an agent with nothing to close.
        outcome = "escalated";
        detail = "no routed finding remains for the executor";
        break;
      }

      // SCP-154: the cut attempt's work goes into the worktree before the
      // executor is invoked, at round 0 and only there — by round 1 it is
      // sealed, checked and reviewed like any other part of the change set.
      //
      // SCP-172: the further attempt a transport failure buys runs in the round's
      // own worktree, where the diff is already applied — sealed onto the branch,
      // in fact, by the failed attempt's own seal — so it is applied once per
      // round rather than once per attempt. The retry is still a resumed attempt
      // and still records itself as one; only the application is skipped.
      const resumedHere =
        state.kind === "execute" && state.round === state.executeRound ? resumeSource : null;
      if (resumedHere !== null && state.transportRetry === 0 && state.ceilingContinuation === 0) {
        await applyRetainedDiff({ worktree: state.workspace.path, source: resumedHere });
        progress(resumeNote(resumedHere));
      }

      // SCP-195: one list, read by the pre-execution hook, by the transcript
      // reading, by the seal's assertion and by the sentence in the brief — so
      // none of the four can hold a different contract than the others.
      const pathsAllowed = admittedWriteGlobs(contract.scope);
      // D-105: the contract's own prohibitions and the repository's standing
      // list, beside the globs above and judged before them, so the guard
      // refuses a prohibited path inside the admitted ones rather than leaving
      // it to the reviewer's backstop.
      const pathsProhibited = guardProhibitedPaths(contract.scope.paths_prohibited, config);

      const basePrompt =
        state.kind === "resolve_conflict"
          ? conflictPrompt({
              base_ref: config.base_ref,
              base_commit: state.conflict!.tip,
              paths: state.conflict!.paths,
              merged: config.relevel_context,
            })
          : state.kind === "execute"
            ? executorPrompt(contract, {
                principles,
                resumed: resumedHere
                  ? { attempt_id: resumedHere.attempt_id, bundle_id: resumedHere.bundle_id }
                  : null,
              })
            : remediationPrompt({
                contract,
                findings: toClose,
                round: state.remediationRound,
                max_rounds: maxRounds,
                principles,
                // D-092: the predecessor's own account of its change. Inside
                // one run that is the last attempt this run recorded; opening
                // a run on findings left open, it is the last attempt on the
                // ticket's record. It reaches the executor's next round and
                // nothing else — the reviewer's inputs are unchanged.
                previous_account:
                  previous !== undefined ? previous.executor_account : previousRunAccount,
                // SCP-194: a scope finding is answered by quoting what the
                // contract admits, and the brief says it in the same words the
                // guard refuses in (SCP-195's sentence).
                paths_allowed: pathsAllowed,
              });

      const { prompt, receipts: executorSkills } = withExecutorSkills(basePrompt, config.executor_skills);

      /**
       * D-096: what a compaction's state block is composed from.
       *
       * The records, not the brief: the contract's outcome and criteria with
       * the graph that groups them, the two path lists the guard judges by,
       * the approach record's No-Gos, the principles file, what the checks
       * have measured so far and what this round is open on. The composer
       * reads them at the moment of injection, in the hook or the adapter,
       * so both transports state the same round.
       */
      const briefRecords: BriefRecords = {
        outcome: contract.outcome,
        acceptance_criteria: contract.acceptance_criteria,
        nodes: [...planNodes(contract)],
        paths_allowed: pathsAllowed,
        // Joined as the guard joins them, so the block states the boundary
        // rather than the half of it the contract happened to name (D-103).
        paths_prohibited: [
          ...new Set([...pathsProhibited, ...standingProhibitedPaths(config.specs)]),
        ],
        no_gos: [...config.no_gos],
        principles,
        // What the pinned set measured on the round before this one, per node
        // where the plan has a graph (D-107). Empty on a run's first round,
        // which nothing has measured yet, and on a round whose predecessor was
        // cut before its checks ran.
        checks: ledger.rounds[ledger.rounds.length - 1]?.checks ?? [],
        open_findings: [...toClose],
      };

      progress(
        state.kind === "resolve_conflict"
          ? `resolving the base conflict on ${state.conflict!.paths.length} file(s)`
          : state.kind === "execute"
            ? "executing"
            : `remediation round ${state.remediationRound} of at most ${maxRounds}`,
      );

      // ADR-0030 requirement 2, around every handover including remediation.
      const journal = quarantine({
        worktree: state.workspace.path,
        store: config.quarantine_root,
        attempt_id,
        now: at,
      });
      const environment = buildAgentEnvironment({
        base: process.env,
        profile,
        worktree: state.workspace.path,
        ports: materialized.ports,
        database_schema: materialized.database_schema,
      });
      const ceilings = new AttemptCeilings(config.limits, Date.now, {
        // D-092: a remediation round closes findings that already name a file
        // and a line, briefed with the previous attempt's account, so the
        // counter it is tested against is `round_iterations` where an attempt
        // building the ticket is tested against `attempt_iterations`. A
        // conflict round is neither: it is not remediation, and it keeps the
        // attempt's counter. Neither counter is set unless the repository sets
        // it (D-096), and then this is which of the two it reads.
        ...(state.kind === "remediate" ? { iterations: "round_iterations" as const } : {}),
      });


      let agentResult;
      try {
        agentResult = await agentRunner({
          binary: config.agent_binary,
          worktree: state.workspace.path,
          prompt,
          brief_records: briefRecords,
          model: config.model,
          profile,
          ceilings,
          env: environment.env,
          paths_allowed: pathsAllowed,
          paths_prohibited: pathsProhibited,
          spec_folder: config.specs,
          onProgress: progress,
          redact: (text) => secrets.redact(text).text,
        });
      } catch (error) {
        release(journal, config.quarantine_root);
        if (error instanceof AgentConfigurationPresentError) {
          outcome = "terminated";
          detail = error.message;
          break;
        }
        throw error;
      }
      release(journal, config.quarantine_root);
      agentResult.invocation.neutralisation.withheld_from_worktree = journal.entries.map(
        (entry) => entry.relative_path,
      );

      const judging = {
        pinned_checks: config.checks.map((check) => check.definition_path ?? "").filter(Boolean),
        protected_tests: config.protected_tests,
        protected_paths: config.protected_paths,
      };
      const rawSeal = await sealChangeSet({
        worktree: state.workspace.path,
        base_commit: state.baseCommit,
        ticket_key: config.ticket_key,
        attempt_id,
        outcome: contract.outcome,
        secrets,
        judging,
        exclude_paths: state.checkArtifacts,
        paths_allowed: pathsAllowed,
        ...sealExclusions,
      });

      // The attempt left the branch head where it found it: whatever the change
      // set contains, this attempt did not write any of it. Read from the seal
      // rather than from the merged-up change set below, because a merge commit
      // the loop makes is not the executor having written something.
      const carriedForward =
        rawSeal.changeset !== null && rawSeal.head_commit === (inherited[inherited.length - 1] ?? null);

      /**
       * SCP-192: the branch is brought level with the base here, after the seal
       * and before anything judges what it holds — the checks, the review, the
       * verification and the pull request all read one change set, and it is
       * the branch against the base a person would merge it into.
       *
       * It runs only for a round that produced something: a ceiling that cut
       * the attempt, or a branch that adds nothing to its base, is answered
       * without a merge commit being made for it.
       */
      let sealed = rawSeal;
      let conflictNow: { tip: string; paths: string[]; detail: string } | null = null;
      if (agentResult.termination.reason === "completed" && rawSeal.changeset !== null) {
        const before = state.baseCommit;
        const up = await mergeUp({
          worktree: state.workspace.path,
          repository_root: config.repository_root,
          base_ref: config.base_ref,
          base_commit: state.baseCommit,
          ticket_key: config.ticket_key,
          attempt_id,
        });
        if (up.status === "conflict") {
          conflictNow = { tip: up.tip, paths: up.paths, detail: up.detail };
        } else {
          const taken = takeMergeUp({ state, mergedBase, up, baseRef: config.base_ref, progress });
          state = taken.state;
          mergedBase = taken.mergedBase;
          if (state.baseCommit !== before) {
            // Both ends of the range moved, so the change set is re-read rather
            // than re-sealed: re-running the seal here would stage and commit
            // whatever the round has since left in the worktree.
            //
            // The scope assertion is re-read with it (SCP-195). It has to be
            // about the change set the checks and the review are handed, and
            // after a merge-up that is this one and not the seal's.
            sealed = {
              ...rawSeal,
              ...(await describeRange({
                worktree: state.workspace.path,
                base_commit: state.baseCommit,
                judging,
                paths_allowed: pathsAllowed,
                fallback_paths: rawSeal.changed_paths,
                ...sealExclusions,
              })),
            };
          }
        }
      }

      // D-107: the pinned set runs over the whole change and then once per
      // node of the execution graph, narrowed to that node's paths. A flat
      // plan has no nodes and runs exactly what it ran before.
      const checks =
        sealed.changeset === null
          ? []
          : await checkRunner({
              checks: config.checks as PinnedCheck[],
              worktree: state.workspace.path,
              env: environment.env,
              secrets,
              onProgress: progress,
              nodes: planNodes(contract),
              changed_files: sealed.changed_paths,
            });

      /**
       * What judges the whole change this round.
       *
       * The node results are recorded with the round and reach that node's
       * own review (`reviewGraph`), never this list. `gating` is what the
       * overall review, the closure verification and the reviewer's own check
       * schema are given — exactly the list a flat plan produces, since a flat
       * plan tags none. A node's own check result gates nothing on its own;
       * the review it feeds can, once the gate reads the combination.
       */
      const gating = wholeChangeChecks(checks);

      if (sealed.changeset !== null) {
        state = {
          ...state,
          checkArtifacts: await untrackedAfterChecks({ worktree: state.workspace.path }),
        };
      }

      /**
       * SCP-263: the attempt is over, so nothing may still be running from its
       * worktree.
       *
       * The executor and every check run in process groups the runner signals,
       * and a process that put itself in a session of its own is in none of
       * them. Swept here rather than at cleanup so the round that produced it
       * is the round that records it, and so the next round starts in a
       * worktree with nothing of the last one's left in it.
       */
      const swept = await sweepWorktree({
        worktree: state.workspace.path,
        onProgress: progress,
      });

      /**
       * The commands the attempt asked for and did not get (SCP-163).
       *
       * An attempt that ends with nothing changed reads two ways, and the
       * difference is this list: an executor that judged the work already done
       * changed nothing by choice, and one whose clean-up and whose type-check
       * were refused changed nothing because it could not.
       */
      const denied = agentResult.commands.filter((command) => command.decision === "denied");
      const deniedSummary = denied
        .slice(0, 5)
        .map(
          (command) =>
            `${command.denial_rule ?? "unknown"} on ` +
            `${command.denial_target ?? command.detail.slice(0, 80)}`,
        )
        .join("; ");

      const termination =
        agentResult.termination.reason !== "completed"
          ? withCeilingGuidance(agentResult.termination, config)
          : sealed.prohibited.length > 0
            ? {
                reason: "prohibited_action" as const,
                detail: sealed.prohibited.map((hit) => `${hit.action}: ${hit.detail}`).join("; "),
              }
            : // SCP-195: the guard refuses a write outside the contract's globs
              // before it happens, so a path here that is still outside them is
              // one the guard never saw. That is a hole in the runner, and the
              // record says so rather than passing the change on to a review
              // that would spend a round finding it.
              sealed.outside_allowed_paths.length > 0
              ? {
                  reason: "runner_defect" as const,
                  detail:
                    `the sealed change set carries ${sealed.outside_allowed_paths.length} path(s) ` +
                    `outside what the contract admits a write under, which the pre-execution ` +
                    `guard should have refused: ` +
                    `${sealed.outside_allowed_paths.slice(0, 5).join(", ")} — ` +
                    `${allowedPathsSentence(pathsAllowed)}`,
                }
            : sealed.changeset === null
              ? denied.length > 0
                ? {
                    reason: "no_changes_after_denials" as const,
                    detail:
                      `the branch adds no change to its base, and ${denied.length} command(s) ` +
                      `the executor asked for were refused: ${deniedSummary}`,
                  }
                : {
                    reason: "no_changes" as const,
                    detail: "the branch adds no change to its base",
                  }
              : carriedForward
                ? {
                    reason: "completed" as const,
                    detail:
                      `the executor added nothing to the ${inherited.length} commit(s) already ` +
                      "on the branch; that change set is what was checked and reviewed",
                  }
                : { reason: "completed" as const, detail: "" };

      /**
       * SCP-194: a round given a scope escape that grew the change set.
       *
       * The brief quotes the contract's globs and asks for the change set to
       * come back inside them. A round that answered by adding files went the
       * other way, and the next round would be asked to undo more than the one
       * before it. Measured against the previous round's own change set rather
       * than against the globs, because a path inside the globs is still a path
       * the round was not asked to add.
       */
      const scopeGiven = toClose.filter((finding) => finding.rule_id.startsWith("scope."));
      const widened =
        state.kind === "remediate" && scopeGiven.length > 0 && termination.reason === "completed"
          ? sealed.changed_paths.filter((path) => !state.previousChangedPaths.includes(path))
          : [];
      if (termination.reason === "completed") {
        state = { ...state, previousChangedPaths: [...sealed.changed_paths] };
      }

      /**
       * SCP-193: the reset a provider named on its way out, and the wait it
       * buys.
       *
       * A 529 clears on its own in a minute and is answered by the fixed retry
       * below. A session limit does not: `429 … resets 4:30am (Europe/London)`
       * says when the provider will serve again, and an attempt started before
       * then meets the same refusal and is paid for. So the reset is read out
       * of the sentence the runner already wrote onto the termination — built
       * from an anchored transport reading and from nothing else — and turned
       * into an instant.
       *
       * A reset further out than `wait_for_provider_ms` is not waited for at
       * all. The bound is a refusal to wait that long rather than an
       * instruction to wait less: waking before the provider's own reset
       * spends an attempt against a limit still in force, which is the thing
       * the wait exists to avoid.
       */
      const reset =
        termination.reason === "transport_unavailable" && state.transportRetry === 0
          ? resetInText(termination.detail, clock())
          : null;
      const parkMs = reset === null ? 0 : reset.until.getTime() - clock().getTime();
      const park: AttemptWait | null =
        reset !== null && parkMs > 0 && parkMs <= waitBoundMs
          ? {
              reason: "provider_reset",
              started_at: clock().toISOString(),
              until: reset.until.toISOString(),
              waited_ms: parkMs,
              zone: reset.zone,
              quoted: reset.quoted,
            }
          : null;

      const attempt = ExecutionAttemptSchema.parse({
        schema_version: EXECUTION_ATTEMPT_SCHEMA_VERSION,
        attempt_id,
        root_attempt_id: rootAttemptId,
        // Round 0 of a re-run continues the previous run's last attempt, so the
        // chain a reader follows crosses runs rather than restarting at each —
        // and a resumed round 0 continues the cut attempt whose diff it holds,
        // which is the more specific answer to the same question.
        continues_attempt_id:
          previous?.attempt_id ?? resumedHere?.attempt_id ?? continuesPreviousRun,
        remediation_round: state.round,
        created_at: at.toISOString(),
        ticket_id: contract.ticket_id,
        plan_id: contract.plan_id,
        plan_version: contract.version,
        planned_risk: contract.level,
        repository_id: contract.scope.repository_id,
        base_ref: config.base_ref,
        base_commit: state.baseCommit,
        provider: "local_worktree",
        branch: state.workspace.branch,
        worktree_path: state.workspace.path,
        autonomy_class: profile.autonomy_class,
        permission_profile: profile,
        agent: agentResult.invocation,
        executor_skills: executorSkills,
        environment: {
          manifest_hash: materialized.manifest_hash,
          install_pinned: manifest.install.pinned,
          materialized_paths: materialized.materialized_paths,
          secret_content_sha256: secrets.entries.map((entry) => entry.content_sha256),
          port_range_start: materialized.ports.start,
          port_range_end: materialized.ports.end,
          database_schema: materialized.database_schema,
          env_names_passed: environment.passed,
          env_names_dropped: environment.dropped.length,
        },
        commands: agentResult.commands,
        egress: agentResult.egress.all(),
        prohibited_action_hits: [
          ...agentResult.prohibited.map((hit) => ({
            action: hit.action,
            detail: hit.detail,
            at: hit.at,
          })),
          ...sealed.prohibited.map((hit) => ({
            action: hit.action,
            detail: hit.detail,
            at: at.toISOString(),
          })),
        ],
        user_instructions: [],
        usage: {
          input_tokens: agentResult.usage.input_tokens,
          cache_creation_input_tokens:
            agentResult.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: agentResult.usage.cache_read_input_tokens,
          output_tokens: agentResult.usage.output_tokens,
          cost_micros: agentResult.usage.cost_micros,
          cost_basis: agentResult.usage.cost_basis,
          // Written only where it is true, so a completed attempt's record is
          // shaped exactly as it always was.
          ...(agentResult.usage.cost_partial ? { cost_partial: true } : {}),
          // Unlike billed usage, this deliberately retains repeated stream
          // envelopes because it is the counter the existing token guard ran.
          token_ceiling_tokens: ceilings.counts().tokens,
          wall_clock_ms: ceilings.counts().wall_clock_ms,
          commands: agentResult.commands.length,
          iterations: agentResult.usage.iterations,
        },
        termination,
        changeset_id: sealed.changeset?.changeset_id ?? null,
        head_commit: sealed.head_commit,
        prior_commits,
        change_set_origin: carriedForward ? "carried_forward" : "attempt",
        // D-092: the executor's own account, read from its final message and
        // already redacted by the adapter. Null where it wrote none.
        executor_account: executorAccount(agentResult.final_message),
        // D-096: every time this round's brief went back after a compaction,
        // as the mechanism that carried it recorded them.
        brief_reinjections: agentResult.reinjections ?? [],
        resumed_from: resumedHere === null ? null : resumedFromRecord(resumedHere),
        merged_base: mergedBase,
        spec_commit: specCommit,
        // What the check attribution above rests on, and — separately — what
        // this attempt's own worktree started from.
        base_verification: baseVerification,
        provisioning_verify: provisioningVerify,
        swept_processes: swept,
        // Written before the loop sleeps, not after: a process killed while it
        // is parked has to leave the instant behind for the next run to honour.
        wait: park,
      } satisfies ExecutionAttempt);
      // The next round inherits this one's commit and can name the attempt
      // that sealed it.
      ledger.addAttempt(attempt, !carriedForward ? sealed.head_commit : null);

      bundles.write({
        kind: "execution",
        subject_id: attempt_id,
        ticket_id: contract.ticket_id,
        inputs: {
          plan_id: contract.plan_id,
          plan_version: contract.version,
          base_commit: state.baseCommit,
          merged_base: mergedBase,
          round_kind: state.kind,
          branch: state.workspace.branch,
          remediation_round: state.round,
          // SCP-194: what this round was handed, so the ladder a reader builds
          // from the bundles is the executor's own brief rather than an
          // inference from what changed. Empty for a round that was given no
          // findings — an execute round, or a conflict round.
          findings_given: toClose.map((finding) => finding.key).join(","),
          findings_given_count: toClose.length,
          invocation_shape: attempt.agent.shape_sha256,
          binary_version: attempt.agent.binary_version,
          termination: termination.reason,
          // The cut attempt's bundle is referenced here and left exactly as it
          // was: this is a new record beside it, never a replacement for it.
          resumed_from_bundle: resumedHere?.bundle_id ?? null,
          resumed_from_attempt: resumedHere?.attempt_id ?? null,
          resumed_diff_sha256: resumedHere?.diff_sha256 ?? null,
        },
        context_manifest: [],
        versions: {
          code: "stage-2",
          prompt:
            state.kind === "resolve_conflict"
              ? conflictPromptVersion(config.relevel_context)
              : state.kind === "execute"
                ? resumedHere === null
                  ? EXECUTOR_PROMPT_VERSION
                  : RESUMED_EXECUTOR_PROMPT_VERSION
                : "executor_remediation_v7",
          policy: profile.autonomy_class,
          model: attempt.agent.model,
          tool: attempt.agent.binary_version,
        },
        usage: {
          input_tokens: attempt.usage.input_tokens,
          output_tokens: attempt.usage.output_tokens,
          cost_micros: attempt.usage.cost_micros,
          cost_basis: attempt.usage.cost_basis,
          ...(attempt.usage.cost_partial ? { cost_partial: true } : {}),
          wall_clock_ms: attempt.usage.wall_clock_ms,
        },
        artifacts: [
          { name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt, null, 2) },
          { name: "transcript.jsonl", media_type: "application/x-ndjson", body: agentResult.transcript.join("\n") },
          { name: "prompt.txt", media_type: "text/plain", body: prompt },
          // The deterministic half of the judgement, beside the attempt it
          // judged (D-045). The reviewer echoes the same results into its own
          // artifact, but only for the round it reviews and only when it is
          // reached: a remediation round is verified rather than reviewed, and
          // an attempt a ceiling cut has no review at all — so without this the
          // measurement that outranks the reviewer existed nowhere on disk.
          // Written even when it is empty, because "nothing was measured"
          // is a fact about the round and not an absence of one.
          {
            name: "checks.json",
            media_type: "application/json",
            body: JSON.stringify(checks, null, 2),
          },
          ...(sealed.diff ? [{ name: "change.diff", media_type: "text/x-diff", body: sealed.diff }] : []),
        ],
        errors: termination.reason === "completed" ? [] : [{ kind: termination.reason, message: termination.detail }],
        transitions: [
          { at: at.toISOString(), from: "PROVISIONING", to: "EXECUTING", reason: "worktree materialized" },
          { at: clock().toISOString(), from: "EXECUTING", to: "VERIFYING", reason: termination.reason },
        ],
        retention: { class: "raw_transcript", expires_at: null },
        secrets,
        excluded_paths: sealed.excluded_paths,
        deterministic: false,
        model_version_pinned: true,
        now: clock(),
      });

      // D-065: declines are parsed from the model's own decoded text before any
      // termination handling — an executor that declines everything and,
      // correctly, changes nothing must end as an escalation with its reasons,
      // not as `no_changes`.
      const declines =
        state.kind === "remediate"
          ? parseDeclines(agentResult.transcript, toClose.map((finding) => finding.key))
          : [];
      if (declines.length > 0) {
        progress(`${declines.length} finding(s) declared no-determinable-practice`);
        ledger.addDeclines(declines);
      }

      /** This round's record where no review and no verification judged it. */
      const record = (): RoundRecord => ({
        round: state.round,
        kind: state.kind,
        attempt,
        superseded_attempts: state.superseded,
        review: null,
        node_reviews: [],
        verification: null,
        checks,
        remediable_findings: 0,
        directly_verified: 0,
        declines,
      });

      if (termination.reason !== "completed") {
        const stoppedStep = routeStopped({
          termination,
          attempt,
          transportRetry: state.transportRetry,
          reset,
          park,
          parkMs,
          waitBoundMs,
          // An attempt that carried an earlier one's commits forward sealed
          // nothing of its own to continue over.
          sealedItsOwn: !carriedForward && sealed.head_commit !== null,
          spend: ledger.spend(),
          budget: ticketBudgetMicros(agentResult.invocation.credential_class),
          declines: declines.length,
          ticketKey: config.ticket_key,
          branch: state.workspace.branch,
          runNumber,
          attemptsSoFar: ledger.attempts.length,
          configPath,
        });
        // A round that stops here has been answered; one that buys another
        // attempt has not, and the attempt it replaces is named on the record
        // the round does get.
        if (stoppedStep.next === "stop") ledger.addRound(record());
        state = applyStep(state, stoppedStep);
        if (stoppedStep.next === "stop") {
          outcome = stoppedStep.end.outcome;
          detail = stoppedStep.end.detail;
          break;
        }
        await waitOut(stoppedStep);
        continue;
      }

      // SCP-192: the round produced a change set the base will not merge into.
      // Nothing judges it — a review of a branch that cannot reach its base is
      // a review of a change nobody can take — and the executor gets one round
      // whose only task is the resolution.
      if (conflictNow !== null) {
        ledger.addRound(record());
        const conflictStep = routeConflict({
          conflict: conflictNow,
          kind: state.kind,
          baseRef: config.base_ref,
          branch: state.workspace.branch,
        });
        state = applyStep(state, conflictStep);
        if (conflictStep.next === "stop") {
          outcome = conflictStep.end.outcome;
          detail = conflictStep.end.detail;
          break;
        }
        continue;
      }

      // SCP-192: the resolution landed and the branch is level with the base
      // again. What follows is whatever the conflict interrupted.
      if (state.kind === "resolve_conflict") {
        const resolution = routeResolution({
          markers: pathsWithConflictMarkers(state.workspace.path, sealed.changed_paths),
          changedPaths: sealed.changed_paths.length,
          beforeExecutor: state.conflict!.before_executor,
          resumeKind: state.conflict!.resume_kind,
          relevel: config.relevel,
          round: state.round,
        });
        if (resolution.say !== null) progress(resolution.say);
        if (resolution.step !== null) {
          ledger.addRound(record());
          state = applyStep(state, resolution.step);
          if (resolution.step.next === "stop") {
            outcome = resolution.step.end.outcome;
            detail = resolution.step.end.detail;
            break;
          }
          continue;
        }
        state = { ...state, conflict: null };
      }

      // A round that answered routed findings is verified, never re-reviewed
      // (D-061). The verifier is handed the findings it must check —
      // dependence is the design — and the deterministic evidence can only
      // fail it.
      //
      // "After the first" is `finalReview !== null` rather than `round > 0`,
      // because a conflict round can carry the one independent review into a
      // later round without a verdict having been reached in between.
      //
      // The one round this is not true of is the one answering a review that
      // could not resolve every criterion: there is no closure to verify there,
      // only criteria to judge, so that round falls through to the review
      // below.
      if (state.finalReview !== null && !state.reviewingAgain) {
        // D-065: declined findings are the person's now — they skip the model
        // half of verification and leave the executor's open set. The
        // deterministic half still applies to the round's tree: verifyClosures
        // consults the pinned checks and the scope computation before asking
        // anything, and with zero findings left it gates on those alone.
        // SCP-194: a scope round that widened is refused before anything is
        // paid to verify it. Nothing is lost — the change set stays on the
        // branch and the finding stays open — and the stop says which paths
        // arrived and what the contract admits.
        const widenedStep = refuseWidening({
          widened,
          scopeGiven,
          remediationRound: state.remediationRound,
          pathsAllowed,
        });
        if (widenedStep !== null) {
          ledger.addRound(record());
          state = applyStep(state, widenedStep);
          outcome = widenedStep.end.outcome;
          detail = widenedStep.end.detail;
          break;
        }
        const declinedKeys = new Set(declines.map((decline) => decline.finding_key));
        const toVerify = toClose.filter((finding) => !declinedKeys.has(finding.key));
        progress(`verifying closures, round ${state.round}`);
        const verification = await verifyRunner({
          findings: toVerify,
          diff: sealed.diff ?? "",
          checks: gating,
          scope: contract.scope,
          changeset: sealed.changeset!,
          model: verifierModel(
            config,
            toVerify.map((finding) => finding.key),
          ),
          onProgress: progress,
        });

        bundles.write({
          kind: "review",
          subject_id: `cv_${attempt_id}`,
          ticket_id: contract.ticket_id,
          inputs: {
            changeset_id: sealed.changeset?.changeset_id ?? null,
            base_commit: state.baseCommit,
            head_commit: sealed.head_commit,
            remediation_round: state.round,
            round_kind: state.kind,
            verification: true,
            all_closed: verification.all_closed,
            deterministic_failure: verification.deterministic_failure,
            // SCP-194: the other half of the round's record — what it was
            // given, above, and which of those it closed. The ladder needs
            // both, and a `per_finding` row is not readable without knowing
            // the set it was drawn from.
            findings_given: toVerify.map((finding) => finding.key).join(","),
            findings_closed: verification.per_finding
              .filter((row) => row.status === "closed")
              .map((row) => row.finding_key)
              .join(","),
            findings_open: verification.open_keys.join(","),
          },
          context_manifest: [],
          versions: {
            code: "stage-3",
            prompt: verification.prompt_version,
            policy: "closure-verification",
            model: config.reviewer_model ?? config.model,
            tool: config.reviewer_provider,
          },
          usage: {
            input_tokens: verification.usage.input_tokens,
            output_tokens: verification.usage.output_tokens,
            cost_micros: verification.cost_micros,
            cost_basis: verification.cost_basis,
            wall_clock_ms: 0,
          },
          artifacts: [
            {
              name: "verification.json",
              media_type: "application/json",
              body: JSON.stringify(verification, null, 2),
            },
          ],
          errors: [],
          transitions: [
            {
              at: clock().toISOString(),
              from: "VERIFYING",
              to: "INDEPENDENT_REVIEW",
              reason: verification.all_closed ? "closures verified" : "closures still open",
            },
          ],
          retention: { class: "replay_retained", expires_at: null },
          secrets,
          excluded_paths: sealed.excluded_paths,
          deterministic: false,
          model_version_pinned: true,
          now: clock(),
        });

        ledger.addRound({
          round: state.round,
          kind: state.kind,
          attempt,
          superseded_attempts: state.superseded,
          review: null,
          node_reviews: [],
          verification,
          checks,
          // Open after verification plus declined: everything a person still
          // has in front of them at the end of this round.
          remediable_findings: verification.open_keys.length + declines.length,
          directly_verified: 0,
          declines,
        });

        const verificationStep = routeVerification({
          verification,
          toVerify,
          openFindings: state.openFindings,
          declines: ledger.declines.length,
          remediationRound: state.remediationRound,
          maxRounds,
          spend: ledger.spend(),
          budget: ticketBudgetMicros(agentResult.invocation.credential_class),
          configPath,
        });
        state = applyStep(state, verificationStep);
        if (verificationStep.next === "stop") {
          outcome = verificationStep.end.outcome;
          detail = verificationStep.end.detail;
          break;
        }
        continue;
      }

      // The independent review: round 0's, and the re-review of a round that
      // answered an incomplete verdict. Its inputs are the plan, the change
      // set, the checks and the files it selects — and nothing about the
      // attempt that produced them.
      progress(`review round ${state.round}`);
      // A verdict the plan cannot accept is the reviewer's error, not the
      // executor's: the review asks once for a correction and, failing that,
      // records `review_failed` with the reasons (SCP-165). The change set is
      // sealed either way and stays on the branch.
      const graphOutcome = await reviewGraph(
        {
          contract,
          diff: sealed.diff,
          // The sealed form: its file list is complete whatever the diff's
          // size, and a withheld diff is refused rather than reviewed.
          changeset: sealed.changeset ?? undefined,
          // The full pinned set: whole-change and, on a graphed plan, every
          // node's own run beside it (D-107). reviewGraph narrows this to
          // each node's own results and to wholeChangeChecks for the overall
          // call, which is what `gating` already is for a flat plan.
          checks,
          repoDir: state.workspace.path,
          model: reviewerModel(config, contract, gating),
          head_commit: sealed.head_commit ?? undefined,
          remediationAvailable: state.remediationRound < maxRounds,
          // Whether the contract's base commit passed the workspace's verify
          // command (d069 reads a pinned check failing now as the change's own
          // breakage). It is the ticket's answer, measured on the attempt that
          // provisioned at the base and read back from the record by every
          // attempt after it, so an attempt continuing over commits an earlier
          // one sealed is not told its own predecessor's breakage is the base's.
          // Verify may run fewer checks than the pinned set, and a base merged up
          // mid-run is not re-verified: a wrong reading costs one round, which the
          // verifier's own run of the checks then stops. Undefined where nothing
          // has measured the base, which the review reads as unknown.
          baseVerified: baseVerification === null ? undefined : baseVerification.verified,
          onProgress: progress,
        },
        reviewRunner,
        { modelFor: (nodeContract, nodeChecks) => reviewerModel(config, contractWithCriteria(nodeContract, contract), nodeChecks) },
      );
      const reviewOutcome = graphOutcome.overall;

      // The artifact is the review as written. Provenance stamping belonged to
      // the retired second-review design; artifacts that carry a remediation
      // block remain readable.
      //
      // The target's provenance is the runner's to state: the reviewer judged
      // the whole range and was told nothing about which of its commits came
      // from which attempt.
      //
      // A check that failed and passed alone on the re-run is recorded
      // `passed`, so the reviewer's own `check.*` finding has nothing to fire
      // on. The flake is still the round's to report, so the runner states it
      // here as its own advisory finding: deterministic, never blocking, and
      // naming the tests.
      //
      // The combined view (D-107): a graphed plan's gate reads the overall
      // review and every reviewed node's together, so a node-local blocking
      // finding closes the gate exactly as a whole-change one does. A flat
      // plan's combined view is the overall artifact itself.
      const review: ReviewArtifact = {
        ...graphOutcome.combined,
        target: { ...graphOutcome.combined.target, prior_commits },
        findings: [...graphOutcome.combined.findings, ...flakyCheckFindings(gating)],
      };
      const nodeReviewsThisRound: NodeReview[] = graphOutcome.nodes.map((entry) => ({
        node_id: entry.node_id,
        review: entry.outcome?.artifact ?? null,
      }));

      writeReviewBundle({
        bundles,
        contract,
        secrets,
        clock,
        review,
        outcome: reviewOutcome,
        node_reviews: nodeReviewsThisRound,
        sealed,
        round: state.round,
        remediation_available: state.remediationRound < maxRounds,
      });

      state = { ...state, finalReview: review, nodeReviews: nodeReviewsThisRound };
      ledger.addRound({
        round: state.round,
        kind: state.kind,
        attempt,
        superseded_attempts: state.superseded,
        review,
        node_reviews: nodeReviewsThisRound,
        verification: null,
        checks,
        remediable_findings: remediableFindings(review.findings).length,
        directly_verified: countDirectlyVerified(review),
        declines: [],
      });

      // The round that answered an incomplete verdict has now been judged, so
      // whatever this review routes next is a closure for the verifier.
      const answeringIncomplete = state.reviewingAgain;
      // D-057: an incomplete verdict is a person's, and only a round that can
      // make its criteria judgeable takes it off them.
      if (review.decision === "incomplete") outcome = "escalated";

      const reviewStep = routeReview({
        review,
        answeringIncomplete,
        round: state.round,
        remediationRound: state.remediationRound,
        maxRounds,
        configPath,
      });
      if (reviewStep.next === "advance" && reviewStep.say !== undefined) progress(reviewStep.say);
      state = applyStep(state, reviewStep);
      if (reviewStep.next === "stop") {
        outcome = reviewStep.end.outcome;
        detail = reviewStep.end.detail;
        break;
      }
      continue;
    }

    let pull_request: TicketRunResult["pull_request"] = null;
    /** SCP-202: what the post-approval merge step did, where one ran. */
    let merge: LoopMergeOutcome | null = null;
    /** What the checks on the published head said, where there was one. */
    let delivery_checks: DeliveredChecksReading | null = null;
    /** SCP-200: the credential path this run published through, where it did. */
    let github_credential: GithubCredential | null = null;
    /** SCP-192: the base tip the branch is level with when the run ends. */
    let merged_base: string | null = state.baseCommit === workspace.base_commit ? null : state.baseCommit;
    // An escalated outcome publishes too (D-065): the pull request is the
    // surface where the person meets the executor's verified fixes and the
    // "no determinable practice — for you to decide" reasons side by side.
    // The system still never merges anything.
    // SCP-227: a re-level judged without an executor has no attempt to
    // publish under; its own block below pushes a `relevelled` branch, and a
    // verdict short of that leaves the merge commit local and unpushed.
    if ((outcome === "approved" || outcome === "escalated") && config.publish && state.finalReview && ledger.attempts.length > 0) {
      // SCP-192, the second merge-up: the base can move between the review and
      // the publish, and a pull request that is behind at the moment it opens
      // is the pull request a person spent day four merging by hand. Nothing
      // unreviewed enters the branch by it — what a clean merge brings in is
      // the base's own commits, which are already on the base branch.
      const up = await mergeUp({
        worktree: workspace.path,
        repository_root: config.repository_root,
        base_ref: config.base_ref,
        base_commit: state.baseCommit,
        ticket_key: config.ticket_key,
        attempt_id: ledger.last()?.attempt_id ?? rootAttemptId,
      });
      if (up.status === "conflict") {
        // There is no round left to hand this to — the loop is past its rounds
        // — and opening a pull request that cannot be merged is the thing this
        // ticket exists to stop. The change set stays on its branch, and the
        // attempts are still recorded below.
        outcome = "base_conflict";
        detail =
          `the change was ${state.finalReview.decision === "approve" ? "approved" : "escalated"} and then ` +
          (up.paths.length > 0
            ? `${config.base_ref} moved to ${up.tip}, which will not merge into ` +
              `${workspace.branch}: ${up.paths.join(", ")}`
            : mergeFailedDetail(config.base_ref, up.tip, workspace.branch, up.detail)) +
          ". No pull request was opened; a re-run merges the base up again.";
        progress(detail);
      } else if (up.base_commit !== state.baseCommit) {
        state = { ...state, baseCommit: up.base_commit };
        progress(`merged ${config.base_ref} at ${state.baseCommit.slice(0, 12)} before publishing`);
      }
    }

    // A second test rather than an `else`: the block above can turn an approved
    // run into `base_conflict`, and the pull request must not open on it.
    if ((outcome === "approved" || outcome === "escalated") && config.publish && state.finalReview && ledger.attempts.length > 0) {
      merged_base = state.baseCommit === workspace.base_commit ? null : state.baseCommit;
      // SCP-200: the runner holds the credential and performs both steps, so
      // the path is read from the runner's own environment. The preflight in
      // front of this run already refused a machine that has neither.
      github_credential = githubCredential();
      await pushBranch({ worktree: workspace.path, branch: workspace.branch, onProgress: progress });
      const body = pullRequestBody({
        contract,
        attempt: ledger.last()!,
        review: state.finalReview,
        attempts: [...ledger.attempts],
        // Where the work came from, so the person merging reads it here
        // rather than going back to the ticket for it.
        source: config.ticket_source,
        verification_costs: ledger.rounds.flatMap((entry) =>
          entry.verification
            ? [
                {
                  cost_micros: entry.verification.cost_micros,
                  cost_basis: entry.verification.cost_basis,
                },
              ]
            : [],
        ),
        declines: ledger.declines,
        // SCP-202: the closing line says which of the two merges this pull
        // request is waiting for, from the switch that decides it.
        merge: config.merge,
      });
      pull_request = await openPullRequest({
        worktree: workspace.path,
        branch: workspace.branch,
        base_ref: config.base_ref,
        title: `${config.ticket_key}: ${contract.outcome}`.slice(0, 120),
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
      merge = await mergePullRequest({
        mode: config.merge,
        repository_root: config.repository_root,
        branch: workspace.branch,
        pull_request_number: pull_request.number,
        base_ref: config.base_ref,
        state_root: config.state_root,
        ticket_key: config.ticket_key,
        paths_allowed: contract.scope.paths_allowed,
        attempt_id: ledger.last()?.attempt_id ?? rootAttemptId,
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
          worktree: workspace.path,
          branch: workspace.branch,
          boundMs: config.delivery_checks_bound_ms,
          now: clock,
          sleep: wait,
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
          worktree: workspace.path,
          branch: workspace.branch,
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
    }

    // SCP-227: a re-levelled branch is pushed and its merge step read. The pull
    // request already exists — the branch is at `pr_open` — so it is found
    // rather than opened, and its body is left as it is.
    if (outcome === "relevelled" && config.publish) {
      merged_base = state.baseCommit === workspace.base_commit ? null : state.baseCommit;
      github_credential = githubCredential();
      await pushBranch({ worktree: workspace.path, branch: workspace.branch, onProgress: progress });
      pull_request = await findPullRequest({ worktree: workspace.path, branch: workspace.branch });
      if (pull_request === null) {
        progress(`no open pull request on ${workspace.branch}: the re-level is pushed and nothing else is read`);
      } else {
        progress(`pull request ${pull_request.url}`);
        merge = await mergePullRequest({
          mode: config.merge,
          repository_root: config.repository_root,
          branch: workspace.branch,
          pull_request_number: pull_request.number,
          base_ref: config.base_ref,
          state_root: config.state_root,
          ticket_key: config.ticket_key,
          paths_allowed: contract.scope.paths_allowed,
          attempt_id: ledger.last()?.attempt_id ?? continuesPreviousRun ?? rootAttemptId,
          now: clock(),
        });
        progress(merge.merged ? `merged: ${merge.detail}` : `not merged — ${merge.detail}`);
        try {
          delivery_checks = await readDeliveredChecks({
            worktree: workspace.path,
            branch: workspace.branch,
            boundMs: config.delivery_checks_bound_ms,
            now: clock,
            sleep: wait,
            onProgress: progress,
          });
          progress(`checks on the head: ${delivery_checks.state}`);
        } catch (error) {
          progress(
            `the checks on the head could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Appended, never replaced: every earlier run stays readable with its own
    // termination, its bundle and its place in the order.
    // Only what a park has not already flushed: an attempt appended twice
    // collides with itself, and the refusal that catches it would fail a run
    // that had otherwise finished.
    const recorded = ledger.finish();
    progress(
      `recorded ${ledger.attempts.length} attempt(s) as run ${recorded.runs} of ${config.ticket_key}; ` +
        `${recorded.attempts.length} on record`,
    );

    return {
      ticket_id: contract.ticket_id,
      workspace,
      rounds: [...ledger.rounds],
      final_review: state.finalReview,
      node_reviews: state.nodeReviews,
      pull_request,
      merge,
      delivery_checks,
      github_credential,
      outcome,
      detail,
      incomplete_review: state.incompleteReview,
      merged_base,
    };
  } finally {
    // Whatever ended the run, nothing of it outlives the worktree. The last
    // attempt's own sweep has usually left this with nothing to find; a run
    // that stopped before an attempt was recorded has not.
    await sweepWorktree({ worktree: workspace.path, onProgress: progress }).catch(() => undefined);
    // The worktree goes; the branch and its commits stay, and so does every
    // attempt record. A retry does not overwrite the previous attempt's history.
    await cleanup({
      workspace,
      root: config.worktree_root,
      outcome: outcome === "approved" ? "success" : "failure",
    }).catch(() => undefined);
  }
}

export { PROMPT_VERSION as REVIEWER_PROMPT_VERSION };
