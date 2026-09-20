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
