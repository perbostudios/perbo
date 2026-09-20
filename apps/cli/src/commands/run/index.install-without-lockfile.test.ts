import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import {
  parseExecuteArgs,
  runDoctorCommand,
  runExecuteCommand,
  type ExecuteOptions,
} from "./index.js";
import { storeDir } from "../../store/index.js";

/**
 * A first run on a repository that has no lockfile yet.
 *
 * Such a checkout used to be refused before anything was provisioned, on the
 * grounds that no reproducible install could be declared — and, because the
 * manager is what decides whether the scripts are read at all, refused a second
 * time for declaring no test script when it declares one. It runs now: the
 * manifest names the manager, the install is the one that manager can run
 * without a lockfile, and the person is told once, in the run and in `doctor`,
 * that the install is unpinned and what writes the lockfile.
 *
 * The same question — which install does this checkout get, and where does it
 * run — has a second answer when the checkout is one package of a monorepo,
 * and the last three groups below are about that: the install runs at the
 * workspace root filtered to the package, `doctor` reports both roots, and a
 * workspace whose manager this build does not install with is answered as
 * such a manager at a plain root is.
 *
 * The reviewer is a double and the executor is a real program this file writes;
 * the argument parsing, the configuration merge, the diagnostic, the worktree,
 * the install, the seal and the pinned checks are the shipped ones.
 *
 * Nothing here imports a symbol the change adds, so this file loads at the
 * commit before it and each test fails on the behaviour it is about.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-no-lockfile-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnv });

/**
 * One commit, a `test` script, no lockfile and no `.perbo/` — the two-file npm
 * package a person points the loop at in their first hour. `node_modules` is
 * ignored because the worktree's install writes it and it is not the change.
 */
function repository(name: string, manifest: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv });
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        private: true,
        scripts: { test: 'node -e "process.exit(0)"' },
        ...manifest,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const version = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

/** An executor that writes one file, as a real program the runner spawns. */
function agent(name: string): string {
  const dir = mkdtempSync(join(scratch, `agent-${name}-`));
  const binary = join(dir, "agent.cjs");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
"use strict";
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

if (process.argv.includes("--version")) {
  process.stdout.write("fake-agent 1.0.0\\n");
  process.exit(0);
}

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  mcp_servers: [],
  plugins: [],
  skills: [],
  agents: [],
  memory_paths: null,
});
const input = { file_path: "src/feature.ts", content: "export const total = 1;\\n" };
emit({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id: "toolu_fake_1", name: "Write", input }],
    usage: { input_tokens: 7, output_tokens: 2 },
  },
});
const path = join(process.cwd(), input.file_path);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, input.content);
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.004,
  permission_denials: [],
});
process.exit(0);
`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return binary;
}

/** The machine, answered rather than measured: what is on PATH is not the subject. */
const okPreflight = (_request: PreflightRequest): PreflightResult => ({
  ok: true,
  findings: [],
  tools: {},
  github: null,
});

/**
 * The one key a test must not inherit — the worktree root, whose derived
 * default is under `$HOME` — and the agent. Deliberately says nothing about
 * `materialization_manifest`: the manifest this run installs from is the one
 * the diagnostic proposes from the checkout, which is the subject.
 */
function runConfig(name: string): string {
  const path = join(scratch, `${name}.config.json`);
  writeFileSync(
    path,
    JSON.stringify({
      worktree_root: join(scratch, `${name}-worktrees`),
      agent_binary: agent(name),
      model: "double",
      limits: { organisation: "test", limits: { concurrent_local_attempts: 4 } },
    }),
  );
  return path;
}

/** A reviewer that approves, priced, with no provider behind it. */
const reviewer =
  () =>
  async (request: { changeset?: { changeset_id: string }; head_commit?: string }) => ({
    artifact: {
      schema_version: 1,
      review_id: "rev_0000000000000001",
      created_at: "2026-09-06T00:00:00.000Z",
      target: {
        type: "changeset",
        id: request.changeset?.changeset_id ?? "cs_0000000000000001",
        base_commit: "abc1234",
        head_commit: request.head_commit ?? "def5678",
      },
      plan_id: "plan_x",
      plan_version: 1,
      planned_risk: "P1",
      actual_risk: "P1",
      escalated: false,
      independence: {
        context_builder: "reviewer_v2",
        executor_narrative_visible: false,
        executor_transcript_visible: false,
        separate_process: true,
        model_family: "same",
        grounded_in: ["plan.acceptance_criteria", "diff", "check_results", "selected_files"],
      },
      context_manifest: [],
      checks: [],
      overrides: [],
      coverage: [
        {
          criterion_id: "ac_1",
          status: "met",
          verification_strength: "directly_verified",
          evidence: null,
          note: null,
        },
      ],
      findings: [],
      scope_deviation: {
        files_outside_scope: [],
        files_in_prohibited_paths: [],
        files_exempt_as_generated: [],
        within_expansion_budget: true,
        expansion_budget_files: 3,
      },
      decision: "approve",
      confidence: 0.9,
      cost_micros: 210_000,
      latency_ms: 100,
      model: {
        provider: "stub",
        model_id: "stub",
        prompt_version: "reviewer_v2",
        input_tokens: 1,
        output_tokens: 1,
      },
      error: null,
    },
    bundle: {
      prompt_version: "reviewer_v2",
      system_prompt: "s",
      turns: [],
      files_read: [],
      rejected_verdicts: [],
    },
  });

interface RunJson {
  rounds: Array<{ checks: Array<{ name: string; status: string; command: string | null }> }>;
}

const OUTCOME = "The feature module exports a computed total";
const CRITERION = "total() returns the sum of its inputs :: total([1,2]) is 3 :: test";

async function loop(
  repo: string,
  argv: readonly string[],
  options: Omit<ExecuteOptions, "args" | "streams" | "cwd"> = {},
): Promise<{ code: number; err: string; out: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runExecuteCommand({
    args: parseExecuteArgs([
      "--repo",
      repo,
      "--outcome",
      OUTCOME,
      "--criterion",
      CRITERION,
      "--path",
      "src/**",
      "--json",
      ...argv,
    ]),
    streams: {
      stdout: (chunk: string) => out.push(chunk),
      stderr: (chunk: string) => err.push(chunk),
      isTTY: false,
    },
    cwd: repo,
    preflight: okPreflight,
    hooks: { review: reviewer() as never },
    ...options,
  });
  // The report is returned unparsed: a run that refuses writes nothing to
  // stdout, and a test that parses eagerly fails on the JSON rather than on
  // the line it is about.
  return { code, err: err.join(""), out: out.join("") };
}

interface AttemptRecord {
  environment: { install_pinned?: boolean };
  termination: { reason: string; detail: string };
  base_commit: string;
  head_commit: string | null;
}

/** The one attempt this repository's record holds. */
function attempt(repo: string): AttemptRecord {
  const dir = join(storeDir(repo, null), "state");
  const files = readdirSync(dir).filter((name) => name.endsWith(".attempts.json"));
  expect(files).toHaveLength(1);
  const record = JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as {
    attempts: AttemptRecord[];
  };
  expect(record.attempts.length).toBeGreaterThan(0);
  return record.attempts[0]!;
}

/** The paths the attempt sealed, read from the branch it sealed them on. */
function sealedPaths(repo: string, one: AttemptRecord): string[] {
  expect(one.head_commit).not.toBeNull();
  return git(repo, "diff", "--name-only", one.base_commit, one.head_commit!)
    .split("\n")
    .filter((path) => path.length > 0);
}

const capture = (isTTY: boolean) => {
  const out: string[] = [];
  return {
    out,
    streams: {
      stdout: (chunk: string) => out.push(chunk),
      stderr: () => undefined,
      isTTY,
    },
  };
};

describe("a run on a repository with no lockfile", () => {
  it("says the install is unpinned, names what pins it, and runs", async () => {
    const repo = repository("run");
    const result = await loop(repo, ["--config", runConfig("run")]);

    const line = result.err.split("\n").filter((text) => text.trimStart().startsWith("install "));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("npm install --ignore-scripts --no-package-lock");
    expect(line[0]).toContain("unpinned");
    expect(line[0]).toContain("npm install --package-lock-only");

    // Past the diagnostic that used to stop here: a worktree was provisioned,
    // the repository's own test script ran as the pinned check, and the run
    // ended on its own terms.
    expect(result.err).toContain("worktree ");
    const report = JSON.parse(result.out) as RunJson;
    expect(report.rounds[0]!.checks.map((check) => check.name)).toEqual(["test"]);
    expect(report.rounds[0]!.checks[0]!.status).toBe("passed");

    // The install is the runner's own doing, and what it writes is not the
    // executor's work. The seal carries the one file the agent wrote and no
    // lockfile the install left in the worktree, so the attempt ends on its own
    // terms rather than as a defect in the guard that never saw that write.
    const one = attempt(repo);
    expect(one.termination.reason).toBe("completed");
    expect(sealedPaths(repo, one)).toEqual(["src/feature.ts"]);
    expect(result.code).toBe(0);

    // And the record says what the attempt was judged on, so a later reading of
    // the run knows the tree was not reproducible from the repository alone.
    expect(one.environment.install_pinned).toBe(false);
  }, 300_000);

  it("prints nothing about the install where a lockfile pins it", async () => {
    const repo = repository("pinned");
    writeFileSync(
      join(repo, "package-lock.json"),
      `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} }, null, 2)}\n`,
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "lockfile");

    const result = await loop(repo, ["--config", runConfig("pinned")]);

    expect(result.err.split("\n").filter((text) => text.trimStart().startsWith("install "))).toEqual(
      [],
    );
    expect(result.code).toBe(0);
    expect(attempt(repo).environment.install_pinned).toBe(true);
  }, 300_000);
});

describe("doctor on a repository with no lockfile", () => {
  it("reports the install as unpinned, and names the advisory", async () => {
    const repo = repository("doctor");

    const reported = capture(false);
    const code = await runDoctorCommand({
      args: parseExecuteArgs(["--repo", repo, "--json"]),
      streams: reported.streams,
      cwd: repo,
      preflight: okPreflight,
    });

    const report = JSON.parse(reported.out.join("")) as {
      materializable: boolean;
      findings: Array<{ reason: string; severity: string; detail: string }>;
      proposed: { install: { command: string[]; pinned: boolean } };
      config: { proposed: { materialization_manifest: { install: { pinned: boolean } } } };
    };
    expect(code).toBe(0);
    expect(report.materializable).toBe(true);
    expect(report.proposed.install.command).toEqual([
      "npm",
      "install",
      "--ignore-scripts",
      "--no-package-lock",
    ]);
    expect(report.proposed.install.pinned).toBe(false);
    // And the file doctor offers carries the same answer.
    expect(report.config.proposed.materialization_manifest.install.pinned).toBe(false);

    const advisory = report.findings.find((finding) => finding.reason === "lockfile_missing");
    expect(advisory?.severity).toBe("advisory");
    expect(advisory?.detail).toContain("npm install --package-lock-only");

    // The report a person reads says it too, rather than only the JSON.
    const shown = capture(true);
    await runDoctorCommand({
      args: parseExecuteArgs(["--repo", repo]),
      streams: shown.streams,
      cwd: repo,
      preflight: okPreflight,
    });
    const text = shown.out.join("");
    expect(text).toContain("advisory  lockfile_missing");
    expect(text).toContain("unpinned");
  }, 120_000);
});

/**
 * The file `doctor --write-config` writes for such a repository (SCP-285).
 *
 * It has to hold the install the repository can actually run — the unpinned
 * one, without the flag that needs a lockfile — because that file is what every
 * later run installs from and `doctor` refuses to rewrite it. And because the
 * file outlives the state it was written from, a later `doctor` reads it back
 * against the checkout: consistent while it still is, and naming what to change
 * from the moment the repository commits a lockfile the configuration predates.
 */

/** A checkout whose manifest names pnpm, which is the manager D-013 leads with. */
const pnpmRepository = (name: string): string =>
  repository(name, { packageManager: "pnpm@9.1.0" });

/** A lockfile committed after the fact, which is how a repository gains one. */
function commitLockfile(dir: string): void {
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "lockfile");
}

interface DoctorReport {
  materializable: boolean;
  findings: Array<{ reason: string; severity: string; detail: string }>;
  proposed: { install: { command: string[]; pinned: boolean } } | null;
  config: {
    written: boolean;
    proposed: {
      materialization_manifest: { install: { command: string[]; pinned: boolean } };
    } | null;
    install: {
      command: string[];
      pinned: boolean;
      checkout: { command: string[]; pinned: boolean };
      consistent: boolean;
      advisory: { reason: string; detail: string } | null;
    } | null;
  };
}

/** One `doctor`, as JSON or as the report a person reads. */
async function doctor(
  repo: string,
  options: { write?: boolean; human?: boolean } = {},
): Promise<{ text: string; code: number }> {
  const shown = capture(options.human === true);
  const code = await runDoctorCommand({
    args: parseExecuteArgs([
      "--repo",
      repo,
      ...(options.human ? [] : ["--json"]),
      ...(options.write ? ["--write-config"] : []),
    ]),
    streams: shown.streams,
    cwd: repo,
    preflight: okPreflight,
  });
  return { text: shown.out.join(""), code };
}

const reportedBy = async (repo: string, write = false): Promise<DoctorReport> =>
  JSON.parse((await doctor(repo, { write })).text) as DoctorReport;

/** The install the configuration on disk actually holds. */
function writtenInstall(repo: string): { command: string[]; pinned: boolean } {
  const config = JSON.parse(
    readFileSync(join(storeDir(repo, null), "config.json"), "utf8"),
  ) as { materialization_manifest: { install: { command: string[]; pinned: boolean } } };
  const install = config.materialization_manifest.install;
  return { command: install.command, pinned: install.pinned };
}

const UNPINNED = ["pnpm", "install", "--prefer-offline", "--ignore-scripts"];
const FROZEN = ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"];

describe("doctor --write-config on a repository that names no package manager", () => {
  it("pins the manifest, and says when the repository has outgrown it", async () => {
    const repo = checkout("write-bare", { "README.md": "# fixture\n" });

    const written = await reportedBy(repo, true);
    expect(written.materializable).toBe(true);
    expect(written.config.written).toBe(true);
    // The install that installs nothing, pinned where every later run reads it.
    expect(writtenInstall(repo)).toEqual({ command: ["true"], pinned: true });
    expect((await reportedBy(repo)).config.install?.advisory).toBeNull();

    // The repository then names a manager and declares a suite.
    writeFileSync(
      join(repo, "package.json"),
      `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2)}\n`,
    );
    commitLockfile(repo);

    const later = await reportedBy(repo);
    const advisory = later.config.install?.advisory;
    expect(advisory?.reason).toBe("install_outgrown");
    expect(advisory?.detail).toContain("pnpm-lock.yaml now names pnpm");
    // Advisory: it names something to change in a file the person owns.
    const shown = await doctor(repo, { human: true });
    expect(shown.text).toContain("advisory  install_outgrown");
    expect(shown.code).toBe(0);
  }, 120_000);

  it("says nothing when the repository gains a lockfile with no package.json to install", async () => {
    const repo = checkout("write-bare-lock-only", { "README.md": "# fixture\n" });
    await doctor(repo, { write: true });

    // A lockfile names pnpm, and there is no manifest beside it: nothing is
    // installed, which is what the pinned manifest already holds.
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "lockfile");

    const later = await reportedBy(repo);
    const finding = later.findings.find((f) => f.reason === "package_manifest_missing");
    expect(finding?.severity).toBe("advisory");
    expect(later.config.install?.consistent).toBe(true);
    expect(later.config.install?.advisory).toBeNull();
  }, 120_000);

  it("says nothing when the repository names a manager this build does not install with", async () => {
    const repo = checkout("write-bare-uv", { "README.md": "# fixture\n" });
    await doctor(repo, { write: true });

    // uv is detected and answered as no manager is — nothing installed,
    // `git status --porcelain` as the verification — which is what the pinned
    // manifest already holds.
    writeFileSync(join(repo, "pyproject.toml"), '[project]\nname = "fixture"\n');
    writeFileSync(join(repo, "uv.lock"), "version = 1\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "uv");

    const later = await reportedBy(repo);
    const finding = later.findings.find((f) => f.reason === "unsupported_package_manager");
    expect(finding?.severity).toBe("advisory");
    expect(later.materializable).toBe(true);
    expect(later.config.install?.consistent).toBe(true);
    expect(later.config.install?.advisory).toBeNull();
  }, 120_000);
});

describe("doctor --write-config on a repository with no lockfile", () => {
  it("writes the install pnpm can run without one, and proposes the same command", async () => {
    const repo = pnpmRepository("write-unpinned");

    // What `doctor` proposes when it is not asked to write anything.
    const proposal = await reportedBy(repo);
    expect(proposal.materializable).toBe(true);
    expect(proposal.proposed?.install.command).toEqual(UNPINNED);
    expect(proposal.proposed?.install.pinned).toBe(false);

    // And what it writes: the same command, in the file every later run
    // installs from.
    const written = await reportedBy(repo, true);
    expect(written.config.written).toBe(true);
    expect(written.config.proposed?.materialization_manifest.install.command).toEqual(UNPINNED);
    expect(writtenInstall(repo)).toEqual({ command: UNPINNED, pinned: false });
  }, 120_000);

  it("says on the same run why that install is not pinned", async () => {
    const written = await reportedBy(pnpmRepository("write-advisory"), true);

    const advisory = written.findings.find((finding) => finding.reason === "lockfile_missing");
    expect(advisory?.severity).toBe("advisory");
    // The file whose absence is the reason, the command that is unpinned
    // because of it, and what writes the lockfile.
    expect(advisory?.detail).toContain("pnpm-lock.yaml");
    expect(advisory?.detail).toContain(UNPINNED.join(" "));
    expect(advisory?.detail).toContain("pnpm install --lockfile-only");

    // The report a person reads names it too, rather than only the JSON.
    const shown = await doctor(pnpmRepository("write-shown"), { write: true, human: true });
    expect(shown.text).toContain(`install           ${UNPINNED.join(" ")}`);
    expect(shown.text).toContain("(unpinned: no pnpm-lock.yaml)");
    expect(shown.text).toContain("advisory  lockfile_missing");
  }, 120_000);

  it("writes the frozen form for the same repository with a lockfile", async () => {
    const repo = pnpmRepository("write-pinned");
    commitLockfile(repo);

    const written = await reportedBy(repo, true);
    expect(written.proposed?.install.command).toEqual(FROZEN);
    expect(writtenInstall(repo)).toEqual({ command: FROZEN, pinned: true });
    expect(written.findings.map((finding) => finding.reason)).not.toContain("lockfile_missing");
  }, 120_000);
});

describe("doctor on a repository whose configuration is already written", () => {
  it("reads the written install back as consistent with the checkout", async () => {
    const repo = pnpmRepository("read-consistent");
    await doctor(repo, { write: true });

    const later = await reportedBy(repo);
    expect(later.config.install?.command).toEqual(UNPINNED);
    expect(later.config.install?.pinned).toBe(false);
    expect(later.config.install?.consistent).toBe(true);
    expect(later.config.install?.advisory).toBeNull();
    expect((await doctor(repo, { human: true })).text).toContain("consistent with this checkout");
  }, 120_000);

  it("says the configuration could now pin once the repository commits a lockfile", async () => {
    const repo = pnpmRepository("read-could-pin");
    await doctor(repo, { write: true });
    commitLockfile(repo);

    const later = await reportedBy(repo);
    expect(later.config.install?.consistent).toBe(false);
    expect(later.config.install?.checkout.command).toEqual(FROZEN);
    const advisory = later.config.install?.advisory;
    expect(advisory?.reason).toBe("install_could_pin");
    expect(advisory?.detail).toContain("pnpm-lock.yaml");
    expect(advisory?.detail).toContain(FROZEN.join(" "));

    // Advisory: it names something to change in a file the person owns, and
    // the repository is materializable either way.
    const shown = await doctor(repo, { human: true });
    expect(shown.text).toContain("advisory  install_could_pin");
    expect(shown.code).toBe(0);
  }, 120_000);

  it("says the configuration could now verify once the package declares a test script", async () => {
    // A package that declares no test script: the manifest written for it
    // installs it and verifies with `git status --porcelain`.
    const repo = repository("read-could-verify", {
      packageManager: "pnpm@9.1.0",
      scripts: { deploy: "wrangler deploy" },
    });
    commitLockfile(repo);
    await doctor(repo, { write: true });
    expect((await reportedBy(repo)).config.install?.advisory).toBeNull();

    // The package then declares a suite.
    writeFileSync(
      join(repo, "package.json"),
      json({
        name: "fixture",
        private: true,
        packageManager: "pnpm@9.1.0",
        scripts: { deploy: "wrangler deploy", test: "node --test" },
      }),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "test script");

    const later = await reportedBy(repo);
    // The install still matches; the verification is what the file predates.
    expect(later.config.install?.consistent).toBe(true);
    const advisory = later.config.install?.advisory;
    expect(advisory?.reason).toBe("verify_outgrown");
    expect(advisory?.detail).toContain("pnpm run test");
    const shown = await doctor(repo, { human: true });
    expect(shown.text).toContain("advisory  verify_outgrown");
    expect(shown.code).toBe(0);
  }, 120_000);

  it("says in the same advisory that the install could pin, when both have moved", async () => {
    // No test script and no lockfile when the manifest was written.
    const repo = repository("read-both-moved", {
      packageManager: "pnpm@9.1.0",
      scripts: { deploy: "wrangler deploy" },
    });
    await doctor(repo, { write: true });

    // Then a suite and a lockfile, in one commit.
    writeFileSync(
      join(repo, "package.json"),
      json({
        name: "fixture",
        private: true,
        packageManager: "pnpm@9.1.0",
        scripts: { deploy: "wrangler deploy", test: "node --test" },
      }),
    );
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "test script and lockfile");

    const advisory = (await reportedBy(repo)).config.install?.advisory;
    expect(advisory?.reason).toBe("verify_outgrown");
    expect(advisory?.detail).toContain("pnpm run test");
    // One advisory, and neither drift hidden behind the other.
    expect(advisory?.detail).toContain(FROZEN.join(" "));
  }, 120_000);

  it("says nothing of an install a person set to none beside the repository's own verification", async () => {
    const repo = pnpmRepository("read-none-by-hand");
    commitLockfile(repo);
    await doctor(repo, { write: true });
    const path = join(storeDir(repo, null), "config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      materialization_manifest: { install: Record<string, unknown>; verify: { command: string[] } };
    };
    config.materialization_manifest.install = {
      ...config.materialization_manifest.install,
      kind: "none",
      package_manager: "none",
      command: ["true"],
      pinned: true,
    };
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    expect(config.materialization_manifest.verify.command).not.toEqual([
      "git",
      "status",
      "--porcelain",
    ]);

    const later = await reportedBy(repo);
    expect(later.config.install?.command).toEqual(["true"]);
    expect(later.config.install?.advisory).toBeNull();
  }, 120_000);
});

/**
 * The install binary a run asks the machine for before it provisions anything:
 * the one its install will spawn, and none where the checkout installs nothing,
 * because an install of kind `none` is never run.
 */
describe("the install binary a run checks the machine for", () => {
  /** A machine that blocks, so the run stops at the check it was asked. */
  const blocking =
    (asked: PreflightRequest[]) =>
    (request: PreflightRequest): PreflightResult => {
      asked.push(request);
      return {
        ok: false,
        findings: [{ severity: "blocking", reason: "git_missing", detail: "stubbed", fix: "stubbed" }],
        tools: {},
        github: null,
      };
    };

  it("is the manager the checkout installs with", async () => {
    const asked: PreflightRequest[] = [];
    const result = await loop(repository("asks-npm"), ["--config", runConfig("asks-npm")], {
      preflight: blocking(asked),
    });

    expect(result.code).not.toBe(0);
    expect(asked.map((request) => request.installBinary)).toEqual(["npm"]);
  }, 120_000);

  it("is none where the checkout installs nothing", async () => {
    const asked: PreflightRequest[] = [];
    const repo = checkout("asks-nothing", { "src/index.ts": "export const version = 1;\n" });
    const result = await loop(repo, ["--config", runConfig("asks-nothing")], {
      preflight: blocking(asked),
    });

    expect(result.code).not.toBe(0);
    expect(asked.map((request) => request.installBinary)).toEqual([null]);
  }, 120_000);
});

/**
 * A checkout of exactly the files it is given, committed once. The monorepos
 * below need several manifests at several depths, which `repository` above —
 * one package at the root — does not build.
 */
function checkout(name: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv });
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [path, body] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const MEMBER_SCRIPTS = { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" };

/**
 * A pnpm monorepo with two members, so a filter that named the wrong one would
 * be visible rather than vacuous.
 */
function monorepo(name: string): { root: string; api: string } {
  const root = checkout(name, {
    "pnpm-workspace.yaml": "packages:\n  - 'services/*'\n",
    "package.json": json({ name: "monorepo", private: true, scripts: { test: "turbo run test" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "services/api/package.json": json({ name: "@fixture/api", scripts: MEMBER_SCRIPTS }),
    "services/api/src/index.ts": "export const version = 1;\n",
    "services/web/package.json": json({ name: "@fixture/web", scripts: MEMBER_SCRIPTS }),
  });
  return { root, api: join(root, "services", "api") };
}

/** The lines of a report that name a root, which is what a reader counts. */
const rootLines = (text: string): string[] =>
  text.split("\n").filter((line) => /^(CHECKOUT|WORKSPACE)\s/.test(line));

interface RootsReport {
  roots: { package: string; workspace: string; package_name: string | null };
  install: { cwd: string; command: string[]; pinned: boolean };
}

const rootsReportedBy = async (repo: string): Promise<RootsReport> =>
  JSON.parse((await doctor(repo)).text) as RootsReport;

describe("doctor on a package inside a workspace", () => {
  it("reports the package root and the workspace root as two lines", async () => {
    const { root, api } = monorepo("two-roots");

    const roots = rootLines((await doctor(api, { human: true })).text);

    // Two lines, naming two distinct directories — not one line repeated, and
    // not the workspace root alone, which is not what the run was pointed at.
    expect(roots).toHaveLength(2);
    expect(roots[0]).toContain(api);
    expect(roots[1]).toContain(root);
    expect(roots[0]).not.toBe(roots[1]);
    expect(roots[0]).not.toContain(`${root} `);
  }, 120_000);

  it("reports one root line for a checkout that is its own workspace", async () => {
    const solo = pnpmRepository("one-root");

    const shown = await doctor(solo, { human: true });

    expect(rootLines(shown.text)).toHaveLength(1);
    expect(rootLines(shown.text)[0]).toContain(solo);
    // Nothing about a second root anywhere in the report: there is not one.
    expect(shown.text).not.toContain("WORKSPACE");
  }, 120_000);
});

describe("the install doctor proposes for a package inside a workspace", () => {
  it("runs at the workspace root, filtered to that package", async () => {
    const { root, api } = monorepo("filtered-install");

    const report = await rootsReportedBy(api);

    // Where it runs is the workspace root — that is where the lockfile is —
    // and not the directory the run was given.
    expect(report.install.cwd).toBe(root);
    expect(report.install.cwd).not.toBe(api);
    // What it runs is pnpm's own filter, naming this package and not the other.
    expect(report.install.command).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
      "--filter",
      "@fixture/api",
    ]);
    expect(report.install.command).not.toContain("@fixture/web");
    expect(report.roots).toEqual({ package: api, workspace: root, package_name: "@fixture/api" });

    // The human report says the same thing on the install line, because a
    // command without the directory it runs in is half an answer.
    const shown = (await doctor(api, { human: true })).text;
    const line = shown.split("\n").filter((text) => text.trimStart().startsWith("install "));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("--filter @fixture/api");
    expect(line[0]).toContain(root);
  }, 120_000);

  it("leaves a checkout that is its own workspace running in itself", async () => {
    const solo = pnpmRepository("unfiltered-install");

    const report = await rootsReportedBy(solo);

    expect(report.roots).toEqual({ package: solo, workspace: solo, package_name: null });
    expect(report.install.cwd).toBe(solo);
    expect(report.install.command).toEqual(UNPINNED);
  }, 120_000);
});

interface Refusal {
  reason: string;
  detail: string;
}

const refusals = (report: DoctorReport): Refusal[] =>
  report.findings
    .filter((finding) => finding.severity === "refusal")
    .map((finding) => ({ reason: finding.reason, detail: finding.detail }));

describe("a package whose workspace names a manager this build does not install with", () => {
  it("is answered naming the manager, exactly as that manager at a plain root is", async () => {
    // uv: a manager this build knows of and does not install with. The
    // workspace declares it and the member is what the run was given.
    const workspace = checkout("uv-workspace", {
      "pyproject.toml": '[tool.uv.workspace]\nmembers = ["services/*"]\n',
      "uv.lock": "version = 1\n",
      "services/api/package.json": json({ name: "@fixture/api", scripts: MEMBER_SCRIPTS }),
      "services/api/src/index.ts": "export const version = 1;\n",
    });
    // The same manager at a plain root: the answer that already exists, and
    // the one this has to match.
    const plain = checkout("uv-plain", {
      "uv.lock": "version = 1\n",
      "package.json": json({ name: "solo", scripts: MEMBER_SCRIPTS }),
      "src/index.ts": "export const version = 1;\n",
    });

    const member = await doctor(join(workspace, "services", "api"));
    const control = await doctor(plain);
    const memberReport = JSON.parse(member.text) as DoctorReport;
    const controlReport = JSON.parse(control.text) as DoctorReport;

    // The same answer: the same exit status, no refusal, and both
    // materializable with nothing installed.
    expect(member.code).toBe(control.code);
    expect(member.code).toBe(0);
    expect(refusals(memberReport)).toEqual([]);
    expect(refusals(controlReport)).toEqual([]);
    expect(memberReport.materializable).toBe(true);
    expect(controlReport.materializable).toBe(true);
    expect(memberReport.proposed?.install.command).toEqual(["true"]);
    expect(controlReport.proposed?.install.command).toEqual(["true"]);

    // And both name the manager, so the report says what was not installed
    // rather than only that nothing was.
    const named = (report: DoctorReport) =>
      report.findings.filter((finding) => finding.reason === "unsupported_package_manager");
    expect(named(memberReport).map((finding) => finding.severity)).toEqual(["advisory"]);
    expect(named(controlReport).map((finding) => finding.severity)).toEqual(["advisory"]);
    expect(named(memberReport)[0]?.detail).toContain("uv");
    expect(named(controlReport)[0]?.detail).toContain("uv");

    // And the report a person reads names no install directory or filter for
    // an install that installs nothing.
    const shown = (await doctor(join(workspace, "services", "api"), { human: true })).text;
    const workspaceLine = rootLines(shown).find((line) => line.startsWith("WORKSPACE"));
    expect(workspaceLine).toContain("nothing is installed");
    expect(workspaceLine).not.toContain("filtered to");
    const installLine = shown.split("\n").find((line) => line.trimStart().startsWith("install "));
    expect(installLine).toBeDefined();
    expect(installLine).not.toContain("(in ");
  }, 120_000);
});
