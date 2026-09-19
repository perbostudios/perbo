import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, run, runOrThrow } from "@perbo/workspace";

/**
 * Keeping the attempt's branch level with the base (SCP-192).
 *
 * Every hand finish of day four began the same way: a person merging the base
 * into the loop's branch before anything else could be done with it — nine
 * commits and three conflicts on one, six files on another. The loop does that
 * itself now, at three points: before the executor starts, before the review
 * reads the change set, and before the pull request opens.
 *
 * Three properties are structural here rather than hoped for.
 *
 * 1. **Nothing a model produced reaches the argv.** The base ref comes from the
 *    run configuration, the commit shas from `git rev-parse`, and the merge
 *    message from the runner's own ticket key and attempt id.
 * 2. **The base is resolved in the repository, never in the worktree.** The base
 *    branch lives in the checkout the worktree was cut from; resolving `HEAD` —
 *    the configuration's own default — inside the attempt's worktree would name
 *    the attempt's branch and merge it into itself.
 * 3. **Nothing is fetched.** The CLI already fetches; this reads the local ref
 *    and nothing else, so a run has no network surface it did not have before.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * What a merge-up did.
 *
 * `base_commit` is the same field in all three: the base the change set is to
 * be measured against afterwards. It is the caller's own base where nothing
 * moved and where the merge failed, and the base branch's tip where the branch
 * now carries it — so a caller that reads only this field is always reading the
 * base a review should judge against.
 */
export type MergeUpResult =
  /** Nothing to merge: the base did not move, or the branch already carries it. */
  | { status: "current"; base_commit: string }
  /** The base's tip is now on the branch, sealed as `merge_commit`. */
  | { status: "merged"; base_commit: string; merge_commit: string }
  /**
   * The merge stopped on conflicting paths and was aborted, so the worktree is
   * exactly as the seal left it. `paths` is what a resolution round is handed,
   * and `tip` is the base commit it has to become mergeable with.
   */
  | { status: "conflict"; base_commit: string; tip: string; paths: string[]; detail: string };

export interface MergeUpRequest {
  /** The attempt's worktree: where the merge happens. */
  worktree: string;
  /** The checkout the worktree was cut from: where `base_ref` is resolved. */
  repository_root: string;
  /** The branch the run is keeping level with, from the run configuration. */
  base_ref: string;
  /** The base the change set is currently measured against. */
  base_commit: string;
  /** For the merge commit's message. Nothing the agent wrote reaches it. */
  ticket_key: string;
  attempt_id: string;
  timeoutMs?: number;
}

/**
 * A ref that could be read as an option is not resolved at all.
 *
 * `base_ref` is a person's configuration rather than model output, so this is
 * a belt beside the braces: `git rev-parse -- <ref>` has no form that ends
 * option parsing for the ref itself, and `--end-of-options` is newer than the
 * Git this has to run on.
 */
const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;

async function git(args: string[], cwd: string, timeoutMs: number) {
  return run(["git", ...args], { cwd, env: gitEnv(), timeoutMs });
}

/** Whether `ancestor` is reachable from `descendant`. */
async function isAncestor(
  ancestor: string,
  descendant: string,
  cwd: string,
  timeoutMs: number,
): Promise<boolean> {
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], cwd, timeoutMs);
  return result.code === 0;
}

/**
 * Merge the base's current tip into the attempt's branch.
 *
 * The four answers are the whole of the contract: `current` where there is
 * nothing to do, `merged` where the branch gained the base, `conflict` where a
 * round has to resolve it, and — for a `base_ref` that names nothing in this
 * checkout, which a ticketless run pointed at somebody else's pull request has
 * — `current` with the base unchanged, because a ref that cannot be read is not
 * evidence that the branch is behind.
 */
export async function mergeUp(request: MergeUpRequest): Promise<MergeUpResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const unchanged: MergeUpResult = { status: "current", base_commit: request.base_commit };

  if (!REF_SHAPE.test(request.base_ref)) return unchanged;
  const resolved = await git(
    ["rev-parse", "--verify", "--quiet", `${request.base_ref}^{commit}`],
    request.repository_root,
    timeoutMs,
  );
  if (resolved.code !== 0) return unchanged;
  const tip = resolved.stdout.trim();
  if (tip.length === 0) return unchanged;

  // The base has to have moved **forward** from the base this change set is
  // measured against. A `base_ref` pointing at an unrelated commit, or at one
  // behind the contract's base, is not a base that moved under the run: merging
  // it would widen the change set with work the plan never named.
  if (tip === request.base_commit) return unchanged;
  if (!(await isAncestor(request.base_commit, tip, request.worktree, timeoutMs))) return unchanged;

  // Already merged up — by an earlier round, or by the executor itself. The
  // branch is level, and the base it is level with is the tip.
  if (await isAncestor(tip, "HEAD", request.worktree, timeoutMs)) {
    return { status: "current", base_commit: tip };
  }

  const message =
    `${request.ticket_key}: merge ${request.base_ref} into the attempt branch\n\n` +
    `Attempt: ${request.attempt_id}\nBase: ${tip}\n`;
  const merged = await git(["merge", "--no-edit", "-m", message, tip], request.worktree, timeoutMs);
  if (merged.code === 0) {
    const head = await runOrThrow(["git", "rev-parse", "HEAD"], {
      cwd: request.worktree,
      env: gitEnv(),
      timeoutMs,
    });
    return { status: "merged", base_commit: tip, merge_commit: head.stdout.trim() };
  }

  // Unmerged paths first, then the abort: reading them after the abort would
  // read an empty list. A merge that failed for some other reason reports no
  // path, and the detail is what says why.
  const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], request.worktree, timeoutMs);
  const paths = unmerged.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  await git(["merge", "--abort"], request.worktree, timeoutMs);
  return {
    status: "conflict",
    base_commit: request.base_commit,
    tip,
    paths,
    detail: (merged.stderr || merged.stdout).trim().split("\n").slice(0, 4).join("; ").slice(0, 400),
  };
}

/** The three markers `git merge` leaves in a file it could not resolve. */
const CONFLICT_MARKERS = ["<<<<<<< ", "=======\n", ">>>>>>> "];

/**
 * Which of `paths` still hold conflict markers.
 *
 * A resolution round that committed the markers rather than resolving them
 * leaves a branch that merges cleanly and builds nothing, and the merge itself
 * cannot tell: the conflict is resolved as far as Git is concerned. So the
 * files the round touched are read, here, before the change set is reviewed.
 *
 * Only paths that exist and decode as text are read; a binary file cannot carry
 * a marker and a deleted one has nothing to read.
 */
export function pathsWithConflictMarkers(worktree: string, paths: readonly string[]): string[] {
  const found: string[] = [];
  for (const path of paths) {
    let text: string;
    try {
      const bytes = readFileSync(join(worktree, path));
      if (bytes.includes(0)) continue;
      text = bytes.toString("utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").map((line) => `${line}\n`);
    if (CONFLICT_MARKERS.every((marker) => lines.some((line) => line.startsWith(marker)))) {
      found.push(path);
    }
  }
  return found;
}
