import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import { type ExecuteDeps, executeCommandLine } from "./run/index.js";
import { inspectCommandLine } from "./inspect.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";
import { gitEnvironment } from "@perbo/test-support";

/**
 * What `perbo inspect` says about the pull request a run with no ticket
 * opened.
 *
 * A ticketed run takes the URL from the ticket file. A local run has no ticket,
 * so the URL has to be on the record the run wrote about itself or it is gone
 * the moment the terminal scrolls — and `inspect` is the command that answers
 * "what happened to that run" a day later.
 *
 * `gh` is faked as a binary on PATH the way run/index.base-without-config.test.ts does
 * it, so `gh pr create` really is what answers the URL. The push is hooked —
 * there is no remote — and the reviewer is a double, but the run record, the
 * delivery call and `inspect`'s own reading are the shipped ones.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-inspect-pr-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnvironment() });

/** A repository with one commit, a `test` script, a lockfile and no `.perbo/`. */
function repository(name: string): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnvironment() });
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: "fixture", private: true, scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    )}\n`,
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

/** The URL the fake `gh` answers `pr create` with. */
const PULL_REQUEST_URL = "https://github.com/o/r/pull/7";

/**
 * A `gh` on PATH that answers `pr create` with {@link PULL_REQUEST_URL} and
 * exits non-zero for everything else: there is no pull request on the branch
 * yet, which is what sends delivery to `create`.
 */
function fakeGh(name: string): string {
  const root = join(scratch, `gh-${name}`);
  mkdirSync(root, { recursive: true });
  const script = join(root, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      `  echo "${PULL_REQUEST_URL}"`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return root;
}

/** The machine, answered rather than measured: PATH is not what this is about. */
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

/** The root a run under the override below puts its worktrees in. */
const worktreeRoot = (name: string): string => join(scratch, `${name}-worktrees`);

/**
 * What a run needs that the repository cannot supply, and the one key a test
 * must not inherit: the worktree root, whose derived default is under `$HOME`.
 */
function runConfig(name: string, repo: string): string {
  const path = join(scratch, `${name}.config.json`);
  writeFileSync(
    path,
    JSON.stringify({
      worktree_root: worktreeRoot(name),
      agent_binary: agent(name),
      model: "double",
      materialization_manifest: noInstall(repo),
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
      created_at: "2026-09-07T00:00:00.000Z",
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

const OUTCOME = "The feature module exports a computed total";
const CRITERION = "total() returns the sum of its inputs :: total([1,2]) is 3 :: test";

const originalPath = process.env.PATH;

/** The `gh` on PATH for one run, restored whatever the run did. */
async function withGh<T>(bin: string, body: () => Promise<T>): Promise<T> {
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  try {
    return await body();
  } finally {
    process.env.PATH = originalPath;
  }
}

/** `perbo run --outcome …` on a repository with no ticket, and what it printed. */
async function run(
  repo: string,
  argv: readonly string[],
  options: Partial<ExecuteDeps> = {},
): Promise<{ code: number; out: string; err: string }> {
  const streams = recordStreams();
  const code = await runCommandLine(executeCommandLine, {
    argv: [
        "--repo",
        repo,
        "--outcome",
        OUTCOME,
        "--criterion",
        CRITERION,
        "--json",
        ...argv,
      ],
    streams,
    cwd: repo,
    deps: { preflight: okPreflight, hooks: {
        review: reviewer() as never,
        push: (async () => ({ pushed: true, detail: "hooked" })) as never,
      }, ...options },
  });
  return { code, out: streams.out(), err: streams.err() };
}

/** What the run reported about itself, from the JSON it writes on stdout. */
interface RunReport {
  ticket_id: string;
  pull_request: { url: string; number: number | null } | null;
}

/** `perbo inspect <run>` as a script reads it, and as a person does. */
async function inspect(
  repo: string,
  runId: string,
): Promise<{ report: { pull_request_url: string | null }; shown: string }> {
  const asJson = recordStreams();
  await runCommandLine(inspectCommandLine, {
    argv: [runId, "--repo", repo],
    streams: asJson,
    cwd: repo,
  });
  const onTty = recordStreams({ isTTY: true });
  await runCommandLine(inspectCommandLine, {
    argv: [runId, "--repo", repo],
    streams: onTty,
    cwd: repo,
  });
  return {
    report: asJson.json<{ pull_request_url: string | null }>(),
    shown: onTty.plain(),
  };
}

const RUN_TIMEOUT_MS = 180_000;

describe("inspect on a run with no ticket", () => {
  it("names the pull request the run opened", async () => {
    const repo = repository("published");

    const result = await withGh(fakeGh("published"), () =>
      run(repo, ["--publish", "--config", runConfig("published", repo)]),
    );

    expect(result.code).toBe(0);
    const reported = JSON.parse(result.out) as RunReport;
    expect(reported.pull_request?.url).toBe(PULL_REQUEST_URL);

    // The same URL the run printed, read back off the record a day later: in
    // the report a script parses, and in the one a person reads.
    const read = await inspect(repo, reported.ticket_id);
    expect(read.report.pull_request_url).toBe(PULL_REQUEST_URL);
    expect(read.shown).toContain(`pull request ${PULL_REQUEST_URL}`);
  }, RUN_TIMEOUT_MS);

  it("reports none for a run that published nothing", async () => {
    const repo = repository("unpublished");

    const result = await run(repo, ["--config", runConfig("unpublished", repo)]);

    expect(result.code).toBe(0);
    const reported = JSON.parse(result.out) as RunReport;
    expect(reported.pull_request).toBeNull();

    const read = await inspect(repo, reported.ticket_id);
    expect(read.report.pull_request_url).toBeNull();
    expect(read.shown).not.toContain("pull request http");
  }, RUN_TIMEOUT_MS);
});
