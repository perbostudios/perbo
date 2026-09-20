import { requireSuccess } from "../process.js";
import type { runProcess } from "../process.js";

/** Every read this host makes of a checkout runs here, as a fixed binary and argv. */
export type Execute = typeof runProcess;

/** The repository's tracked files, from Git in the registered repository and never from a path a renderer sent. */
export async function trackedFiles(execute: Execute, root: string): Promise<string[]> {
  const result = await execute("git", ["--no-optional-locks", "ls-files", "-z"], {
    cwd: root,
  });
  return requireSuccess(result).split("\0").filter((entry) => entry.length > 0);
}

/** What the checkout is on now: its commit, the branch that points at it, and whether anything is uncommitted. */
export async function repositoryStatus(
  execute: Execute,
  root: string,
): Promise<{ head: string; branch: string; dirty: boolean }> {
  const result = await execute(
    "git",
    ["--no-optional-locks", "status", "--porcelain=v1", "--branch"],
    { cwd: root },
  );
  const status = requireSuccess(result).trimEnd().split("\n");
  const head = requireSuccess(
    await execute("git", ["rev-parse", "HEAD"], { cwd: root }),
  ).trim();
  return {
    head,
    branch: (status[0] ?? "").replace(/^## /, "").split("...")[0] ?? "detached",
    dirty: status.length > 1,
  };
}

/** The root of the checkout a path sits in, which is the only folder this host registers. */
export async function topLevel(execute: Execute, path: string): Promise<string> {
  return requireSuccess(
    await execute("git", ["rev-parse", "--show-toplevel"], { cwd: path }),
  ).trim();
}

/**
 * Where a branch is checked out, or null where no worktree holds it.
 *
 * Read from the `-z` listing rather than the line-separated one: a worktree
 * path may hold a newline, and a listing split on newlines would report the
 * wrong folder for it.
 */
export function parseWorktreeList(porcelainZ: string, ref: string): string | null {
  const entry = porcelainZ
    .split("\0\0")
    .find((record) => record.split("\0").includes("branch " + ref));
  const path = entry
    ?.split("\0")
    .find((field) => field.startsWith("worktree "))
    ?.slice(9);
  return path ?? null;
}

export async function worktreeForBranch(
  execute: Execute,
  root: string,
  ref: string,
): Promise<string | null> {
  const listed = requireSuccess(
    await execute("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root }),
  );
  return parseWorktreeList(listed, ref);
}
