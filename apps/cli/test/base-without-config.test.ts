import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import {
  parseExecuteArgs,
  resolveBase,
  runDoctorCommand,
  runExecuteCommand,
  type ExecuteOptions,
} from "../src/execute.js";
import { attemptsRecordSubject, runInspectCommand } from "../src/inspect.js";
import { exitForThrown } from "../src/entry.js";
import { storeDir } from "../src/store.js";

/**
 * The branch a run publishes against, and which of three sources named it.
 *
 * A repository with no `.perbo/config.json` used to publish against the
 * literal `HEAD`, which GitHub refuses — `Base ref must be a branch` — after
 * the whole loop has been paid for. The base is resolved before the run starts
 * instead: a `base_ref` somebody configured, failing that the branch this
 * checkout is on, failing that — CI checks out a commit, not a branch — the
 * branch the remote declares as its default. Where none of the three answers,
 * the run refuses before it provisions anything, naming `base_ref` as the fix.
 *
 * Everything here is driven through the shipped command. `gh` is faked as a
 * binary on PATH, the way `inspect-pull-request.test.ts` does it, so the argv
 * `gh pr create` is really given is what these read; the push is hooked — there
 * is no remote to push to — and the reviewer is a double, but the configuration
 * merge, the worktree, the merge-up, the seal and the delivery call are the
 * shipped ones. The remote is a real bare repository whose `HEAD` names the
 * default, so the resolution reads `refs/remotes/origin/HEAD` rather than
 * something this file asserted about it.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-base-"));
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

/** The commit a ref names, as `git` resolves it in that checkout. */
const tipOf = (dir: string, ref: string): string => git(dir, "rev-parse", ref).trim();

/** Whether `ref` carries `commit` — how a merge that happened is read back. */
const carries = (dir: string, ref: string, commit: string): boolean => {
  try {
    git(dir, "merge-base", "--is-ancestor", commit, ref);
    return true;
  } catch {
    return false;
  }
};

interface RepositoryShape {
  /** Leave HEAD detached, so no branch names itself. */
  detached?: boolean;
  /**
   * Give it an `origin` whose HEAD names a branch: `main`, or the branch named.
   * Every local branch is pushed to it, and the remote's own HEAD is set there
   * — a clone reads `origin/HEAD` from the remote, and `git remote set-head
   * --auto` asks it.
   */
  remoteDefault?: boolean | string;
  /**
   * Branches cut at the base commit and moved one commit past it, so a base
   * named from one of them is a base the run's merge-up really resolves and
   * really merges — the shape a checkout has when the branch it publishes
   * against has moved since the commit under test was cut.
   */
  branches?: readonly string[];
}

/** A repository with one commit, a `test` script, a lockfile and no `.perbo/`. */
function repository(name: string, shape: RepositoryShape = {}): string {
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
  for (const branch of shape.branches ?? []) {
    git(dir, "checkout", "-q", "-b", branch);
    writeFileSync(join(dir, "src", `${branch.replace(/[^a-z0-9]/gi, "-")}.ts`), "export const on = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `work on ${branch}`);
    git(dir, "checkout", "-q", "main");
  }
  const remoteDefault = shape.remoteDefault === true ? "main" : (shape.remoteDefault ?? null);
  if (remoteDefault) {
    const bare = mkdtempSync(join(scratch, `${name}-remote-`));
    execFileSync("git", ["init", "-q", "--bare", bare], { env: gitEnv });
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "origin", "--all");
    // A default the checkout has no branch for is still a branch on the remote:
    // the fixture pushes this commit under that name, which is what a
    // repository whose default nobody has checked out looks like.
    if (git(dir, "branch", "--list", remoteDefault).trim() === "") {
      git(dir, "push", "-q", "origin", `HEAD:refs/heads/${remoteDefault}`);
    }
    // The remote's own HEAD first, so `origin/HEAD` is what the remote declares
    // rather than something this fixture asserted about it.
    git(bare, "symbolic-ref", "HEAD", `refs/heads/${remoteDefault}`);
    git(dir, "remote", "set-head", "origin", "--auto");
  }
  if (shape.detached) git(dir, "checkout", "-q", "--detach", "HEAD");
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

/**
 * A `gh` on PATH that records every argv it is given and answers `pr create`
 * with a URL. `pr view` exits non-zero: there is no pull request on the branch
 * yet, which is what sends delivery to `create`.
 */
function fakeGh(name: string): { bin: string; calls: () => string[][] } {
  const root = join(scratch, `gh-${name}`);
  mkdirSync(root, { recursive: true });
  const log = join(root, "argv");
  writeFileSync(log, "");
  const script = join(root, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `{ for a in "$@"; do printf '%s\\n' "$a"; done; printf 'END\\n'; } >> ${log}`,
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      '  echo "https://github.com/o/r/pull/1"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    bin: root,
    calls: () =>
      readFileSync(log, "utf8")
        .split("END\n")
        .filter((block) => block.length > 0)
        .map((block) => block.split("\n").slice(0, -1)),
  };
}

/** The one `gh pr create` argv, or a failure naming what was recorded instead. */
function created(calls: string[][]): string[] {
  const create = calls.filter((argv) => argv[0] === "pr" && argv[1] === "create");
  expect(create, `gh calls: ${JSON.stringify(calls)}`).toHaveLength(1);
  return create[0]!;
}

/** What `--base` was given in an argv. */
const baseOf = (argv: readonly string[]): string | null => {
  const at = argv.indexOf("--base");
  return at === -1 ? null : (argv[at + 1] ?? null);
};

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

/** The root a run under the configuration below puts its worktrees in. */
const worktreeRoot = (name: string): string => join(scratch, `${name}-worktrees`);

/**
 * What a run needs that the repository cannot supply, and the one key a test
 * must not inherit: the worktree root, whose derived default is under `$HOME`.
 * Deliberately says nothing about `base_ref`.
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

/** The repository's own `.perbo/config.json`. */
function repoConfig(repo: string, config: Record<string, unknown>): void {
  const dir = storeDir(repo, null);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
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
  return { out, err, streams: { stdout: (c: string) => out.push(c), stderr: (c: string) => err.push(c), isTTY } };
};

/** The rendering without its colours: the words are what is being read. */
// eslint-disable-next-line no-control-regex
const uncoloured = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

/** What a run reported about itself, from the JSON it writes on stdout. */
interface RunReport {
  ticket_id: string;
  branch: string;
}

/**
 * `perbo run …` as the program runs it: the command, and — for anything that
 * escapes it — `exitForThrown` writing onto the same stderr.
 */
async function run(
  repo: string,
  argv: readonly string[],
  options: Omit<ExecuteOptions, "args" | "streams" | "cwd"> = {},
): Promise<{ code: number; err: string; out: string }> {
  const streams = capture();
  try {
    const code = await runExecuteCommand({
      args: parseExecuteArgs(["--repo", repo, "--outcome", OUTCOME, "--criterion", CRITERION, "--json", ...argv]),
      streams: streams.streams,
      cwd: repo,
      preflight: okPreflight,
      hooks: {
        review: reviewer() as never,
        push: (async () => ({ pushed: true, detail: "hooked" })) as never,
      },
      ...options,
    });
    return { code, err: streams.err.join(""), out: streams.out.join("") };
  } catch (error) {
    const failure = exitForThrown("run", error);
    streams.streams.stderr(`error: ${failure.message}\n`);
    return { code: failure.code, err: streams.err.join(""), out: streams.out.join("") };
  }
}

/**
 * `perbo run --contract <file> --config <file>`: the one path that is handed a
 * whole run configuration instead of merging one. The contract is written here
 * rather than minted, pinned to this checkout's HEAD, and the configuration
 * carries the roots a merged one would have derived — deliberately with no
 * `base_ref` unless a test writes one, because what this path used to do with
 * that silence was run against the schema's literal `HEAD`.
 */
async function runContract(
  repo: string,
  name: string,
  config: Record<string, unknown>,
  argv: readonly string[] = [],
): Promise<{ code: number; err: string; out: string }> {
  const contractPath = join(scratch, `${name}.contract.json`);
  writeFileSync(
    contractPath,
    JSON.stringify({
      plan_id: `plan_${name.replace(/[^a-z0-9]/gi, "")}`.slice(0, 40),
      version: 1,
      ticket_id: `ticket_${name.replace(/[^a-z0-9]/gi, "")}`.slice(0, 40),
      level: "P1",
      outcome: OUTCOME,
      acceptance_criteria: [
        {
          id: "ac_1",
          text: "total() returns the sum of its inputs",
          expected_verification: { kind: "test", assertion: "total([1,2]) is 3" },
        },
      ],
      scope: {
        repository_id: `repo_${name}`,
        paths_allowed: ["src/**"],
        paths_prohibited: [".github/**"],
        generated_paths: [],
        expansion_budget_files: 2,
      },
      base: {
        base_commit: tipOf(repo, "HEAD"),
        context_manifest_hash: `sha256:${"0".repeat(64)}`,
        captured_at: "2026-08-27T00:00:00.000Z",
      },
    }),
  );
  const store = storeDir(repo, null);
  const configPath = join(scratch, `${name}.run-config.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      ticket_key: name.replace(/[^A-Za-z0-9_-]/g, "-"),
      repository_root: repo,
      worktree_root: worktreeRoot(name),
      bundle_root: join(store, "bundles"),
      quarantine_root: join(store, "quarantine"),
      state_root: join(store, "state"),
      agent_binary: agent(name),
      model: "double",
      materialization_manifest: noInstall(repo),
      limits: { organisation: "test", limits: { concurrent_local_attempts: 4 } },
      ...config,
    }),
  );
  const streams = capture();
  try {
    const code = await runExecuteCommand({
      args: parseExecuteArgs(["--repo", repo, "--contract", contractPath, "--config", configPath, "--json", ...argv]),
      streams: streams.streams,
      cwd: repo,
      preflight: okPreflight,
      hooks: {
        review: reviewer() as never,
        push: (async () => ({ pushed: true, detail: "hooked" })) as never,
      },
    });
    return { code, err: streams.err.join(""), out: streams.out.join("") };
  } catch (error) {
    const failure = exitForThrown("run", error);
    streams.streams.stderr(`error: ${failure.message}\n`);
    return { code: failure.code, err: streams.err.join(""), out: streams.out.join("") };
  }
}

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

/** One line of stderr that is a stack frame, as V8 writes them. */
const STACK_FRAME = /^\s+at\s/m;

/** The `base` lines the run prints, or none. */
const baseLines = (err: string): string[] => err.split("\n").filter((line) => /^\s+base\s/.test(line));

/** The merge-up lines the loop prints, which name the base they merged. */
const mergedLines = (err: string): string[] => err.split("\n").filter((line) => line.includes("merged "));

const RUN_TIMEOUT_MS = 180_000;
const DOCTOR_TIMEOUT_MS = 120_000;

describe("the base a run publishes against, where nothing configured one", () => {
  it("opens the pull request against the branch the checkout is on", async () => {
    const repo = repository("on-main");
    const gh = fakeGh("on-main");

    expect(resolveBase(repo, undefined, { publish: false })).toEqual({
      base_ref: "main",
      from: "branch",
    });

    const result = await withGh(gh.bin, () => run(repo, ["--publish", "--config", runConfig("on-main", repo)]));

    expect(result.code).toBe(0);
    expect(baseOf(created(gh.calls()))).toBe("main");

    // And the run says so, in the register of the line that names its checks.
    const line = baseLines(result.err);
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("main");
    expect(line[0]).toContain("the branch this checkout is on");
  }, RUN_TIMEOUT_MS);

  it("takes the remote's default branch where the checkout is detached", async () => {
    const repo = repository("detached", { detached: true, remoteDefault: true });

    const result = await run(repo, ["--config", runConfig("detached", repo)]);

    expect(result.code).toBe(0);
    const line = baseLines(result.err);
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("main");
    expect(line[0]).toContain("default branch");
  }, RUN_TIMEOUT_MS);

  it("refuses before a worktree exists where neither names a base", async () => {
    const repo = repository("nameless", { detached: true });

    expect(resolveBase(repo, undefined, { publish: false })).toBeNull();

    const result = await run(repo, ["--config", runConfig("nameless", repo)]);

    expect(result.code).toBe(EXIT_CODES.did_not_complete);

    // Nothing was cut and nothing was provisioned on the way there: no worktree
    // under the root this run was given, no attempt branch, no run state.
    const worktrees = worktreeRoot("nameless");
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
    expect(git(repo, "branch", "--list", "ayo/*", "prb/*").trim()).toBe("");
    expect(existsSync(join(storeDir(repo, null), "state"))).toBe(false);

    // One message about the base: the finding, the key that fixes it and the
    // file to set it in — and, in the refusal around it, the command that
    // reports the whole diagnostic.
    const said = result.err.split("\n").filter((line) => line.includes("base_ref"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("base_ref_unknown");
    expect(said[0]).toContain(join(storeDir(repo, null), "config.json"));
    expect(result.err).toContain(`perbo doctor --repo ${repo}`);
    expect(result.err).not.toMatch(STACK_FRAME);
  }, RUN_TIMEOUT_MS);

  it("leaves a configured base alone, and says it is the configuration's", async () => {
    const repo = repository("configured", { branches: ["develop"] });
    repoConfig(repo, { base_ref: "develop" });
    const gh = fakeGh("configured");
    const develop = tipOf(repo, "develop");

    const result = await withGh(gh.bin, () => run(repo, ["--publish", "--config", runConfig("configured", repo)]));

    expect(result.code).toBe(0);
    // The configured base beats the branch this checkout is on, and the run
    // names it and its source rather than leaving a person to read the pull
    // request to find out it did not land on `main`.
    expect(baseOf(created(gh.calls()))).toBe("develop");
    const line = baseLines(result.err);
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("develop");
    expect(line[0]).toContain("config");

    // And it is the branch the run kept level with: `develop` has moved past
    // the commit this was cut from, and the attempt branch carries it.
    expect(carries(repo, (JSON.parse(result.out) as RunReport).branch, develop)).toBe(true);
  }, RUN_TIMEOUT_MS);
});

describe("a detached checkout whose remote declares develop", () => {
  it("resolves develop, merges it up and opens the pull request against it", async () => {
    const repo = repository("develop", { detached: true, remoteDefault: "develop", branches: ["develop"] });
    const gh = fakeGh("develop");
    const develop = tipOf(repo, "develop");

    // The checkout is on nothing, and `main` — the branch it was cut from, and
    // the base the old default would have produced — is not what the remote
    // declares.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");
    expect(git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").trim()).toBe("origin/develop");

    // The resolution, with nothing configured: the remote's default branch.
    expect(resolveBase(repo, undefined, { publish: false })).toEqual({
      base_ref: "develop",
      from: "remote_default",
    });

    const result = await withGh(gh.bin, () => run(repo, ["--publish", "--config", runConfig("develop", repo)]));

    expect(result.code).toBe(0);
    // The pull request `gh` was really asked to open targets it.
    expect(baseOf(created(gh.calls()))).toBe("develop");

    // And the whole run used it, not only the delivery call: the loop merged
    // `develop` into the attempt branch, and the branch carries its tip.
    const reported = JSON.parse(result.out) as RunReport;
    expect(mergedLines(result.err).join("\n")).toContain(`merged develop at ${develop.slice(0, 12)}`);
    expect(carries(repo, reported.branch, develop)).toBe(true);

    // The run says so before it starts, and says where the answer came from.
    const line = baseLines(result.err);
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("develop");
    expect(line[0]).toContain("remote default");
  }, RUN_TIMEOUT_MS);

  it("publishes against a configured base_ref instead of the remote default", async () => {
    const repo = repository("release", {
      detached: true,
      remoteDefault: "develop",
      branches: ["develop", "release/1.x"],
    });
    repoConfig(repo, { base_ref: "release/1.x" });
    const gh = fakeGh("release");
    const release = tipOf(repo, "release/1.x");
    const develop = tipOf(repo, "develop");

    expect(resolveBase(repo, "release/1.x", { publish: false })).toEqual({
      base_ref: "release/1.x",
      from: "config",
    });

    const result = await withGh(gh.bin, () => run(repo, ["--publish", "--config", runConfig("release", repo)]));

    expect(result.code).toBe(0);
    expect(baseOf(created(gh.calls()))).toBe("release/1.x");

    // The remote still declares `develop`; the configuration is the base the
    // run merged up from and the base it published against, and `develop` is
    // nowhere in either.
    expect(git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").trim()).toBe("origin/develop");
    const reported = JSON.parse(result.out) as RunReport;
    expect(mergedLines(result.err).join("\n")).toContain(`merged release/1.x at ${release.slice(0, 12)}`);
    expect(carries(repo, reported.branch, release)).toBe(true);
    expect(carries(repo, reported.branch, develop)).toBe(false);

    const line = baseLines(result.err);
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("release/1.x");
    expect(line[0]).toContain("config");
    expect(line[0]).not.toContain("develop");
  }, RUN_TIMEOUT_MS);
});

describe("a base_ref that is not a branch name", () => {
  /** Every shape a mistyped `base_ref` arrives in, and what it holds. */
  const mistyped: Array<[string, unknown]> = [
    ["blank", ""],
    ["whitespace", "   "],
    ["padded", " develop "],
    ["a number", 42],
    ["null", null],
  ];

  it.each(mistyped)("refuses a %s base_ref rather than deriving over it", async (kind, value) => {
    const name = `mistyped-${kind.replace(/\s/g, "-")}`;
    // A checkout that has an answer of its own for every derivation: on `main`,
    // with a remote declaring `develop`. Neither may be used — the person who
    // wrote this key meant a branch, and quietly publishing against one they
    // did not name is the failure.
    const repo = repository(name, { remoteDefault: "develop", branches: ["develop"] });
    repoConfig(repo, { base_ref: value });
    const gh = fakeGh(name);

    const result = await withGh(gh.bin, () => run(repo, ["--publish", "--config", runConfig(name, repo)]));

    expect(result.code).not.toBe(0);
    // Named, with the file it was read from and what it holds, in one message.
    const said = result.err.split("\n").filter((line) => line.includes("base_ref"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(join(storeDir(repo, null), "config.json"));
    expect(said[0]).toContain(JSON.stringify(value));
    expect(result.err).not.toMatch(STACK_FRAME);

    // And nothing ran: no pull request, no worktree, no attempt branch.
    expect(gh.calls()).toEqual([]);
    const worktrees = worktreeRoot(name);
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
    expect(git(repo, "branch", "--list", "ayo/*", "prb/*").trim()).toBe("");
    expect(baseLines(result.err)).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("refuses one an explicit --config names, and says which file said it", async () => {
    const repo = repository("mistyped-override", { remoteDefault: "develop", branches: ["develop"] });
    // The repository agreed a good one; the file passed on the command line is
    // the narrower layer, so its answer is the one under test — and a `--config`
    // that names a base wins, whatever it holds.
    repoConfig(repo, { base_ref: "develop" });
    const path = runConfig("mistyped-override", repo);
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...config, base_ref: " develop " }));
    const gh = fakeGh("mistyped-override");

    const result = await withGh(gh.bin, () => run(repo, ["--publish", "--config", path]));

    expect(result.code).not.toBe(0);
    const said = result.err.split("\n").filter((line) => line.includes("base_ref"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("--config");
    expect(said[0]).toContain('" develop "');
    expect(gh.calls()).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("doctor names the key, the file and the value it holds", async () => {
    const repo = repository("doctor-mistyped", { remoteDefault: "develop" });
    repoConfig(repo, { base_ref: "" });

    const reported = capture(true);
    await runDoctorCommand({
      args: parseExecuteArgs(["--repo", repo]),
      streams: reported.streams,
      cwd: repo,
      preflight: okPreflight,
    });

    const shown = uncoloured(reported.out.join(""));
    // The diagnostic reports what a run would do with this file, which is
    // refuse — and does not answer `main` as though the key were not there.
    expect(shown).toContain("BASE      none");
    expect(shown).toContain(`base_ref in ${join(storeDir(repo, null), "config.json")}`);
    expect(shown).toContain('is ""');
    expect(shown).not.toContain("BASE      main");
  }, DOCTOR_TIMEOUT_MS);
});

describe("a run handed its whole configuration, on the --contract path", () => {
  it("resolves the base that configuration does not name", async () => {
    const repo = repository("contract-detached", {
      detached: true,
      remoteDefault: "develop",
      branches: ["develop"],
    });
    const gh = fakeGh("contract-detached");
    const develop = tipOf(repo, "develop");

    const result = await withGh(gh.bin, () => runContract(repo, "contract-detached", {}, ["--publish"]));

    expect(result.code).toBe(0);
    // The configuration named no base, so the remote's default answered — and
    // not the schema's literal `HEAD`, which GitHub refuses as a base.
    expect(baseOf(created(gh.calls()))).toBe("develop");
    expect(mergedLines(result.err).join("\n")).toContain(`merged develop at ${develop.slice(0, 12)}`);
    const line = baseLines(result.err);
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("develop");
    expect(line[0]).toContain("remote default");
    expect(line[0]).not.toContain("HEAD");
  }, RUN_TIMEOUT_MS);

  it("says config, and means it, where that configuration names one", async () => {
    const repo = repository("contract-configured", {
      detached: true,
      remoteDefault: "develop",
      branches: ["develop", "release/1.x"],
    });
    const gh = fakeGh("contract-configured");

    const result = await withGh(gh.bin, () =>
      runContract(repo, "contract-configured", { base_ref: "release/1.x" }, ["--publish"]),
    );

    expect(result.code).toBe(0);
    expect(baseOf(created(gh.calls()))).toBe("release/1.x");
    const line = baseLines(result.err);
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("release/1.x");
    expect(line[0]).toContain("config");
  }, RUN_TIMEOUT_MS);

  it("refuses where nothing names a base, before a worktree exists", async () => {
    const repo = repository("contract-nameless", { detached: true });

    const result = await runContract(repo, "contract-nameless", {});

    expect(result.code).toBe(EXIT_CODES.did_not_complete);
    const said = result.err.split("\n").filter((line) => line.includes("base_ref"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("base_ref_unknown");
    const worktrees = worktreeRoot("contract-nameless");
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
    expect(result.err).not.toMatch(STACK_FRAME);
  }, RUN_TIMEOUT_MS);

  it("works on the branch it derives, whatever delivery_branch that configuration names", async () => {
    const repo = repository("contract-branch");
    const gh = fakeGh("contract-branch");

    // Under the contract's own id, so what keeps it off is the rule that no
    // configuration file names the branch, not the one that turns away another
    // ticket's.
    const result = await withGh(gh.bin, () =>
      runContract(repo, "contract-branch", { delivery_branch: "prb/contractbranch/named-by-the-file" }, [
        "--publish",
      ]),
    );

    expect(result.code).toBe(0);
    const derived = "prb/contractbranch/the-feature-module-exports-a-com";
    expect((JSON.parse(result.out) as RunReport).branch).toBe(derived);
    const create = created(gh.calls());
    expect(create[create.indexOf("--head") + 1]).toBe(derived);
    expect(result.err).toContain("sets 'delivery_branch', which only a ticket's delivery record sets. Ignoring it.");
  }, RUN_TIMEOUT_MS);
});

describe("what says where a run publishes", () => {
  it("inspect names the base and the source that answered", async () => {
    const repo = repository("inspected", { detached: true, remoteDefault: "develop", branches: ["develop"] });
    const gh = fakeGh("inspected");
    const result = await withGh(gh.bin, () => run(repo, ["--publish", "--config", runConfig("inspected", repo)]));
    expect(result.code).toBe(0);
    const reported = JSON.parse(result.out) as RunReport;
    expect(baseOf(created(gh.calls()))).toBe("develop");

    // The checkout moves on under the record, the way a checkout does: the
    // remote now declares `main`, and somebody has since pinned `release/1.x`.
    // What `inspect` prints beside this run's pull request is where *this run*
    // published, so neither of those may change the answer below.
    git(repo, "remote", "set-head", "origin", "main");
    repoConfig(repo, { base_ref: "release/1.x" });

    const asJson = capture();
    expect(
      await runInspectCommand({
        argv: [reported.ticket_id, "--repo", repo],
        streams: asJson.streams,
        cwd: repo,
        subject: attemptsRecordSubject,
      }),
    ).toBe(0);
    const report = JSON.parse(asJson.out.join("")) as { base: { ref: string; from: string } | null };
    expect(report.base).toEqual({ ref: "develop", from: "remote_default" });

    // And in the reading a person gets on a terminal, beside the pull request.
    const onTty = capture(true);
    expect(
      await runInspectCommand({
        argv: [reported.ticket_id, "--repo", repo],
        streams: onTty.streams,
        cwd: repo,
        subject: attemptsRecordSubject,
      }),
    ).toBe(0);
    const shown = uncoloured(onTty.out.join(""));
    expect(shown).toContain("base develop (remote default)");
    // Above the attempts, with the run's identity and its pull request, not
    // buried in the round that happened to publish.
    expect(shown.indexOf("base develop")).toBeLessThan(shown.indexOf("ATTEMPT"));
  }, RUN_TIMEOUT_MS);

  it("doctor names the base it would use, and the key to set where it cannot", async () => {
    const declared = repository("doctor-develop", { detached: true, remoteDefault: "develop" });
    const nameless = repository("doctor-nameless", { detached: true });

    const report = async (repo: string): Promise<string> => {
      const reported = capture(true);
      await runDoctorCommand({
        args: parseExecuteArgs(["--repo", repo]),
        streams: reported.streams,
        cwd: repo,
        preflight: okPreflight,
      });
      return uncoloured(reported.out.join(""));
    };

    expect(await report(declared)).toContain("BASE      develop — remote default:");
    // And where no source names one, the diagnostic says so before a run has
    // to, and names the key that fixes it.
    const none = await report(nameless);
    expect(none).toContain("BASE      none");
    expect(none).toContain(`set base_ref in ${join(storeDir(nameless, null), "config.json")}`);
  }, DOCTOR_TIMEOUT_MS);

  it("doctor pins the base it named in the config it writes", async () => {
    const repo = repository("doctor-base");
    const doctorArgs = (writeConfig: boolean) =>
      parseExecuteArgs(["--repo", repo, "--json", ...(writeConfig ? ["--write-config"] : [])]);

    const reported = capture();
    await runDoctorCommand({
      args: doctorArgs(false),
      streams: reported.streams,
      cwd: repo,
      preflight: okPreflight,
    });
    const report = JSON.parse(reported.out.join("")) as {
      base: { ref: string | null; from: string | null };
      config: { proposed: { base_ref?: string } };
    };
    expect(report.base.ref).toBe("main");
    expect(report.base.from).toBe("branch");
    expect(report.config.proposed.base_ref).toBe("main");

    const written = capture();
    await runDoctorCommand({
      args: doctorArgs(true),
      streams: written.streams,
      cwd: repo,
      preflight: okPreflight,
    });
    const onDisk = JSON.parse(readFileSync(join(storeDir(repo, null), "config.json"), "utf8")) as {
      base_ref?: string;
    };
    expect(onDisk.base_ref).toBe("main");
  }, DOCTOR_TIMEOUT_MS);
});
