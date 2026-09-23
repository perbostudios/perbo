/** One checkout registered against a repository. */
export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** The branch it holds, without `refs/heads/`, or null when it is detached. */
  branch: string | null;
  detached: boolean;
}

/**
 * The records of `git worktree list --porcelain`: one attribute a line, a
 * blank line between worktrees. The line-based form rather than `-z`, which
 * git accepts only from 2.36 and which a distribution's git may not have; the
 * cost is that a worktree whose path carries a line break is read as two, and
 * that is a path git itself warns against.
 */
export function parseWorktrees(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const attribute of stdout.split("\n")) {
    if (attribute.length === 0) {
      if (current !== null) entries.push(current);
      current = null;
      continue;
    }
    if (attribute.startsWith("worktree ")) {
      if (current !== null) entries.push(current);
      current = { path: attribute.slice("worktree ".length), head: null, branch: null, detached: false };
      continue;
    }
    if (current === null) continue;
    if (attribute.startsWith("HEAD ")) current.head = attribute.slice("HEAD ".length);
    else if (attribute.startsWith("branch ")) {
      current.branch = attribute.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (attribute === "detached") current.detached = true;
  }
  if (current !== null) entries.push(current);
  return entries;
}
