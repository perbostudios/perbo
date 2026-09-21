import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initRepository, scratchDirectories, type Repository } from "@perbo/test-support";
import { DEFAULT_LIMITS_TABLE } from "@perbo/contracts";
import { diagnose, unpinnedInstallEnv } from "./diagnostic.js";
import { materialize } from "./materialize.js";
import { provision } from "./worktree.js";

/**
 * A checkout that has no lockfile yet.
 *
 * The manifest names the package manager where no lockfile does, so the scripts
 * are read and the install proposed is the one that manager can run without a
 * lockfile — carried on the proposal as unpinned, with an advisory that says
 * what writes the lockfile. A checkout that names no manager at all is a
 * different answer: it installs nothing, and what verifies it is whether Git
 * can read the worktree.
 *
 * Nothing here imports a symbol the change adds, so this file loads at the
 * commit before it and each test fails on the behaviour it is about.
 */

const scratch = scratchDirectories("perbo-nolock-");
const scratchRoot = scratch();

/** A one-commit checkout holding exactly the files it is given. */
function checkout(name: string, files: Record<string, string>): Repository {
  return initRepository(mkdtempSync(join(scratchRoot, `${name}-`)), { files, message: "base" });
}

const manifest = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ name: "fixture", private: true, scripts: { test: "node --test" }, ...extra }, null, 2)}\n`;

const reasons = (result: { findings: Array<{ reason: string }> }): string[] =>
  result.findings.map((finding) => finding.reason);

describe("a checkout with no lockfile", () => {
  it("reads the manifest for the manager, and proposes an install that manager can run", async () => {
    const { dir } = checkout("npm", {
      "package.json": manifest(),
      "src/index.js": "module.exports = 1;\n",
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    expect(result.materializable).toBe(true);
    expect(result.proposed?.install.package_manager).toBe("npm");
    // The install writes no lockfile: it is the runner's install, and what it
    // leaves in the worktree is sealed into the attempt as the executor's work.
    expect(result.proposed?.install.command).toEqual([
      "npm",
      "install",
      "--ignore-scripts",
      "--no-package-lock",
    ]);
    expect(result.proposed?.install.pinned).toBe(false);
    // npm's cache holds metadata about versions rather than the versions, so
    // the command asks nothing of it and the strategy beside it says so.
    expect(result.proposed?.install.offline_preferred).toBe(false);
    // Its command already suppresses the lockfile, so its environment adds
    // nothing.
    expect(unpinnedInstallEnv(result.proposed!.install)).toEqual({});
    // The scripts were read, so the test script this manifest declares is the
    // verification command — and nothing says the repository declares none.
    expect(result.proposed?.verify.command).toEqual(["npm", "run", "test"]);
    expect(reasons(result)).not.toContain("no_verification_command");

    const advisory = result.findings.find((finding) => finding.reason === "lockfile_missing");
    expect(advisory?.severity).toBe("advisory");
    expect(advisory?.detail).toContain("npm install --package-lock-only");
  });

  it("takes the manager the packageManager field names", async () => {
    const { dir } = checkout("corepack", {
      "package.json": manifest({ packageManager: "pnpm@9.1.0" }),
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    expect(result.proposed?.install.package_manager).toBe("pnpm");
    // The pinned install without the flag that needs a lockfile: pnpm's store
    // holds the package contents, so an unpinned install still prefers what is
    // already on disk, and the strategy beside the command says so.
    expect(result.proposed?.install.command).toEqual([
      "pnpm",
      "install",
      "--prefer-offline",
      "--ignore-scripts",
    ]);
    expect(result.proposed?.install.pinned).toBe(false);
    expect(result.proposed?.install.offline_preferred).toBe(true);
    // The lockfile it would otherwise leave in the worktree is suppressed in
    // the install's environment rather than on the command line, so what a
    // configuration carries is a command a person can read and run.
    expect(unpinnedInstallEnv(result.proposed!.install)).toEqual({ npm_config_lockfile: "false" });

    const advisory = result.findings.find((finding) => finding.reason === "lockfile_missing");
    // The file whose absence is the reason, named rather than left as "no
    // lockfile", and what writes it.
    expect(advisory?.detail).toContain("pnpm-lock.yaml");
    expect(advisory?.detail).toContain("pnpm install --lockfile-only");
  });

  it("reproduces the lockfile's own install where the checkout has one", async () => {
    const { dir } = checkout("locked", {
      "package.json": manifest(),
      "package-lock.json": `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} })}\n`,
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    expect(result.materializable).toBe(true);
    expect(result.proposed?.install.command).toEqual([
      "npm",
      "ci",
      "--prefer-offline",
      "--ignore-scripts",
    ]);
    expect(result.proposed?.install.pinned).toBe(true);
    expect(result.proposed?.install.offline_preferred).toBe(true);
    // A pinned install reproduces the lockfile rather than writing one, so
    // there is nothing to suppress.
    expect(unpinnedInstallEnv(result.proposed!.install)).toEqual({});
    expect(reasons(result)).not.toContain("lockfile_missing");
  });

  it("materializes a checkout that names no package manager, installing nothing", async () => {
    const repository = checkout("bare", { "src/index.js": "module.exports = 1;\n" });
    const dir = repository.dir;

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    // A repository with nothing to install is still one an attempt can be made
    // against.
    expect(result.materializable).toBe(true);
    const finding = result.findings.find(
      (f) => f.reason === "package_manager_undetected",
    );
    expect(finding?.severity).toBe("advisory");
    expect(finding?.detail).toContain("package.json");

    // Nothing is installed, and the install command is never spawned for a
    // `none` strategy — so what matters is that the kind says so.
    expect(result.proposed?.install.kind).toBe("none");
    expect(result.proposed?.install.package_manager).toBe("none");

    // Verification still runs, so it has to be a command that means something:
    // the worktree is a checkout Git can read.
    expect(result.proposed?.verify.command).toEqual(["git", "status", "--porcelain"]);

    // No manifest was read, so nothing is claimed about the scripts it declares.
    expect(reasons(result)).not.toContain("no_verification_command");

    // And the proposal runs: a worktree of the checkout, nothing installed,
    // verification green.
    const workspace = await provision({
      repository_root: dir,
      repository_id: "repo_fixture",
      ticket_key: "PRB-1",
      ticket_id: "ticket_1",
      outcome: "materialize an empty repository",
      base_commit: repository.head,
      attempt_id: "att_1",
      root: mkdtempSync(join(scratchRoot, "worktrees-")),
      limits: DEFAULT_LIMITS_TABLE,
    });
    const materialized = await materialize({
      workspace,
      manifest: result.proposed!,
      limits: DEFAULT_LIMITS_TABLE,
      warm: false,
    });
    expect(materialized.install).toBeNull();
    expect(materialized.verify?.code).toBe(0);
  });

  it("verifies such a checkout with the command it is given, and says nothing of the default", async () => {
    const { dir } = checkout("bare-verified", { "src/index.js": "module.exports = 1;\n" });

    const result = await diagnose({
      checkout: dir,
      repository_id: "repo_fixture",
      verify_command: ["node", "--test"],
    });

    expect(result.materializable).toBe(true);
    expect(result.proposed?.verify.command).toEqual(["node", "--test"]);
    const finding = result.findings.find((f) => f.reason === "package_manager_undetected");
    expect(finding?.severity).toBe("advisory");
    expect(finding?.detail).not.toContain("git status");
  });

  it("materializes a checkout in an ecosystem this build does not read, judged by the review", async () => {
    const { dir } = checkout("cargo", {
      "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/main.rs": "fn main() {}\n",
    });

    const result = await diagnose({ checkout: dir, repository_id: "repo_fixture" });

    // Nothing here names a manager this build reads, so the repository is
    // accepted with nothing installed and a verification that only proves Git
    // can read the worktree, and the advisory says what that leaves.
    expect(result.materializable).toBe(true);
    expect(result.proposed?.install.kind).toBe("none");
    expect(result.proposed?.verify.command).toEqual(["git", "status", "--porcelain"]);
    const finding = result.findings.find((f) => f.reason === "package_manager_undetected");
    expect(finding?.severity).toBe("advisory");
    // Cargo.toml names cargo; what is true is that this build does not read it.
    expect(finding?.detail).toMatch(/^nothing here names a package manager this build reads \(/);
    expect(finding?.detail).toContain("judged by the review and whichever checks are pinned");
  });
});
