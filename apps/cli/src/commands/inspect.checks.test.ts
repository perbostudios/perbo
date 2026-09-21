import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DELIVERED_CHECKS_POLL_INTERVAL_MS,
  type PreflightRequest,
  type PreflightResult,
} from "@perbo/runner";
import { parseExecuteArgs, runExecuteCommand, type ExecuteOptions } from "./run/index.js";
import { attemptsRecordSubject, inspectCommandLine } from "./inspect.js";
import { runCommandLine } from "../command-line/terminal.js";

/**
 * What `perbo inspect` says about the checks on the head a run published.
 *
 * The run reads them after opening the pull request and writes them down. Read
 * back a day later, `inspect` says which check ran and what it concluded — so
 * a check that fails only on CI's own checkout is a line in the record rather
 * than something to find on GitHub.
 *
 * `gh` is faked as a binary on PATH the way inspect.pull-request.test.ts does
 * it, so `gh pr create` really answers the URL and `gh pr view` really answers
 * the rollup. The push is hooked — there is no remote — and the reviewer is a
 * double; the read, the record and `inspect`'s own reading are the shipped
 * ones.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-inspect-checks-"));
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

/** A repository with one commit, a `test` script, a lockfile and no `.perbo/`. */
function repository(name: string): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv });
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
const PULL_REQUEST_URL = "https://github.com/o/r/pull/11";

/**
 * A `gh` on PATH that answers `pr create` with {@link PULL_REQUEST_URL}, the
 * status rollup with one failing check and one green one, and `pr edit` by
 * keeping the body where the test can read it. Everything else exits non-zero
 * — including the `pr view` that looks for a pull request already on the
 * branch, which is what sends delivery to `create`.
 */
function fakeGh(name: string): { bin: string; body: () => string | null } {
  const root = join(scratch, `gh-${name}`);
  mkdirSync(root, { recursive: true });
  const bodyPath = join(root, "body.md");
  const rollup = JSON.stringify({
    statusCheckRollup: [
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
  });
  const script = join(root, "gh");
  writeFileSync(
    script,
    `#!/usr/bin/env node
"use strict";
const { writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "pr" && argv[1] === "create") {
  process.stdout.write(${JSON.stringify(PULL_REQUEST_URL)} + "\\n");
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "view" && argv.includes("statusCheckRollup")) {
  process.stdout.write(${JSON.stringify(rollup)});
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "edit") {
  writeFileSync(${JSON.stringify(bodyPath)}, argv[argv.indexOf("--body") + 1] ?? "");
  process.exit(0);
}
process.exit(1);
`,
  );
  chmodSync(script, 0o755);
  return {
    bin: root,
    body: () => {
      try {
        return readFileSync(bodyPath, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * A `gh` that answers the four questions a published run asks it: `pr create`,
 * the status rollup, `pr edit`, and — for SCP-279 — what this repository runs
 * on a pull request.
 *
 * `workflow list` answers with the workflows the case says GitHub has
 * registered, which is not the same set as the files on the branch and is
 * exactly what the cases below vary. The base branch requires nothing: no
 * ruleset (`[]`) and no classic protection (a 404, which is an answer).
 *
 * The rollup is empty on every poll unless the case says otherwise, and every
 * poll, every body edit and every body written is counted where the test can
 * read it back.
 */
function fakeGhForChecks(
  name: string,
  options: {
    workflows?: ReadonlyArray<{ name: string; path: string }>;
    /**
     * Where true, `workflow list` writes nothing at all and exits 0 — what
     * `gh --all` prints on a repository that has no workflow to list.
     */
    listsNothing?: boolean;
    /** What `statusCheckRollup` answers, on every poll. Empty by default. */
    rollup?: ReadonlyArray<Record<string, unknown>>;
  } = {},
): { bin: string; polls: () => number; edits: () => number; body: () => string | null } {
  const root = join(scratch, `gh-${name}`);
  mkdirSync(root, { recursive: true });
  const bodyPath = join(root, "body.md");
  const pollsPath = join(root, "polls");
  const editsPath = join(root, "edits");
  const listed = options.listsNothing
    ? ""
    : JSON.stringify((options.workflows ?? []).map((entry) => ({ ...entry, state: "active" })));
  const rollup = JSON.stringify({ statusCheckRollup: options.rollup ?? [] });
  const script = join(root, "gh");
  writeFileSync(
    script,
    `#!/usr/bin/env node
"use strict";
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "pr" && argv[1] === "create") {
  process.stdout.write(${JSON.stringify(PULL_REQUEST_URL)} + "\\n");
  process.exit(0);
}
// The body as it stands, so that anything reading it back before rewriting it
// gets what was published rather than a refusal it would give up on.
if (argv[0] === "pr" && argv[1] === "view" && argv.includes("body")) {
  let body = "";
  try {
    body = readFileSync(${JSON.stringify(bodyPath)}, "utf8");
  } catch {}
  process.stdout.write(JSON.stringify({ body }));
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "view" && argv.includes("statusCheckRollup")) {
  appendFileSync(${JSON.stringify(pollsPath)}, ".");
  process.stdout.write(${JSON.stringify(rollup)});
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "edit") {
  appendFileSync(${JSON.stringify(editsPath)}, ".");
  writeFileSync(${JSON.stringify(bodyPath)}, argv[argv.indexOf("--body") + 1] ?? "");
  process.exit(0);
}
if (argv[0] === "workflow" && argv[1] === "list") {
  process.stdout.write(${JSON.stringify(listed)});
  process.exit(0);
}
if (argv[0] === "api" && /rules\\/branches/.test(argv.join(" "))) {
  process.stdout.write("[]");
  process.exit(0);
}
if (argv[0] === "api" && /protection/.test(argv.join(" "))) {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
process.exit(1);
`,
  );
  chmodSync(script, 0o755);
  const counted = (path: string) => () => {
    try {
      return readFileSync(path, "utf8").length;
    } catch {
      return 0;
    }
  };
  return {
    bin: root,
    polls: counted(pollsPath),
    edits: counted(editsPath),
    body: () => {
      try {
        return readFileSync(bodyPath, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** A workflow file in the checkout, committed, triggering on one event. */
function workflowFile(repo: string, path: string, on: string): void {
  mkdirSync(join(repo, dirname(path)), { recursive: true });
  writeFileSync(join(repo, path), `name: ${on}\non:\n  ${on}:\n    branches: [main]\njobs: {}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `workflow on ${on}`);
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

/**
 * What a run needs that the repository cannot supply, and the one key a test
 * must not inherit: the worktree root, whose derived default is under `$HOME`.
 */
function runConfig(name: string, repo: string, extra: Record<string, unknown> = {}): string {
  const path = join(scratch, `${name}.config.json`);
  writeFileSync(
    path,
    JSON.stringify({
      worktree_root: join(scratch, `${name}-worktrees`),
      agent_binary: agent(name),
      model: "double",
      materialization_manifest: noInstall(repo),
      limits: { organisation: "test", limits: { concurrent_local_attempts: 4 } },
      ...extra,
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

const capture = (isTTY = false) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      stdout: (chunk: string) => out.push(chunk),
      stderr: (chunk: string) => err.push(chunk),
      isTTY,
    },
  };
};

/** The rendering without its colours: the words are what is being read. */
// eslint-disable-next-line no-control-regex
const uncoloured = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

const originalPath = process.env.PATH;
const originalToken = process.env.GH_TOKEN;

/** The `gh` on PATH for one run, restored whatever the run did. */
async function withGh<T>(bin: string, body: () => Promise<T>): Promise<T> {
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.GH_TOKEN = "test-token";
  try {
    return await body();
  } finally {
    process.env.PATH = originalPath;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
}

/** `perbo run --outcome …` on a repository with no ticket, and what it printed. */
async function run(
  repo: string,
  argv: readonly string[],
  options: Omit<ExecuteOptions, "args" | "streams" | "cwd"> & { tty?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
  // On a terminal and without `--json`, the command prints what a person reads
  // rather than the record a script parses; both are the same run.
  const { tty, ...rest } = options;
  const streams = capture(tty === true);
  const code = await runExecuteCommand({
    args: parseExecuteArgs([
      "--repo",
      repo,
      "--outcome",
      OUTCOME,
      "--criterion",
      CRITERION,
      ...(tty === true ? [] : ["--json"]),
      ...argv,
    ]),
    streams: streams.streams,
    cwd: repo,
    preflight: okPreflight,
    hooks: {
      review: reviewer() as never,
      push: (async () => ({ pushed: true, detail: "hooked" })) as never,
    },
    ...rest,
  });
  return { code, out: streams.out.join(""), err: streams.err.join("") };
}

interface RunReport {
  ticket_id: string;
  detail: string;
  pull_request: { url: string; number: number | null } | null;
  delivery_checks: {
    state: string;
    reason: string;
    waited_ms: number;
    bounded: boolean;
    checks: Array<{ name: string; conclusion: string }>;
  } | null;
  repository_checks: {
    answered: boolean;
    runs_checks: boolean;
    workflows: Array<{ path: string }>;
    workflows_seen: number;
  } | null;
}

/** `perbo inspect <run>` as a script reads it, and as a person does. */
async function inspect(
  repo: string,
  runId: string,
): Promise<{
  report: { delivery_checks: RunReport["delivery_checks"] };
  shown: string;
}> {
  const asJson = capture(false);
  await runCommandLine(inspectCommandLine, {
    argv: [runId, "--repo", repo],
    streams: asJson.streams,
    cwd: repo,
    deps: { subject: attemptsRecordSubject },
  });
  const onTty = capture(true);
  await runCommandLine(inspectCommandLine, {
    argv: [runId, "--repo", repo],
    streams: onTty.streams,
    cwd: repo,
    deps: { subject: attemptsRecordSubject },
  });
  return {
    report: JSON.parse(asJson.out.join("")) as { delivery_checks: RunReport["delivery_checks"] },
    shown: uncoloured(onTty.out.join("")),
  };
}

const RUN_TIMEOUT_MS = 180_000;

describe("inspect on a run whose head's checks were read", () => {
  it("names each check and what it concluded", async () => {
    const repo = repository("checked");
    const gh = fakeGh("checked");

    const result = await withGh(gh.bin, () =>
      run(repo, ["--publish", "--config", runConfig("checked", repo)]),
    );

    expect(result.code).toBe(0);
    const reported = JSON.parse(result.out) as RunReport;
    expect(reported.pull_request?.url).toBe(PULL_REQUEST_URL);
    // The run read them before it recorded anything, and says which failed.
    expect(reported.delivery_checks?.state).toBe("checks_failed");
    expect(reported.detail).toContain("build (failure)");

    // The same reading, off the record a day later: in the report a script
    // parses, and in the one a person reads.
    const read = await inspect(repo, reported.ticket_id);
    expect(read.report.delivery_checks).toEqual({
      state: "checks_failed",
      checks: [
        { name: "build", conclusion: "failure" },
        { name: "lint", conclusion: "success" },
      ],
    });
    expect(read.shown).toContain("checks checks_failed");
    expect(read.shown).toContain("build failure");
    expect(read.shown).toContain("lint success");

    // And the pull request itself says it, below what it already said.
    expect(gh.body()).toContain("- `build` — failure");
  }, RUN_TIMEOUT_MS);

  it("says nothing about checks for a run that published nothing", async () => {
    const repo = repository("unpublished");

    const result = await run(repo, ["--config", runConfig("unpublished", repo)]);

    expect(result.code).toBe(0);
    const reported = JSON.parse(result.out) as RunReport;
    expect(reported.pull_request).toBeNull();
    expect(reported.delivery_checks).toBeNull();

    const read = await inspect(repo, reported.ticket_id);
    expect(read.report.delivery_checks).toBeNull();
    expect(read.shown).not.toMatch(/checks (green|checks_failed|unchecked)/);
  }, RUN_TIMEOUT_MS);
});

/**
 * SCP-279: a head that nothing reported on, from the two repositories that
 * produce it.
 *
 * The rollup is empty on every poll in both cases, so the reading the loop
 * arrives at is byte for byte the same; what differs is the repository. One
 * runs no workflow on a pull request and requires no status check on its base,
 * so nothing was ever going to report and there is nothing to wait for. The
 * other runs a workflow on every pull request and has simply not registered it
 * yet — which is the existing "not yet" rule, and the bound is what decides it.
 *
 * Both runs are the shipped command end to end: the real argument parsing, the
 * real configuration merge, the real worktree, the real publish, the real
 * reading of what this repository runs, and the real delivery read. `gh` is a
 * program on PATH, and the reviewer and the push are doubles.
 */
describe("a run whose head reported no check at all", () => {
  /** Short enough to wait for in a test, long enough to see a run spend it. */
  const BOUND_MS = 3_000;

  it(
    "records `none reported` at once where the repository runs nothing on a pull request",
    async () => {
      const repo = repository("runs-nothing");
      // One workflow, and it runs on a push. Nothing here triggers on a pull
      // request, and the fake `gh` reports no required check on `main`.
      workflowFile(repo, ".github/workflows/release.yml", "push");
      const gh = fakeGhForChecks("runs-nothing", {
        workflows: [{ name: "Release", path: ".github/workflows/release.yml" }],
      });

      const startedAt = Date.now();
      const result = await withGh(gh.bin, () =>
        run(repo, [
          "--publish",
          "--config",
          runConfig("runs-nothing", repo, { delivery_checks_bound_ms: BOUND_MS }),
        ]),
      );
      const elapsed = Date.now() - startedAt;

      expect(result.code).toBe(0);
      const reported = JSON.parse(result.out) as RunReport;
      expect(reported.pull_request?.url).toBe(PULL_REQUEST_URL);
      // What the repository was read as running, and what the delivery read
      // then did about it.
      expect(reported.repository_checks?.answered).toBe(true);
      expect(reported.repository_checks?.runs_checks).toBe(false);
      expect(reported.repository_checks?.workflows_seen).toBe(1);
      expect(reported.delivery_checks?.state).toBe("unchecked");
      expect(reported.delivery_checks?.reason).toBe("none reported");
      // Inside one poll interval, and strictly inside the bound: the read did
      // not sit out a wait for something that was never going to arrive. The
      // whole run — worktree, agent, checks, review, publish — is bounded too,
      // which it could not be if the delivery read had spent its bound.
      expect(reported.delivery_checks!.waited_ms).toBeLessThan(DELIVERED_CHECKS_POLL_INTERVAL_MS);
      expect(reported.delivery_checks!.waited_ms).toBeLessThan(BOUND_MS);
      expect(reported.delivery_checks!.bounded).toBe(true);
      expect(elapsed).toBeLessThan(RUN_TIMEOUT_MS);
      // It read the head once all the same: a check this repository was not
      // seen to run is still read rather than assumed away.
      expect(gh.polls()).toBe(1);
      // And the pull request was written once, when it was opened. A published
      // pull request is not edited a second time by the run that opened it.
      expect(gh.edits()).toBe(1);

      // And the record says `unchecked`, because nothing reported is not a pass.
      const read = await inspect(repo, reported.ticket_id);
      expect(read.report.delivery_checks).toEqual({ state: "unchecked", checks: [] });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "records `none reported` at once where `gh` lists no workflow at all",
    async () => {
      // The repository SCP-279 is about: no workflow anywhere, so `gh workflow
      // list --all` writes nothing rather than `[]`. Nothing reports on the
      // head, and the run has to know that before it starts waiting.
      const repo = repository("lists-nothing");
      const gh = fakeGhForChecks("lists-nothing", { listsNothing: true });

      const startedAt = Date.now();
      const result = await withGh(gh.bin, () =>
        run(repo, [
          "--publish",
          "--config",
          runConfig("lists-nothing", repo, { delivery_checks_bound_ms: BOUND_MS }),
        ]),
      );
      const elapsed = Date.now() - startedAt;

      expect(result.code).toBe(0);
      const reported = JSON.parse(result.out) as RunReport;
      expect(reported.pull_request?.url).toBe(PULL_REQUEST_URL);
      // The empty listing was read, and read as an answer of none.
      expect(reported.repository_checks?.answered).toBe(true);
      expect(reported.repository_checks?.runs_checks).toBe(false);
      expect(reported.repository_checks?.workflows_seen).toBe(0);
      expect(reported.delivery_checks?.state).toBe("unchecked");
      expect(reported.delivery_checks?.reason).toBe("none reported");
      // The head was read once, and no second poll was waited out for it.
      expect(gh.polls()).toBe(1);
      expect(reported.delivery_checks!.waited_ms).toBeLessThan(DELIVERED_CHECKS_POLL_INTERVAL_MS);
      expect(reported.delivery_checks!.waited_ms).toBeLessThan(BOUND_MS);
      expect(reported.delivery_checks!.bounded).toBe(true);
      expect(elapsed).toBeLessThan(RUN_TIMEOUT_MS);

      const read = await inspect(repo, reported.ticket_id);
      expect(read.report.delivery_checks).toEqual({ state: "unchecked", checks: [] });
      expect(read.shown).toContain("checks unchecked");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "polls to the bound where a workflow does trigger on a pull request",
    async () => {
      const repo = repository("registers-late");
      workflowFile(repo, ".github/workflows/ci.yml", "pull_request");
      const gh = fakeGhForChecks("registers-late", {
        workflows: [{ name: "CI", path: ".github/workflows/ci.yml" }],
      });

      const startedAt = Date.now();
      const result = await withGh(gh.bin, () =>
        run(repo, [
          "--publish",
          "--config",
          runConfig("registers-late", repo, { delivery_checks_bound_ms: BOUND_MS }),
        ]),
      );
      const elapsed = Date.now() - startedAt;

      expect(result.code).toBe(0);
      const reported = JSON.parse(result.out) as RunReport;
      expect(reported.repository_checks?.runs_checks).toBe(true);
      expect(reported.repository_checks?.workflows.map((entry) => entry.path)).toEqual([
        ".github/workflows/ci.yml",
      ]);
      // The same empty rollup, and this time the bound is what ended the read.
      expect(reported.delivery_checks?.state).toBe("unchecked");
      expect(reported.delivery_checks?.reason).toBe("not reported in time");
      expect(reported.delivery_checks!.bounded).toBe(true);
      expect(reported.delivery_checks!.waited_ms).toBeGreaterThanOrEqual(BOUND_MS);
      expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS);
      // More than the one read the case above made: it went back for them.
      expect(gh.polls()).toBeGreaterThan(1);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "tells a person which of the two it was, in different words",
    async () => {
      const nothing = repository("says-nothing-runs");
      workflowFile(nothing, ".github/workflows/release.yml", "push");
      const nothingGh = fakeGhForChecks("says-nothing-runs", {
        workflows: [{ name: "Release", path: ".github/workflows/release.yml" }],
      });
      const late = repository("says-late");
      workflowFile(late, ".github/workflows/ci.yml", "pull_request");
      const lateGh = fakeGhForChecks("says-late", {
        workflows: [{ name: "CI", path: ".github/workflows/ci.yml" }],
      });

      const ranNothing = await withGh(nothingGh.bin, () =>
        run(nothing, [
          "--publish",
          "--config",
          runConfig("says-nothing-runs", nothing, { delivery_checks_bound_ms: BOUND_MS }),
        ], { tty: true }),
      );
      const wasLate = await withGh(lateGh.bin, () =>
        run(late, [
          "--publish",
          "--config",
          runConfig("says-late", late, { delivery_checks_bound_ms: BOUND_MS }),
        ], { tty: true }),
      );

      const checksBlock = (printed: string): string =>
        uncoloured(printed)
          .split("\n")
          .filter((line) => line.startsWith("CHECKS") || line.startsWith("          "))
          .join("\n");
      const shownForNothing = checksBlock(ranNothing.out);
      const shownForLate = checksBlock(wasLate.out);

      // Both are `unchecked`, and neither reads as evidence that anything
      // passed — but one is about the repository and the other about the wait.
      expect(shownForNothing).toContain("unchecked — none reported");
      expect(shownForNothing).toContain("runs no checks on pull requests");
      expect(shownForNothing).toContain("nothing to wait for");
      expect(shownForNothing).not.toContain("stopped waiting");

      expect(shownForLate).toContain("unchecked — not reported in time");
      expect(shownForLate).toContain("had not concluded after");
      expect(shownForLate).toContain("still be running");
      expect(shownForLate).not.toContain("runs no checks");

      expect(shownForNothing).not.toEqual(shownForLate);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "waits for a workflow on the branch that GitHub has never registered",
    async () => {
      // The case the reading has to get right and a `gh workflow list` alone
      // cannot: `main` carries a workflow that triggers on every pull request,
      // and GitHub has never run it, so it is in no list. A reading taken from
      // the list would call this repository one that runs nothing and record
      // the delivery `none reported` a second after the push.
      const repo = repository("never-registered");
      workflowFile(repo, ".github/workflows/ci.yml", "pull_request");
      const gh = fakeGhForChecks("never-registered", { workflows: [] });

      const result = await withGh(gh.bin, () =>
        run(repo, [
          "--publish",
          "--config",
          runConfig("never-registered", repo, { delivery_checks_bound_ms: BOUND_MS }),
        ]),
      );

      expect(result.code).toBe(0);
      const reported = JSON.parse(result.out) as RunReport;
      expect(reported.repository_checks?.runs_checks).toBe(true);
      expect(reported.repository_checks?.workflows.map((entry) => entry.path)).toEqual([
        ".github/workflows/ci.yml",
      ]);
      expect(reported.delivery_checks?.reason).toBe("not reported in time");
      expect(reported.delivery_checks!.waited_ms).toBeGreaterThanOrEqual(BOUND_MS);
      expect(gh.polls()).toBeGreaterThan(1);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "reads the branch a run lands on, not whatever is lying in the working tree",
    async () => {
      // `main` runs a workflow on every pull request. The person's checkout has
      // that same file edited down to a push trigger and not committed — a
      // branch they are part-way through, a merge they have not finished. The
      // head this run pushes is `main` plus its own commits, and the seal
      // refuses an attempt that writes `.github/**` at all, so what will run on
      // the pull request is what `main` says and not what is on disk here.
      const repo = repository("dirty-worktree");
      workflowFile(repo, ".github/workflows/ci.yml", "pull_request");
      writeFileSync(
        join(repo, ".github/workflows/ci.yml"),
        "name: CI\non:\n  push:\n    branches: [main]\njobs: {}\n",
      );
      const gh = fakeGhForChecks("dirty-worktree", {
        workflows: [{ name: "CI", path: ".github/workflows/ci.yml" }],
      });

      const result = await withGh(gh.bin, () =>
        run(repo, [
          "--publish",
          "--config",
          runConfig("dirty-worktree", repo, { delivery_checks_bound_ms: BOUND_MS }),
        ]),
      );

      const reported = JSON.parse(result.out) as RunReport;
      expect(reported.repository_checks?.runs_checks).toBe(true);
      expect(reported.delivery_checks?.reason).toBe("not reported in time");
      expect(reported.delivery_checks!.waited_ms).toBeGreaterThanOrEqual(BOUND_MS);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "waits for a check that reported anyway, and still leaves the pull request alone",
    async () => {
      // Nothing in this repository runs on a pull request, and a check reported
      // on the head all the same — an app, or a status pushed through the API.
      // The run goes back for it rather than recording at once what it read a
      // second after the push; the pull request it published is not rewritten
      // from the second reading, and it still carries the first.
      const repo = repository("unexpected-check");
      workflowFile(repo, ".github/workflows/release.yml", "push");
      const gh = fakeGhForChecks("unexpected-check", {
        workflows: [{ name: "Release", path: ".github/workflows/release.yml" }],
        rollup: [{ __typename: "CheckRun", name: "external", status: "IN_PROGRESS", conclusion: "" }],
      });

      const result = await withGh(gh.bin, () =>
        run(repo, [
          "--publish",
          "--config",
          runConfig("unexpected-check", repo, { delivery_checks_bound_ms: BOUND_MS }),
        ]),
      );

      expect(result.code).toBe(0);
      const reported = JSON.parse(result.out) as RunReport;
      expect(reported.repository_checks?.runs_checks).toBe(false);
      // It waited the bound it was configured with, and recorded the check it
      // was not expecting rather than calling it one that never came.
      expect(reported.delivery_checks?.state).toBe("unchecked");
      expect(reported.delivery_checks?.reason).toBe("not reported in time");
      expect(reported.delivery_checks?.checks).toEqual([
        { name: "external", conclusion: "unchecked" },
      ]);
      expect(reported.delivery_checks!.waited_ms).toBeGreaterThanOrEqual(BOUND_MS);
      expect(gh.polls()).toBeGreaterThan(1);

      // And the pull request was written once, when it was opened: a body that
      // has been public since the push is not truncated and rewritten from a
      // later reading, whatever anyone has added to it since.
      expect(gh.edits()).toBe(1);
      expect(gh.body()).toContain("## Checks on the head");
    },
    RUN_TIMEOUT_MS,
  );
});
