import { createGit, type Git } from "@perbo/workspace";
import { childEnvironment, type runProcess } from "../process.js";
import { desktopGitProcess } from "./git-process.js";

/** Every read this host makes of a checkout runs here, as a fixed binary and argv. */
export type Execute = typeof runProcess;

/**
 * Git, as this host reaches it: through the runner it was handed, in the
 * environment `childEnvironment` builds, so a copy opened from Finder finds
 * the `git` a shell would.
 */
const repository = (execute: Execute): Git =>
  createGit({ process: desktopGitProcess(execute), environment: childEnvironment });

/**
 * What a status listing may say. It is an answer this host reads rather than a
 * command it merely runs, and a checkout with thousands of uncommitted files
 * writes a long one.
 */
const STATUS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** The repository's tracked files, from Git in the registered repository and never from a path a renderer sent. */
export function trackedFiles(execute: Execute, root: string): Promise<string[]> {
  return repository(execute).trackedFiles(root);
}

/** What the checkout is on now: its commit, the branch that points at it, and whether anything is uncommitted. */
export async function repositoryStatus(
  execute: Execute,
  root: string,
): Promise<{ head: string; branch: string; dirty: boolean }> {
  const git = repository(execute);
  const result = await git.runOrThrow(
    root,
    ["--no-optional-locks", "status", "--porcelain=v1", "--branch"],
    { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES },
  );
  const status = result.stdout.trimEnd().split("\n");
  const head = await git.head(root);
  if (head === null) throw new Error("This checkout has no commit yet.");
  return {
    head,
    branch: (status[0] ?? "").replace(/^## /, "").split("...")[0] ?? "detached",
    dirty: status.length > 1,
  };
}

/** The root of the checkout a path sits in, which is the only folder this host registers. */
export function topLevel(execute: Execute, path: string): Promise<string> {
  return repository(execute).topLevel(path);
}

/** Where a branch is checked out, or null where no worktree holds it. */
export async function worktreeForBranch(
  execute: Execute,
  root: string,
  ref: string,
): Promise<string | null> {
  const branch = ref.replace(/^refs\/heads\//, "");
  const worktrees = await repository(execute).worktrees(root);
  return worktrees.find((worktree) => worktree.branch === branch)?.path ?? null;
}
