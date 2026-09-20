import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import {
  parseExecuteArgs,
  proposedChecks,
  runExecuteCommand,
  type ExecuteOptions,
} from "./index.js";
import { storeDir } from "../../store/index.js";

/**
 * A first run on a repository that has no `.perbo/config.json` (SCP-259).
 *
 * The claim is that such a run is judged by the repository's own checks anyway:
 * the ones `perbo doctor` would propose, derived from the scripts
 * `package.json` already declares, pinned for this run and marked in the record
 * as proposed rather than configured. Before this, a config-less repository ran
 * no check at all and the reviewer had no executed test to read.
 *
 * The reviewer is a double — what these tests are about is not a provider — and
 * the executor is a real program this file writes, because the change set the
 * checks are run against has to be one the runner really sealed. Everything
 * between is the shipped thing: the real argument parsing, the real
 * configuration merge, the real worktree and seal, and the real pinned-check
 * runner spawning the command the derivation produced.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-checks-no-config-"));
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
 * A repository with one commit, an npm lockfile, and whatever scripts the test
 * gives it — and, above all, no `.perbo/` at all.
 */
function repository(name: string, scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv });
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, scripts }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} }, null, 2)}\n`,
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const version = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

/**
 * A pnpm monorepo whose root and whose members declare **differently named**
 * scripts, so which `package.json` a derivation read is visible in its answer
 * rather than inferred: the root's unit script is `test:unit` and is declared
 * nowhere else, and the two members exist so a derivation that reached the
 * wrong one would be visible too.
 */
const ROOT_SCRIPTS = {
  "test:unit": "turbo run test",
  lint: "turbo run lint",
  typecheck: "turbo run typecheck",
};
const MEMBER_SCRIPTS = {
  test: "vitest run services/api",
  lint: "eslint services/api",
  typecheck: "tsc -p services/api",
};

function monorepo(name: string): { root: string; api: string } {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv });
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  const files: Record<string, string> = {
    "pnpm-workspace.yaml": "packages:\n  - 'services/*'\n",
    "package.json": `${JSON.stringify({ name: "monorepo", private: true, scripts: ROOT_SCRIPTS }, null, 2)}\n`,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "services/api/package.json": `${JSON.stringify({ name: "@fixture/api", scripts: MEMBER_SCRIPTS }, null, 2)}\n`,
    "services/api/src/index.ts": "export const version = 1;\n",
    "services/web/package.json": `${JSON.stringify({ name: "@fixture/web", scripts: MEMBER_SCRIPTS }, null, 2)}\n`,
  };
  for (const [path, body] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return { root: dir, api: join(dir, "services", "api") };
}

/**
 * An executor that writes one file, as a real program the runner spawns: the
 * change set the checks are run against has to be one the seal really produced,
 * and a round whose change set is null runs no check whatever is pinned.
 */
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

/** A materialization that installs nothing: this fixture has no dependencies. */
const noInstall = (repo: string) => ({
  manifest_version: 1,
  repository_id: `repo_${repo.split("/").pop()}`,
  source_checkout: repo,
  entries: [],
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
    port_range_size: 0,
    port_range_start: 41_000,
    port_range_end: 41_009,
    database_schema_prefix: null,
  },
});

/**
 * The two things a run needs that a repository with no configuration cannot
 * supply, and the one key a test must not inherit: the worktree root, whose
 * derived default is under `$HOME`. Deliberately says nothing about `checks` —
 * what this file is about is the set a run pins when nobody named one.
 */
function runConfig(name: string, repo: string, config: Record<string, unknown> = {}): string {
  const path = join(scratch, `${name}.config.json`);
  writeFileSync(
    path,
    JSON.stringify({
      worktree_root: join(scratch, `${name}-worktrees`),
      agent_binary: agent(name),
      model: "double",
      materialization_manifest: noInstall(repo),
      limits: { organisation: "test", limits: { concurrent_local_attempts: 4 } },
      ...config,
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
  outcome: string;
  rounds: Array<{
    checks: Array<{
      check_id: string;
      name: string;
      kind: string;
      status: string;
      command: string | null;
      origin?: string;
    }>;
  }>;
}

const OUTCOME = "The feature module exports a computed total";
const CRITERION = "total() returns the sum of its inputs :: total([1,2]) is 3 :: test";

async function loop(
  repo: string,
  argv: readonly string[],
  options: Omit<ExecuteOptions, "args" | "streams" | "cwd"> = {},
): Promise<{ code: number; err: string; json: RunJson }> {
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
  return { code, err: err.join(""), json: JSON.parse(out.join("")) as RunJson };
}

describe("a run on a repository that has no configuration", () => {
  it("pins the checks doctor would propose, runs them, and marks them proposed", async () => {
    const repo = repository("proposed", { test: 'node -e "process.exit(0)"' });
    const result = await loop(repo, ["--config", runConfig("proposed", repo)]);

    // The set the reviewer received: the repository's own `test` script, as the
    // unit check, run through the package manager its lockfile names.
    const checks = result.json.rounds[0]!.checks;
    expect(checks.map((check) => [check.check_id, check.name, check.kind])).toEqual([
      ["check_unit", "test", "unit"],
    ]);
    expect(checks[0]!.command).toBe("npm run test");
    expect(checks[0]!.status).toBe("passed");
    // Marked for what it is: derived here, not agreed in a file.
    expect(checks[0]!.origin).toBe("proposed");

    // One line, and it names the command that turns the proposal into a file.
    const line = result.err
      .split("\n")
      .filter((text) => /proposed/.test(text) && /doctor/.test(text));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("test");
    expect(line[0]).toContain("doctor");
    expect(line[0]).toContain("--write-config");
    expect(result.code).toBe(0);
  }, 180_000);

  it("proposes nothing where a configuration exists, and runs what it pins", async () => {
    const repo = repository("configured", { test: 'node -e "process.exit(1)"' });
    const store = storeDir(repo, null);
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, "config.json"),
      `${JSON.stringify({
        checks: [
          {
            check_id: "check_unit",
            name: "agreed",
            kind: "unit",
            command: ["node", "-e", "process.exit(0)"],
            timeout_ms: 30_000,
          },
        ],
      })}\n`,
    );

    const result = await loop(repo, ["--config", runConfig("configured", repo)]);

    // The file's check, not the script's — and nothing about it says proposed.
    const checks = result.json.rounds[0]!.checks;
    expect(checks.map((check) => check.name)).toEqual(["agreed"]);
    expect(checks[0]!.command).toBe("node -e process.exit(0)");
    expect(checks[0]!.origin).toBeUndefined();
    expect(result.err).not.toMatch(/--write-config/);
  }, 180_000);

  it("pins none where the package declares no scripts, and says so on the same line", async () => {
    const repo = repository("scriptless", {});
    const result = await loop(repo, ["--config", runConfig("scriptless", repo)]);

    expect(result.json.rounds[0]!.checks).toEqual([]);
    const line = result.err
      .split("\n")
      .filter((text) => /proposed/.test(text) && /doctor/.test(text));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("none");
  }, 180_000);
});

/**
 * The same question asked of one package of a monorepo, which is an ordinary
 * thing to point a run at: the outcome is about that package, so its suite is
 * what judges it. The derivation is the shipped one, read against a real
 * checkout on disk.
 */
describe("the checks derived for a package inside a workspace", () => {
  it("come from that package's own scripts and none of the workspace root's", () => {
    const { root, api } = monorepo("member-checks");

    const checks = proposedChecks(api).map((check) => ({
      name: check["name"],
      kind: check["kind"],
      command: (check["command"] as string[]).join(" "),
    }));

    // Exactly the three the package declares, each running the script that
    // package names, through the manager the workspace's lockfile names.
    expect(checks).toEqual([
      { name: "typecheck", kind: "typecheck", command: "pnpm run typecheck" },
      { name: "lint", kind: "lint", command: "pnpm run lint" },
      { name: "test", kind: "unit", command: "pnpm run test" },
    ]);

    // And none of the root's own. `test:unit` is declared at the workspace root
    // and nowhere else, so a derivation that had read the root's `package.json`
    // would have pinned `pnpm run test:unit` as the unit check — as it does
    // when the root is what it is given.
    expect(checks.map((check) => check.command)).not.toContain("pnpm run test:unit");
    expect(proposedChecks(root).map((check) => (check["command"] as string[]).join(" "))).toContain(
      "pnpm run test:unit",
    );
  });
});

/**
 * Scripts a run does not run on a repository's behalf: one that starts a
 * service, which a worktree cannot be given, and any script where no manager
 * this build installs with is there to run it.
 */
describe("the checks derived from scripts a worktree cannot run", () => {
  it("leave out a script that starts a service, and keep the others", () => {
    const repo = repository("service-checks", {
      lint: "eslint .",
      test: "docker compose up -d && vitest run",
    });

    expect(proposedChecks(repo).map((check) => check["name"])).toEqual(["lint"]);
  });

  it("keep a lint script that runs a container, since only a test script is the suite", () => {
    const repo = repository("container-lint", {
      lint: "eslint . && docker run --rm -i hadolint/hadolint < Dockerfile",
      test: "vitest run",
    });

    expect(proposedChecks(repo).map((check) => check["name"])).toEqual(["lint", "test"]);
  });

  it("are none where the manager is one this build does not install with", () => {
    const dir = mkdtempSync(join(scratch, "uv-checks-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { lint: "eslint .", test: "vitest run" } }),
    );
    writeFileSync(join(dir, "uv.lock"), "version = 1\n");

    expect(proposedChecks(dir)).toEqual([]);
  });
});

describe("the checks derived for a member of a pnpm workspace with no root package.json", () => {
  it("are the member's own, run with pnpm", () => {
    // pnpm installs a workspace from `pnpm-workspace.yaml` with no root
    // manifest, so the member's scripts are installed for and are its checks.
    const root = mkdtempSync(join(scratch, "rootless-workspace-"));
    mkdirSync(join(root, "packages", "api"), { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(
      join(root, "packages", "api", "package.json"),
      JSON.stringify({ name: "@fixture/api", scripts: { lint: "eslint .", test: "vitest run" } }),
    );

    expect(
      proposedChecks(join(root, "packages", "api")).map((check) => (check["command"] as string[]).join(" ")),
    ).toEqual(["pnpm run lint", "pnpm run test"]);
  });
});
