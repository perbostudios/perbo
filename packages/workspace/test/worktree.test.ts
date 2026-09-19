import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, toNamespacedPath } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS_TABLE, LimitExceededError, LimitsTableSchema } from "@perbo/contracts";
import {
  WorkspaceError,
  cleanup,
  leaseIsStale,
  listLeases,
  provision,
  reclaimStaleWorktrees,
} from "../src/worktree.js";
import { makeRepo } from "./support.js";

const scratch = () => mkdtempSync(join(tmpdir(), "perbo-wt-"));

const base = (dir: string, head: string, root: string) => ({
  repository_root: dir,
  repository_id: "repo_fixture",
  ticket_key: "PRB-16",
  ticket_id: "ticket_SCP016",
  outcome: "provision an isolated worktree",
  base_commit: head,
  root,
  limits: DEFAULT_LIMITS_TABLE,
});

describe("provision", () => {
  it("creates from the exact base commit on the prb/<ticket id>/<slug> branch", async () => {
    const repo = makeRepo();
    const root = scratch();
    const workspace = await provision({ ...base(repo.dir, repo.first, root), attempt_id: "att_1" });

    expect(workspace.branch).toBe("prb/scp016/provision-an-isolated-worktree");
    expect(workspace.base_commit).toBe(repo.first);
    // The exact base commit, not the tip: the second commit's file is absent.
    expect(existsSync(join(workspace.path, "src.ts"))).toBe(false);
    expect(existsSync(join(workspace.path, "package.json"))).toBe(true);
  });

  it("refuses a base commit that does not resolve, before creating anything", async () => {
    const repo = makeRepo();
    const root = scratch();
    await expect(
      provision({ ...base(repo.dir, "0".repeat(40), root), attempt_id: "att_1" }),
    ).rejects.toMatchObject({ reason: "base_commit_missing" });
    expect(listLeases(root)).toEqual([]);
  });

  it("refuses a directory that is not a Git repository", async () => {
    const root = scratch();
    await expect(
      provision({ ...base(scratch(), "abcdef1", root), attempt_id: "att_1" }),
    ).rejects.toMatchObject({ reason: "not_a_git_repository" });
  });

  it("rejects a second worktree on the same branch", async () => {
    const repo = makeRepo();
    const root = scratch();
    await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });
    const limits = LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 5 },
    });
    await expect(
      provision({ ...base(repo.dir, repo.head, root), limits, attempt_id: "att_2" }),
    ).rejects.toMatchObject({ reason: "worktree_collision" });
  });

  it("stops at concurrent_local_attempts rather than filling the laptop", async () => {
    const repo = makeRepo();
    const root = scratch();
    await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });
    await expect(
      provision({
        ...base(repo.dir, repo.head, root),
        ticket_id: "ticket_OTHER",
        attempt_id: "att_2",
      }),
    ).rejects.toBeInstanceOf(LimitExceededError);
  });

  it("lets a continuation take over its predecessor's worktree and lease", async () => {
    const repo = makeRepo();
    const root = scratch();
    const first = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });
    const second = await provision({
      ...base(repo.dir, repo.head, root),
      attempt_id: "att_2",
      continues: { root_attempt_id: "att_1" },
    });
    expect(second.continued).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
    expect(listLeases(root)).toHaveLength(1);
    expect(listLeases(root)[0]?.attempt_id).toBe("att_2");
  });

  it("keeps the branch the ticket already has, whatever its key would derive now", async () => {
    const repo = makeRepo();
    const root = scratch();
    const recorded = "ayo/scp016/provision-an-isolated-worktree";
    const workspace = await provision({
      ...base(repo.dir, repo.head, root),
      attempt_id: "att_1",
      recorded: { attempt: recorded },
    });
    expect(workspace.branch).toBe(recorded);
    expect(execFileSync("git", ["branch", "--list", "prb/*"], { cwd: repo.dir, encoding: "utf8" })).toBe("");
  });

  it("continues on the branch its lease holds, whatever its outcome would derive now", async () => {
    const repo = makeRepo();
    const root = scratch();
    // A chain begun under another outcome, whose slug the current one does not derive.
    const first = await provision({ ...base(repo.dir, repo.head, root), outcome: "an earlier outcome", attempt_id: "att_1" });
    const second = await provision({
      ...base(repo.dir, repo.head, root),
      attempt_id: "att_2",
      continues: { root_attempt_id: "att_1" },
    });
    expect(first.branch).toBe("prb/scp016/an-earlier-outcome");
    expect(second.continued).toBe(true);
    expect(second.branch).toBe(first.branch);
  });

  it("derives a new name where the branch on record is not one the loop minted", async () => {
    const repo = makeRepo();
    const root = scratch();
    const workspace = await provision({
      ...base(repo.dir, repo.head, root),
      attempt_id: "att_1",
      recorded: { delivery: "direct/prb-16/provision" },
    });
    expect(workspace.branch).toBe("prb/scp016/provision-an-isolated-worktree");
  });

  it("refuses a worktree path that would land outside the workspace root", async () => {
    const repo = makeRepo();
    const root = scratch();
    // A traversing attempt id is the only route to a path outside the root.
    await expect(
      provision({ ...base(repo.dir, repo.head, root), attempt_id: "../../escape" }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });
});

describe("leases", () => {
  it("treats an expired lease as stale", () => {
    const lease = {
      attempt_id: "a",
      root_attempt_id: "a",
      repository_id: "repo_x",
      branch: "ayo/x/y",
      path: "/tmp/x",
      base_commit: "abc1234",
      created_at: "2020-01-01T00:00:00.000Z",
      expires_at: "2020-01-01T01:00:00.000Z",
      pid: process.pid,
      host: "somewhere-else",
    };
    expect(leaseIsStale(lease, new Date("2020-01-02T00:00:00.000Z"))).toBe(true);
    expect(leaseIsStale(lease, new Date("2020-01-01T00:30:00.000Z"))).toBe(false);
  });

  it("reclaims a stale worktree so its branch can be provisioned again", async () => {
    const repo = makeRepo();
    const root = scratch();
    const workspace = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });

    const leaseFile = join(root, "att_1.lease.json");
    const lease = JSON.parse(readFileSync(leaseFile, "utf8"));
    writeFileSync(
      leaseFile,
      JSON.stringify({ ...lease, expires_at: "2020-01-01T00:00:00.000Z" }, null, 2),
    );

    const reclaimed = await reclaimStaleWorktrees({ repository_root: repo.dir, root });
    expect(reclaimed).toHaveLength(1);
    expect(existsSync(workspace.path)).toBe(false);

    const again = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_3" });
    expect(again.branch).toBe(workspace.branch);
  });
});

describe("cleanup", () => {
  for (const outcome of ["success", "failure", "cancelled"] as const) {
    it(`removes the worktree after ${outcome} and keeps the branch`, async () => {
      const repo = makeRepo();
      const root = scratch();
      const workspace = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });
      const result = await cleanup({ workspace, root, outcome });

      expect(result.removed).toBe(true);
      expect(existsSync(workspace.path)).toBe(false);
      expect(listLeases(root)).toEqual([]);
      const branches = execFileSync("git", ["branch", "--list", workspace.branch], {
        cwd: repo.dir,
        encoding: "utf8",
      });
      expect(branches).toContain(workspace.branch);
    });
  }

  it("removes a worktree Git cannot delete: a link whose target is longer than MAX_PATH", async () => {
    const repo = makeRepo();
    const root = scratch();
    const workspace = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });

    // What a pnpm install leaves behind: a package directory deep in the
    // virtual store, and a short link under node_modules whose *target* runs
    // past 260 characters. Git for Windows reads a link's target into a
    // MAX_PATH buffer that `core.longpaths` does not enlarge, so `git worktree
    // remove` stops on the first such link with "Result too large" and leaves
    // the tree standing. Built one segment at a time: a recursive mkdir
    // path-resolves the `\\?\` prefix away, a plain one does not. Segments are
    // added until the target is past 260 characters, however short the
    // temporary directory it starts from.
    const segment = "y".repeat(60);
    let target = workspace.path;
    const descend = (part: string): void => {
      target = join(target, part);
      mkdirSync(toNamespacedPath(target));
    };
    for (const part of ["node_modules", ".pnpm", segment, "node_modules"]) descend(part);
    while (target.length <= 260) descend(segment);
    descend("pkg");
    writeFileSync(toNamespacedPath(join(target, "index.js")), "module.exports = 1;\n");
    expect(target.length).toBeGreaterThan(260);
    symlinkSync(target, join(workspace.path, "node_modules", "pkg"), "junction");

    const result = await cleanup({ workspace, root, outcome: "failure" });

    expect(result.removed).toBe(true);
    expect(existsSync(workspace.path)).toBe(false);
    expect(listLeases(root)).toEqual([]);
    // The registration Git dropped before it gave up is pruned either way.
    const registered = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repo.dir,
      encoding: "utf8",
    });
    expect(registered).not.toContain(workspace.path);
    // Elsewhere Git deletes a symlink like any file and the fallback is never
    // reached; only on Windows does this scenario need it, and there the
    // detail has to say the tree was removed directly rather than by Git.
    if (process.platform === "win32") expect(result.detail).toContain("removed directly");
  });

  // Off Windows, no tree that Node can delete defeats Git's own removal, so a
  // `git` that fails the way Git does stands in for it.
  it.skipIf(process.platform === "win32")(
    "finishes a removal Git accepted and could not complete",
    async () => {
      const repo = makeRepo();
      const root = scratch();
      const workspace = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });

      const result = await withPath(gitFailingRemoval(workspace.path), () =>
        cleanup({ workspace, root, outcome: "failure" }),
      );

      expect(result.removed).toBe(true);
      expect(result.detail).toContain("removed directly");
      expect(existsSync(workspace.path)).toBe(false);
      expect(listLeases(root)).toEqual([]);
    },
  );

  it("leaves a worktree Git refused to remove, and says it could not remove it", async () => {
    const repo = makeRepo();
    const root = scratch();
    const workspace = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });
    // A lock is one refusal. Git refuses before it touches the tree or its
    // registration, so there is no removal of Git's here to finish.
    execFileSync("git", ["worktree", "lock", workspace.path], { cwd: repo.dir });

    await expect(cleanup({ workspace, root, outcome: "failure" })).rejects.toMatchObject({
      reason: "cleanup_failed",
    });
    expect(existsSync(join(workspace.path, "package.json"))).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says both failed where neither Git nor the direct removal can delete the tree",
    async () => {
      const repo = makeRepo();
      const root = scratch();
      const workspace = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });
      // A directory whose entries this user may not unlink. Git accepts the
      // removal, drops the registration and fails on it; the direct removal
      // then fails on it too.
      const held = join(workspace.path, "held");
      mkdirSync(held);
      writeFileSync(join(held, "file"), "x");
      chmodSync(held, 0o555);
      try {
        await expect(cleanup({ workspace, root, outcome: "failure" })).rejects.toThrow(
          /removing it directly failed as well/,
        );
      } finally {
        chmodSync(held, 0o755);
      }
    },
  );

  it("removes a tree whose registration an earlier cleanup's removal already dropped", async () => {
    const repo = makeRepo();
    const root = scratch();
    const workspace = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });
    // What a removal Git accepted and could not finish leaves behind: the tree,
    // and no registration. Git now refuses it as not a working tree.
    rmSync(registrationOf(workspace.path), { recursive: true, force: true });

    const result = await cleanup({ workspace, root, outcome: "failure" });

    expect(result.removed).toBe(true);
    expect(result.detail).toContain("removed directly");
    expect(existsSync(workspace.path)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "does not say the tree was removed directly when Git removed it",
    async () => {
      const repo = makeRepo();
      const root = scratch();
      const workspace = await provision({ ...base(repo.dir, repo.head, root), attempt_id: "att_1" });

      // Git removes the tree and still exits non-zero.
      const result = await withPath(fakeGit([`'${realGit()}' "$@"`, "exit 1"]), () =>
        cleanup({ workspace, root, outcome: "failure" }),
      );

      expect(result.removed).toBe(true);
      expect(existsSync(workspace.path)).toBe(false);
      expect(result.detail).not.toContain("removed directly");
    },
  );
});

/** The administrative directory Git keeps for a worktree, named by its `.git` file. */
function registrationOf(worktree: string): string {
  return resolve(
    worktree,
    readFileSync(join(worktree, ".git"), "utf8").replace(/^gitdir: /, "").trim(),
  );
}

/** The real `git` on PATH. */
function realGit(): string {
  const real = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "git"))
    .find((candidate) => existsSync(candidate));
  if (real === undefined) throw new Error("no git on PATH");
  return real;
}

/**
 * A `git` first on PATH that runs `onRemove` for `worktree remove` and passes
 * every other command to the real Git.
 */
function fakeGit(onRemove: string[]): string {
  const bin = scratch();
  const script = join(bin, "git");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = worktree ] && [ "$2" = remove ]; then',
      ...onRemove.map((line) => `  ${line}`),
      "fi",
      `exec '${realGit()}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return bin;
}

/**
 * A `git` that fails `worktree remove` the way Git fails a removal it has
 * accepted: registration dropped, tree left standing, non-zero exit.
 */
function gitFailingRemoval(worktree: string): string {
  return fakeGit([
    `rm -rf '${registrationOf(worktree)}'`,
    `echo "error: failed to delete '$4': Result too large" >&2`,
    "exit 255",
  ]);
}

/** `body` with `bin` first on PATH, and PATH put back however it ends. */
async function withPath<T>(bin: string, body: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${original ?? ""}`;
  try {
    return await body();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}
