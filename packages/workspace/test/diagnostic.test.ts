import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose, enclosingWorkspaceRoot } from "../src/diagnostic.js";
import { makeRepo } from "./support.js";

const scratch = () => mkdtempSync(join(tmpdir(), "perbo-nest-"));

/** A directory tree `a/b/c` under `root`, returning the deepest directory. */
function nest(root: string): string {
  const deep = join(root, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  return deep;
}

/**
 * That the walk finds no workspace inside the tree under test.
 *
 * `enclosingWorkspaceRoot` walks to the filesystem root and does not stop at a
 * temporary directory, so what lies *above* the fixture is the machine's
 * business and not the function's: a checkout that declares a workspace above
 * TMPDIR — which is exactly where these run under the runner, whose TMPDIR is a
 * directory inside this repository — makes a bare `toBeNull()` fail for a
 * reason that has nothing to do with what is being tested. What the function
 * promises is that nothing *within* the fixture answers.
 */
function expectNoWorkspaceWithin(root: string, directory: string): void {
  const found = enclosingWorkspaceRoot(directory);
  expect(found === null || !found.startsWith(root)).toBe(true);
}

describe("enclosingWorkspaceRoot", () => {
  it("finds the pnpm workspace above a nested directory, and reports none where there is none", () => {
    const workspace = scratch();
    writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    const deep = nest(workspace);

    expect(enclosingWorkspaceRoot(deep)).toBe(workspace);

    const clean = scratch();
    expectNoWorkspaceWithin(clean, nest(clean));
  });

  it("finds a package.json that declares workspaces, and ignores one that does not", () => {
    const workspace = scratch();
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "monorepo", workspaces: ["apps/*"] }));
    expect(enclosingWorkspaceRoot(nest(workspace))).toBe(workspace);

    const plain = scratch();
    writeFileSync(join(plain, "package.json"), JSON.stringify({ name: "plain", scripts: { test: "true" } }));
    // A package.json without a `workspaces` field declares no workspace, so
    // nothing inside this tree answers.
    expectNoWorkspaceWithin(plain, nest(plain));
  });

  it("returns the nearest such ancestor, not the outermost", () => {
    const outer = scratch();
    writeFileSync(join(outer, "pnpm-workspace.yaml"), "packages: []\n");
    const inner = join(outer, "inner");
    mkdirSync(inner);
    writeFileSync(join(inner, "pnpm-workspace.yaml"), "packages: []\n");

    expect(enclosingWorkspaceRoot(nest(inner))).toBe(inner);
  });

  it("does not count the directory itself, and does not need it to exist yet", () => {
    const workspace = scratch();
    writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");

    // A workspace root is not nested inside itself: this is the normal shape of
    // a monorepo checkout, not the hazard.
    expectNoWorkspaceWithin(workspace, workspace);
    // The worktree root is usually proposed before it is created.
    expect(enclosingWorkspaceRoot(join(workspace, "not-created-yet"))).toBe(workspace);
  });
});

describe("diagnose with a worktree root", () => {
  it("names the workspace that would capture a nested worktree root, and what it costs", async () => {
    const repo = makeRepo();
    const workspace = scratch();
    writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    const root = join(workspace, "worktrees");
    mkdirSync(root);

    const result = await diagnose({
      checkout: repo.dir,
      repository_id: "repo_fixture",
      worktree_root: root,
    });

    const finding = result.findings.find((f) => f.reason === "nested_package_manager_workspace");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain(workspace);
    expect(finding?.detail).toMatch(/install/);
    expect(finding?.detail).toMatch(/pnpm exec/);
    expect(finding?.path).toBe(workspace);
  });

  it("reports the nesting without refusing a repository that is otherwise well formed", async () => {
    const repo = makeRepo();
    const workspace = scratch();
    writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");
    const root = join(workspace, "worktrees");
    mkdirSync(root);

    const result = await diagnose({
      checkout: repo.dir,
      repository_id: "repo_fixture",
      worktree_root: root,
    });

    expect(result.findings.map((f) => f.reason)).toEqual(["nested_package_manager_workspace"]);
    expect(result.materializable).toBe(true);
    expect(result.proposed).not.toBeNull();
  });

  it("still refuses a repository whose own failure is real, alongside the advisory", async () => {
    // A checkout that is not there, which no environment can make present:
    // the refusal holds wherever the temporary directory sits.
    const dir = join(scratch(), "gone");
    const workspace = scratch();
    writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");

    const result = await diagnose({
      checkout: dir,
      repository_id: "repo_fixture",
      worktree_root: join(workspace, "worktrees"),
    });

    expect(result.findings.map((f) => f.reason).sort()).toEqual([
      "nested_package_manager_workspace",
      "source_checkout_missing",
    ]);
    expect(result.materializable).toBe(false);
  });

  it("says nothing about a worktree root it was not given", async () => {
    const repo = makeRepo();
    const result = await diagnose({ checkout: repo.dir, repository_id: "repo_fixture" });
    expect(result.findings).toEqual([]);
    expect(result.materializable).toBe(true);
  });
});
