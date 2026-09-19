import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS_TABLE,
  LimitExceededError,
  LimitsTableSchema,
  MaterializationManifestSchema,
  SecretIndex,
  type InstallStrategy,
} from "@perbo/contracts";
import { MaterializationMeasurementSchema } from "@perbo/contracts";
import {
  assertAttemptFootprint,
  materialize,
  materializationEnv,
  materializeEntry,
} from "../src/materialize.js";
import { WorkspaceError, provision } from "../src/worktree.js";
import { diagnose, validateManifest } from "../src/diagnostic.js";
import { git, makeRepo } from "./support.js";

const scratch = () => mkdtempSync(join(tmpdir(), "perbo-mat-"));

describe("materializeEntry", () => {
  it("copies a secret and indexes it by content, not by name", () => {
    const source = scratch();
    const worktree = scratch();
    writeFileSync(join(source, ".env"), "API_KEY=sk_live_0123456789ab\n");
    const secrets = new SecretIndex();

    materializeEntry({
      worktree,
      source_checkout: source,
      secrets,
      entry: {
        path: ".env",
        kind: "file",
        source_path: ".env",
        strategy: "copy",
        secret: true,
        required: true,
        reason: "the application reads it at startup",
      },
    });

    expect(readFileSync(join(worktree, ".env"), "utf8")).toContain("sk_live_0123456789ab");
    expect(secrets.contains("some log line mentioning sk_live_0123456789ab")).toBe(true);
    expect(JSON.stringify(secrets.manifest())).not.toContain("sk_live_0123456789ab");
  });

  it("indexes a secret directory file by file", () => {
    const source = scratch();
    const worktree = scratch();
    mkdirSync(join(source, "certs"));
    writeFileSync(join(source, "certs", "dev.key"), "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n");
    const secrets = new SecretIndex();

    materializeEntry({
      worktree,
      source_checkout: source,
      secrets,
      entry: {
        path: "certs",
        kind: "directory",
        source_path: "certs",
        strategy: "copy",
        secret: true,
        required: true,
        reason: "local certificates",
      },
    });

    expect(existsSync(join(worktree, "certs", "dev.key"))).toBe(true);
    expect(secrets.contains("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC")).toBe(true);
  });

  it("refuses a required source that is not there", () => {
    expect(() =>
      materializeEntry({
        worktree: scratch(),
        source_checkout: scratch(),
        secrets: new SecretIndex(),
        entry: {
          path: ".env",
          kind: "file",
          source_path: ".env",
          strategy: "copy",
          secret: true,
          required: true,
          reason: "required",
        },
      }),
    ).toThrow(/required materialization source/);
  });
});

describe("materializationEnv", () => {
  it("builds the environment rather than inheriting it", () => {
    const env = materializationEnv({
      base: {
        PATH: "/usr/bin",
        HOME: "/home/u",
        NPM_TOKEN: "npm_secret_value",
        AWS_ACCESS_KEY_ID: "AKIA",
        DATABASE_URL: "postgres://production",
      },
      worktree: "/w",
      ports: { start: 41000, end: 41009, size: 10 },
      database_schema: "ayo_att_1",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PERBO_PORT_START).toBe("41000");
    expect(env.PERBO_DB_SCHEMA).toBe("ayo_att_1");
  });
});

describe("diagnose", () => {
  it("proposes the untracked files a fresh worktree would not have", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo.dir, ".env"), "SECRET_TOKEN=abcdef0123456789\n");
    mkdirSync(join(repo.dir, "certs"));
    writeFileSync(join(repo.dir, "certs", "dev.pem"), "-----BEGIN CERTIFICATE-----\n");

    const result = await diagnose({ checkout: repo.dir, repository_id: "repo_fixture" });
    const paths = result.proposed?.entries.map((entry) => entry.path) ?? [];
    expect(paths).toContain(".env");
    expect(result.proposed?.entries.find((entry) => entry.path === ".env")?.secret).toBe(true);
    expect(result.proposed?.install.lifecycle_scripts.policy).toBe("disabled");
    expect(result.proposed?.install.command).toContain("--ignore-scripts");
    expect(result.materializable).toBe(true);
  });

  it("does not propose build output or dependency trees", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo.dir, "node_modules"));
    writeFileSync(join(repo.dir, "node_modules", "x.js"), "//\n");
    const result = await diagnose({ checkout: repo.dir, repository_id: "repo_fixture" });
    const paths = result.proposed?.entries.map((entry) => entry.path) ?? [];
    expect(paths).not.toContain("node_modules");
  });

  it("names a repository with no verification command, and verifies it with Git", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo.dir, "package.json"), JSON.stringify({ name: "x" }));
    const result = await diagnose({ checkout: repo.dir, repository_id: "repo_fixture" });
    expect(result.materializable).toBe(true);
    const finding = result.findings.find((f) => f.reason === "no_verification_command");
    expect(finding?.severity).toBe("advisory");
    expect(result.proposed?.verify.command).toEqual(["git", "status", "--porcelain"]);
  });

  it("names an unsupported package manager rather than trying it", async () => {
    const bare = mkdtempSync(join(tmpdir(), "perbo-uv-"));
    writeFileSync(join(bare, "uv.lock"), "version = 1\n");
    writeFileSync(
      join(bare, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "true" } }),
    );
    const result = await diagnose({ checkout: bare, repository_id: "repo_py" });
    const finding = result.findings.find((f) => f.reason === "unsupported_package_manager");
    expect(finding?.severity).toBe("advisory");
    // Not tried: nothing is installed, and the scripts are not read.
    expect(result.proposed?.install.kind).toBe("none");
    expect(result.proposed?.verify.command).toEqual(["git", "status", "--porcelain"]);
  });

  it("reports a required entry whose source has since disappeared", async () => {
    const manifest = MaterializationManifestSchema.parse({
      manifest_version: 1,
      repository_id: "repo_x",
      source_checkout: scratch(),
      entries: [
        {
          path: ".env",
          kind: "file",
          source_path: ".env",
          strategy: "copy",
          secret: true,
          required: true,
          reason: "needed",
        },
      ],
      install: {
        kind: "none",
        package_manager: "none",
        offline_preferred: true,
        lifecycle_scripts: { policy: "disabled", exception: null },
        command: ["true"],
        pinned: true,
      },
      verify: { command: ["true"], timeout_ms: 5000 },
      isolation: {
        mode: "parallel",
        port_range_size: 0,
        port_range_start: 41000,
        port_range_end: 41000,
        database_schema_prefix: null,
      },
    });
    expect(validateManifest(manifest).map((f) => f.reason)).toEqual(["required_entry_missing"]);
  });
});

describe("materialize", () => {
  it("makes the worktree runnable and reports what it cost", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo.dir, ".env"), "TOKEN=abcdefghijklmnop\n");
    const root = scratch();
    const workspace = await provision({
      repository_root: repo.dir,
      repository_id: "repo_fixture",
      ticket_key: "PRB-1",
      ticket_id: "ticket_1",
      outcome: "materialize",
      base_commit: repo.head,
      attempt_id: "att_1",
      root,
      limits: DEFAULT_LIMITS_TABLE,
    });
    const diagnostic = await diagnose({ checkout: repo.dir, repository_id: "repo_fixture" });
    const manifest = MaterializationManifestSchema.parse({
      ...diagnostic.proposed,
      install: {
        kind: "none",
        package_manager: "none",
        offline_preferred: true,
        lifecycle_scripts: { policy: "disabled", exception: null },
        command: ["true"],
        pinned: true,
      },
      verify: { command: ["node", "-e", "process.exit(0)"], timeout_ms: 30_000 },
      isolation: {
        mode: "parallel",
        port_range_size: 2,
        port_range_start: 44100,
        port_range_end: 44101,
        database_schema_prefix: "ayo_",
      },
    });

    const result = await materialize({ workspace, manifest, limits: DEFAULT_LIMITS_TABLE, warm: false });
    expect(result.verify?.code).toBe(0);
    expect(existsSync(join(workspace.path, ".env"))).toBe(true);
    expect(result.secrets.contains("abcdefghijklmnop")).toBe(true);
    expect(result.ports.size).toBe(2);
    expect(result.database_schema).toMatch(/^ayo_att_1$/);
    expect(result.measurement.total_ms).toBeGreaterThanOrEqual(0);
  });

  it("refuses when the attempt's disk footprint exceeds the laptop ceiling", () => {
    // Driven from a measurement rather than from a real install: on a machine
    // with a warm package store the real footprint is legitimately near zero,
    // so a test that tries to provoke a refusal by installing something is
    // measuring the store's state rather than the ceiling.
    const measurement = MaterializationMeasurementSchema.parse({
      provision_ms: 0,
      materialize_ms: 0,
      install_ms: 0,
      verify_ms: 0,
      total_ms: 0,
      steady_state_bytes: 900,
      peak_bytes: 1_500,
      warm: false,
      install_strategy: "shared_store",
      package_manager: "pnpm",
    });
    const tight = LimitsTableSchema.parse({
      organisation: "test",
      limits: { local_workspace_bytes: 1_000 },
    });
    expect(() => assertAttemptFootprint(tight, measurement)).toThrow(LimitExceededError);

    const roomy = LimitsTableSchema.parse({
      organisation: "test",
      limits: { local_workspace_bytes: 2_000 },
    });
    expect(() => assertAttemptFootprint(roomy, measurement)).not.toThrow();
  });
});

/**
 * Where the install and the verification actually run.
 *
 * A command and the directory it runs in are one answer: `pnpm install --filter
 * @scope/api` is the workspace root's install, and the same argv in a directory
 * that is not a workspace root is a different thing that happens to be spelled
 * the same. So what the derivation says about the directory has to reach the
 * process, and where the worktree cannot offer that directory the run has to
 * say so rather than run the command somewhere else.
 *
 * Nothing here runs a package manager: the install and the verification are
 * `node` programs that record where they were run and what they could see from
 * there, which is exactly the question.
 */

/** A command that records its own working directory in `file`, in that directory. */
const recordCwd = (file: string): string[] => [
  "node",
  "-e",
  `require("node:fs").writeFileSync(${JSON.stringify(file)}, process.cwd())`,
];

const RUNS: InstallStrategy = {
  kind: "shared_store",
  package_manager: "pnpm",
  offline_preferred: false,
  lifecycle_scripts: { policy: "disabled", exception: null },
  command: recordCwd("install-cwd.txt"),
  pinned: true,
};

/**
 * One package of a monorepo that is its own Git repository: the
 * `pnpm-workspace.yaml` that makes it a member, and the lockfile its install
 * would reproduce, are in the directory **above** the repository. A worktree of
 * this repository is a checkout of the package alone, so the workspace root the
 * install is derived at is not in it.
 *
 * The workspace root declares a `test` script of its own, so which
 * `package.json` a command run in the worktree reads is visible in its answer.
 */
function memberRepository(): { workspace: string; member: string; head: string } {
  const workspace = mkdtempSync(join(tmpdir(), "perbo-monorepo-"));
  writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - 'services/*'\n");
  writeFileSync(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "monorepo", private: true, scripts: { test: "turbo run test" } }),
  );
  const member = join(workspace, "services", "api");
  mkdirSync(member, { recursive: true });
  git(member, "init", "-q", "-b", "main");
  git(member, "config", "user.name", "test");
  git(member, "config", "user.email", "test@example.com");
  git(member, "config", "commit.gpgsign", "false");
  writeFileSync(join(member, ".gitignore"), ".env\nnode_modules/\n");
  // Untracked and needed: the diagnostic proposes it as an entry, so whether it
  // reached the worktree says whether materialization got that far.
  writeFileSync(join(member, ".env"), "TOKEN=abcdefghijklmnop\n");
  writeFileSync(
    join(member, "package.json"),
    JSON.stringify({ name: "@fixture/api", scripts: { test: "vitest run services/api" } }),
  );
  git(member, "add", "-A");
  git(member, "commit", "-qm", "first");
  return { workspace, member, head: git(member, "rev-parse", "HEAD").trim() };
}

/**
 * A monorepo that is **one** Git repository, which is what a monorepo usually
 * is: the workspace root is the repository root and the package a run is
 * pointed at is a directory inside it. Git checks out repositories rather than
 * directories, so a worktree of this holds both roots — the workspace root at
 * its own root, the package at `services/api` — and each command has a
 * directory of its own to run in.
 *
 * Both `package.json`s declare a `test` script and they are different scripts,
 * so which directory a command ran in is visible in what it read.
 */
function monorepoRepository(args: { ignoreMember?: boolean } = {}): {
  root: string;
  member: string;
  head: string;
} {
  const root = mkdtempSync(join(tmpdir(), "perbo-monorepo-one-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'services/*'\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "monorepo", private: true, scripts: { test: "turbo run test" } }),
  );
  writeFileSync(
    join(root, ".gitignore"),
    `node_modules/\n${args.ignoreMember === true ? "services/api/\n" : ""}`,
  );
  const member = join(root, "services", "api");
  mkdirSync(member, { recursive: true });
  writeFileSync(
    join(member, "package.json"),
    JSON.stringify({ name: "@fixture/api", scripts: { test: "vitest run services/api" } }),
  );
  git(root, "add", "-A");
  git(root, "commit", "-qm", "first");
  return { root, member, head: git(root, "rev-parse", "HEAD").trim() };
}

let attempt = 0;

/** A worktree of `repository`, one per call. */
async function worktreeOf(repository: string, head: string) {
  attempt += 1;
  return provision({
    repository_root: repository,
    repository_id: "repo_fixture",
    ticket_key: "PRB-1",
    ticket_id: `ticket_cwd_${attempt}`,
    outcome: `install directory ${attempt}`,
    base_commit: head,
    attempt_id: `att_cwd_${attempt}`,
    root: scratch(),
    limits: DEFAULT_LIMITS_TABLE,
  });
}

const manifestFor = (workspace: { repository_root: string }, install: InstallStrategy, verify: string[]) =>
  MaterializationManifestSchema.parse({
    manifest_version: 1,
    repository_id: "repo_fixture",
    source_checkout: workspace.repository_root,
    entries: [],
    install,
    verify: { command: verify, timeout_ms: 30_000 },
    isolation: {
      mode: "parallel",
      port_range_size: 0,
      port_range_start: 44200,
      port_range_end: 44200,
      database_schema_prefix: null,
    },
  });

describe("the directory the install runs in", () => {
  it("runs it in the worktree for a checkout that is its own workspace", async () => {
    const repo = makeRepo();
    const workspace = await worktreeOf(repo.dir, repo.head);

    const result = await materialize({
      workspace,
      manifest: manifestFor(workspace, RUNS, ["node", "-e", "process.exit(0)"]),
      limits: DEFAULT_LIMITS_TABLE,
      warm: false,
    });

    // The install ran, and it ran in the worktree: the file it wrote is there,
    // and the directory it recorded is that one.
    expect(result.install?.code).toBe(0);
    expect(readFileSync(join(workspace.path, "install-cwd.txt"), "utf8")).toBe(
      realpathSync(workspace.path),
    );
  });

  it("refuses a filtered install whose workspace root the worktree does not contain", async () => {
    const { workspace: monorepo, member, head } = memberRepository();
    const worktree = await worktreeOf(member, head);
    // The shipped derivation, not a command written for this test: the install
    // the diagnostic proposes for this package, narrowed to it.
    const diagnostic = await diagnose({ checkout: member, repository_id: "repo_fixture" });
    const proposed = diagnostic.proposed;
    expect(proposed?.install.command).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
      "--filter",
      "@fixture/api",
    ]);
    expect(proposed?.entries.map((entry) => entry.path)).toContain(".env");

    const refused = await materialize({
      workspace: worktree,
      manifest: MaterializationManifestSchema.parse({ ...proposed, source_checkout: member }),
      limits: DEFAULT_LIMITS_TABLE,
      warm: false,
    }).catch((error: unknown) => error);

    // Named, and naming both directories: the workspace root the install is
    // derived at, and the worktree that does not contain it.
    expect(refused).toBeInstanceOf(WorkspaceError);
    const error = refused as WorkspaceError;
    expect(error.reason).toBe("install_root_outside_worktree");
    expect(error.message).toContain(monorepo);
    expect(error.message).toContain(worktree.path);
    expect(error.message).toContain("--filter @fixture/api");
    // And refused before anything was done: no install ran here or in the
    // person's own workspace, and the entry the manifest requires — which is
    // copied before the install — is not in the worktree either.
    expect(existsSync(join(worktree.path, "node_modules"))).toBe(false);
    expect(existsSync(join(monorepo, "node_modules"))).toBe(false);
    expect(existsSync(join(worktree.path, ".env"))).toBe(false);
  });

  it("runs an install that narrows to nothing in the worktree, member or not", async () => {
    const { member, head } = memberRepository();
    const worktree = await worktreeOf(member, head);

    // A command a person could have written into `.perbo/config.json` for this
    // package: it asks nothing of a workspace root, so the worktree is where it
    // runs and there is nothing to refuse.
    const result = await materialize({
      workspace: worktree,
      manifest: manifestFor(worktree, RUNS, ["node", "-e", "process.exit(0)"]),
      limits: DEFAULT_LIMITS_TABLE,
      warm: false,
    });

    expect(result.install?.code).toBe(0);
    expect(readFileSync(join(worktree.path, "install-cwd.txt"), "utf8")).toBe(
      realpathSync(worktree.path),
    );
  });
});

describe("the worktree's measured size", () => {
  it("is measured on a machine with no `du`, which Windows does not have", async () => {
    const repo = makeRepo();
    const workspace = await worktreeOf(repo.dir, repo.head);
    // Nothing on PATH at all: a `none` install spawns nothing, and the
    // verification names its binary by path.
    const empty = scratch();

    const result = await materialize({
      workspace,
      manifest: manifestFor(
        workspace,
        { ...RUNS, kind: "none", package_manager: "none", command: ["true"] },
        [process.execPath, "-e", "process.exit(0)"],
      ),
      limits: DEFAULT_LIMITS_TABLE,
      warm: false,
      baseEnv: { PATH: empty, HOME: process.env.HOME ?? "" },
    });

    expect(result.verify?.code).toBe(0);
    expect(result.apparent_bytes).toBeGreaterThan(0);
  });
});

describe("the directory the verification runs in", () => {
  it("runs it where the scripts it was derived from live", async () => {
    const { workspace: monorepo, member, head } = memberRepository();
    const worktree = await worktreeOf(member, head);
    // What the derivation says the verification is: this package's own `test`,
    // and not the workspace root's script of the same name.
    const diagnostic = await diagnose({ checkout: member, repository_id: "repo_fixture" });
    expect(diagnostic.proposed?.verify.command).toEqual(["pnpm", "run", "test"]);

    const result = await materialize({
      workspace: worktree,
      manifest: manifestFor(
        worktree,
        { ...RUNS, kind: "none", package_manager: "none", command: ["true"] },
        [
          "node",
          "-e",
          'require("node:fs").writeFileSync("verify.json", JSON.stringify({' +
            "cwd: process.cwd()," +
            'test: require("node:fs").readFileSync("package.json", "utf8"),' +
            "}))",
        ],
      ),
      limits: DEFAULT_LIMITS_TABLE,
      warm: false,
    });

    expect(result.verify?.code).toBe(0);
    const seen = JSON.parse(readFileSync(join(worktree.path, "verify.json"), "utf8")) as {
      cwd: string;
      test: string;
    };
    // `pnpm run test` there would have run the member's script, which is the
    // one the derivation named — not the workspace root's `turbo run test`,
    // which runs every package.
    expect(seen.cwd).toBe(realpathSync(worktree.path));
    expect(JSON.parse(seen.test).scripts.test).toBe("vitest run services/api");
    expect(seen.test).not.toContain("turbo run test");
    expect(readFileSync(join(monorepo, "package.json"), "utf8")).toContain("turbo run test");
  });

  it("runs it in the package's own directory when the worktree holds the whole monorepo", async () => {
    const { root, member, head } = monorepoRepository();
    // The worktree is a checkout of the repository, because that is the only
    // thing Git checks out — and the run was pointed at one package of it.
    const worktree = await worktreeOf(root, head);
    const pointedAtMember = { ...worktree, repository_root: member };

    // The shipped derivation, read against the package on disk: its own `test`,
    // through the manager the workspace's lockfile names.
    const diagnostic = await diagnose({ checkout: member, repository_id: "repo_fixture" });
    expect(diagnostic.proposed?.verify.command).toEqual(["pnpm", "run", "test"]);

    const result = await materialize({
      workspace: pointedAtMember,
      manifest: manifestFor(
        pointedAtMember,
        // An install narrowed to the member, as the derivation proposes for it.
        { ...RUNS, command: [...recordCwd("install-cwd.txt"), "--", "--filter", "@fixture/api"] },
        [
          "node",
          "-e",
          'require("node:fs").writeFileSync("verify.json", JSON.stringify({' +
            "cwd: process.cwd()," +
            'read: require("node:fs").readFileSync("package.json", "utf8"),' +
            "}))",
        ],
      ),
      limits: DEFAULT_LIMITS_TABLE,
      warm: false,
    });

    // The verification ran in the package's directory inside the worktree, and
    // the `package.json` a script name would have been resolved against there
    // is the member's — not the workspace root's `turbo run test`, which is a
    // different suite and runs every package.
    expect(result.verify?.code).toBe(0);
    const memberDirectory = realpathSync(join(worktree.path, "services", "api"));
    const seen = JSON.parse(readFileSync(join(memberDirectory, "verify.json"), "utf8")) as {
      cwd: string;
      read: string;
    };
    expect(seen.cwd).toBe(memberDirectory);
    expect(seen.cwd).not.toBe(realpathSync(worktree.path));
    expect(JSON.parse(seen.read).name).toBe("@fixture/api");
    expect(JSON.parse(seen.read).scripts.test).toBe("vitest run services/api");
    // The other script really is there to have been run instead: the worktree
    // holds the workspace root's `package.json` at its own root.
    expect(readFileSync(join(worktree.path, "package.json"), "utf8")).toContain("turbo run test");

    // And the install ran at the workspace root's counterpart — the worktree
    // root — rather than being refused for a workspace root the worktree does
    // hold, one directory above the package.
    expect(result.install?.code).toBe(0);
    expect(readFileSync(join(worktree.path, "install-cwd.txt"), "utf8")).toBe(
      realpathSync(worktree.path),
    );
  });

  it("refuses where the worktree does not hold the directory those scripts live in", async () => {
    // The package is in the person's checkout and Git is ignoring it, so the
    // commit the worktree is made from does not carry it.
    const { root, member, head } = monorepoRepository({ ignoreMember: true });
    const worktree = await worktreeOf(root, head);
    expect(existsSync(join(worktree.path, "services", "api"))).toBe(false);

    const refused = await materialize({
      workspace: { ...worktree, repository_root: member },
      manifest: manifestFor(
        { repository_root: member },
        RUNS,
        ["node", "-e", 'require("node:fs").writeFileSync("verify.json", process.cwd())'],
      ),
      limits: DEFAULT_LIMITS_TABLE,
      warm: false,
    }).catch((error: unknown) => error);

    // Named, and naming the directory the scripts would have been read in: the
    // alternative is running whatever `test` script the worktree root declares,
    // which is not the one the manifest describes.
    expect(refused).toBeInstanceOf(WorkspaceError);
    const error = refused as WorkspaceError;
    expect(error.reason).toBe("verify_root_outside_worktree");
    expect(error.message).toContain(join(worktree.path, "services", "api"));
    expect(error.message).toContain(worktree.path);
    // Refused before anything ran: no install, and no verification at the
    // worktree root either.
    expect(existsSync(join(worktree.path, "install-cwd.txt"))).toBe(false);
    expect(existsSync(join(worktree.path, "verify.json"))).toBe(false);
  });
});
