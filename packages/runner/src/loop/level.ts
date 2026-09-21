import { mergeUp, type MergeUpResult } from "../merge-up.js";
import { judgeRelevel, type RelevelContext } from "./relevel.js";
import type { RoundState, Step } from "./state.js";

/**
 * Keeping the attempt's branch level with the base branch (SCP-192).
 */

/**
 * A merge-up that stopped without naming an unmerged path (SCP-192).
 *
 * `git merge` reports a conflict and a refusal the same way — a non-zero exit —
 * and only the first has files a round could reconcile. The second is an
 * untracked file in the way, a signing key the process cannot reach, a
 * repository state the runner put it in: nobody's round to spend, so the stop
 * quotes what git said rather than handing an executor an empty list.
 */
export function mergeFailedDetail(base_ref: string, tip: string, branch: string, said: string): string {
  return (
    `merging ${base_ref} at ${tip} into ${branch} failed and git named no conflicting file, ` +
    `so it is not a conflict a round can resolve: ${said || "no output"}`
  );
}

/** What a round holds of the base branch: where it is, and what it merged. */
export interface Levelled {
  state: RoundState;
  /** The base tip this attempt's own branch was merged with, if any. */
  mergedBase: string | null;
  /** Set where the level answered the round; null where the round goes on. */
  step: Step | null;
}

/**
 * Take a merge-up's answer: the base moves where the branch now carries it,
 * and the round records the tip it merged.
 */
export function takeMergeUp(input: {
  state: RoundState;
  mergedBase: string | null;
  up: MergeUpResult;
  baseRef: string;
  progress: (message: string) => void;
}): { state: RoundState; mergedBase: string | null } {
  const { state, up } = input;
  if (up.status === "conflict" || up.base_commit === state.baseCommit) {
    return { state, mergedBase: input.mergedBase };
  }
  input.progress(
    `merged ${input.baseRef} at ${up.base_commit.slice(0, 12)} into ` +
      `${state.workspace.branch}; the change set is the branch against it`,
  );
  return { state: { ...state, baseCommit: up.base_commit }, mergedBase: up.base_commit };
}

/**
 * SCP-192: the merge-up before the executor, on this run's first round and only
 * there.
 *
 * A re-run's branch carries commits an earlier run sealed against a base that
 * has since moved, and an executor handed that tree rebuilds what the base
 * already has. Later rounds start from the previous round's merge-up, and a
 * conflict round starts from a branch that is deliberately not merged.
 *
 * SCP-227: a re-level run stops here. Nothing it does needs an executor — what
 * the branch holds is what a review already judged plus the base's own commits
 * — so a branch already level is `level` and a merged one is judged and the
 * verdict stands.
 */
export async function levelBeforeExecutor(
  context: RelevelContext & {
    state: RoundState;
    /** This run's attempts so far: the merge-up is the first round's. */
    attemptsSoFar: number;
    attemptId: string;
    /** The attempt a re-level's merge commit belongs to, where the record names one. */
    continuesPreviousRun: string | null;
  },
): Promise<Levelled> {
  const { config, progress, attemptId } = context;
  let state = context.state;
  if (
    context.attemptsSoFar > 0 ||
    state.transportRetry > 0 ||
    state.ceilingContinuation > 0 ||
    state.kind === "resolve_conflict"
  ) {
    return { state, mergedBase: null, step: null };
  }
  const baseBefore = state.baseCommit;
  const up = await mergeUp({
    worktree: state.workspace.path,
    repository_root: config.repository_root,
    base_ref: config.base_ref,
    base_commit: state.baseCommit,
    ticket_key: config.ticket_key,
    // A re-level's merge commit belongs to the attempt chain already on
    // the branch: this run may record no attempt of its own.
    attempt_id: config.relevel ? (context.continuesPreviousRun ?? attemptId) : attemptId,
  });
  if (up.status === "conflict") {
    // A merge that stopped without naming an unmerged path did not stop
    // on a conflict — an untracked file in the way, a signing key the
    // process cannot reach — and there is nothing for a round to resolve.
    if (up.paths.length === 0) {
      return {
        state,
        mergedBase: null,
        step: {
          next: "stop",
          end: {
            outcome: "base_conflict",
            detail: mergeFailedDetail(config.base_ref, up.tip, state.workspace.branch, up.detail),
          },
        },
      };
    }
    // Nothing this run produced is at stake yet, and the round is spent
    // on the resolution: the ticket's own brief follows it.
    progress(
      `${config.base_ref} conflicts with the branch on ${up.paths.length} file(s); ` +
        "the round resolves that first",
    );
    return {
      state,
      mergedBase: null,
      step: {
        next: "reenter",
        conflict: {
          tip: up.tip,
          paths: up.paths,
          before_executor: true,
          resume_kind: state.kind,
        },
      },
    };
  }
  const taken = takeMergeUp({
    state,
    mergedBase: null,
    up,
    baseRef: config.base_ref,
    progress,
  });
  state = taken.state;
  if (!config.relevel) return { state, mergedBase: taken.mergedBase, step: null };
  if (up.status === "current") {
    return {
      state,
      mergedBase: taken.mergedBase,
      step: {
        next: "stop",
        end: {
          outcome: "level",
          detail:
            `${state.workspace.branch} is level with ${config.base_ref} at ` +
            `${state.baseCommit.slice(0, 12)}; nothing to re-level`,
        },
      },
    };
  }
  const levelled = await judgeRelevel(context, {
    branch: state.workspace.branch,
    worktree: state.workspace.path,
    base_commit: state.baseCommit,
    base_before: baseBefore,
  });
  return {
    state,
    mergedBase: taken.mergedBase,
    step: {
      next: "stop",
      end: { outcome: levelled.outcome, detail: levelled.detail },
      ...(levelled.review !== null
        ? { carry: { finalReview: levelled.review, nodeReviews: levelled.node_reviews } }
        : {}),
    },
  };
}
