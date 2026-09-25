import {
  admittedWriteGlobs,
  planNodes,
  standingProhibitedPaths,
  type ExecutionAttempt,
  type Finding,
  type PlanContractWithCriteria,
  type SealedCommit,
} from "@perbo/contracts";
import { git } from "@perbo/workspace";
import type { BriefRecords } from "../../brief.js";
import { conflictPrompt, executorPrompt, remediationPrompt } from "../../prompt.js";
import {
  applyRetainedDiff,
  resumeNote,
  type ResumeOutcome,
  type ResumeSource,
} from "../../resume.js";
import { commitsSince } from "../../seal.js";
import { withExecutorSkills } from "../../skills/index.js";
import { guardProhibitedPaths, type TicketRunConfig } from "./config.js";
import type { Ledger } from "./ledger.js";
import type { RoundState, Stop } from "./state.js";

/**
 * What a round hands its executor.
 */

/** Everything one round's executor is given, and what the round's record reads back. */
export interface Brief {
  /** The commits on the branch before this attempt, oldest first, without the spec commit. */
  inherited: string[];
  prior_commits: SealedCommit[];
  /** The routed findings this round is asked to close; empty for an execute round. */
  toClose: Finding[];
  /** The prior attempt whose work this round runs over, where there is one. */
  resumedHere: ResumeSource | null;
  /** What the resume did with `resumedHere`'s retained diff; null where there is none. */
  resumeOutcome: ResumeOutcome | null;
  pathsAllowed: string[];
  pathsProhibited: string[];
  prompt: string;
  executorSkills: ReturnType<typeof withExecutorSkills>["receipts"];
  briefRecords: BriefRecords;
}

/**
 * Brief a round: what the branch already carries, what the round is asked to
 * close, the work a prior attempt left, the two path lists the guard judges by,
 * and the prompt.
 *
 * The stop it can return instead is the guard on a remediation round with
 * nothing to close, which is a run the loop ends rather than an executor it
 * briefs.
 */
export async function briefRound(args: {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  ledger: Ledger;
  state: RoundState;
  /** The commit the loop made of the ticket's spec, where it made one (D-103). */
  specCommit: string | null;
  /** The prior attempt this run was asked to resume, where it was. */
  resumeSource: ResumeSource | null;
  /** The product principles the person has recorded (D-065 option 3). */
  principles: string | null;
  maxRounds: number;
  /** The attempt this one continues, as the ledger names it. */
  previous: ExecutionAttempt | undefined;
  /** The account the previous run's last attempt wrote, for a run opened on open findings. */
  previousRunAccount: string | null;
  progress: (message: string) => void;
}): Promise<{ brief: Brief } | Stop> {
  const { config, contract, ledger, state, progress } = args;
  // Read before the executor runs, so a commit the executor makes itself is
  // this attempt's rather than one it inherited. The spec commit is left
  // out: the loop made it before any executor ran, and the change set the
  // review reads does not contain it (D-103).
  const inherited = (
    await commitsSince({ worktree: state.workspace.path, base_commit: state.baseCommit })
  ).filter((sha) => sha !== args.specCommit);
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
    return {
      next: "stop",
      end: { outcome: "escalated", detail: "no routed finding remains for the executor" },
    };
  }

  // SCP-154: the prior attempt's work goes into the worktree before the
  // executor is invoked, at round 0 and only there — by round 1 it is
  // sealed, checked and reviewed like any other part of the change set. A
  // branch that already holds the commit that attempt sealed is given
  // nothing: the work is there, and a later commit that undid part of it
  // stays undone.
  //
  // SCP-172: the further attempt a transport failure or a ceiling buys runs in
  // the round's own worktree, where the work already is — sealed onto the
  // branch, in fact, by the attempt before it — so the diff is applied once
  // per round rather than once per attempt. The further attempt is still a
  // resumed one and records the round's outcome, dropped diff included; only
  // the application is skipped, and its brief says the work is committed.
  //
  // A diff that does not apply leaves the worktree at the commit it was on and
  // the round going on from there: the executor is briefed as a fresh one,
  // because nothing of the prior attempt's diff is in front of it.
  const resumedHere =
    state.kind === "execute" && state.round === state.executeRound ? args.resumeSource : null;
  let resumeOutcome = resumedHere === null ? null : state.resumeOutcome;
  let committedAt: string | null = null;
  if (resumedHere !== null) {
    if (state.transportRetry === 0 && state.ceilingContinuation === 0) {
      resumeOutcome = await applyRetainedDiff({
        worktree: state.workspace.path,
        source: resumedHere,
      });
      progress(
        resumeOutcome.state === "dropped"
          ? `${resumeNote(resumedHere, resumeOutcome)} — git apply said: ${resumeOutcome.reason}`
          : resumeNote(resumedHere, resumeOutcome),
      );
      if (resumeOutcome.state === "held") committedAt = resumeOutcome.at;
    } else if (resumeOutcome?.state === "held") {
      committedAt = resumeOutcome.at;
    } else if (resumeOutcome?.state === "applied") {
      committedAt = await git.head(state.workspace.path, { timeoutMs: 120_000 });
    }
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

  const basePrompt = executorBrief();
  function executorBrief(): string {
    if (state.kind === "resolve_conflict") {
      return conflictPrompt({
        base_ref: config.base_ref,
        base_commit: state.conflict!.tip,
        paths: state.conflict!.paths,
        merged: config.relevel_context,
      });
    }
    if (state.kind === "execute") {
      return executorPrompt(contract, {
        principles: args.principles,
        resumed:
          resumedHere !== null && resumeOutcome !== null && resumeOutcome.state !== "dropped"
            ? {
                attempt_id: resumedHere.attempt_id,
                bundle_id: resumedHere.bundle_id,
                termination: resumedHere.termination,
                committed_at: committedAt,
              }
            : null,
      });
    }
    return remediationPrompt({
      contract,
      findings: toClose,
      round: state.remediationRound,
      max_rounds: args.maxRounds,
      principles: args.principles,
      // D-092: the predecessor's own account of its change. Inside
      // one run that is the last attempt this run recorded; opening
      // a run on findings left open, it is the last attempt on the
      // ticket's record. It reaches the executor's next round and
      // nothing else — the reviewer's inputs are unchanged.
      previous_account:
        args.previous !== undefined ? args.previous.executor_account : args.previousRunAccount,
      // D-NEW-a-person-s-answer-closes-a-routed-finding: a person's words for
      // the findings they handed to this round, as data beside them.
      directions: state.directions.filter((direction) =>
        toClose.some((finding) => finding.key === direction.finding_key),
      ),
      // SCP-194: a scope finding is answered by quoting what the
      // contract admits, and the brief says it in the same words the
      // guard refuses in (SCP-195's sentence).
      paths_allowed: pathsAllowed,
    });
  }

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
    principles: args.principles,
    // What the pinned set measured on the round before this one, per node
    // where the plan has a graph (D-107). Empty on a run's first round,
    // which nothing has measured yet, and on a round whose predecessor was
    // cut before its checks ran.
    checks: ledger.rounds[ledger.rounds.length - 1]?.checks ?? [],
    open_findings: [...toClose],
  };

  progress(roundLine());

  /** What the person is told the round is about to do. */
  function roundLine(): string {
    if (state.kind === "resolve_conflict") {
      return `resolving the base conflict on ${state.conflict!.paths.length} file(s)`;
    }
    if (state.kind === "execute") return "executing";
    return `remediation round ${state.remediationRound} of at most ${args.maxRounds}`;
  }

  return {
    brief: {
      inherited,
      prior_commits,
      toClose,
      resumedHere,
      resumeOutcome,
      pathsAllowed,
      pathsProhibited,
      prompt,
      executorSkills,
      briefRecords,
    },
  };
}
