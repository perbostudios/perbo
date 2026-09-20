import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS_TABLE,
  isRefusal,
  type InstallStrategy,
  type MaterializationManifest,
} from "@perbo/contracts";
import { diagnose } from "./diagnostic.js";
import { materialize } from "./materialize.js";
import { provision } from "./worktree.js";
import { git } from "./test-support/repository.js";

/**
 * A repository whose own scripts give a worktree nothing to run is accepted, not
 * refused: one that declares no test script, one whose package manager this
 * build does not install with, and one whose test script starts a service.
 * Each is verified with `git status --porcelain`, an advisory says what that
 * leaves unproven, and the proposal materializes — a worktree of the checkout,
 * verification green.
 *
 * Nothing here imports a symbol the change adds, so this file loads at the
 * commit before it and each test fails on the behaviour it is about.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-unverified-"));

const GIT_STATUS = ["git", "status", "--porcelain"];

/** A one-commit checkout holding exactly the files it is given. */
function checkout(name: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

const manifest = (scripts: Record<string, string>): string =>
  `${JSON.stringify({ name: "fixture", private: true, scripts }, null, 2)}\n`;

/**
 * The install a fixture runs in place of the package manager's. The proposed
 * install is the manager's own and unchanged by any of this; running it would
 * measure the package store rather than the verification.
 */
const NO_INSTALL: InstallStrategy = {
  kind: "none",
  package_manager: "none",
  offline_preferred: true,
  lifecycle_scripts: { policy: "disabled", exception: null },
  command: ["true"],
  pinned: true,
};

/** The proposal provisioned and materialized, as an attempt's first minutes do. */
async function materializeProposal(dir: string, name: string, proposed: MaterializationManifest) {
  const workspace = await provision({
    repository_root: dir,
    repository_id: "repo_fixture",
    ticket_key: "PRB-1",
    ticket_id: `ticket_${name}`,
    outcome: `materialize ${name}`,
    base_commit: git(dir, "rev-parse", "HEAD").trim(),
    attempt_id: `att_${name}`,
    root: mkdtempSync(join(scratch, "worktrees-")),
    limits: DEFAULT_LIMITS_TABLE,
  });
  return materialize({ workspace, manifest: proposed, limits: DEFAULT_LIMITS_TABLE, warm: false });
}

describe("a repository whose scripts give a worktree nothing to run", () => {
  it("accepts a package that declares no test script, and still installs it", async () => {
    // The shape of a static site: a manifest for its deploy tooling, a
    // lockfile, and nothing that tests anything.
    const dir = checkout("static-site", {
      "package.json": manifest({ dev: "wrangler dev", deploy: "wrangler deploy" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "public/index.html": "<!doctype html>\n",
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    expect(result.findings.filter(isRefusal)).toEqual([]);
    expect(result.materializable).toBe(true);
    // An attempt may need the tools the package declares, so they are
    // installed whether or not anything tests them.
    expect(result.proposed?.install.command).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
    ]);
    expect(result.proposed?.verify.command).toEqual(GIT_STATUS);
    const finding = result.findings.find((f) => f.reason === "no_verification_command");
    expect(finding?.severity).toBe("advisory");
    expect(finding?.detail).toContain("git status --porcelain");

    const materialized = await materializeProposal(dir, "static-site", {
      ...result.proposed!,
      install: NO_INSTALL,
    });
    expect(materialized.verify?.code).toBe(0);
  });

  it("accepts a project whose package manager this build does not install with, installing nothing", async () => {
    const dir = checkout("python", {
      "pyproject.toml": '[project]\nname = "fixture"\nversion = "0.1.0"\n',
      "uv.lock": "version = 1\n",
      "src/fixture/__init__.py": "\n",
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    expect(result.findings.filter(isRefusal)).toEqual([]);
    expect(result.materializable).toBe(true);
    // Named, and not run: an install of kind `none` is never spawned.
    expect(result.proposed?.install.kind).toBe("none");
    expect(result.proposed?.install.package_manager).toBe("none");
    expect(result.proposed?.verify.command).toEqual(GIT_STATUS);
    const finding = result.findings.find((f) => f.reason === "unsupported_package_manager");
    expect(finding?.severity).toBe("advisory");
    expect(finding?.detail).toContain("uv.lock names uv");
    expect(finding?.detail).toContain("git status --porcelain");
    // Checks a person pins in `.perbo/config.json` still judge it.
    expect(finding?.detail).toContain("whichever checks are pinned");
    // No scripts were read, so nothing is claimed about a test script.
    expect(result.findings.map((f) => f.reason)).not.toContain("no_verification_command");

    // The proposal exactly as proposed: nothing installed, verification green.
    const materialized = await materializeProposal(dir, "python", result.proposed!);
    expect(materialized.install).toBeNull();
    expect(materialized.verify?.code).toBe(0);
  });

  it("accepts a package whose test script starts a service, and does not run that script", async () => {
    const dir = checkout("compose", {
      "package.json": manifest({ test: "docker compose up -d && vitest run" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    expect(result.findings.filter(isRefusal)).toEqual([]);
    expect(result.materializable).toBe(true);
    // The suite would run with the tests that need the service erroring or
    // skipping, and report green; it is not the verification.
    expect(result.proposed?.verify.command).toEqual(GIT_STATUS);
    const finding = result.findings.find((f) => f.reason === "verification_requires_service");
    expect(finding?.severity).toBe("advisory");
    expect(finding?.detail).toContain("docker compose up -d");
    expect(finding?.detail).toContain("git status --porcelain");
    // Its own reason, not a second one saying the package declares no test.
    expect(result.findings.map((f) => f.reason)).not.toContain("no_verification_command");

    const materialized = await materializeProposal(dir, "compose", {
      ...result.proposed!,
      install: NO_INSTALL,
    });
    expect(materialized.verify?.code).toBe(0);
  });
}, 120_000);

describe("which script a worktree can run as the verification", () => {
  it("falls through to the unit script where the test script starts a service", async () => {
    const dir = checkout("compose-unit", {
      "package.json": manifest({
        test: "docker compose up -d && vitest run",
        "test:unit": "vitest run --dir src",
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    // The suite a worktree can run is the verification, as it is the unit
    // check the same scripts give.
    expect(result.proposed?.verify.command).toEqual(["pnpm", "run", "test:unit"]);
    expect(result.findings.map((f) => f.reason)).not.toContain("verification_requires_service");
    expect(result.findings.map((f) => f.reason)).not.toContain("no_verification_command");
  });

  it("keeps a verification it is given, and says what that command starts", async () => {
    const dir = checkout("compose-given", {
      "package.json": manifest({ test: "docker compose up -d && vitest run" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const result = await diagnose({
      checkout: dir,
      repository_id: "repo_fixture",
      verify_command: ["pnpm", "run", "test"],
    });

    // The caller named the command; the diagnostic reports what it starts and
    // runs what it was given.
    expect(result.proposed?.verify.command).toEqual(["pnpm", "run", "test"]);
    const finding = result.findings.find((f) => f.reason === "verification_requires_service");
    expect(finding?.severity).toBe("advisory");
    expect(finding?.detail).not.toContain("git status --porcelain");
  });

  it("installs nothing where a lockfile names a manager and no package.json is there to install", async () => {
    const dir = checkout("lock-only", {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "src/index.js": "module.exports = 1;\n",
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    expect(result.findings.filter(isRefusal)).toEqual([]);
    expect(result.materializable).toBe(true);
    expect(result.proposed?.install.kind).toBe("none");
    expect(result.proposed?.verify.command).toEqual(GIT_STATUS);
    const finding = result.findings.find((f) => f.reason === "package_manifest_missing");
    expect(finding?.severity).toBe("advisory");
    expect(finding?.detail).toContain("pnpm-lock.yaml names pnpm");
    // There is no manifest, so nothing is said about the scripts it declares.
    expect(result.findings.map((f) => f.reason)).not.toContain("no_verification_command");

    const materialized = await materializeProposal(dir, "lock-only", result.proposed!);
    expect(materialized.install).toBeNull();
    expect(materialized.verify?.code).toBe(0);
  });

  it("installs a pnpm workspace with no root package.json, from its workspace file", async () => {
    const root = checkout("rootless-workspace", {
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "packages/api/package.json": `${JSON.stringify({ name: "@fixture/api", scripts: { test: "node -e 0" } })}\n`,
    });

    // pnpm installs such a workspace from `pnpm-workspace.yaml`, so there is
    // something to install, at the root and for each member.
    const atRoot = await diagnose({ checkout: root, repository_id: "repo_fixture" });
    expect(atRoot.proposed?.install.command).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
    ]);
    expect(atRoot.findings.map((f) => f.reason)).not.toContain("package_manifest_missing");

    const member = await diagnose({ checkout: join(root, "packages", "api"), repository_id: "repo_fixture" });
    expect(member.proposed?.install.command).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
      "--filter",
      "@fixture/api",
    ]);
    expect(member.proposed?.verify.command).toEqual(["pnpm", "run", "test"]);

    const materialized = await materializeProposal(root, "rootless-workspace", {
      ...atRoot.proposed!,
      install: NO_INSTALL,
    });
    expect(materialized.verify?.code).toBe(0);
  });

  it("says how it read a project whose only manifest is pyproject.toml", async () => {
    const dir = checkout("pyproject-only", {
      "pyproject.toml": '[project]\nname = "fixture"\nversion = "0.1.0"\n',
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    // Nothing in the file names uv: this build reads it as uv, and says so
    // rather than claiming the file does.
    const finding = result.findings.find((f) => f.reason === "unsupported_package_manager");
    expect(finding?.detail).toContain("this build reads pyproject.toml as uv");
    expect(finding?.detail).not.toContain("pyproject.toml names uv");
  });
}, 120_000);
