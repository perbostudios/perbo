import {
  admittedWriteGlobs,
  matchesAny,
  planNodes,
  wholeChangeChecks,
  type NodeReview,
  type PermissionProfile,
  type PlanContractWithCriteria,
  type ReviewArtifact,
  type SecretIndex,
} from "@perbo/contracts";
import { git, type MaterializedWorkspace } from "@perbo/workspace";
import { reviewGraph } from "@perbo/review";
import type { BundleStore } from "../bundle.js";
import type { PinnedCheck } from "../checks.js";
import { buildAgentEnvironment } from "../profile.js";
import { describeRange } from "../seal.js";
import type { TicketRunConfig } from "./config.js";
import type { LoopPorts } from "./context.js";
import {
  contractWithCriteria,
  flakyCheckFindings,
  reviewerModel,
  writeReviewBundle,
} from "./review.js";
import type { RunOutcome } from "./state.js";

/**
 * SCP-227: a re-level, which judges a branch the base has moved under without
 * an executor running.
 */

/** Everything the judgement of a clean re-level reads. */
export interface RelevelContext {
  config: TicketRunConfig;
  contract: PlanContractWithCriteria;
  bundles: BundleStore;
  materialized: MaterializedWorkspace;
  profile: PermissionProfile;
  secrets: SecretIndex;
  /** The spec paths the seal leaves out (D-103), as the run resolved them. */
  sealExclusions: { spec_paths?: string[] };
  /** Whether the workspace's verify command measured the base at all. */
  verifyMeasures: boolean;
  ports: Pick<LoopPorts, "checks" | "review">;
  clock: () => Date;
  progress: (message: string) => void;
}

/** What the re-level came to, and the review that decided it where one ran. */
export interface RelevelJudgement {
  outcome: RunOutcome;
  detail: string;
  review: ReviewArtifact | null;
  node_reviews: NodeReview[];
}

/**
 * SCP-227: the judgement of a clean re-level, where no executor ran.
 *
 * What the branch holds is what a review already judged plus the base's own
 * commits. The pinned checks run on the result; where the base brought in
 * nothing inside the contract's scope that is the whole judgement and the
 * earlier review carries, and where it did the merged change set is
 * reviewed afresh — what a person would do — and that verdict stands. No
 * remediation follows a verdict here: the executor wrote nothing in this
 * run, and a change the base has made unjudgeable is a person's.
 */
export async function judgeRelevel(
  context: RelevelContext,
  input: {
    branch: string;
    worktree: string;
    /** The base the branch is now merged with. */
    base_commit: string;
    /** The base it was measured against before the merge. */
    base_before: string;
  },
): Promise<RelevelJudgement> {
  const {
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
  } = context;
  const merged =
    `merged ${config.base_ref} at ${input.base_commit.slice(0, 12)} into ${input.branch}`;
  // What the base brought in, read in the repository where both commits are,
  // against the contract's own globs rather than the wider write guard.
  const moved = await git.changedPaths(
    config.repository_root,
    input.base_before,
    input.base_commit,
    { timeoutMs: 120_000 },
  );
  const touched =
    moved === null
      ? null
      : moved
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && matchesAny(line, contract.scope.paths_allowed));
  const pathsAllowed = admittedWriteGlobs(contract.scope);
  const judging = {
    pinned_checks: config.checks.map((check) => check.definition_path ?? "").filter(Boolean),
    protected_tests: config.protected_tests,
    protected_paths: config.protected_paths,
  };
  const sealed = await describeRange({
    worktree: input.worktree,
    base_commit: input.base_commit,
    judging,
    paths_allowed: pathsAllowed,
    ...sealExclusions,
  });
  const environment = buildAgentEnvironment({
    base: process.env,
    profile,
    worktree: input.worktree,
    ports: materialized.ports,
    database_schema: materialized.database_schema,
  });
  const checks =
    sealed.changeset === null
      ? []
      : await ports.checks({
          checks: config.checks as PinnedCheck[],
          worktree: input.worktree,
          env: environment.env,
          secrets,
          onProgress: progress,
          nodes: planNodes(contract),
          changed_files: sealed.changed_paths,
        });
  // D-107: a node's results are evidence for that node's review and gate
  // nothing. What decides the re-level is the whole-change result, which is
  // the whole of what a flat plan measures.
  const gating = wholeChangeChecks(checks);
  const red = gating.filter((check) => check.status === "failed" || check.status === "errored");
  if (red.length > 0) {
    return {
      outcome: "changes_requested",
      detail:
        `${merged}, and the pinned checks fail on the result: ` +
        `${red.map((check) => `${check.check_id} ${check.status}`).join(", ")}; a person decides`,
      review: null,
      node_reviews: [],
    };
  }
  if (touched !== null && touched.length === 0) {
    return {
      outcome: "relevelled",
      detail:
        `${merged}: the checks pass and the base brought in nothing inside the contract's scope, ` +
        "so the review that approved this change set carries",
      review: null,
      node_reviews: [],
    };
  }
  progress(
    touched === null
      ? "git could not list what the base brought in; reviewing the merged change set afresh"
      : `the base brought in ${touched.length} path(s) inside the contract's scope ` +
          `(${touched.slice(0, 5).join(", ")}); reviewing the merged change set afresh`,
  );
  const graphOutcome = await reviewGraph(
    {
      contract,
      diff: sealed.diff,
      changeset: sealed.changeset ?? undefined,
      checks,
      repoDir: input.worktree,
      model: reviewerModel(config, contract, gating),
      head_commit: sealed.head_commit ?? undefined,
      remediationAvailable: false,
      baseVerified:
        materialized.verify === null || !verifyMeasures ? undefined : materialized.verify.code === 0,
      onProgress: progress,
    },
    ports.review,
    { modelFor: (nodeContract, nodeChecks) => reviewerModel(config, contractWithCriteria(nodeContract, contract), nodeChecks) },
  );
  const reviewOutcome = graphOutcome.overall;
  const review: ReviewArtifact = {
    ...graphOutcome.combined,
    target: { ...graphOutcome.combined.target, prior_commits: [] },
    findings: [...graphOutcome.combined.findings, ...flakyCheckFindings(gating)],
  };
  const node_reviews: NodeReview[] = graphOutcome.nodes.map((entry) => ({
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
    node_reviews,
    // Nothing was sealed by this run, so nothing was excluded from a seal.
    sealed: { excluded_paths: [] },
    round: 0,
    remediation_available: false,
  });
  if (review.decision === "approve") {
    return {
      outcome: "relevelled",
      detail: `${merged}, and a fresh review approved the merged change set`,
      review,
      node_reviews,
    };
  }
  if (review.decision === "error") {
    return {
      outcome: "review_failed",
      detail:
        `${merged}, and the review of the result did not complete: ` +
        `${review.error?.kind ?? "unknown"} — ${review.error?.message ?? "no reason recorded"}`,
      review,
      node_reviews,
    };
  }
  return {
    outcome: review.decision === "escalate" || review.decision === "incomplete" ? "escalated" : "changes_requested",
    detail: `${merged}, and a fresh review of the merged change set decided ${review.decision}; a person decides`,
    review,
    node_reviews,
  };
}
