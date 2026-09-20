import { describe, expect, it } from "vitest";
import { parseWorktrees } from "./worktrees.js";

const record = (...attributes: string[]) => `${attributes.join("\0")}\0\0`;

describe("reading the registered worktrees", () => {
  it("reads a branch, a detached head and a path with a space", () => {
    const stdout =
      record("worktree /r/main", "HEAD abc123", "branch refs/heads/main") +
      record("worktree /r/a space", "HEAD def456", "branch refs/heads/prb/scp016/slug") +
      record("worktree /r/det", "HEAD abc123", "detached");

    expect(parseWorktrees(stdout)).toEqual([
      { path: "/r/main", head: "abc123", branch: "main", detached: false },
      { path: "/r/a space", head: "def456", branch: "prb/scp016/slug", detached: false },
      { path: "/r/det", head: "abc123", branch: null, detached: true },
    ]);
  });

  it("keeps a path that contains a newline whole", () => {
    // The reason for `-z`: a line-based reader reports two worktrees here, one
    // of them at a path that does not exist.
    const stdout = record("worktree /r/two\nlines", "HEAD abc123", "detached");
    expect(parseWorktrees(stdout)).toEqual([
      { path: "/r/two\nlines", head: "abc123", branch: null, detached: true },
    ]);
  });

  it("carries the attributes it does not model without losing the record", () => {
    const stdout = record("worktree /r/locked", "HEAD abc123", "branch refs/heads/main", "locked reason here");
    expect(parseWorktrees(stdout)).toEqual([
      { path: "/r/locked", head: "abc123", branch: "main", detached: false },
    ]);
  });

  it("reads an empty listing as no worktrees", () => {
    expect(parseWorktrees("")).toEqual([]);
  });
});
