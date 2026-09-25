import type { PlanContractWithCriteria, SecretIndex } from "@perbo/contracts";
import type { JudgingArtifacts } from "../../prohibited.js";
import { sealChangeSet, type SealResult } from "../../seal.js";
import type { Brief } from "./brief.js";
import type { TicketRunConfig } from "./config.js";
import { levelAfterSeal } from "./level.js";
import type { RoundState } from "./state.js";

/**
 * Sealing what a round's attempt wrote, and levelling the branch on it.
 */

/** The change set a round is judged on, and how it came to be that one. */
export interface Sealed {
  state: RoundState;
  mergedBase: string | null;
  /** What everything after this reads: the branch against the base it merges into. */
  sealed: SealResult;
  /**
   * The attempt left the branch head where it found it: whatever the change
   * set contains, this attempt did not write any of it.
   */
  carriedForward: boolean;
  /** The artifacts the seal judges a path by, reused by a re-read of the range. */
  judging: JudgingArtifacts;
  /** The conflict the merge after the seal stopped on, where it did. */
  conflictNow: { tip: string; paths: string[]; detail: string } | null;
}

/**
 * Seal the round's change set and bring the branch level with its base.
 *
 * `carriedForward` is read from the seal rather than from the merged-up change
 * set, because a merge commit the loop makes is not the executor having
 * written something.
 */
export async function sealRound(args: {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  state: RoundState;
  mergedBase: string | null;
  brief: Brief;
  attemptId: string;
  /** Whether the executor finished; a cut attempt is not levelled. */
  completed: boolean;
  secrets: SecretIndex;
  sealExclusions: { spec_paths?: string[] };
  progress: (message: string) => void;
}): Promise<Sealed> {
  const { config, state, brief } = args;
  const judging: JudgingArtifacts = {
    pinned_checks: config.checks.map((check) => check.definition_path ?? "").filter(Boolean),
    protected_tests: config.protected_tests,
    protected_paths: config.protected_paths,
  };
  args.progress("sealing the change set");
  const raw = await sealChangeSet({
    worktree: state.workspace.path,
    base_commit: state.baseCommit,
    ticket_key: config.ticket_key,
    attempt_id: args.attemptId,
    outcome: args.contract.outcome,
    secrets: args.secrets,
    judging,
    exclude_paths: state.checkArtifacts,
    paths_allowed: brief.pathsAllowed,
    ...args.sealExclusions,
  });
  const carriedForward =
    raw.changeset !== null &&
    raw.head_commit === (brief.inherited[brief.inherited.length - 1] ?? null);
  const levelled = await levelAfterSeal({
    config,
    state,
    mergedBase: args.mergedBase,
    attemptId: args.attemptId,
    raw,
    completed: args.completed,
    judging,
    pathsAllowed: brief.pathsAllowed,
    sealExclusions: args.sealExclusions,
    progress: args.progress,
  });
  return {
    state: levelled.state,
    mergedBase: levelled.mergedBase,
    sealed: levelled.sealed,
    carriedForward,
    judging,
    conflictNow: levelled.conflictNow,
  };
}
