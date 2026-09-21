import { describe, expect, it } from "vitest";
import { repositoryStatus, topLevel, trackedFiles, worktreeForBranch, type Execute } from "./git.js";
import type { ProcessResult } from "../process.js";

const ok = (stdout: string): ProcessResult => ({
  code: 0,
  stdout,
  stderr: "",
  cancelled: false,
});
/** Answers each argv with the output Git would write, and records what it was asked. */
function fakeGit(answers: Record<string, ProcessResult>): {
  execute: Execute;
  calls: { binary: string; args: readonly string[]; cwd: string | undefined }[];
} {
  const calls: { binary: string; args: readonly string[]; cwd: string | undefined }[] = [];
  const execute: Execute = (binary, args, options) => {
    calls.push({ binary, args, cwd: options.cwd });
    const answer = answers[args.join(" ")];
    if (!answer) throw new Error(`no answer for ${args.join(" ")}`);
    return Promise.resolve(answer);
  };
  return { execute, calls };
}

const record = (...fields: string[]): string => fields.join("\0");

describe("the worktree holding a branch", () => {
  const listing = (listed: string): Record<string, ProcessResult> => ({
    "worktree list --porcelain -z": ok(listed),
  });

  it("finds the worktree holding a branch, across records", async () => {
    const { execute } = fakeGit(
      listing(
        [
          record("worktree /checkout", "HEAD abc", "branch refs/heads/main", ""),
          record("worktree /work/PRB-1", "HEAD def", "branch refs/heads/prb-1", ""),
        ].join("\0"),
      ),
    );
    expect(await worktreeForBranch(execute, "/checkout", "refs/heads/prb-1")).toBe("/work/PRB-1");
  });

  it("matches a branch whole, so a longer name is not its worktree", async () => {
    const listed = record("worktree /work/ab", "branch refs/heads/ab", "") + "\0";
    expect(await worktreeForBranch(fakeGit(listing(listed)).execute, "/checkout", "refs/heads/a")).toBeNull();
    expect(await worktreeForBranch(fakeGit(listing(listed)).execute, "/checkout", "refs/heads/ab")).toBe(
      "/work/ab",
    );
  });

  it("keeps a path that holds a newline, which a line-separated listing would split", async () => {
    const listed = record("worktree /work/two\nlines", "branch refs/heads/prb-1", "") + "\0";
    expect(await worktreeForBranch(fakeGit(listing(listed)).execute, "/checkout", "refs/heads/prb-1")).toBe(
      "/work/two\nlines",
    );
  });

  it("answers nothing for a detached record, and for a branch nothing holds", async () => {
    const listed = [
      record("worktree /checkout", "HEAD abc", "detached", ""),
      record("worktree /other", "HEAD def", "branch refs/heads/other", ""),
    ].join("\0");
    expect(await worktreeForBranch(fakeGit(listing(listed)).execute, "/checkout", "refs/heads/prb-1")).toBeNull();
    expect(await worktreeForBranch(fakeGit(listing("")).execute, "/checkout", "refs/heads/prb-1")).toBeNull();
  });

  it("answers nothing for a record that names a branch but no worktree", async () => {
    const listed = record("branch refs/heads/prb-1", "") + "\0";
    expect(await worktreeForBranch(fakeGit(listing(listed)).execute, "/checkout", "refs/heads/prb-1")).toBeNull();
  });
});

describe("reading a checkout", () => {
  it("lists the tracked files, and drops the listing's trailing empty entry", async () => {
    const { execute, calls } = fakeGit({
      "--no-optional-locks ls-files -z": ok("README.md\0src/main.ts\0"),
    });
    expect(await trackedFiles(execute, "/checkout")).toEqual(["README.md", "src/main.ts"]);
    expect(calls[0]).toEqual({
      binary: "git",
      args: ["--no-optional-locks", "ls-files", "-z"],
      cwd: "/checkout",
    });
  });

  it("reads the branch, the commit and whether anything is uncommitted", async () => {
    const { execute } = fakeGit({
      "--no-optional-locks status --porcelain=v1 --branch": ok("## main...origin/main\n M src/main.ts\n"),
      "rev-parse HEAD": ok("abc123\n"),
    });
    expect(await repositoryStatus(execute, "/checkout")).toEqual({
      head: "abc123",
      branch: "main",
      dirty: true,
    });
  });

  it("calls a clean checkout clean, and a detached head detached", async () => {
    const { execute } = fakeGit({
      "--no-optional-locks status --porcelain=v1 --branch": ok("## main\n"),
      "rev-parse HEAD": ok("abc123\n"),
    });
    expect(await repositoryStatus(execute, "/checkout")).toMatchObject({ branch: "main", dirty: false });
    const detached = fakeGit({
      "--no-optional-locks status --porcelain=v1 --branch": ok(""),
      "rev-parse HEAD": ok("abc123\n"),
    });
    expect(await repositoryStatus(detached.execute, "/checkout")).toMatchObject({ branch: "" });
  });

  it("says a checkout has no commit yet rather than reporting an empty one", async () => {
    const { execute } = fakeGit({
      "--no-optional-locks status --porcelain=v1 --branch": ok("## main\n"),
      "rev-parse HEAD": { code: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'\n", cancelled: false },
    });
    await expect(repositoryStatus(execute, "/checkout")).rejects.toThrow("has no commit yet");
  });

  it("carries Git's own refusal rather than an empty reading", async () => {
    const { execute } = fakeGit({
      "--no-optional-locks status --porcelain=v1 --branch": {
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository\n",
        cancelled: false,
      },
    });
    await expect(repositoryStatus(execute, "/checkout")).rejects.toThrow("not a git repository");
  });

  it("reads the root of the checkout a folder sits in", async () => {
    const { execute } = fakeGit({ "rev-parse --show-toplevel": ok("/checkout\n") });
    expect(await topLevel(execute, "/checkout/src")).toBe("/checkout");
  });

  it("asks Git for the -z listing when looking for a branch's worktree", async () => {
    const { execute, calls } = fakeGit({
      "worktree list --porcelain -z": ok(record("worktree /work/PRB-1", "branch refs/heads/prb-1", "") + "\0"),
    });
    expect(await worktreeForBranch(execute, "/checkout", "refs/heads/prb-1")).toBe("/work/PRB-1");
    expect(calls[0]?.args).toEqual(["worktree", "list", "--porcelain", "-z"]);
  });
});
