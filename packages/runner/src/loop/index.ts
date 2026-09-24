import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  configPath,
  limitFor,
  limitsForCredential,
  STORE_DIRNAME,
  type GithubCredential,
  type IncompleteReviewPath,
  type NodeReview,
  type PlanContract,
  type ReviewArtifact,
} from "@perbo/contracts";
import { cleanup, type Workspace } from "@perbo/workspace";
import { PROMPT_VERSION } from "@perbo/review";
import { Ledger } from "./internal/ledger.js";
import { acquireRunLock, type HeldRunLock } from "../lock.js";
import { pathsWithConflictMarkers } from "./internal/merge-up.js";
import { sweepWorktree } from "./internal/orphans.js";
import type { DeliveredChecksReading } from "../delivery.js";
import type { LoopMergeOutcome } from "../merge.js";
import { type TicketRunConfig } from "./internal/config.js";
import { recordAttempt } from "./internal/attempt.js";
import { briefRound } from "./internal/brief.js";
import { start } from "./internal/start.js";
import {
  attemptsThatSealed,
  branchStillAt,
  confirmContinuation,
  decidedDelivery,
  decisionsOn,
  remediationToContinue,
  stillWithPerson,
} from "./internal/continuation.js";
import { recordDecisions, type DecidedFinding } from "../decisions.js";
import { checkRound } from "./internal/check.js";
import { publish, publishRelevel, type Delivery } from "./internal/deliver.js";
import { execute } from "./internal/execute.js";
import { sealRound } from "./internal/seal.js";
import { levelBeforeExecutor, levelBeforePublish } from "./internal/level.js";
import { reviewRound } from "./internal/review.js";
import { resolvePorts, type LoopPorts, type RunLimits } from "./internal/context.js";
import {
  applyStep,
  initialRoundState,
  type RoundRecord,
  type Retry,
  type RunOutcome,
} from "./internal/state.js";
import { routeConflict, routeResolution, routeStopped } from "./internal/route.js";
import { provisionRound, provisionRun } from "./internal/provision.js";
import type { RelevelContext } from "./internal/relevel.js";
import { verifyRound } from "./internal/verify.js";

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
 *
 * **A person's answer closes the finding it answers**
 * (D-NEW-a-person-s-answer-closes-a-routed-finding). Where the last review's
 * every standing finding is answered by a person or verified closed, and the
 * branch is still the commit it judged, the run executes and reviews nothing
 * and goes where an approval goes; the answers are recorded on their findings.
 */

export { resolvePorts, type LoopPorts, type RunLimits } from "./internal/context.js";
export { incompleteReviewCauses } from "./internal/review.js";
export { type DecidedFinding } from "../decisions.js";
export { type RoundKind, type RoundRecord, type RunOutcome } from "./internal/state.js";

export {
  BaseSourceSchema,
  MergedTicketContextSchema,
  TicketRunConfigSchema,
  guardProhibitedPaths,
  type BaseSource,
  type TicketRunConfig,
} from "./internal/config.js";


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
  /**
   * The person's decisions this run closed findings on
   * (D-NEW-a-person-s-answer-closes-a-routed-finding): every one a delivery
   * without a round rests on, and those a continued review's findings carried.
   * Empty where no decision answered the review the run ended on.
   */
  decided: DecidedFinding[];
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
  /**
   * The answers a person gave to findings routed to them, from the verdicts
   * record (`perbo verdict --decide`). Each closes its finding on the review it
   * was taken after; none reaches the executor or the reviewer.
   */
  decided?: readonly DecidedFinding[];
  /** Injected by tests: a stand-in for the agent, the checks and the reviewer. */
  hooks?: Partial<LoopPorts>;
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
    configPath: join(config.repository_root, STORE_DIRNAME, ...configPath()),
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

  const limits = runLimits(config);
  const { configPath, waitBoundMs, ticketBudgetMicros, maxRounds, roundCeiling } = limits;
  const started = await start({
    config,
    contract: args.contract,
    lock,
    limits,
    clock,
    wait,
    progress,
  });
  const { contract, bundles, resumeSource, manifest, verifyMeasures } = started;
  const {
    attemptsPath,
    prior: priorAttempts,
    runNumber,
    rootAttemptId,
    continuesPreviousRun,
    previousRunAccount,
  } = started.record;
  const ledger = new Ledger({ path: attemptsPath, prior: priorAttempts, ticketId: contract.ticket_id });

  const {
    workspace,
    materialized,
    secrets,
    specCommit,
    sealExclusions,
    provisioningVerify,
    baseVerification,
    profile,
    principles,
  } = await provisionRun({
    config,
    started,
    sealedBy: (sha) => ledger.sealedBy(sha),
    clock,
    progress,
  });

  let outcome: TicketRunResult["outcome"] = "terminated";
  let detail = "";
  const decided = args.decided ?? [];
  let decidedOn: DecidedFinding[] = [];

  // D-NEW-a-person-s-answer-closes-a-routed-finding: a delivery on a person's
  // answers (`decidedDelivery`), taken only while the branch is the commit that
  // review judged; a branch that has moved carries work nobody judged.
  const decidedNow =
    resumeSource !== null || config.relevel
      ? null
      : decidedDelivery({
          bundles,
          ticket_id: contract.ticket_id,
          repository_id: contract.scope.repository_id,
          decided,
        });
  const delivering =
    decidedNow !== null &&
    (await branchStillAt(workspace.path, workspace.base_commit, decidedNow.head_commit))
      ? decidedNow
      : null;
  if (decidedNow !== null && delivering === null) {
    progress(
      `every finding ${config.ticket_key}'s last review routed to a person is decided, but the ` +
        `branch has moved past ${decidedNow.head_commit}, the commit that review judged: this run ` +
        "reviews what is there",
    );
  }

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
    resumeSource !== null || config.relevel || delivering !== null
      ? null
      : remediationToContinue({ bundles, ticket_id: contract.ticket_id, decided });
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
  if (delivering !== null) {
    decidedOn = delivering.decided;
    state = { ...state, finalReview: delivering.review, nodeReviews: delivering.node_reviews };
    outcome = "approved";
    detail =
      `every finding the review routed to a person is decided (${delivering.decided
        .map((row) => row.finding_key.slice(0, 12))
        .join(", ")}), and the branch is still at ${delivering.head_commit}, the commit that ` +
      "review judged: nothing was executed or reviewed again";
    progress(detail);
  }

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
    while (delivering === null && state.round <= roundCeiling) {
      state = await confirmContinuation(state, progress);

      const entered = await provisionRound({
        config,
        contract,
        ledger,
        state,
        rootAttemptId,
        branchesOnRecord: started.record.branchesOnRecord,
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

      const briefed = await briefRound({
        config,
        contract,
        ledger,
        state,
        specCommit,
        resumeSource,
        principles,
        maxRounds,
        previous,
        previousRunAccount,
        progress,
      });
      if ("next" in briefed) {
        state = applyStep(state, briefed);
        outcome = briefed.end.outcome;
        detail = briefed.end.detail;
        break;
      }
      const { prior_commits, toClose, pathsAllowed } = briefed.brief;

      const executed = await execute({
        config,
        state,
        brief: briefed.brief,
        attemptId: attempt_id,
        at,
        profile,
        materialized,
        secrets,
        agent: agentRunner,
        progress,
      });
      if ("next" in executed) {
        state = applyStep(state, executed);
        outcome = executed.end.outcome;
        detail = executed.end.detail;
        break;
      }
      const { result: agentResult, ceilings, environment } = executed.executed;

      const round = await sealRound({
        config,
        contract,
        state,
        mergedBase,
        brief: briefed.brief,
        attemptId: attempt_id,
        completed: agentResult.termination.reason === "completed",
        secrets,
        sealExclusions,
        progress,
      });
      state = round.state;
      mergedBase = round.mergedBase;
      const { sealed, carriedForward, conflictNow } = round;

      const measured = await checkRound({
        config,
        contract,
        state,
        sealed,
        env: environment.env,
        secrets,
        checks: checkRunner,
        progress,
      });
      state = measured.state;
      const { checks, gating, swept } = measured;

      const recorded = recordAttempt({
        config,
        contract,
        state,
        brief: briefed.brief,
        bundles,
        ledger,
        attemptId: attempt_id,
        rootAttemptId,
        previous,
        continuesPreviousRun,
        at,
        agentResult,
        ceilings,
        environment,
        profile,
        materialized,
        manifest,
        secrets,
        sealed,
        carriedForward,
        mergedBase,
        specCommit,
        baseVerification,
        provisioningVerify,
        swept,
        checks,
        waitBoundMs,
        clock,
        progress,
      });
      state = recorded.state;
      const { attempt, termination, declines, widened, scopeGiven, reset, park, parkMs } = recorded;

      /** This round's record where no review and no verification judged it. */
      const record: RoundRecord = {
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
      };

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
        if (stoppedStep.next === "stop") ledger.addRound(record);
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
        ledger.addRound(record);
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
          ledger.addRound(record);
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
        const verificationStep = await verifyRound({
          config,
          contract,
          state,
          ledger,
          bundles,
          attemptId: attempt_id,
          attempt,
          sealed,
          gating,
          checks,
          declines,
          toClose,
          widened,
          scopeGiven,
          pathsAllowed,
          record,
          maxRounds,
          budget: ticketBudgetMicros(agentResult.invocation.credential_class),
          configPath,
          secrets,
          verify: verifyRunner,
          clock,
          progress,
        });
        state = applyStep(state, verificationStep);
        if (verificationStep.next === "stop") {
          outcome = verificationStep.end.outcome;
          detail = verificationStep.end.detail;
          break;
        }
        continue;
      }

      const reviewed = await reviewRound({
        config,
        contract,
        state,
        ledger,
        bundles,
        attempt,
        sealed,
        gating,
        checks,
        priorCommits: prior_commits,
        baseVerification,
        maxRounds,
        configPath,
        secrets,
        review: reviewRunner,
        clock,
        progress,
      });
      state = reviewed.state;
      if (reviewed.escalated) outcome = "escalated";
      const reviewStep = reviewed.step;
      if (reviewStep.next === "advance" && reviewStep.say !== undefined) progress(reviewStep.say);
      state = applyStep(state, reviewStep);
      if (reviewStep.next === "stop") {
        outcome = reviewStep.end.outcome;
        detail = reviewStep.end.detail;
        break;
      }
      continue;
    }

    // The review a continued remediation answered stays the one a person was
    // shown: its findings routed to a person are closed by their decisions —
    // shipped as they are, or handed to the executor and verified closed — and
    // by nothing else a round did, so an approval that leaves one open is
    // still the person's to give. A finding handed to the executor is recorded
    // as closed only where the run's verification closed it, which is an
    // approval; anything short of that leaves it open on the review.
    if (continuing !== null && state.finalReview === continuing.review) {
      const decisions = decisionsOn(continuing.review, continuing.reviewed_at, decided);
      const handed = new Set(continuing.directions.map((direction) => direction.finding_key));
      const owed = stillWithPerson(continuing.review, decisions, handed);
      if (outcome === "approved" && owed.length > 0) {
        outcome = "escalated";
        detail =
          `${detail}; ${owed.length} finding(s) the review routed to a person are still theirs: ` +
          `${owed.map((finding) => finding.key).join(", ")}`;
      }
      const recorded = new Map(
        [...decisions].filter(
          ([key, decision]) =>
            decision.choice === "ship_as_is" || (outcome === "approved" && handed.has(key)),
        ),
      );
      decidedOn = [...recorded.values()];
      state = {
        ...state,
        finalReview: recordDecisions(continuing.review, recorded, contract.scope.repository_id),
      };
    }

    /**
     * What a pull request is opened under: this run's attempts, or — for a
     * delivery that ran none — the attempts of the run that sealed the commit
     * the review judged.
     */
    const delivered =
      delivering === null ? [...ledger.attempts] : attemptsThatSealed(priorAttempts, delivering.head_commit);
    const deliveredUnder = delivered[delivered.length - 1]?.attempt_id ?? rootAttemptId;
    if (delivering !== null && config.publish && delivered.length === 0) {
      outcome = "terminated";
      detail =
        `every finding the review routed to a person is answered, but no attempt on ${config.ticket_key}'s ` +
        `record sealed ${delivering.head_commit}, the commit that review judged, so there is no run to ` +
        "open the pull request under";
      progress(detail);
    }

    let delivery: Delivery = {
      pull_request: null,
      merge: null,
      delivery_checks: null,
      github_credential: null,
      merged_base: state.baseCommit === workspace.base_commit ? null : state.baseCommit,
      detail,
    };
    // An escalated outcome publishes too (D-065): the pull request is the
    // surface where the person meets the executor's verified fixes and the
    // "no determinable practice — for you to decide" reasons side by side.
    // The system still never merges anything.
    // SCP-227: a re-level judged without an executor has no attempt to
    // publish under; its own block below pushes a `relevelled` branch, and a
    // verdict short of that leaves the merge commit local and unpushed.
    if ((outcome === "approved" || outcome === "escalated") && config.publish && state.finalReview && delivered.length > 0) {
      const levelled = await levelBeforePublish({
        config,
        state,
        end: { outcome, detail },
        ledger,
        rootAttemptId: deliveredUnder,
        finalReview: state.finalReview,
        progress,
      });
      state = levelled.state;
      outcome = levelled.end.outcome;
      detail = levelled.end.detail;
    }

    // A second test rather than an `else`: the block above can turn an approved
    // run into `base_conflict`, and the pull request must not open on it.
    if ((outcome === "approved" || outcome === "escalated") && config.publish && state.finalReview && delivered.length > 0) {
      delivery = await publish({
        config,
        contract,
        state,
        ledger,
        attempts: delivered,
        rootAttemptId: deliveredUnder,
        finalReview: state.finalReview,
        detail,
        push: pushBranch,
        open: openPullRequest,
        merge: mergePullRequest,
        onPullRequest: args.onPullRequest,
        clock,
        wait,
        progress,
      });
      detail = delivery.detail;
    }

    if (outcome === "relevelled" && config.publish) {
      delivery = await publishRelevel({
        config,
        contract,
        state,
        ledger,
        rootAttemptId,
        continuesPreviousRun,
        detail,
        push: pushBranch,
        existing: findPullRequest,
        merge: mergePullRequest,
        clock,
        wait,
        progress,
      });
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
      pull_request: delivery.pull_request,
      merge: delivery.merge,
      delivery_checks: delivery.delivery_checks,
      github_credential: delivery.github_credential,
      outcome,
      detail,
      incomplete_review: state.incompleteReview,
      merged_base: delivery.merged_base,
      decided: decidedOn,
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
