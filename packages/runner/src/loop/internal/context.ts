import { runAgent } from "../../adapter.js";
import { runCodexAgent } from "../../codex/index.js";
import { runPinnedChecks } from "../../checks/index.js";
import { createPullRequest, existingPullRequest, pushAttemptBranch } from "../../delivery.js";
import { mergeLoopPullRequest } from "../../merge.js";
import { runReview, verifyClosures } from "@perbo/review";
import type { CredentialClass } from "@perbo/contracts";
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
