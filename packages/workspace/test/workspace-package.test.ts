import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  enclosingWorkspaceRoot,
  proposedInstallStep,
  workspaceMembership,
} from "../src/diagnostic.js";

/**
 * A run pointed at one package of a monorepo.
 *
 * Two roots exist and they are not the same directory: the package, whose
 * scripts judge the attempt, and the workspace, whose lockfile the install
 * reproduces. Reading only the first answered `npm` for a pnpm monorepo — the
 * member has no lockfile of its own and its `package.json` names no manager —
 * and proposed an install that resolves a different dependency graph from the
 * one the repository actually runs.
 *
 * Nothing here starts a process: every answer is read off files on disk.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-ws-package-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A directory tree holding exactly the files it is given, relative to its root. */
function tree(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(scratch, `${name}-`));
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const SCRIPTS = { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" };

/**
 * A pnpm monorepo: a workspace root that holds the lockfile, and two members
 * under it. The second exists so a filter that named the wrong one would be
 * visible rather than vacuous.
 */
function pnpmWorkspace(name: string): { root: string; api: string; web: string } {
  const root = tree(name, {
    "pnpm-workspace.yaml": "packages:\n  - 'services/*'\n",
    "package.json": json({ name: "monorepo", private: true, scripts: { test: "turbo run test" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "services/api/package.json": json({ name: "@fixture/api", scripts: SCRIPTS }),
    "services/web/package.json": json({ name: "@fixture/web", scripts: SCRIPTS }),
  });
  return { root, api: join(root, "services", "api"), web: join(root, "services", "web") };
}

describe("the two roots a package inside a workspace has", () => {
  it("separates the package it was given from the workspace whose manager installs it", () => {
    const { root, api } = pnpmWorkspace("membership");

    expect(workspaceMembership(api)).toEqual({
      package_root: api,
      workspace_root: root,
      package_name: "@fixture/api",
    });

    // The workspace root is its own workspace: one root, and every derivation
    // below reads exactly as it did before there were two.
    expect(workspaceMembership(root)).toEqual({
      package_root: root,
      workspace_root: root,
      package_name: null,
    });
  });

  it("does not capture a directory the workspace does not list as a member", () => {
    const { root } = pnpmWorkspace("unlisted");
    const outside = join(root, "scratch", "elsewhere");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "package.json"), json({ name: "unrelated", scripts: SCRIPTS }));

    // `services/*` does not name it. A package manager matches its declared
    // globs, and a directory that merely sits below a monorepo is its own
    // checkout — otherwise every temporary directory under one would be
    // installed from a lockfile that has never heard of it.
    expect(workspaceMembership(outside)).toEqual({
      package_root: outside,
      workspace_root: outside,
      package_name: null,
    });
  });

  it("honours a negated member pattern", () => {
    const root = tree("negated", {
      "pnpm-workspace.yaml": "packages:\n  - 'services/*'\n  - '!services/legacy'\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "services/legacy/package.json": json({ name: "@fixture/legacy", scripts: SCRIPTS }),
    });
    const legacy = join(root, "services", "legacy");

    expect(workspaceMembership(legacy).workspace_root).toBe(legacy);
  });
});

/**
 * Which list the member globs are read from.
 *
 * A workspace names its members under one key of one file, and a key of the
 * same name elsewhere in that file is a different setting: TOML puts every
 * table's keys at the start of a line, so a `members` under `[tool.mypy]` and
 * one under `[tool.uv.workspace]` look identical to a reader that matches only
 * the key. Reading the wrong one does not fail — it answers, and the answer
 * puts an unrelated directory inside a workspace it has nothing to do with.
 */
describe("the list a workspace's members are read from", () => {
  it("reads a TOML members list from the table that declares the workspace", () => {
    const root = tree("toml-tables", {
      "pyproject.toml": [
        "[project]",
        'name = "monorepo"',
        "",
        "[tool.mypy]",
        'members = ["everything/*"]',
        "",
        "[tool.uv.workspace]",
        'members = ["services/*"]',
        "",
      ].join("\n"),
      "uv.lock": "version = 1\n",
      "services/api/pyproject.toml": '[project]\nname = "api"\n',
      "everything/unrelated/pyproject.toml": '[project]\nname = "unrelated"\n',
    });

    // The workspace's own list names `services/*`, so that is what belongs to
    // it — and the directory the other table happens to name does not.
    expect(workspaceMembership(join(root, "services", "api")).workspace_root).toBe(root);
    const unrelated = join(root, "everything", "unrelated");
    expect(workspaceMembership(unrelated).workspace_root).toBe(unrelated);
  });

  it("reads a members list a workspace table indents under its header", () => {
    const root = tree("toml-indented", {
      "pyproject.toml": '[tool.uv.workspace]\n    members = ["services/*"]\n',
      "uv.lock": "version = 1\n",
      "services/api/pyproject.toml": '[project]\nname = "api"\n',
    });

    // Indentation carries no meaning in TOML: this is the same table and the
    // same key as the flush-left form.
    expect(workspaceMembership(join(root, "services", "api")).workspace_root).toBe(root);
  });

  it("declares no workspace where the members list belongs to no workspace table", () => {
    const root = tree("toml-no-workspace", {
      "pyproject.toml": '[project]\nname = "solo"\n\n[tool.mypy]\nmembers = ["services/*"]\n',
      "uv.lock": "version = 1\n",
      "services/api/pyproject.toml": '[project]\nname = "api"\n',
    });
    const api = join(root, "services", "api");

    // Nothing here declares a workspace at all, so the package below is its own
    // checkout and the directory above it is not a root anything installs at.
    expect(enclosingWorkspaceRoot(api)).not.toBe(root);
    expect(workspaceMembership(api).workspace_root).toBe(api);
  });

  it("reads the pnpm members from the document's own key, not one nested under another", () => {
    const root = tree("yaml-nested", {
      "pnpm-workspace.yaml": [
        "catalogs:",
        "  sometool:",
        "    packages:",
        "      - 'everything/*'",
        "packages:",
        "  - 'services/*'",
        "",
      ].join("\n"),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "services/api/package.json": json({ name: "@fixture/api", scripts: SCRIPTS }),
      "everything/unrelated/package.json": json({ name: "@fixture/unrelated", scripts: SCRIPTS }),
    });

    expect(workspaceMembership(join(root, "services", "api")).workspace_root).toBe(root);
    const unrelated = join(root, "everything", "unrelated");
    expect(workspaceMembership(unrelated).workspace_root).toBe(unrelated);
  });
});

describe("the install a package inside a workspace runs", () => {
  it("runs at the workspace root, filtered to that package, with the workspace's manager", () => {
    const { root, api } = pnpmWorkspace("install");

    const step = proposedInstallStep(api);

    // Where it runs: the workspace root. That is where the lockfile is, and it
    // is not the directory the run was given.
    expect(step.cwd).toBe(root);
    // What it runs: pnpm's own filter, naming this package and not the other.
    expect(step.command).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
      "--filter",
      "@fixture/api",
    ]);
    expect(step.command).not.toContain("@fixture/web");
    expect(step.pinned).toBe(true);

    // The manager is the workspace's, read from the lockfile above the package
    // — not the npm that the member's own `package.json` used to imply.
    const detected = detectPackageManager(api);
    expect(detected?.manager).toBe("pnpm");
    expect(detected?.named_by).toBe(join("..", "..", "pnpm-lock.yaml"));
  });

  it("filters an npm workspace with npm's own flag", () => {
    const root = tree("npm", {
      "package.json": json({ name: "monorepo", private: true, workspaces: ["services/*"] }),
      "package-lock.json": json({ name: "monorepo", lockfileVersion: 3, packages: {} }),
      "services/api/package.json": json({ name: "@fixture/api", scripts: SCRIPTS }),
    });

    const step = proposedInstallStep(join(root, "services", "api"));

    expect(step.cwd).toBe(root);
    expect(step.command).toEqual([
      "npm",
      "ci",
      "--prefer-offline",
      "--ignore-scripts",
      "--workspace",
      "@fixture/api",
    ]);
  });

  it("installs the whole workspace where the manager has no per-member form", () => {
    const root = tree("yarn", {
      "package.json": json({ name: "monorepo", private: true, workspaces: ["services/*"] }),
      "yarn.lock": "# yarn lockfile v1\n",
      "services/api/package.json": json({ name: "@fixture/api", scripts: SCRIPTS }),
    });

    const step = proposedInstallStep(join(root, "services", "api"));

    // Yarn classic has no per-member install and berry says it as a different
    // command; the whole workspace is a superset of what this package needs,
    // which is slower and correct.
    expect(step.cwd).toBe(root);
    expect(step.command).toEqual([
      "yarn",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
    ]);
  });

  it("leaves a checkout that is its own workspace exactly as it was", () => {
    const root = tree("standalone", {
      "package.json": json({ name: "solo", scripts: SCRIPTS }),
      "package-lock.json": json({ name: "solo", lockfileVersion: 3, packages: {} }),
    });

    const step = proposedInstallStep(root);

    expect(step.cwd).toBe(root);
    expect(step.command).toEqual(["npm", "ci", "--prefer-offline", "--ignore-scripts"]);
    expect(detectPackageManager(root)?.named_by).toBe("package-lock.json");
  });

  it("takes pnpm from a workspace that declares one before a lockfile is written", () => {
    const root = tree("unpinned", {
      "pnpm-workspace.yaml": 'packages:\n  - "services/*"\n',
      "package.json": json({ name: "monorepo", private: true }),
      "services/api/package.json": json({ name: "@fixture/api", scripts: SCRIPTS }),
    });

    const step = proposedInstallStep(join(root, "services", "api"));

    // No other manager reads `pnpm-workspace.yaml`, so a workspace holding one
    // is pnpm's whether or not the lockfile has been committed yet.
    expect(step.command).toEqual([
      "pnpm",
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--filter",
      "@fixture/api",
    ]);
    expect(step.pinned).toBe(false);
  });

  it("still obeys a `packageManager` field that names something else", () => {
    const root = tree("pinned-elsewhere", {
      "pnpm-workspace.yaml": 'packages:\n  - "services/*"\n',
      "package.json": json({
        name: "monorepo",
        private: true,
        packageManager: "yarn@4.5.0",
        workspaces: ["services/*"],
      }),
      "services/api/package.json": json({ name: "@fixture/api", scripts: SCRIPTS }),
    });

    // The field corepack obeys is an explicit declaration; the workspace file
    // beside it is an inference from a file's presence. The declaration wins,
    // here and at the root itself, exactly as it did before that inference
    // existed.
    expect(detectPackageManager(root)?.manager).toBe("yarn");
    expect(detectPackageManager(join(root, "services", "api"))?.manager).toBe("yarn");
    expect(proposedInstallStep(join(root, "services", "api")).command[0]).toBe("yarn");
  });
});
