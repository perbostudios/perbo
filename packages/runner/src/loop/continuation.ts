import {
  NodeReviewsSchema,
  ReviewArtifactSchema,
  type Finding,
  type NodeReview,
  type ReviewArtifact,
  type RunBundle,
} from "@perbo/contracts";
import { isRemediableFamily, remediableFindings } from "@perbo/review";
import type { BundleStore } from "../bundle.js";
import { sameCommit } from "../resume.js";
import { commitsSince } from "../seal.js";
import type { RoundState } from "./state.js";

/**
 * Whether a re-run continues a remediation already under way (SCP-194).
 */

/**
 * The remediation a re-run continues, or null where there is nothing to
 * continue (SCP-194).
 *
 * A ticket in `changes_requested` has a review on record and findings that
 * review left open. Re-running it used to start at round 0: a fresh independent
 * review of the same sealed commit, which returned the same verdict for the
 * same money — twice on AYO-31. What the branch is actually asking for is the
 * next remediation round, from the findings that are still open.
 *
 * Two things have to be true for that to be safe. The review has to exist, and
 * the change set it judged has to be the one on the branch — a branch that has
 * moved carries work no review has seen, and verifying closures against it
 * would grade a change nobody judged. The second is checked against the live
 * branch by the caller; this answers the first, and says which commit was last
 * judged so the caller can.
 */
export function remediationToContinue(input: {
  bundles: BundleStore;
  ticket_id: string;
}): { review: ReviewArtifact; node_reviews: NodeReview[]; findings: Finding[]; head_commit: string } | null {
  const forTicket = input.bundles.forTicket(input.ticket_id);
  const reviews = forTicket.filter(
    (bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_"),
  );
  const last = reviews[reviews.length - 1];
  if (last === undefined) return null;
  const artifact = last.artifacts.find((entry) => entry.name === "review.json");
  if (!artifact || !artifact.retained) return null;
  const body = input.bundles.readObject(artifact.sha256);
  if (body === null) return null;
  let parsed: ReturnType<typeof ReviewArtifactSchema.safeParse>;
  try {
    parsed = ReviewArtifactSchema.safeParse(JSON.parse(body));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const review = parsed.data;
  // The per-node reviews recorded beside it (D-107). Absent on a bundle
  // written before per-node review existed, or unreadable: [] either way,
  // the same default the schema gives a record that never held them.
  const node_reviews = readNodeReviews(input.bundles, last);

  /**
   * The closures the rounds after that review already verified. The last
   * verification's open set is the authoritative one — each round narrows it —
   * and the commit it judged is the one the branch should still be at.
   */
  const verifications = forTicket.filter(
    (bundle) =>
      bundle.kind === "review" &&
      bundle.subject_id.startsWith("cv_") &&
      bundle.created_at >= last.created_at,
  );
  const lastVerification = verifications[verifications.length - 1];
  const openKeys =
    lastVerification === undefined
      ? null
      : new Set(
          String(lastVerification.inputs["findings_open"] ?? "")
            .split(",")
            .filter((key) => key.length > 0),
        );
  // A verification bundle written before this ticket recorded its open set
  // cannot say what is still open, and guessing would hand the executor
  // findings it already closed.
  if (openKeys !== null && lastVerification!.inputs["findings_open"] === undefined) return null;

  const head =
    lastVerification === undefined
      ? review.target.head_commit
      : (lastVerification.inputs["head_commit"] ?? null);
  if (typeof head !== "string" || head.length === 0) return null;

  const findings = remediableFindings(review.findings)
    .filter((finding) => isRemediableFamily(finding.rule_id))
    .filter((finding) => openKeys === null || openKeys.has(finding.key));
  if (findings.length === 0) return null;
  return { review, node_reviews, findings, head_commit: head };
}

/** A review bundle's per-node reviews (D-107), `[]` where the bundle holds none. */
export function readNodeReviews(bundles: BundleStore, bundle: RunBundle): NodeReview[] {
  const artifact = bundle.artifacts.find((entry) => entry.name === "node-reviews.json");
  if (!artifact || !artifact.retained) return [];
  const body = bundles.readObject(artifact.sha256);
  if (body === null) return [];
  try {
    const parsed = NodeReviewsSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * SCP-194: is the branch still the one the last review judged?
 *
 * Asked of the branch rather than of the record, and before the merge-up, so
 * what is compared is the work on the branch and not the base moving under it.
 * A branch that has moved carries commits no review has seen, and a
 * verification against it would grade a change nobody judged — so the run
 * drops back to a fresh review of what is there.
 *
 * Asked before the attempt id is minted, because the answer decides the round
 * this attempt is in. Answered once per run: the state it returns carries no
 * continuation.
 */
export async function confirmContinuation(
  state: RoundState,
  progress: (message: string) => void,
): Promise<RoundState> {
  if (state.continuing === null) return state;
  const onBranch = await commitsSince({
    worktree: state.workspace.path,
    base_commit: state.baseCommit,
  });
  const head = onBranch[onBranch.length - 1] ?? null;
  if (head !== null && sameCommit(head, state.continuing.head_commit)) {
    return { ...state, continuing: null };
  }
  progress(
    `the branch is at ${head ?? "its base"} and the last review judged ` +
      `${state.continuing.head_commit}: it has moved, so this run reviews it afresh rather ` +
      "than verifying closures against a change set nobody judged",
  );
  return {
    ...state,
    kind: "execute",
    round: 0,
    remediationRound: 0,
    openFindings: [],
    finalReview: null,
    nodeReviews: [],
    continuing: null,
  };
}
