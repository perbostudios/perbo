import {
  planNodes,
  wholeChangeChecks,
  type CheckResult,
  type PlanContractWithCriteria,
  type SecretIndex,
} from "@perbo/contracts";
import type { PinnedCheck } from "../checks/index.js";
import { sweepWorktree, type SweptProcess } from "../orphans.js";
import { untrackedAfterChecks, type SealResult } from "../seal.js";
import type { TicketRunConfig } from "./config.js";
import type { LoopPorts } from "./context.js";
import type { RoundState } from "./state.js";

/**
 * The deterministic half of a round's judgement.
 */

/** What the pinned set measured, and what the round leaves behind. */
export interface Checked {
  /** The state the round goes on with: what the checks left untracked is next round's exclusion. */
  state: RoundState;
  /** Every result: the whole change, and one per node of a graphed plan (D-107). */
  checks: CheckResult[];
  /** What judges the whole change this round; see `checkRound`. */
  gating: CheckResult[];
  swept: SweptProcess[];
}

/**
 * Run the pinned checks on the round's change set and close the attempt's
 * worktree down.
 *
 * D-107: the pinned set runs over the whole change and then once per node of
 * the execution graph, narrowed to that node's paths. A flat plan has no nodes
 * and runs exactly what it ran before. The node results are recorded with the
 * round and reach that node's own review (`reviewGraph`), never `gating`,
 * which is what the overall review, the closure verification and the
 * reviewer's own check schema are given — exactly the list a flat plan
 * produces, since a flat plan tags none. A node's own check result gates
 * nothing on its own; the review it feeds can, once the gate reads the
 * combination.
 *
 * SCP-263: the attempt is over, so nothing may still be running from its
 * worktree. The executor and every check run in process groups the runner
 * signals, and a process that put itself in a session of its own is in none of
 * them. Swept here rather than at cleanup so the round that produced it is the
 * round that records it, and so the next round starts in a worktree with
 * nothing of the last one's left in it.
 */
export async function checkRound(args: {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  state: RoundState;
  sealed: SealResult;
  /** The environment the executor ran in; the checks run in the same one. */
  env: NodeJS.ProcessEnv;
  secrets: SecretIndex;
  checks: LoopPorts["checks"];
  progress: (message: string) => void;
}): Promise<Checked> {
  const { config, state, sealed, progress } = args;
  const checks =
    sealed.changeset === null
      ? []
      : await args.checks({
          checks: config.checks as PinnedCheck[],
          worktree: state.workspace.path,
          env: args.env,
          secrets: args.secrets,
          onProgress: progress,
          nodes: planNodes(args.contract),
          changed_files: sealed.changed_paths,
        });
  const gating = wholeChangeChecks(checks);
  const after =
    sealed.changeset === null
      ? state
      : { ...state, checkArtifacts: await untrackedAfterChecks({ worktree: state.workspace.path }) };
  const swept = await sweepWorktree({
    worktree: state.workspace.path,
    onProgress: progress,
  });
  return { state: after, checks, gating, swept };
}
