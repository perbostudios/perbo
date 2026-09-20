import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandFailedError } from "../exec.js";
import { createGh, createGit, git } from "./index.js";
import { fakeGitProcess } from "./test-support/fake-process.js";
import { git as fixtureGit, makeRepo } from "../../test/support.js";

const scratch = () => mkdtempSync(join(tmpdir(), "perbo-repo-"));

/**
 * A `git` or `gh` first on `PATH` that writes the environment it was given to a
 * file. What the child is handed cannot be read any other way, and it is the
 * property the whole posture rests on.
 */
function recordingBinary(name: string): { dir: string; env: () => NodeJS.ProcessEnv } {
  const dir = scratch();
  const dump = join(dir, "environment");
  const binary = join(dir, name);
  writeFileSync(binary, `#!/bin/sh\nenv > ${JSON.stringify(dump)}\n`, { mode: 0o755 });
  chmodSync(binary, 0o755);
  return {
    dir,
    env: () => {
      const text = readFileSync(dump, "utf8");
      const env: NodeJS.ProcessEnv = {};
      for (const line of text.split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
      }
      return env;
    },
  };
}

const posix = process.platform !== "win32";

describe("what a git child is given", () => {
  it.skipIf(!posix)("refuses prompts and carries nothing the allow-list does not name", () => {
    const recorder = recordingBinary("git");
    const repository = createGit({
      environment: () => ({
        PATH: `${recorder.dir}${delimiter}${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? "",
        PERBO_SENTINEL_TOKEN: "must-not-travel",
      }),
    });

    expect(repository.headSync(recorder.dir)).toBe(null);
    const environment = recorder.env();
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(environment.GCM_INTERACTIVE).toBe("never");
    expect(environment.PERBO_SENTINEL_TOKEN).toBeUndefined();
  });

  it.skipIf(!posix)("gives the asynchronous path the same environment", async () => {
    const recorder = recordingBinary("git");
    const repository = createGit({
      environment: () => ({
        PATH: `${recorder.dir}${delimiter}${process.env.PATH ?? ""}`,
        PERBO_SENTINEL_TOKEN: "must-not-travel",
      }),
    });

    expect(await repository.head(recorder.dir)).toBe(null);
    const environment = recorder.env();
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(environment.PERBO_SENTINEL_TOKEN).toBeUndefined();
  });

  it.skipIf(!posix)("gives gh its own refusal and the credential the runner holds", async () => {
    const recorder = recordingBinary("gh");
    const hub = createGh({
      environment: () => ({
        PATH: `${recorder.dir}${delimiter}${process.env.PATH ?? ""}`,
        GH_TOKEN: "runner-token",
        PERBO_SENTINEL_TOKEN: "must-not-travel",
        NPM_TOKEN: "must-not-travel",
      }),
    });

    await hub.viewPullRequest(recorder.dir, "13", ["number", "url"]);
    const environment = recorder.env();
    expect(environment.GH_PROMPT_DISABLED).toBe("1");
    expect(environment.GH_TOKEN).toBe("runner-token");
    expect(environment.PERBO_SENTINEL_TOKEN).toBeUndefined();
    expect(environment.NPM_TOKEN).toBeUndefined();
  });
});

describe("an operand that would be read as an option", () => {
  it("is refused before anything is spawned", async () => {
    const process_ = fakeGitProcess();
    const repository = createGit({ process: process_ });

    await expect(repository.resolveCommit("/repo", "--output=x")).rejects.toThrowError(RangeError);
    await expect(repository.changedPaths("/repo", "--output=/tmp/x", "HEAD")).rejects.toThrowError(RangeError);
    await expect(repository.mergeBase("/repo", "-f", "HEAD")).rejects.toThrowError(RangeError);
    expect(repository.headSync).toBeTypeOf("function");
    expect(process_.calls).toEqual([]);
  });
});

describe("how long a call may take, and how much it may say", () => {
  it("gives a local read two minutes and anything crossing the network three", async () => {
    const process_ = fakeGitProcess();
    const repository = createGit({ process: process_ });

    await repository.head("/repo");
    await repository.run("/repo", ["fetch", "--quiet", "origin", "main"]);
    await repository.clone("/parent", "/source", "/into");

    expect(process_.calls.map((call) => call.options.timeoutMs)).toEqual([120_000, 180_000, 180_000]);
  });

  it("gives a question whose answer is read room for a diff, and a bare command less", async () => {
    const process_ = fakeGitProcess();
    const repository = createGit({ process: process_ });

    await repository.changedPaths("/repo", "a", "b");
    await repository.run("/repo", ["status"]);

    expect(process_.calls.map((call) => call.options.maxOutputBytes)).toEqual([64 * 1024 * 1024, 512 * 1024]);
  });

  it("lets one caller redirect git's object store without widening the rest", async () => {
    const process_ = fakeGitProcess();
    const repository = createGit({ process: process_, environment: () => ({ PATH: "/usr/bin" }) });

    await repository.run("/repo", ["commit-tree", "-m", "probe", "tree"], {
      overlay: { GIT_OBJECT_DIRECTORY: "/scratch/objects" },
    });

    const [call] = process_.calls;
    expect(call?.options.env.GIT_OBJECT_DIRECTORY).toBe("/scratch/objects");
    expect(call?.options.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("lets a caller hand gh an environment of its own, and name the binary", () => {
    const process_ = fakeGitProcess();
    const hub = createGh({
      process: process_,
      environment: () => ({ PATH: "/usr/bin", GH_TOKEN: "the runner's" }),
      binary: "/opt/gh",
    });

    hub.runSync("/repo", ["auth", "status"], { base: { PATH: "/usr/bin", GH_TOKEN: "the caller's" } });
    hub.viewPullRequestSync("/repo", "13", ["state"]);

    expect(process_.calls.map((call) => [call.argv, call.options.env.GH_TOKEN, call.options.timeoutMs])).toEqual([
      [["/opt/gh", "auth", "status"], "the caller's", 180_000],
      [["/opt/gh", "pr", "view", "13", "--json", "state"], "the runner's", 180_000],
    ]);
  });

  it("builds gh's argv from what the caller asked, not from a command line", async () => {
    const process_ = fakeGitProcess();
    const hub = createGh({ process: process_ });

    await hub.viewPullRequest("/repo", "13", ["number", "url"], { repo: "o/r" });
    await hub.api("/repo", "repos/o/r/commits/abc", { accept: "application/vnd.github+json", silent: true });

    expect(process_.calls.map((call) => call.argv)).toEqual([
      ["gh", "pr", "view", "13", "--repo", "o/r", "--json", "number,url"],
      ["gh", "api", "-H", "Accept: application/vnd.github+json", "repos/o/r/commits/abc", "--silent"],
    ]);
  });
});

describe("the questions, against a real repository", () => {
  it("answers the head, the merge base and what changed, the same way on both paths", async () => {
    const repo = makeRepo();

    expect(await git.head(repo.dir)).toBe(repo.head);
    expect(git.headSync(repo.dir)).toBe(repo.head);
    expect(await git.resolveCommit(repo.dir, "main")).toBe(repo.head);
    expect(git.resolveCommitSync(repo.dir, "main")).toBe(repo.head);
    expect(await git.resolveCommit(repo.dir, "refs/heads/no-such-branch")).toBe(null);
    expect(await git.mergeBase(repo.dir, repo.first, repo.head)).toBe(repo.first);
    expect(git.mergeBaseSync(repo.dir, repo.first, repo.head)).toBe(repo.first);
    expect(await git.isAncestor(repo.dir, repo.first, repo.head)).toBe(true);
    expect(await git.isAncestor(repo.dir, repo.head, repo.first)).toBe(false);
    expect(await git.changedPaths(repo.dir, repo.first, repo.head)).toEqual(["src.ts"]);
    expect(await git.topLevel(repo.dir)).toBe(realpathSync(repo.dir));
    expect(git.topLevelSync(repo.dir)).toBe(realpathSync(repo.dir));
    expect(await git.config(repo.dir, "user.name")).toBe("test");
    expect(git.configSync(repo.dir, "commit.gpgsign", "bool")).toBe("false");
    expect(git.configSync(repo.dir, "perbo.nothing")).toBe(null);
  });

  it("refuses to answer from outside a repository, rather than answering about one above it", () => {
    const empty = scratch();
    expect(() => git.topLevelSync(empty)).toThrowError(CommandFailedError);
    expect(() => git.trackedFilesSync(empty)).toThrowError(CommandFailedError);
  });

  it("lists the tracked files, and says so when the listing did not fit", async () => {
    const repo = makeRepo();

    expect((await git.trackedFiles(repo.dir)).sort()).toEqual([".gitignore", "package.json", "pnpm-lock.yaml", "src.ts"]);
    expect(git.trackedFilesSync(repo.dir).sort()).toEqual([".gitignore", "package.json", "pnpm-lock.yaml", "src.ts"]);
    // A cut listing is shaped exactly like a complete one, so it is refused
    // rather than returned as the repository's contents.
    await expect(git.trackedFiles(repo.dir, { maxOutputBytes: 8 })).rejects.toThrowError(CommandFailedError);
  });

  it("says whether the tracked files have changed", () => {
    const repo = makeRepo();
    expect(git.hasTrackedChangesSync(repo.dir)).toBe(false);
    writeFileSync(join(repo.dir, "src.ts"), "export const value = 2;\n");
    expect(git.hasTrackedChangesSync(repo.dir)).toBe(true);
  });

  it("stages what it is given, commits it, and reports the commit", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo.dir, "added.ts"), "export const added = true;\n");

    await git.stage(repo.dir, ["."]);
    expect(await git.stagedPaths(repo.dir, ["."])).toEqual(["added.ts"]);

    const sha = await git.commit(repo.dir, "add a file");
    expect(sha).toBe(await git.head(repo.dir));
    expect(sha).not.toBe(repo.head);
    expect(await git.stagedPaths(repo.dir, ["."])).toEqual([]);
  });

  it("stages a path the repository ignores only when told to force it", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo.dir, ".env"), "SECRET=1\n");

    // git refuses a pathspec it is ignoring, and the refusal reaches the caller
    // rather than being read as "there was nothing to stage".
    await expect(git.stage(repo.dir, [".env"])).rejects.toThrowError(CommandFailedError);
    expect(await git.stagedPaths(repo.dir, ["."])).toEqual([]);
    await git.stage(repo.dir, [".env"], { force: true });
    expect(await git.stagedPaths(repo.dir, ["."])).toEqual([".env"]);
  });

  it("leaves signing to the repository's own configuration", async () => {
    const repo = makeRepo();
    fixtureGit(repo.dir, "config", "commit.gpgsign", "true");
    fixtureGit(repo.dir, "config", "gpg.format", "ssh");
    fixtureGit(repo.dir, "config", "gpg.ssh.program", "/bin/false");
    fixtureGit(repo.dir, "config", "user.signingkey", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIkey");
    writeFileSync(join(repo.dir, "added.ts"), "export const added = true;\n");
    await git.stage(repo.dir, ["."]);

    // A commit this repository says to sign, with a signer that cannot: the
    // module neither suppresses the signing nor pretends the commit was made.
    await expect(git.commit(repo.dir, "add a file")).rejects.toThrowError(CommandFailedError);
    expect(await git.head(repo.dir)).toBe(repo.head);
  });

  it("reads the worktrees git has registered, path by path", async () => {
    const repo = makeRepo();
    const root = scratch();
    const spaced = join(root, "a space");
    const detached = join(root, "detached");

    await git.addWorktree(repo.dir, { path: spaced, newBranch: "feature", startPoint: repo.head });
    await git.addWorktree(repo.dir, { path: detached, detach: repo.first, force: true });

    const entries = await git.worktrees(repo.dir);
    const byPath = new Map(entries.map((entry) => [realpathSync(entry.path), entry]));
    expect(byPath.get(realpathSync(repo.dir))?.branch).toBe("main");
    expect(byPath.get(realpathSync(spaced))?.branch).toBe("feature");
    expect(byPath.get(realpathSync(detached))).toMatchObject({ branch: null, detached: true, head: repo.first });

    const removed = await git.removeWorktree(repo.dir, spaced);
    expect(removed.code).toBe(0);
    rmSync(detached, { recursive: true, force: true });
    await git.pruneWorktrees(repo.dir);
    expect((await git.worktrees(repo.dir)).map((entry) => realpathSync(entry.path))).toEqual([realpathSync(repo.dir)]);
  });

  it("adds a worktree on a branch that already exists", async () => {
    const repo = makeRepo();
    const root = scratch();
    fixtureGit(repo.dir, "branch", "existing", repo.first);

    const added = await git.addWorktree(repo.dir, { path: join(root, "existing"), branch: "existing" });
    expect(added.code).toBe(0);
    const entry = (await git.worktrees(repo.dir)).find((candidate) => candidate.branch === "existing");
    expect(entry?.head).toBe(repo.first);
  });

  it("clones a repository into a directory that does not exist yet", async () => {
    const repo = makeRepo();
    const root = scratch();
    const into = join(root, "clone");

    const cloned = await git.clone(root, repo.dir, into, { noTags: true, noHardlinks: true });
    expect(cloned.code).toBe(0);
    expect(await git.head(into)).toBe(repo.head);
  });

  it("hands a command with one caller its exit status as data, and throws where asked to", async () => {
    const repo = makeRepo();

    const missing = await git.run(repo.dir, ["rev-parse", "--verify", "--quiet", "refs/heads/absent"]);
    expect(missing.code).not.toBe(0);
    expect(missing.truncated).toBe(false);
    await expect(git.runOrThrow(repo.dir, ["rev-parse", "--verify", "refs/heads/absent"])).rejects.toThrowError(
      CommandFailedError,
    );
    expect(git.runSync(repo.dir, ["rev-parse", "HEAD"]).stdout.trim()).toBe(repo.head);
  });
});

describe("a repository whose worktree directory is gone", () => {
  it("still lists it, because git's registration is what a listing reads", async () => {
    const repo = makeRepo();
    const root = scratch();
    const path = join(root, "vanished");
    mkdirSync(root, { recursive: true });

    await git.addWorktree(repo.dir, { path, newBranch: "vanishing", startPoint: repo.head });
    rmSync(path, { recursive: true, force: true });

    expect((await git.worktrees(repo.dir)).some((entry) => entry.branch === "vanishing")).toBe(true);
    await git.pruneWorktrees(repo.dir);
    expect((await git.worktrees(repo.dir)).some((entry) => entry.branch === "vanishing")).toBe(false);
  });
});
