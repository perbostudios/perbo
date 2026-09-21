import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import { type ExecuteDeps, executeCommandLine } from "./index.js";
import { storeDir } from "../../store/index.js";
import { runCommandLine } from "../../command-line/terminal.js";

/**
 * A run on a repository whose own scripts give a worktree nothing to run: a
 * package that declares no test script, a project whose package manager this
 * build does not install with, and a package whose test script starts a
 * service. None is refused. Each is verified with `git status --porcelain`,
 * runs no script that starts a service, and is judged by the review and
 * whichever checks its scripts give it.
 *
 * The reviewer is a double and the executor is a real program this file writes;
 * the argument parsing, the configuration merge, the diagnostic, the worktree,
 * the install, the seal and the pinned checks are the shipped ones. No manifest
 * is pinned, so the one the run materializes is the one the diagnostic
 * proposes from the checkout, which is the subject.
 *
 * Nothing here imports a symbol the change adds, so this file loads at the
 * commit before it and each test fails on the behaviour it is about.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-unverified-run-"));
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

/** A checkout of exactly the files it is given, committed once. */
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

/** A package with these scripts and no lockfile, so it installs with npm and nothing else. */
const npmPackage = (name: string, scripts: Record<string, string>): string =>
  checkout(name, {
    "package.json": `${JSON.stringify({ name: "fixture", private: true, scripts }, null, 2)}\n`,
    "src/index.ts": "export const version = 1;\n",
  });

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
 * default is under `$HOME` — and the agent. Says nothing about
 * `materialization_manifest` or `checks`: both are the run's own derivation.
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

/**
 * A reviewer that approves, priced, with no provider behind it, and records
 * what each call was told about the base.
 */
const reviewer =
  (told: Array<boolean | undefined> = []) =>
  async (request: {
    changeset?: { changeset_id: string };
    head_commit?: string;
    baseVerified?: boolean;
  }) => {
    told.push(request.baseVerified);
    return approval(request);
  };

const approval = (request: { changeset?: { changeset_id: string }; head_commit?: string }) => ({
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
  options: Partial<ExecuteDeps> = {},
): Promise<{ code: number; err: string; out: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommandLine(executeCommandLine, {
    argv: [
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
      ],
    streams: {
        stdout: (chunk: string) => out.push(chunk),
        stderr: (chunk: string) => err.push(chunk),
        isTTY: false,
      },
    cwd: repo,
    deps: { preflight: okPreflight, hooks: { review: reviewer() as never }, ...options },
  });
  // Unparsed: a run that refuses writes nothing to stdout, and a test that
  // parsed eagerly would fail on the JSON rather than on the refusal.
  return { code, err: err.join(""), out: out.join("") };
}

interface AttemptRecord {
  termination: { reason: string; detail: string };
  base_commit: string;
  head_commit: string | null;
  base_verification?: { commit: string; verified: boolean } | null;
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

/** The run's own report of the verification command materialization ran. */
const verifyLines = (err: string): string[] =>
  err.split("\n").filter((text) => /\bverify: /.test(text));

/** The attempt ran to its own end, sealing the one file the executor wrote. */
function ranToCompletion(repo: string, result: { code: number; err: string }): void {
  expect(result.err).not.toContain("no attempt was started");
  const one = attempt(repo);
  expect(one.termination.reason).toBe("completed");
  expect(sealedPaths(repo, one)).toEqual(["src/feature.ts"]);
  expect(result.code).toBe(0);
}

describe("a run on a repository whose scripts give a worktree nothing to run", () => {
  it("runs a package that declares no test script, verifying with Git", async () => {
    // The shape of a static site: a manifest for its deploy tooling, and
    // nothing that tests anything.
    const repo = npmPackage("untested", { deploy: "wrangler deploy" });
    const told: Array<boolean | undefined> = [];

    const result = await loop(repo, ["--config", runConfig("untested")], {
      hooks: { review: reviewer(told) as never },
    });

    ranToCompletion(repo, result);
    expect(verifyLines(result.err)).toEqual([expect.stringContaining("verify: git status --porcelain")]);
    // Nothing in its scripts is a check, so the review is what judges it.
    expect((JSON.parse(result.out) as RunJson).rounds[0]!.checks).toEqual([]);

    // `git status --porcelain` passes on any checkout, so it measured nothing
    // about the base: the review is told the base is unknown, and the ticket's
    // record keeps no answer a later attempt would read back as a measurement.
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((base) => base === undefined)).toBe(true);
    expect(attempt(repo).base_verification ?? null).toBeNull();
    expect(result.err).toContain("nothing has verified");
  }, 300_000);

  it("tells the review a base its own test script verified", async () => {
    // The control: the same run on a package whose suite a worktree can run,
    // so the reading above is one that could have come out the other way.
    const repo = npmPackage("tested", { test: 'node -e "process.exit(0)"' });
    const told: Array<boolean | undefined> = [];

    const result = await loop(repo, ["--config", runConfig("tested")], {
      hooks: { review: reviewer(told) as never },
    });

    ranToCompletion(repo, result);
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((base) => base === true)).toBe(true);
    expect(attempt(repo).base_verification?.verified).toBe(true);
  }, 300_000);

  it("runs a project whose package manager this build does not install with, installing nothing", async () => {
    const repo = checkout("python", {
      "pyproject.toml": '[project]\nname = "fixture"\nversion = "0.1.0"\n',
      "uv.lock": "version = 1\n",
      "src/index.ts": "export const version = 1;\n",
    });

    const result = await loop(repo, ["--config", runConfig("python")]);

    ranToCompletion(repo, result);
    expect(verifyLines(result.err)).toEqual([expect.stringContaining("verify: git status --porcelain")]);
    expect((JSON.parse(result.out) as RunJson).rounds[0]!.checks).toEqual([]);
  }, 300_000);

  it("runs a package whose test script starts a service, and never runs that script", async () => {
    const repo = npmPackage("compose", {
      test: "docker compose up -d && node --test",
      lint: 'node -e "process.exit(0)"',
    });

    const result = await loop(repo, ["--config", runConfig("compose")]);

    ranToCompletion(repo, result);
    // Neither the verification nor a check: the lint script is the one check,
    // and it ran.
    expect(verifyLines(result.err)).toEqual([expect.stringContaining("verify: git status --porcelain")]);
    const checks = (JSON.parse(result.out) as RunJson).rounds[0]!.checks;
    expect(checks.map((check) => [check.name, check.status])).toEqual([["lint", "passed"]]);
  }, 300_000);
});
