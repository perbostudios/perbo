import { assertWithinLimits, type ExecutionAttempt, type PlanContractWithCriteria } from "@perbo/contracts";
import { provision } from "@perbo/workspace";
import type { TicketRunConfig } from "./config.js";
import type { Ledger } from "./ledger.js";
import { attemptIdFor, type RoundState } from "./state.js";

/**
 * Provisioning the worktree a round's attempt runs in.
 */

/** What a round has as it starts, before anything is briefed or run. */
export interface RoundEntry {
  /** The state the round runs with: a round after the first has its own worktree. */
  state: RoundState;
  attemptId: string;
  /** When the attempt started; its record and its bundles are stamped with it. */
  at: Date;
  /**
   * The attempt this one continues: the last one this run recorded, whether
   * that is the previous round's or the transport failure this one answers.
   * Read from the attempts themselves rather than from the round records,
   * which hold one entry per round and so cannot name a retried attempt.
   */
  previous: ExecutionAttempt | undefined;
}

/**
 * Start a round: check the run's ceilings, mint the attempt's id, and give the
 * round its own worktree.
 *
 * A worktree per round after the first this run runs, counted in attempts
 * rather than rounds because a run that continues a remediation starts at
 * round 1 in the worktree already provisioned for it. A retry and a ceiling
 * continuation run in the round's own worktree, where the diff is already
 * applied.
 */
export async function provisionRound(args: {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  ledger: Ledger;
  state: RoundState;
  rootAttemptId: string;
  /** The branches the ticket's record already names, so provisioning reuses them. */
  branchesOnRecord: { delivery: string | null; attempt: string | null };
  clock: () => Date;
}): Promise<RoundEntry> {
  const { config, contract, ledger, state } = args;
  // Every attempt the run starts passes the run's ceilings — the retry
  // included, so a kill switch flipped or a budget spent between the
  // failure and the retry stops it as it would stop a round.
  assertWithinLimits(config.limits, "remediation_rounds", state.remediationRound);
  const at = args.clock();
  const attemptId = attemptIdFor({
    root: args.rootAttemptId,
    round: state.round,
    transport_retry: state.transportRetry,
    ceiling_continuation: state.ceilingContinuation,
  });
  const previous = ledger.last();
  if (ledger.attempts.length === 0 || state.transportRetry > 0 || state.ceilingContinuation > 0) {
    return { state, attemptId, at, previous };
  }
  const provisioned = await provision({
    repository_root: config.repository_root,
    repository_id: contract.scope.repository_id,
    ticket_key: config.ticket_key,
    ticket_id: contract.ticket_id,
    outcome: contract.outcome,
    recorded: args.branchesOnRecord,
    base_commit: contract.base.base_commit,
    attempt_id: attemptId,
    root: config.worktree_root,
    limits: config.limits,
    continues: { root_attempt_id: args.rootAttemptId },
    now: at,
  });
  return { state: { ...state, workspace: provisioned }, attemptId, at, previous };
}
