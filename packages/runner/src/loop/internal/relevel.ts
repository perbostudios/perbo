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
import { cleanup, git, type MaterializedWorkspace, type Workspace } from "@perbo/workspace";
import { reviewGraph } from "@perbo/review";
import type { BundleStore } from "../../bundle.js";
import type { PinnedCheck } from "../../checks/index.js";
import { sweepWorktree } from "./orphans.js";
import { buildAgentEnvironment } from "../../profile.js";
import { RunRefusedError } from "../../refusal.js";
import { describeRange } from "../../seal.js";
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

/**
 * What the log of a branch's own line past the pushed tip may say.
 *
 * The commits it names are what a re-level decides on: every one of them is
 * either the loop's own or a person's, and a listing held from its end has
 * lost its oldest — the ones a reset would drop. Past this nothing is read.
 */
const MAX_BRANCH_LOG_BYTES = 64 * 1024 * 1024;

/**
 * SCP-227: a re-level judges what the pull request has.
 *
 * A re-level that pushed nothing left its merge commit — and any resolution no
 * review approved — on the local branch, and starting from there would call a
 * branch level that the pull request still shows behind. So the worktree is put
 * back to the pushed ref where one exists and everything the local branch
 * carries past it is the loop's own: a commit whose `Attempt:` trailer names an
 * attempt on the record (every seal and every merge of the base carries one),
 * or a head the record sealed. The trailer is trusted as written: a commit a
 * person gave the loop's trailer is treated as the loop's. A commit a person
 * made on the branch and has not pushed is theirs, not the loop's to drop or to
 * publish, and a branch that diverged from its pull request is not one a merge
 * of the base levels: both are refused with what the branch carries named, for
 * a person to reconcile.
 */
export async function resetToPullRequest(args: {
  config: TicketRunConfig;
  workspace: Workspace;
  /** Whether the record already names the attempt a commit's trailer cites. */
  onRecord: ReadonlySet<string>;
  /** The attempt that sealed a commit, where this run's ledger knows of one. */
  sealedBy: (sha: string) => string | null;
  progress: (message: string) => void;
}): Promise<void> {
  const { config, workspace, progress } = args;
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
        args.sealedBy(commit.sha) !== null || commit.attempts.some((attempt) => args.onRecord.has(attempt));
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
