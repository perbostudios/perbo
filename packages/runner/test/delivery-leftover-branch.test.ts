import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pushAttemptBranch } from "../src/delivery.js";
import { git } from "../src/test-support/repository.js";
import { scratchDirectories } from "@perbo/test-support";
import { initBareRepository, initRepository } from "@perbo/test-support";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A remote attempt branch, `prb/…` or `ayo/…`, a failed publish left behind
 * (SCP-266).
 *
 * The branch name is a digest of the outcome, so a re-run on the same outcome
 * mints the same name over a different commit: its push is rejected
 * non-fast-forward, and stays rejected until the branch is deleted by hand. The
 * loop owns the `prb/` and `ayo/` namespaces, so a leftover there with no open
 * pull request standing on it is the loop's to replace — under a lease on the
 * tip it read, so a branch that moved between the read and the push is not
 * overwritten.
 *
 * Everything below runs against a bare repository on disk as `origin` and a
 * `gh` that is a script on PATH: the argv, the refspecs, the lease and git's
 * own refusals are the shipped ones. Each case spawns real `git`, so each
 * carries its own timeout rather than vitest's five-second default.
 */

const BRANCH = "ayo/fixture/leftover-branch";
const TIMEOUT_MS = 30_000;

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

interface Fixture {
  origin: string;
  work: string;
  /** The commit this run would publish. */
  mine: string;
  /** What an earlier run left on the remote's copy of the branch. */
  leftover: string;
  /** A third commit, parked on the remote, for a tip that moves mid-push. */
  moved: string;
  tipOf: (branch?: string) => string;
}

/** A worktree on `BRANCH`, and a bare `origin` that may already hold it. */
function fixture(options: { leftover?: boolean } = {}): Fixture {
  const origin = initBareRepository(scratch("perbo-origin-"));
  const repository = initRepository(scratch("perbo-work-"), {
    files: { "first.txt": "first\n" },
    message: "first",
  });
  const work = repository.dir;
  repository.git("remote", "add", "origin", origin);
  repository.git("push", "-q", "origin", "main");

  const commit = (branch: string, file: string) => {
    repository.git("checkout", "-q", "-b", branch, "main");
    return repository.commit({ [file]: `${file}\n` }, file);
  };

  const mine = commit(BRANCH, "mine.txt");
  const leftover = commit("leftover", "leftover.txt");
  const moved = commit("moved", "moved.txt");
  repository.git("push", "-q", "origin", "moved:refs/heads/moved");
  if (options.leftover !== false) {
    repository.git("push", "-q", "origin", `leftover:refs/heads/${BRANCH}`);
  }
  repository.git("checkout", "-q", BRANCH);

  return {
    origin,
    work,
    mine,
    leftover,
    moved,
    tipOf: (branch = BRANCH) =>
      git(origin, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`).trim(),
  };
}

const quoted = (value: string) => JSON.stringify(value);

/**
 * A `gh` on PATH that answers `pr view` and logs every invocation.
 *
 * `advance` is how the remote moves between the delivery's read and its push:
 * the answer to `pr view` is the only thing that happens between the two, so a
 * script that moves the branch there is the race, run for real.
 */
function fakeGh(options: {
  answer: "open" | "closed" | "absent" | "error";
  advance?: { origin: string; branch: string; to: string };
}): { bin: string } {
  const dir = scratch("perbo-gh-");
  const log = join(dir, "calls.log");
  const answer = {
    open: `printf '%s' '{"number":7,"url":"https://example.invalid/pull/7","state":"OPEN"}'; exit 0`,
    closed: `printf '%s' '{"number":7,"url":"https://example.invalid/pull/7","state":"CLOSED"}'; exit 0`,
    absent: `printf 'no pull requests found for branch "%s"\\n' "$3" >&2; exit 1`,
    error: `printf 'could not reach the API\\n' >&2; exit 1`,
  }[options.answer];
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${quoted(log)}`,
    ...(options.advance
      ? [
          `git --git-dir=${quoted(options.advance.origin)} update-ref ` +
            `refs/heads/${options.advance.branch} ${options.advance.to}`,
        ]
      : []),
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    `  ${answer}`,
    "fi",
    'echo "this gh answers pr view only, got: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  const binary = join(dir, "gh");
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return { bin: dir };
}

/** A PATH holding `git` and nothing else — the machine with no `gh` installed. */
function pathWithGitOnly(): string {
  const dir = scratch("perbo-no-gh-");
  symlinkSync(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(dir, "git"));
  return dir;
}

/** The lines the fake `gh` logged, or none where it was never run. */
function ghCalls(bin: string): string[] {
  const log = join(bin, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("a remote attempt branch an earlier run left behind", () => {
  it("replaces it where no pull request stands on it, under a lease on the tip it read", async () => {
    const repo = fixture();
    const gh = fakeGh({ answer: "absent" });
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    const progress: string[] = [];

    const result = await pushAttemptBranch({
      worktree: repo.work,
      branch: BRANCH,
      onProgress: (line) => progress.push(line),
    });

    expect(result.pushed).toBe(true);
    expect(repo.tipOf()).toBe(repo.mine);
    expect(progress).toContain(
      `replaced origin/${BRANCH} at ${repo.leftover.slice(0, 12)} — left by an earlier run; ` +
        "no pull request stood on it",
    );
    expect(ghCalls(gh.bin).join("\n")).toContain(`pr view ${BRANCH}`);
  }, TIMEOUT_MS);

  it("replaces it where the pull request that stood on it is closed", async () => {
    const repo = fixture();
    const gh = fakeGh({ answer: "closed" });
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;

    await pushAttemptBranch({ worktree: repo.work, branch: BRANCH });
    expect(repo.tipOf()).toBe(repo.mine);
  }, TIMEOUT_MS);

  it("leaves it alone where an open pull request stands, and git's refusal reaches the caller", async () => {
    const repo = fixture();
    const gh = fakeGh({ answer: "open" });
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    const progress: string[] = [];

    await expect(
      pushAttemptBranch({
        worktree: repo.work,
        branch: BRANCH,
        onProgress: (line) => progress.push(line),
      }),
    ).rejects.toMatchObject({
      name: "DeliveryError",
      message: "git push failed",
      detail: expect.stringContaining("non-fast-forward"),
    });
    expect(repo.tipOf()).toBe(repo.leftover);
    expect(progress).toEqual([]);
  }, TIMEOUT_MS);

  it("treats a `gh` that could not answer as unknown and does not replace", async () => {
    const repo = fixture();
    const gh = fakeGh({ answer: "error" });
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;

    await expect(pushAttemptBranch({ worktree: repo.work, branch: BRANCH })).rejects.toMatchObject({
      name: "DeliveryError",
      detail: expect.stringContaining("non-fast-forward"),
    });
    expect(repo.tipOf()).toBe(repo.leftover);
  }, TIMEOUT_MS);

  it("treats a machine with no `gh` at all as unknown and does not replace", async () => {
    const repo = fixture();
    process.env.PATH = pathWithGitOnly();

    await expect(pushAttemptBranch({ worktree: repo.work, branch: BRANCH })).rejects.toMatchObject({
      name: "DeliveryError",
      detail: expect.stringContaining("non-fast-forward"),
    });
    expect(repo.tipOf()).toBe(repo.leftover);
  }, TIMEOUT_MS);

  it("refuses the push where the remote moved between the read and the lease", async () => {
    const repo = fixture();
    const gh = fakeGh({
      answer: "absent",
      advance: { origin: repo.origin, branch: BRANCH, to: repo.moved },
    });
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    const progress: string[] = [];

    await expect(
      pushAttemptBranch({
        worktree: repo.work,
        branch: BRANCH,
        onProgress: (line) => progress.push(line),
      }),
    ).rejects.toMatchObject({
      name: "DeliveryError",
      message: "git push failed",
      detail: expect.stringContaining("stale info"),
    });
    expect(repo.tipOf()).toBe(repo.moved);
    expect(progress).toEqual([]);
  }, TIMEOUT_MS);
});

describe("what does not change", () => {
  it("pushes a branch the remote does not have without asking `gh` anything", async () => {
    const repo = fixture({ leftover: false });
    const gh = fakeGh({ answer: "open" });
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    const progress: string[] = [];

    const result = await pushAttemptBranch({
      worktree: repo.work,
      branch: BRANCH,
      onProgress: (line) => progress.push(line),
    });

    expect(result.pushed).toBe(true);
    expect(repo.tipOf()).toBe(repo.mine);
    expect(ghCalls(gh.bin)).toEqual([]);
    expect(progress).toEqual([]);
  }, TIMEOUT_MS);

  it("pushes a branch the remote already holds at this very commit without asking `gh`", async () => {
    const repo = fixture({ leftover: false });
    git(repo.work, "push", "-q", "origin", `${BRANCH}:refs/heads/${BRANCH}`);
    const gh = fakeGh({ answer: "open" });
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;

    const result = await pushAttemptBranch({ worktree: repo.work, branch: BRANCH });
    expect(result.pushed).toBe(true);
    expect(repo.tipOf()).toBe(repo.mine);
    expect(ghCalls(gh.bin)).toEqual([]);
  }, TIMEOUT_MS);

  it("never replaces a branch that is not the attempt's own", async () => {
    const repo = fixture();
    const gh = fakeGh({ answer: "absent" });
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    const mainBefore = repo.tipOf("main");

    await expect(pushAttemptBranch({ worktree: repo.work, branch: "main" })).rejects.toMatchObject({
      name: "DeliveryError",
      detail: expect.stringContaining("not an attempt branch"),
    });
    expect(repo.tipOf("main")).toBe(mainBefore);
    expect(ghCalls(gh.bin)).toEqual([]);
  }, TIMEOUT_MS);
});
