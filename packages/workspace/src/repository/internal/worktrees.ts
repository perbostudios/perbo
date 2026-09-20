/** One checkout registered against a repository. */
export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** The branch it holds, without `refs/heads/`, or null when it is detached. */
  branch: string | null;
  detached: boolean;
}

/**
 * `git worktree list --porcelain -z`, read.
 *
 * `-z` rather than lines: a worktree path may contain a newline, and a parser
 * that splits on one reports a repository it cannot see the shape of. Each
 * attribute is NUL-terminated and an empty attribute ends a record, so the
 * separator between two worktrees is two NULs.
 */
export function parseWorktrees(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const attribute of stdout.split("\0")) {
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
