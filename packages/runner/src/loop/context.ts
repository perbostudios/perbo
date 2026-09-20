import { runAgent } from "../adapter.js";
import { runCodexAgent } from "../adapter-codex.js";
import { runPinnedChecks } from "../checks.js";
import { createPullRequest, existingPullRequest, pushAttemptBranch } from "../delivery.js";
import { mergeLoopPullRequest } from "../merge.js";
import { runReview, verifyClosures } from "@perbo/review";
import type { TicketRunConfig } from "./config.js";

/**
 * Everything a run reaches the world through.
 *
 * One port per call that spends money, starts a process or talks to GitHub, so
 * a phase can be driven without any of them. A test replaces the ones its
 * question needs and the loop's own behaviour either side of them is the same
 * call it makes in anger.
 */
export interface LoopPorts {
  agent: typeof runAgent;
  review: typeof runReview;
  verify: typeof verifyClosures;
  checks: typeof runPinnedChecks;
  /**
   * The two calls that reach GitHub. A test drives the merge-up before the
   * pull request without a remote to push to or a `gh` to answer; the loop's
   * own behaviour either side of them is the same call it makes in anger.
   */
  push: typeof pushAttemptBranch;
  open: typeof createPullRequest;
  /**
   * SCP-202's post-approval merge step. A test drives the loop's own call to
   * it — where it happens, and what the run records of the answer — without
   * a `gh` to answer the six conditions; the conditions themselves are
   * proven against a fake `gh` in the CLI's own suite.
   */
  merge: typeof mergeLoopPullRequest;
  /** SCP-227: the open pull request a re-level pushes to, read rather than opened. */
  existing: typeof existingPullRequest;
}

/**
 * The ports a run uses: whatever the caller injected, and the real call
 * otherwise. Which executor answers is the configuration's, never a hook's
 * absence.
 */
export function resolvePorts(
  config: TicketRunConfig,
  hooks: Partial<LoopPorts> | undefined,
): LoopPorts {
  return {
    agent: hooks?.agent ?? (config.agent_provider === "codex-cli" ? runCodexAgent : runAgent),
    review: hooks?.review ?? runReview,
    verify: hooks?.verify ?? verifyClosures,
    checks: hooks?.checks ?? runPinnedChecks,
    push: hooks?.push ?? pushAttemptBranch,
    open: hooks?.open ?? createPullRequest,
    merge: hooks?.merge ?? mergeLoopPullRequest,
    existing: hooks?.existing ?? existingPullRequest,
  };
}
