import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_CODES,
  TicketSchema,
  planContractFromSource,
  sourceContractFromArguments,
  sourceIdentity,
  type Ticket,
} from "@perbo/contracts";
import { pollPullRequest, type PreflightRequest, type PreflightResult } from "@perbo/runner";
import { branchName } from "@perbo/workspace";
import { admitCommandLine } from "../admit.js";
import { escapesCommandLine } from "../escapes/index.js";
import { type ExecuteDeps, executeCommandLine } from "./index.js";
import { buildInspectReport } from "../inspect.js";
import {
  LOCAL_RUN_SCHEMA_VERSION,
  LocalRunRecordSchema,
  readLocalRunRecord,
  writeLocalRunRecord,
  type LocalRunRecord,
} from "./local.js";
import { stopsCommandLine } from "../stops.js";
import { syncCommandLine } from "../sync.js";
import {
  headCommit,
  idsFor,
  localRunBranch,
  localRunChange,
  repositoryId,
  storeDir,
  writeTicket,
} from "../../store/tickets.js";
import { makeAttempt } from "../../test-support/records.js";
import { buildCli, removeStagedBundles, spawnBuilt } from "../../test-support/built-cli.js";
import { SPAWN_TEST_TIMEOUT_MS, watchOutbound } from "@perbo/test-support";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";

/**
 * `perbo run` with nothing admitted behind it (AYO-32).
 *
 * The reviewer is a double and the executor is a real binary this file writes:
 * paying a provider is not what these tests are about, but the write guard is,
 * so the agent has to be a process the runner really spawns, that really runs
 * the `PreToolUse` hook the adapter installed and really obeys its answer. That
 * is what makes "the file was never created" an assertion about the guard.
 *
 * Everything else is the shipped thing: the real argument parser, the real
 * contract minting, the real run-configuration merge, the real worktree, the
 * real seal, the real pinned checks, the real store writes and the real
 * `inspect`. What is asserted is the effect — a contract on disk, a file that
 * does not exist, a record `inspect` can read — rather than that a function was
 * called.
 *
 * **Fail-first, measured rather than argued.** Nothing here imports a module
 * the change adds, so this file loads at the commit before it and each test
 * fails on the behaviour it is about instead of on an import that cannot
 * resolve — which is the difference between evidence that the tests
 * discriminate and evidence that the file is new.
 *
 * Taken on 2026-09-04: `apps/cli/src`, `packages/contracts/src` and
 * `packages/runner/src` restored to 4377cdb (dropping `src/local-run.ts`, which
 * that commit does not have), the workspace packages rebuilt, then
 * `pnpm exec vitest run src/commands/run/local.test.ts` in `apps/cli`. Result: 7 of 7
 * failed, six on `unknown flag '--outcome'` and one on `unknown flag '--pr'`,
 * thrown where the run reads its line — at that commit the command takes its plan only
 * from an admitted ticket. The same command after the change: 7 passed.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-local-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

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

/** A repository with one commit and, above all, no ticket store. */
function repository(name: string): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv });
  // Repository-local identity, so the seal's commit does not depend on the
  // developer's global Git configuration or on a signing key nobody can unlock.
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const version = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

/** One tool call the executor makes, as the agent's stream reports it. */
interface AgentCall {
  tool: "Bash" | "Write";
  input: Record<string, unknown>;
}

/**
 * An executor that obeys the write guard, as a real program.
 *
 * Before each call it runs the `PreToolUse` hook out of its own `--settings`
 * file with the call on stdin — which is where the pinned binary runs it — and
 * performs the call only when the answer is not `deny`, reporting a refusal in
 * `permission_denials` the way the agent's own permission layer does. The
 * runner spawns it, reads its stream-json and its exit code, so what these
 * tests drive is the shipped adapter rather than a stand-in for it.
 */
function guardedAgent(
  name: string,
  calls: readonly AgentCall[],
  /**
   * What the init line reports the credential came from. `none` is a
   * subscription, which is what a developer machine reports; a name is an API
   * key, and D-096 makes that the only case a cost cap binds at all.
   */
  apiKeySource = "none",
): string {
  const dir = mkdtempSync(join(scratch, `agent-${name}-`));
  const binary = join(dir, "agent.cjs");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
"use strict";
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

// The runner fingerprints the binary before it runs it; that is not a call.
if (process.argv.includes("--version")) {
  process.stdout.write("fake-agent 1.0.0\\n");
  process.exit(0);
}

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({
  type: "system",
  subtype: "init",
  apiKeySource: ${JSON.stringify(apiKeySource)},
  mcp_servers: [],
  plugins: [],
  skills: [],
  agents: [],
  memory_paths: null,
});

const settings = JSON.parse(
  readFileSync(process.argv[process.argv.indexOf("--settings") + 1], "utf8"),
);
const hook = settings.hooks.PreToolUse[0].hooks[0].command;
const denials = [];
let index = 0;
for (const call of ${JSON.stringify(calls)}) {
  index += 1;
  const id = "toolu_fake_" + index;
  const stdin = JSON.stringify({
    session_id: "fake",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: call.tool,
    tool_input: call.input,
    tool_use_id: id,
  });
  const printed = execFileSync("/bin/sh", ["-c", hook], { input: stdin, encoding: "utf8" }).trim();
  // Nothing printed is the hook deferring, and this stand-in then does what the
  // agent's own permission layer would for these calls, which is to run them.
  const answer = printed.length > 0 ? JSON.parse(printed) : null;
  const allowed = answer === null || answer.hookSpecificOutput.permissionDecision === "allow";
  emit({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: call.tool, input: call.input }],
      usage: { input_tokens: 7, output_tokens: 2 },
    },
  });
  if (!allowed) {
    denials.push({ tool_name: call.tool, tool_use_id: id, tool_input: call.input });
    continue;
  }
  // Admitted, so it happens — which is what makes "the file was never created"
  // an assertion about the guard rather than about this program.
  try {
    if (call.tool === "Bash") {
      execFileSync("/bin/sh", ["-c", call.input.command], { cwd: process.cwd() });
    } else {
      mkdirSync(dirname(call.input.file_path), { recursive: true });
      writeFileSync(call.input.file_path, call.input.content || "");
    }
  } catch (error) {
    // A command that failed on its own is not a refusal.
  }
}
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.004,
  permission_denials: denials,
});
process.exit(0);
`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return binary;
}

/**
 * A `gh` that answers reads and refuses everything else, and logs every
 * invocation. Handed to the command as a binary rather than dropped on PATH: a
 * test that edits the environment of the process edits it for every other test
 * in the file.
 *
 * `auth status` answers too: SCP-200 asks which credential a `--pr` read goes
 * through before it goes, and this is a `gh` that is signed in.
 */
function replayGh(name: string, view: unknown, diff = ""): { binary: string; log: string } {
  const dir = mkdtempSync(join(scratch, `gh-${name}-`));
  const log = join(dir, "invocations.log");
  writeFileSync(join(dir, "view.json"), JSON.stringify(view));
  writeFileSync(join(dir, "change.diff"), diff);
  const binary = join(dir, "gh");
  writeFileSync(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat ${JSON.stringify(join(dir, "view.json"))}; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then cat ${JSON.stringify(join(dir, "change.diff"))}; exit 0; fi
echo "refused: this gh replays reads only, got: $*" >&2
exit 1
`,
  );
  chmodSync(binary, 0o755);
  return { binary, log };
}

const ghInvocations = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.trim() !== "") : [];

/**
 * The machine, answered rather than measured. What is on this developer's PATH
 * is not what any of these tests are about, and the real check spawns three
 * binaries to ask each for its version.
 */
const okPreflight = (_request: PreflightRequest): PreflightResult => ({
  ok: true,
  findings: [],
  tools: {},
  github: null,
});

/**
 * The repository's own `.perbo/config.json` — the pinned checks, the protected
 * paths and the limits this repository agreed once, which is where a run with
 * no ticket behind it reads its judging artifacts from.
 */
function repoConfig(repo: string, config: Record<string, unknown>): void {
  const dir = storeDir(repo, null);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    `${JSON.stringify(
      {
        agent_binary: "true",
        model: "double",
        checks: [
          {
            check_id: "check_unit",
            name: "unit",
            kind: "unit",
            command: ["node", "-e", "process.exit(0)"],
            timeout_ms: 30_000,
          },
        ],
        limits: { organisation: "test", limits: { concurrent_local_attempts: 4 } },
        ...config,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * The one thing a repository configuration may not set, because the derived
 * default puts the worktree under `$HOME` and a test must not write there.
 * `--config` is the documented way to override a derived key deliberately.
 */
function worktreeOverride(name: string, config: Record<string, unknown> = {}): string {
  const path = join(scratch, `${name}.config.json`);
  writeFileSync(
    path,
    JSON.stringify({ worktree_root: join(scratch, `${name}-worktrees`), ...config }),
  );
  return path;
}

/** A materialization that installs nothing: these fixtures have no dependencies. */
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

/** What the loop hands its reviewer, of which these tests read two fields. */
interface ReviewRequest {
  changeset?: { changeset_id: string };
  head_commit?: string;
}

/**
 * A reviewer that returns one verdict, priced, without a provider behind it.
 *
 * Its target is the change set it was handed, which is what a reviewer states:
 * it is told what to judge and names that in its verdict. A double that names
 * some other change set would be asserting a property of itself.
 */
const reviewer = (decision: "approve" | "remediable") => async (request: ReviewRequest) => ({
  artifact: {
    schema_version: 1,
    review_id: "rev_0000000000000001",
    created_at: "2026-09-04T00:00:00.000Z",
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
        status: decision === "approve" ? "met" : "not_met",
        verification_strength: decision === "approve" ? "directly_verified" : "asserted_only",
        evidence: null,
        note: null,
      },
    ],
    findings:
      decision === "approve"
        ? []
        : [
            {
              key: "f".repeat(64),
              rule_id: "test.missing_for_criterion",
              source: "semantic",
              criterion_id: "ac_1",
              severity: "major",
              blocking: false,
              blocking_reason: "verification: routed to the executor",
              routing: "remediable",
              confidence: 0.9,
              file: "src/feature.ts",
              line: 1,
              symbol: "total",
              statement: "No test exercises total(); nothing establishes ac_1.",
              status: "open",
              outcome: "unknown",
              waiver: null,
            },
          ],
    scope_deviation: {
      files_outside_scope: [],
      files_in_prohibited_paths: [],
      files_exempt_as_generated: [],
      within_expansion_budget: true,
      expansion_budget_files: 3,
    },
    decision,
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

/** What a run with no ticket behind it writes about itself, on disk. */
interface RunRecordJson {
  run_id: string;
  label: string;
  source: { source: string; reference: string | null; url: string | null };
  contract: {
    ticket_id: string;
    plan_id: string;
    outcome: string;
    acceptance_criteria: Array<{
      id: string;
      text: string;
      expected_verification: { kind: string; assertion: string };
    }>;
    scope: { paths_allowed: string[] };
  };
}

/**
 * The run record as a reader of the store gets it: the bytes at
 * `<store>/runs/<id>.run.json`, parsed here rather than through the module that
 * wrote them. A helper from the change reading a file the change wrote would
 * prove the two agree; this proves the file says what the arguments did.
 */
function runRecord(store: string, runId: string): RunRecordJson {
  const path = join(store, "runs", `${runId}.run.json`);
  expect(existsSync(path), `no run record at ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, "utf8")) as RunRecordJson;
}

/** Every file under a directory, by its path relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(dir, path));
    }
  };
  walk(dir);
  return found.sort();
}

/** The run, its streams and the JSON it printed. */
async function run(
  repo: string,
  argv: readonly string[],
  options: Partial<ExecuteDeps> = {},
): Promise<{ code: number; out: string; err: string; json: RunJson }> {
  const streams = recordStreams();
  const code = await runCommandLine(executeCommandLine, {
    argv: ["--repo", repo, ...argv],
    streams,
    cwd: repo,
    deps: { preflight: okPreflight, ...options },
  });
  const out = streams.out();
  return { code, out, err: streams.err(), json: JSON.parse(out) as RunJson };
}

interface RunJson {
  ticket_id: string;
  outcome: string;
  detail: string;
  /** The branch the run's worktree was on. */
  branch: string;
  total_cost: { micros: number; components: number; priced: number };
  rounds: Array<{
    round: number;
    attempt: {
      attempt_id: string;
      ticket_id: string;
      commands: Array<{
        tool: string;
        decision: string;
        denial_rule: string | null;
        denial_target: string | null;
        denial_reason: string | null;
        decided_by: string;
      }>;
      /** Every host the attempt asked for, as the runner observed it. */
      egress: Array<{ host: string; source: string }>;
      termination: { reason: string; detail: string };
    };
    checks: Array<{ name: string; status: string }>;
    review: { decision: string } | null;
  }>;
}

const OUTCOME = "The feature module exports a computed total";
const CRITERION = "total() returns the sum of its inputs :: total([1,2]) is 3 :: test";

describe("the contract a run with nothing admitted mints", () => {
  it("is the arguments as typed, and it is what the loop ran on", async () => {
    const repo = repository("mint-arguments");
    repoConfig(repo, { agent_binary: guardedAgent("mint-arguments", [
      { tool: "Write", input: { file_path: "src/feature.ts", content: "export const total = 1;\n" } },
    ]), materialization_manifest: noInstall(repo) });
    const gh = replayGh("mint-arguments", {});

    const result = await run(
      repo,
      [
        "--outcome", OUTCOME,
        "--criterion", CRITERION,
        "--path", "src/**",
        "--path", "test/**",
        "--config", worktreeOverride("mint-arguments"),
        "--json",
      ],
      { gh: { binary: gh.binary }, hooks: { review: reviewer("approve") as never } },
    );

    expect(result.code).toBe(0);
    // No admission step: nothing was approved, and there is no ticket to approve.
    expect(existsSync(join(storeDir(repo, null), "tickets"))).toBe(false);

    const record = runRecord(storeDir(repo, null), result.json.ticket_id);
    expect(record.source.source).toBe("arguments");
    // The outcome, the criteria and the globs are the ones supplied — the
    // criterion's own assertion and kind included, and nothing invented.
    expect(record.contract.outcome).toBe(OUTCOME);
    expect(record.contract.acceptance_criteria).toEqual([
      {
        id: "ac_1",
        text: "total() returns the sum of its inputs",
        expected_verification: { kind: "test", assertion: "total([1,2]) is 3" },
      },
    ]);
    expect(record.contract.scope.paths_allowed).toEqual(["src/**", "test/**"]);

    // And that contract is the one the attempt was made against, not a second
    // one minted somewhere else: the plan the attempt records is this plan.
    const attempt = result.json.rounds[0]!.attempt;
    expect(attempt.ticket_id).toBe(record.contract.ticket_id);
    expect(result.json.rounds[0]!.review?.decision).toBe("approve");
    // Reading a pull request is the only thing this command can send anywhere,
    // and no pull request was named.
    expect(ghInvocations(gh.log)).toEqual([]);
  }, 120_000);

  it("is the pull request's own text where one is named, read through gh", async () => {
    const repo = repository("mint-pr");
    repoConfig(repo, { agent_binary: guardedAgent("mint-pr", [
      { tool: "Write", input: { file_path: "src/feature.ts", content: "export const total = 1;\n" } },
    ]), materialization_manifest: noInstall(repo) });
    const gh = replayGh("mint-pr", {
      number: 412,
      title: "Paginate the catalog listing",
      body:
        "## Outcome\n\nThe catalog listing is paginated at 25 per page.\n\n" +
        "## Acceptance criteria\n\n" +
        "- The listing returns 25 rows per page :: the second page starts at row 26\n" +
        "- A page beyond the last returns an empty list\n",
      url: "https://github.invalid/o/r/pull/412",
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: "a".repeat(40),
      baseRefOid: "b".repeat(40),
    });

    const result = await run(
      repo,
      [
        "--pr", "https://github.invalid/o/r/pull/412",
        "--path", "src/**",
        "--config", worktreeOverride("mint-pr"),
        "--json",
      ],
      { gh: { binary: gh.binary }, hooks: { review: reviewer("approve") as never } },
    );

    expect(result.code).toBe(0);
    expect(existsSync(join(storeDir(repo, null), "tickets"))).toBe(false);

    const record = runRecord(storeDir(repo, null), result.json.ticket_id);
    expect(record.source.source).toBe("pull_request");
    expect(record.source.reference).toBe("o/r#412");
    expect(record.source.url).toBe("https://github.invalid/o/r/pull/412");
    expect(record.contract.outcome).toBe("The catalog listing is paginated at 25 per page.");
    expect(record.contract.acceptance_criteria).toEqual([
      {
        id: "ac_1",
        text: "The listing returns 25 rows per page",
        expected_verification: { kind: "test", assertion: "the second page starts at row 26" },
      },
      {
        id: "ac_2",
        text: "A page beyond the last returns an empty list",
        expected_verification: {
          kind: "test",
          assertion: "A page beyond the last returns an empty list",
        },
      },
    ]);
    expect(record.contract.scope.paths_allowed).toEqual(["src/**"]);
    expect(record.contract.ticket_id).toBe("ticket_gh_o_r_412");

    // `gh` was asked which credential it has and then to read, and only to
    // read. A run that pushed, commented or opened anything would have hit the
    // branch this replay refuses.
    expect(ghInvocations(gh.log).map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "auth status",
      "pr view",
      "pr diff",
    ]);
  }, 120_000);
});

/**
 * The write guard, on both paths, against one executor.
 *
 * The calls are identical, the allowed globs are identical, and the only thing
 * that differs is whether a person approved a ticket first. What is compared is
 * the refusal itself — the rule, the target, the reason and who decided — so a
 * run with no admission behind it cannot be running under a weaker guard.
 */
describe("the write guard a run with nothing admitted enforces", () => {
  /**
   * A path outside every worktree, named for the run that will try to reach it.
   *
   * Two runs compared against each other take tags of the **same length**: the
   * refusal quotes the command it refused and caps that quote at a fixed width,
   * so targets of different lengths are cut at different points and the two
   * reasons then differ in the quoting rather than in the guard.
   */
  const escape = (tag: string) => join(scratch, `guard-escape-${process.pid}-${tag}.txt`);

  /** The calls: one write inside the scope, and two outside every glob. */
  const callsFor = (outside: string): AgentCall[] => [
    { tool: "Write", input: { file_path: "src/feature.ts", content: "export const total = 1;\n" } },
    { tool: "Write", input: { file_path: outside, content: "escaped" } },
    { tool: "Bash", input: { command: `printf 'escaped' > ${outside}-bash` } },
  ];

  it("refuses a write outside the allowed globs, and the file is never created", async () => {
    const repo = repository("guard-local");
    const outside = escape("alone");
    repoConfig(repo, {
      agent_binary: guardedAgent("guard-local", callsFor(outside)),
      materialization_manifest: noInstall(repo),
    });

    const result = await run(
      repo,
      [
        "--outcome", OUTCOME,
        "--criterion", CRITERION,
        "--path", "src/**",
        "--config", worktreeOverride("guard-local"),
        "--json",
      ],
      { hooks: { review: reviewer("approve") as never } },
    );

    expect(existsSync(outside)).toBe(false);
    expect(existsSync(`${outside}-bash`)).toBe(false);
    const denied = result.json.rounds[0]!.attempt.commands.filter(
      (command) => command.decision === "denied",
    );
    // Two writes refused, by their targets rather than by a row count: the
    // guard reads a Bash call twice (SCP-161/175) — the pre-execution hook
    // refuses it before it runs, and the transcript reading that outranks the
    // hook records the same refusal again — so one redirect is two rows.
    expect(new Set(denied.map((command) => command.denial_target))).toEqual(
      new Set([outside, `${outside}-bash`]),
    );
    for (const command of denied) {
      expect(command.denial_rule).toBe("write_outside_worktree");
      expect(["pre_execution_hook", "transcript_reading"]).toContain(command.decided_by);
    }
    // The Write is refused before it runs, which is what keeps the file from
    // existing at all rather than being noticed after the fact.
    expect(denied.find((command) => command.tool === "Write")?.decided_by).toBe(
      "pre_execution_hook",
    );
    // The write inside the scope was admitted, so the refusals are the guard
    // discriminating rather than an executor that could do nothing at all.
    expect(result.json.rounds[0]!.attempt.commands[0]?.decision).toBe("allowed");
  }, 120_000);

  it("refuses it exactly as a ticket-backed run does", async () => {
    // One target per run, so a file that did land names the run that wrote it.
    const outside = escape("argument");
    const ticketOutside = escape("ticketed");

    const local = repository("guard-parity-local");
    repoConfig(local, {
      agent_binary: guardedAgent("guard-parity-local", callsFor(outside)),
      materialization_manifest: noInstall(local),
    });
    const fromArguments = await run(
      local,
      [
        "--outcome", OUTCOME,
        "--criterion", CRITERION,
        "--path", "src/**",
        "--config", worktreeOverride("guard-parity-local"),
        "--json",
      ],
      { hooks: { review: reviewer("approve") as never } },
    );

    const ticketed = repository("guard-parity-ticket");
    repoConfig(ticketed, {
      agent_binary: guardedAgent("guard-parity-ticket", callsFor(ticketOutside)),
      materialization_manifest: noInstall(ticketed),
    });
    await runCommandLine(admitCommandLine, {
      argv: [
        "--repo", ticketed,
        "--outcome", OUTCOME,
        "--criterion", CRITERION,
        "--path", "src/**",
        "--approve",
      ],
      streams: recordStreams(),
      cwd: ticketed,
    });
    const fromTicket = await run(
      ticketed,
      ["--ticket", "PRB-1", "--config", worktreeOverride("guard-parity-ticket"), "--json"],
      { hooks: { review: reviewer("approve") as never } },
    );

    // Neither escape landed, and the two runs refused for the same reason under
    // the same rule, decided in the same place.
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(ticketOutside)).toBe(false);
    const shape = (result: RunJson, target: string) =>
      result.rounds[0]!.attempt.commands.map((command) => ({
        tool: command.tool,
        decision: command.decision,
        rule: command.denial_rule,
        by: command.decided_by,
        target: command.denial_target?.replace(target, "<escape>") ?? null,
        reason: command.denial_reason?.replaceAll(target, "<escape>") ?? null,
      }));
    expect(shape(fromArguments.json, outside)).toEqual(shape(fromTicket.json, ticketOutside));
  }, 240_000);
});

describe("the branch a ticket-backed run works on", () => {
  it("is never another ticket's that an explicit --config names: it reaches neither the worktree nor the push", async () => {
    const repo = repository("config-branch");
    repoConfig(repo, {
      agent_binary: guardedAgent("config-branch", [
        { tool: "Write", input: { file_path: "src/feature.ts", content: "export const total = 1;\n" } },
      ]),
      materialization_manifest: noInstall(repo),
    });
    const other = "Totals are rounded to whole cents";
    for (const outcome of [OUTCOME, other]) {
      await runCommandLine(admitCommandLine, {
        argv: [
          "--repo", repo,
          "--outcome", outcome,
          "--criterion", CRITERION,
          "--path", "src/**",
          "--approve",
        ],
        streams: recordStreams(),
        cwd: repo,
      });
    }
    const store = storeDir(repo, null);
    const ticket = (key: string) =>
      JSON.parse(readFileSync(join(store, "tickets", `${key}.json`), "utf8")) as {
        ticket_id: string;
        delivery: { branch: string | null };
      };
    const own = branchName({ ticket_key: "PRB-1", ticket_id: ticket("PRB-1").ticket_id, outcome: OUTCOME });
    // PRB-2's branch, present in the checkout as its own run would leave it.
    const foreign = branchName({ ticket_key: "PRB-2", ticket_id: ticket("PRB-2").ticket_id, outcome: other });
    git(repo, "branch", foreign);
    const foreignTip = git(repo, "rev-parse", foreign).trim();

    // The loop asks `gh` about the head's checks once the pull request is open.
    // This one refuses every question, so nothing leaves the machine.
    const gh = mkdtempSync(join(scratch, "gh-config-branch-"));
    writeFileSync(join(gh, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const pushed: string[] = [];
    const opened: string[] = [];
    const path = process.env.PATH ?? "";
    process.env.PATH = `${gh}:${path}`;
    try {
      const result = await run(
        repo,
        [
          "--ticket", "PRB-1",
          "--config", worktreeOverride("config-branch", { delivery_branch: foreign }),
          "--publish",
          "--json",
        ],
        {
          hooks: {
            review: reviewer("approve") as never,
            push: (async (request: { branch: string }) => {
              pushed.push(request.branch);
              return { pushed: true, detail: "hooked" };
            }) as never,
            open: (async (request: { branch: string }) => {
              opened.push(request.branch);
              return { url: "https://github.com/o/r/pull/9", number: 9 };
            }) as never,
          },
        },
      );

      expect(result.code).toBe(0);
      expect(result.json.branch).toBe(own);
      expect(pushed).toEqual([own]);
      expect(opened).toEqual([own]);
      // The ticket records its own branch, and PRB-2's is where it was.
      expect(ticket("PRB-1").delivery.branch).toBe(own);
      expect(git(repo, "rev-parse", foreign).trim()).toBe(foreignTip);
    } finally {
      process.env.PATH = path;
    }
  }, 120_000);
});

describe("the record a run with nothing admitted leaves", () => {
  it("is under the repository's .perbo/, is read back by inspect, and names no ticket", async () => {
    const repo = repository("record");
    repoConfig(repo, {
      agent_binary: guardedAgent("record", [
        { tool: "Write", input: { file_path: "src/feature.ts", content: "export const total = 1;\n" } },
      ]),
      materialization_manifest: noInstall(repo),
    });
    // Nothing in this path may reach a hosted plane, so every socket this
    // process opens is watched rather than assumed absent.
    const outbound = watchOutbound();

    const result = await run(
      repo,
      [
        "--outcome", OUTCOME,
        "--criterion", CRITERION,
        "--path", "src/**",
        "--config", worktreeOverride("record"),
        "--json",
      ],
      { hooks: { review: reviewer("approve") as never } },
    );
    expect(result.code).toBe(0);
    // No connection asked for by this process, and no host named by the
    // attempt — the second is the half of it a child process could have used.
    expect(outbound.destinations()).toEqual([]);
    expect(result.json.rounds[0]!.attempt.egress).toEqual([]);

    const store = storeDir(repo, null);
    const written = filesUnder(store);
    // The run, the attempts, the bundles: all of it in this repository's store.
    expect(written).toContain(join("runs", `${result.json.ticket_id}.run.json`));
    expect(written).toContain(join("state", `${result.json.ticket_id}.attempts.json`));
    expect(written.some((path) => path.startsWith(`bundles${sep()}`))).toBe(true);
    expect(written.some((path) => path.startsWith(`tickets${sep()}`))).toBe(false);

    // And `inspect` reads the whole of it back out of those files.
    const report = buildInspectReport({ storeDirectory: store, key: result.json.ticket_id, attempt: null });
    expect(report.kind).toBe("local");
    expect(report.state).toBeNull();
    expect(report.outcome).toBe(OUTCOME);
    expect(report.attempts).toHaveLength(1);
    const [reported] = report.attempts;
    expect(reported!.attempt_id).toBe(result.json.rounds[0]!.attempt.attempt_id);
    expect(reported!.bundles.map((bundle) => bundle.kind)).toContain("execution");
    expect(reported!.checks).not.toBeNull();
    expect(reported!.checks!.map((check) => check.name)).toEqual(["unit"]);
    expect(reported!.review?.decision).toBe("approve");
    expect(report.total_cost.micros).toBe(result.json.total_cost.micros);

    // No ticket key anywhere in what was persisted: not in the run record, not
    // in the attempts, not in a bundle. The work is keyed by where its contract
    // came from, and nothing invented an `PRB-…` to stand in for a ticket.
    for (const path of written) {
      expect(readFileSync(join(store, path), "utf8"), path).not.toMatch(/\bFCX-\d+\b/);
    }
  }, 120_000);
});

const sep = () => (process.platform === "win32" ? "\\" : "/");

describe("the ceilings a run with nothing admitted stops at", () => {
  it("stops after one attempt when the attempt ceiling allows one", async () => {
    const repo = repository("ceiling-attempts");
    repoConfig(repo, {
      agent_binary: guardedAgent("ceiling-attempts", [
        { tool: "Write", input: { file_path: "src/feature.ts", content: "export const total = 1;\n" } },
      ]),
      materialization_manifest: noInstall(repo),
      // One attempt, and the reviewer routes a finding back — so a second
      // attempt is what this run would do next, and the ceiling is what stops it.
      limits: {
        organisation: "test",
        limits: { concurrent_local_attempts: 4, remediation_rounds: 0 },
      },
    });

    const result = await run(
      repo,
      [
        "--outcome", OUTCOME,
        "--criterion", CRITERION,
        "--path", "src/**",
        "--config", worktreeOverride("ceiling-attempts"),
        "--json",
      ],
      { hooks: { review: reviewer("remediable") as never } },
    );

    expect(result.json.rounds).toHaveLength(1);
    expect(result.json.outcome).toBe("remediation_exhausted");
    const record = JSON.parse(
      readFileSync(join(storeDir(repo, null), "state", `${result.json.ticket_id}.attempts.json`), "utf8"),
    ) as { attempts: unknown[] };
    expect(record.attempts).toHaveLength(1);
    // What it cost, where the run ended, rather than by opening the store after.
    expect(result.err).toContain("cost      $");
    expect(result.json.total_cost.micros).toBe(214_000);
  }, 120_000);

  it("stops where the spend crosses the ceiling, and still reports what it spent", async () => {
    const repo = repository("ceiling-cost");
    repoConfig(repo, {
      agent_binary: guardedAgent(
        "ceiling-cost",
        [{ tool: "Write", input: { file_path: "src/feature.ts", content: "export const total = 1;\n" } }],
        // D-096: a cost ceiling binds only an executor billed per token, so the
        // stand-in reports an API key.
        "ANTHROPIC_API_KEY",
      ),
      materialization_manifest: noInstall(repo),
      // The executor reports $0.004; the ceiling is a tenth of that.
      limits: {
        organisation: "test",
        // SCP-193: the ticket budget is pinned under one attempt's cost, so the
        // per-attempt ceiling is what ends this run rather than the first of
        // several attempts over the sealed branch.
        limits: { concurrent_local_attempts: 4, attempt_cost_micros: 400, ticket_cost_micros: 1 },
      },
    });

    const result = await run(
      repo,
      [
        "--outcome", OUTCOME,
        "--criterion", CRITERION,
        "--path", "src/**",
        "--config", worktreeOverride("ceiling-cost"),
        "--json",
      ],
      { hooks: { review: reviewer("approve") as never } },
    );

    expect(result.json.outcome).toBe("terminated");
    expect(result.json.rounds[0]!.attempt.termination.reason).toBe("cost_ceiling_exceeded");
    // The setting that raises it, named with the file it lives in.
    expect(result.json.detail).toContain("attempt_cost_micros");
    expect(result.json.detail).toContain(join(repo, ".perbo", "config.json"));
    expect(result.json.rounds).toHaveLength(1);
    // The stop spent money on the way to being reached, and says so.
    expect(result.err).toContain("cost      $0.0040");
    expect(result.json.total_cost.micros).toBe(4_000);
  }, 120_000);
});

/**
 * SCP-284 — what happens to a run with nothing admitted **after** it publishes.
 *
 * The rest of this file is the run itself; this is the same run's pull request
 * read back. The partner's first runs are local runs: `perbo run --outcome "…"`
 * mints its own contract, publishes its own pull request and writes its own
 * record, and until now nothing read that pull request back. A repository with
 * no ticket store had a store full of runs and no way to learn that any of them
 * had merged — and `sync` itself failed on `<store>/tickets`, a directory
 * `perbo run` never creates.
 *
 * Nothing here stands in for the thing under test. The store is written with
 * the shipped writer, the runs' branches and merges are real `git` history,
 * `gh` is a script on PATH so what runs is the subprocess `sync` really spawns
 * and the arguments it really passes, and every assertion is on a file the
 * command wrote or a line it printed.
 *
 * The helpers are scoped to this block rather than shared with the file's
 * others: a run that has already published is a different fixture from a run
 * being executed, and the two `repository` builders would otherwise be one
 * name for two shapes.
 */
describe("a run with nothing admitted, after its pull request is open", () => {
  const syncScratch = mkdtempSync(join(tmpdir(), "perbo-sync-local-runs-"));
  afterAll(() => rmSync(syncScratch, { recursive: true, force: true }));
  // The one test below that runs the built program compiles `apps/cli` first,
  // into a directory of this run's own; this takes it away again.
  afterAll(removeStagedBundles);

  /**
   * A `tsc` compile of the package plus one spawn of what it produced, on a
   * machine also running a loop attempt — the 180s `entry-point.test.ts`
   * measured for the same build, plus the spawn deadline `spawnBuilt` already
   * enforces.
   */
  const BUILD_AND_SPAWN_TIMEOUT_MS = 200_000;

  const gitEnvAt = (at?: string): NodeJS.ProcessEnv => ({
    ...gitEnv,
    ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}),
  });

  const MERGED_AT = "2026-08-01T00:00:00.000Z";
  /** Well past the fourteen days, so a merged change's window has closed. */
  const NOW = new Date("2026-09-15T00:00:00.000Z");

  interface Repo {
    root: string;
    dir: string;
    git: (at: string | undefined, ...args: string[]) => string;
  }

  function publishedRepository(name: string): Repo {
    const root = join(syncScratch, name);
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", root], { env: gitEnvAt() });
    const at = (when: string | undefined, ...args: string[]): string =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: gitEnvAt(when) });
    writeFileSync(join(root, "README.md"), "base\n");
    // The store is working state of this machine, as it is in a real checkout:
    // untracked, so moving between branches never takes the run records with it.
    writeFileSync(join(root, ".gitignore"), ".perbo/\n");
    at(undefined, "add", "README.md", ".gitignore");
    at("2026-07-01T00:00:00Z", "commit", "-qm", "base");
    return { root, dir: storeDir(root, null), git: at };
  }

  /**
   * The record `perbo run --outcome "…"` writes about itself before the loop
   * starts, with the pull request it went on to publish.
   *
   * The contract is minted by the shipped minting — so the run id, the label
   * and the branch are the ones a real run would have had, and `sync` has to
   * derive that branch from this record the way the runner derived it from the
   * plan.
   */
  function localRun(repo: Repo, outcome: string, pull: { url: string; number: number }): LocalRunRecord {
    const source = sourceContractFromArguments({ outcome, criteria: [] });
    const contract = planContractFromSource({
      contract: source,
      base_commit: headCommit(repo.root),
      repository_id: repositoryId(repo.root),
      paths_allowed: ["**"],
      captured_at: new Date("2026-07-20T09:00:00.000Z"),
    });
    const record = LocalRunRecordSchema.parse({
      schema_version: LOCAL_RUN_SCHEMA_VERSION,
      run_id: contract.ticket_id,
      label: sourceIdentity(source),
      created_at: "2026-07-20T09:00:00.000Z",
      source,
      contract,
      base: { ref: "main", from: "branch" },
      pull_request: {
        url: pull.url,
        number: pull.number,
        opened_at: "2026-07-20T10:00:00.000Z",
        // What the run itself read on the head it published; `sync` re-reads it.
        checks: [],
        checks_state: null,
      },
    });
    writeLocalRunRecord(repo.dir, record);
    return record;
  }

  /** The branch the run published on, derived the way the runner named it. */
  const branchOf = (record: LocalRunRecord): string =>
    branchName({ ticket_key: record.label, ticket_id: record.run_id, outcome: record.contract.outcome });

  /** A branch with one commit on it, merged into `main` with `--no-ff`. */
  function mergeBranch(repo: Repo, branch: string, file: string, at: string): string {
    repo.git(undefined, "checkout", "-q", "-b", branch);
    writeFileSync(join(repo.root, file), `${branch}\n`);
    repo.git(undefined, "add", file);
    repo.git(at, "commit", "-qm", `the change on ${branch}`);
    repo.git(undefined, "checkout", "-q", "main");
    repo.git(at, "merge", "-q", "--no-ff", branch, "-m", `Merge ${branch}`);
    return repo.git(undefined, "rev-parse", "HEAD").trim();
  }

  /** A branch with one commit on it, left unmerged. */
  function openBranch(repo: Repo, branch: string, file: string): void {
    repo.git(undefined, "checkout", "-q", "-b", branch);
    writeFileSync(join(repo.root, file), `${branch}\n`);
    repo.git(undefined, "add", file);
    repo.git(undefined, "commit", "-qm", `the change on ${branch}`);
    repo.git(undefined, "checkout", "-q", "main");
  }

  /** One commit's messages, as `gh pr view --json commits` reports them. */
  const loopCommit = (headline: string) => ({
    oid: "0".repeat(40),
    messageHeadline: headline,
    messageBody: "Attempt: att_0001",
  });

  interface PullRequestAnswer {
    number: number;
    url: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    checks: Array<{ name: string; status: string; conclusion: string | null }>;
    body?: string;
    comments?: Array<{ body: string }>;
    /** Set for a merged pull request: what `readMergeFacts` asks `gh` for. */
    merge?: { commit: string; mergedAt: string };
  }

  /**
   * A `gh` on PATH that answers `gh pr view <target> --json <fields>` from a
   * file per target, and exits non-zero for a target it holds none for — which
   * is what `gh` itself does for a branch with no pull request.
   *
   * Two payloads per pull request, because two readers ask different questions
   * of it: the poller's fields, keyed by the branch it asks about, and the
   * merge facts the escape record needs, keyed by the number `readMergeFacts`
   * asks by.
   */
  function fakeGh(name: string, answers: Record<string, PullRequestAnswer>): string {
    const bin = join(syncScratch, `gh-${name}`);
    mkdirSync(bin, { recursive: true });
    const key = (target: string): string => target.replace(/[^0-9A-Za-z]+/g, "_");
    for (const [branch, answer] of Object.entries(answers)) {
      writeFileSync(
        join(bin, `${key(branch)}.view.json`),
        JSON.stringify({
          number: answer.number,
          url: answer.url,
          state: answer.state,
          body: answer.body ?? "",
          mergeable: answer.state === "OPEN" ? "MERGEABLE" : "UNKNOWN",
          mergeStateStatus: "CLEAN",
          closedAt: answer.state === "OPEN" ? null : "2026-08-01T00:00:00Z",
          statusCheckRollup: answer.checks,
          reviews: [],
          comments: answer.comments ?? [],
          commits: [loopCommit(`the change on ${branch}`)],
        }),
      );
      if (answer.merge) {
        writeFileSync(
          join(bin, `${key(String(answer.number))}.merge.json`),
          JSON.stringify({
            number: answer.number,
            url: answer.url,
            state: "MERGED",
            mergedAt: answer.merge.mergedAt,
            mergeCommit: { oid: answer.merge.commit },
            baseRefName: "main",
            commits: [{ oid: answer.merge.commit }],
          }),
        );
      }
    }
    const script = [
      "#!/bin/sh",
      // `gh pr view <target> --json <fields>`: which payload depends on the
      // target and on whether the fields ask about the merge.
      'target=$(printf "%s" "$3" | tr -c "0-9A-Za-z" "_")',
      'case "$5" in',
      `  *mergeCommit*) file="${bin}/$target.merge.json" ;;`,
      `  *) file="${bin}/$target.view.json" ;;`,
      "esac",
      'if [ -f "$file" ]; then cat "$file"; else',
      '  echo "no pull request found for $3" >&2; exit 1;',
      "fi",
      "",
    ].join("\n");
    writeFileSync(join(bin, "gh"), script);
    chmodSync(join(bin, "gh"), 0o755);
    return bin;
  }

  const originalPath = process.env.PATH;
  const originalToken = process.env.GH_TOKEN;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGithubToken;
  });

  const withGh = async <T>(bin: string, body: () => T | Promise<T>): Promise<Awaited<T>> => {
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    delete process.env.GITHUB_TOKEN;
    return await body();
  };

  describe("sync over a store that holds only local runs", () => {
    it("records the merge on one run's record and the close on the other, with the checks each head reported", async () => {
      const repo = publishedRepository("two-runs");
      const merged = localRun(repo, "Search results are paginated.", {
        url: "https://github.com/o/r/pull/11",
        number: 11,
      });
      const closed = localRun(repo, "The importer retries a timeout.", {
        url: "https://github.com/o/r/pull/12",
        number: 12,
      });
      const mergeCommit = mergeBranch(repo, branchOf(merged), "paging.ts", MERGED_AT);
      openBranch(repo, branchOf(closed), "importer.ts");

      const bin = fakeGh("two-runs", {
        [branchOf(merged)]: {
          number: 11,
          url: "https://github.com/o/r/pull/11",
          state: "MERGED",
          checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
          merge: { commit: mergeCommit, mergedAt: MERGED_AT },
        },
        [branchOf(closed)]: {
          number: 12,
          url: "https://github.com/o/r/pull/12",
          state: "CLOSED",
          checks: [{ name: "unit", status: "COMPLETED", conclusion: "FAILURE" }],
        },
      });

      const streams = recordStreams();
      const code = await withGh(bin, () =>
        runCommandLine(syncCommandLine, { argv: ["--repo", repo.root], streams, cwd: repo.root, now: NOW }),
      );

      expect(code).toBe(EXIT_CODES.approve);

      const first = readLocalRunRecord(repo.dir, merged.run_id);
      expect(first?.pull_request?.state).toBe("merged");
      expect(first?.pull_request?.checks).toEqual([{ name: "unit", conclusion: "success" }]);
      expect(first?.pull_request?.checks_state).toBe("green");
      expect(first?.pull_request?.observed_at).toBe(NOW.toISOString());
      // The publish is still dated by the run that made it, not by this read.
      expect(first?.pull_request?.opened_at).toBe("2026-07-20T10:00:00.000Z");

      const second = readLocalRunRecord(repo.dir, closed.run_id);
      expect(second?.pull_request?.state).toBe("closed");
      expect(second?.pull_request?.checks).toEqual([{ name: "unit", conclusion: "failure" }]);
      expect(second?.pull_request?.checks_state).toBe("checks_failed");

      // The same table a ticket's sync prints: the change, where its record now
      // stands, what `gh` said, and the pull request.
      const printed = streams.out();
      expect(printed).toContain(`${merged.run_id}  merged  merged  https://github.com/o/r/pull/11\n`);
      expect(printed).toContain(`${closed.run_id}  closed  closed  https://github.com/o/r/pull/12\n`);
      expect(printed).toContain("2 local runs: 2 read, 0 unread\n");
      expect(streams.err()).toContain("pull request #12 closed without merging");

      // The fourteen days after the merge are not read, and the sync says so
      // where a person is reading the merge rather than leaving the row to be
      // misread as a window that found nothing: an escape record's `ticket_key`
      // must be a ticket key, and no run has one.
      expect(existsSync(join(repo.dir, "state", `${merged.run_id}.escapes.json`))).toBe(false);
      expect(streams.err()).toContain(`escapes: ${merged.run_id} merged, but`);
    });

    it("records the review verdict a closed pull request carries", async () => {
      const repo = publishedRepository("closed-over-a-verdict");
      const rejected = localRun(repo, "Failures are retried with a backoff.", {
        url: "https://github.com/o/r/pull/21",
        number: 21,
      });
      openBranch(repo, branchOf(rejected), "backoff.ts");

      const bin = fakeGh("closed-over-a-verdict", {
        [branchOf(rejected)]: {
          number: 21,
          url: "https://github.com/o/r/pull/21",
          state: "CLOSED",
          checks: [],
          comments: [
            { body: "**D-073 review — claude-fable-5-1 — verdict: CHANGES REQUESTED** (head `75e790e2b1c4`)" },
          ],
        },
      });

      const streams = recordStreams();
      const code = await withGh(bin, () =>
        runCommandLine(syncCommandLine, { argv: ["--repo", repo.root], streams, cwd: repo.root, now: NOW }),
      );

      expect(code).toBe(EXIT_CODES.approve);
      const record = readLocalRunRecord(repo.dir, rejected.run_id);
      expect(record?.pull_request?.state).toBe("closed");
      expect(record?.pull_request?.review_verdicts).toEqual([
        { model: "claude-fable-5-1", verdict: "CHANGES REQUESTED", head: "75e790e2b1c4" },
      ]);
      // A close over a verdict is a rejection of the content, and the row says
      // so in the same word a ticket's would.
      expect(streams.out()).toContain(`${rejected.run_id}  changes_requested  closed`);
    });

    it("leaves the record alone when `gh` finds no pull request on the branch", async () => {
      const repo = publishedRepository("no-pull-request");
      const run = localRun(repo, "The queue drains on shutdown.", {
        url: "https://github.com/o/r/pull/31",
        number: 31,
      });
      openBranch(repo, branchOf(run), "queue.ts");

      const streams = recordStreams();
      const code = await withGh(fakeGh("no-pull-request", {}), () =>
        runCommandLine(syncCommandLine, { argv: ["--repo", repo.root], streams, cwd: repo.root, now: NOW }),
      );

      expect(code).toBe(EXIT_CODES.approve);
      const record = readLocalRunRecord(repo.dir, run.run_id);
      expect(record?.pull_request?.url).toBe("https://github.com/o/r/pull/31");
      expect(record?.pull_request?.state).toBeNull();
      expect(streams.err()).toContain("unchanged");
      // The sweep counts what it could not read, so a table of nothing is a
      // number a person is told rather than one they have to infer.
      expect(streams.out()).toContain("1 local run: 0 read, 1 unread\n");
    });

    it("names one run whose read failed and still reads every run after it", async () => {
      const repo = publishedRepository("one-unreadable");
      // Two runs, and the first one's read blows up in a way `syncLocalRun`
      // does not itself catch — the class of failure the sweep's own isolation
      // is about, rather than the credential case handled a level down.
      const broken = localRun(repo, "Search results are paginated.", {
        url: "https://github.com/o/r/pull/61",
        number: 61,
      });
      const readable = localRun(repo, "The importer retries a timeout.", {
        url: "https://github.com/o/r/pull/62",
        number: 62,
      });
      const mergeCommit = mergeBranch(repo, branchOf(readable), "importer.ts", MERGED_AT);
      openBranch(repo, branchOf(broken), "paging.ts");

      const bin = fakeGh("one-unreadable", {
        [branchOf(readable)]: {
          number: 62,
          url: "https://github.com/o/r/pull/62",
          state: "MERGED",
          checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
          merge: { commit: mergeCommit, mergedAt: MERGED_AT },
        },
      });

      const streams = recordStreams();
      const code = await withGh(bin, () =>
        runCommandLine(syncCommandLine, {
          argv: ["--repo", repo.root],
          streams,
          cwd: repo.root,
          now: NOW,
          deps: {
            poll: async (args) =>
              args.branch === branchOf(broken)
                ? Promise.reject(new Error("gh: the remote end hung up unexpectedly"))
                : pollPullRequest(args),
          },
        }),
      );

      expect(code).toBe(EXIT_CODES.approve);
      // The one that failed is named with what went wrong.
      expect(streams.err()).toContain(`${broken.run_id} unread: gh: the remote end hung up`);
      // And the one after it was read all the way to its own record.
      expect(readLocalRunRecord(repo.dir, readable.run_id)?.pull_request?.state).toBe("merged");
      expect(streams.out()).toContain("2 local runs: 1 read, 1 unread\n");
    });

    it("exits 0 for a run it read and 3 for one it could not, named one at a time", async () => {
      const repo = publishedRepository("one-run-at-a-time");
      const run = localRun(repo, "Search results are paginated.", {
        url: "https://github.com/o/r/pull/71",
        number: 71,
      });
      openBranch(repo, branchOf(run), "paging.ts");

      const read = recordStreams();
      const readCode = await withGh(
        fakeGh("one-run-at-a-time", {
          [branchOf(run)]: {
            number: 71,
            url: "https://github.com/o/r/pull/71",
            state: "OPEN",
            checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
          },
        }),
        () =>
          runCommandLine(syncCommandLine, { argv: [run.run_id, "--repo", repo.root], streams: read, cwd: repo.root, now: NOW }),
      );
      expect(readCode).toBe(EXIT_CODES.approve);
      expect(read.out()).toContain(`${run.run_id}  pr_open  open`);

      // The same run with nothing to ask `gh` with. The status is the one the
      // ticket path returns for a read that did not happen, so a script can
      // tell it from a pull request that was read.
      const unread = recordStreams();
      process.env.PATH = originalPath;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      const unreadCode = await runCommandLine(syncCommandLine, {
        argv: [run.run_id, "--repo", repo.root],
        streams: unread,
        cwd: repo.root,
        now: NOW,
      });
      expect(unreadCode).toBe(EXIT_CODES.did_not_complete);
      expect(unread.err()).toContain(`${run.run_id} unchanged`);
    });
  }, SPAWN_TEST_TIMEOUT_MS);

  describe("sync on a repository with neither runs nor tickets", () => {
    it("says so in one line and exits 0 rather than failing on a store that does not exist", async () => {
      const root = join(syncScratch, "never-run");
      mkdirSync(root, { recursive: true });
      expect(existsSync(join(root, ".perbo"))).toBe(false);

      const streams = recordStreams();
      const code = await runCommandLine(syncCommandLine, { argv: ["--repo", root], streams, cwd: root, now: NOW });

      expect(code).toBe(EXIT_CODES.approve);
      const said = streams.out() + streams.err();
      expect(said.split("\n").filter((line) => line !== "")).toHaveLength(1);
      expect(said).toContain(join(root, ".perbo"));
      expect(said).not.toMatch(/ENOENT|no such file|error/i);
    });

    it("says the same for a store that exists and holds neither", async () => {
      const repo = publishedRepository("empty-store");
      mkdirSync(repo.dir, { recursive: true });

      const streams = recordStreams();
      const code = await runCommandLine(syncCommandLine, { argv: ["--repo", repo.root], streams, cwd: repo.root, now: NOW });

      expect(code).toBe(EXIT_CODES.approve);
      expect(
        (streams.out() + streams.err()).split("\n").filter((line) => line !== ""),
      ).toHaveLength(1);
    });

    /**
     * The same reading, taken off the program rather than off the function: the
     * compiled entry point is run as a process in a directory with no `.perbo`,
     * and what is counted is the bytes it wrote to its own stdout and the status
     * it exited with. Nothing in this repository stands between the two — a
     * `process.exit` that turned the returned code into something else, or an
     * entry point that printed a line of its own around it, would show here and
     * nowhere above.
     */
    it(
      "writes one line to stdout and exits 0 when it is run as a program",
      () => {
        const root = join(syncScratch, "never-run-built");
        mkdirSync(root, { recursive: true });
        expect(existsSync(join(root, ".perbo"))).toBe(false);

        const result = spawnBuilt([join(buildCli(), "main.js"), "sync"], { cwd: root });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout.split("\n").filter((line) => line !== "")).toHaveLength(1);
        expect(result.stdout).toContain(join(root, ".perbo"));
        expect(result.stdout).not.toMatch(/ENOENT|no such file|error/i);
      },
      BUILD_AND_SPAWN_TIMEOUT_MS,
    );
  });

  describe("the branch a local run is on", () => {
    it("is derived under prb/ from the run's label where nothing records one", () => {
      const repo = publishedRepository("derived-branch");
      const record = localRun(repo, "Imports keep their order.", {
        url: "https://github.com/o/r/pull/31",
        number: 31,
      });
      const hex = record.run_id.replace(/^ticket_local_/, "");
      expect(localRunBranch(repo.dir, record)).toBe(`prb/local-${hex}/imports-keep-their-order`);
    });

    it("is the one its attempts record names, whatever its label would derive now", () => {
      const repo = publishedRepository("recorded-branch");
      const record = localRun(repo, "Exports keep their order.", {
        url: "https://github.com/o/r/pull/32",
        number: 32,
      });
      // The branch the run published on: `ayo/`, which its label does not derive.
      const recorded = `ayo/local-${record.run_id.replace(/^ticket_local_/, "")}/exports-keep-their-order`;
      mkdirSync(join(repo.dir, "state"), { recursive: true });
      writeFileSync(
        join(repo.dir, "state", `${record.run_id}.attempts.json`),
        `${JSON.stringify(
          {
            ticket_id: record.run_id,
            attempts: [
              makeAttempt({
                attempt_id: "att_00000000000000c1",
                ticket_id: record.run_id,
                created_at: "2026-07-20T09:30:00.000Z",
                termination: { reason: "completed", detail: "" },
                usage: {},
                changeset_id: "cs_0000000000000001",
                head_commit: "b2c3d4e",
                branch: recorded,
              }),
            ],
          },
          null,
          2,
        )}\n`,
      );
      expect(localRunBranch(repo.dir, record)).toBe(recorded);
      expect(localRunChange(repo.dir, record).branch).toBe(recorded);
    });
  });

  /** A ticket sitting at `pr_open` behind a pull request the loop published. */
  function publishedTicket(repo: Repo, key: string, outcome: string, number: number): Ticket {
    const at = "2026-07-20T09:00:00.000Z";
    const ids = idsFor(key, new Date(at));
    const ticket = TicketSchema.parse({
      schema_version: 1,
      ticket_id: ids.ticket_id,
      key,
      title: outcome,
      state: "pr_open",
      priority: "normal",
      labels: [],
      depends_on: [],
      source: { kind: "none", reference: null, url: null, title_at_admission: null },
      repository_root: repo.root,
      plan_id: ids.plan_id,
      plan_version: 1,
      approved_at: at,
      admitted_at: at,
      updated_at: at,
      admission: { elapsed_ms: 1, criteria_source: "typed", criteria_count: 1 },
      delivery: {
        branch: branchName({ ticket_key: key, ticket_id: ids.ticket_id, outcome }),
        pull_request_url: `https://github.com/o/r/pull/${number}`,
        pull_request_number: number,
        state: "open",
        observed_at: at,
        opened_by: "loop",
      },
      history: [{ at, from: null, to: "plan_review", note: "admitted" }],
    });
    writeTicket(repo.dir, ticket);
    return ticket;
  }

  describe("escapes and stops over a synced local run", () => {
    it("lists it with the fields they list a ticket's merge with", async () => {
      const repo = publishedRepository("both-kinds");
      const ticket = publishedTicket(repo, "AYO-1", "Search results are paginated.", 41);
      const run = localRun(repo, "The importer retries a timeout.", {
        url: "https://github.com/o/r/pull/42",
        number: 42,
      });
      const ticketMerge = mergeBranch(repo, ticket.delivery.branch!, "paging.ts", MERGED_AT);
      const runMerge = mergeBranch(repo, branchOf(run), "importer.ts", MERGED_AT);

      const bin = fakeGh("both-kinds", {
        [ticket.delivery.branch!]: {
          number: 41,
          url: "https://github.com/o/r/pull/41",
          state: "MERGED",
          checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
          merge: { commit: ticketMerge, mergedAt: MERGED_AT },
        },
        [branchOf(run)]: {
          number: 42,
          url: "https://github.com/o/r/pull/42",
          state: "MERGED",
          checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
          merge: { commit: runMerge, mergedAt: MERGED_AT },
        },
      });

      await withGh(bin, async () => {
        const ticketSync = await runCommandLine(syncCommandLine, {
          argv: ["AYO-1", "--repo", repo.root],
          streams: recordStreams(),
          cwd: repo.root,
          now: NOW,
        });
        expect(ticketSync).toBe(EXIT_CODES.approve);
        const sweep = recordStreams();
        const runSync = await runCommandLine(syncCommandLine, {
          argv: ["--repo", repo.root],
          streams: sweep,
          cwd: repo.root,
          now: NOW,
        });
        expect(runSync).toBe(EXIT_CODES.approve);
        // The sweep read the run and said what it did not read, so a store
        // holding both kinds cannot be mistaken for a store holding one.
        expect(sweep.out()).toContain(run.run_id);
        expect(sweep.out()).not.toContain("AYO-1");
        expect(sweep.err()).toContain("1 ticket in");
        expect(sweep.err()).toContain("perbo sync PRB-1");
      });

      const escapes = recordStreams();
      expect(
        await runCommandLine(escapesCommandLine, {
          argv: ["--repo", repo.root, "--json"],
          streams: escapes,
          cwd: repo.root,
          now: NOW,
        }),
      ).toBe(EXIT_CODES.approve);
      const report = escapes.json<{
        escapes: { merged: number; closed: number };
        tickets: Array<Record<string, unknown>>;
      }>();
      const rows = new Map(report.tickets.map((row) => [row["ticket_key"] as string, row]));
      expect([...rows.keys()].sort()).toEqual(["AYO-1", run.run_id].sort());
      const ticketRow = rows.get("AYO-1")!;
      const runRow = rows.get(run.run_id)!;
      // The same fields, filled the same way: every key the ticket's row
      // carries is on the run's, and both merges are one row each in the same
      // population.
      expect(Object.keys(runRow).sort()).toEqual(Object.keys(ticketRow).sort());
      expect(ticketRow["status"]).toBe("observed");
      expect(ticketRow["merge_commit"]).toBe(ticketMerge);
      expect(runRow["reverted"]).toBe(false);
      expect(report.escapes.merged).toBe(2);
      expect(report.escapes.closed).toBe(1);
      // The run's window is not read, because the escape record it would be
      // read from is keyed by a ticket key it has none of. The row says that
      // in the word the reading already has for it, rather than by not being
      // there — the count above is what it is counted in.
      expect(runRow["status"]).toBe("not observed");
      // And on the printed table a person reads, one line each.
      const printed = recordStreams();
      await runCommandLine(escapesCommandLine, { argv: ["--repo", repo.root], streams: printed, cwd: repo.root, now: NOW });
      expect(printed.out()).toContain(run.run_id);

      const stops = recordStreams();
      expect(
        await runCommandLine(stopsCommandLine, {
          argv: ["--repo", repo.root, "--json"],
          streams: stops,
          cwd: repo.root,
          now: NOW,
        }),
      ).toBe(EXIT_CODES.approve);
      const measured = stops.json<{
        unattended_merges: { tickets: number; merged: number; unattended: number };
        merged_cost: { tickets: number };
        loop_merges: { merged: number };
      }>();
      // Both merges are in the populations `stops` measures over the store's
      // own records: D-076's bar, the cost the bar is read beside, and D-077's
      // count of what the loop merged itself.
      expect(measured.unattended_merges.merged).toBe(2);
      expect(measured.unattended_merges.unattended).toBe(2);
      expect(measured.merged_cost.tickets).toBe(2);
      expect(measured.loop_merges.merged).toBe(2);
    });

    it("reads a store of local runs alone the way it reads a store of tickets alone", async () => {
      // Two stores rather than one, because the criterion is about the store a
      // repository that admitted nothing has: the runs' rows are read out of a
      // store with no ticket file in it at all, and compared against the rows
      // the same two commands produce for a ticket whose change landed the
      // same day.
      const ticketed = publishedRepository("ticketed-only");
      const ticket = publishedTicket(ticketed, "AYO-2", "Search results are paginated.", 51);
      const ticketMerge = mergeBranch(ticketed, ticket.delivery.branch!, "paging.ts", MERGED_AT);

      const local = publishedRepository("local-only");
      const merged = localRun(local, "The importer retries a timeout.", {
        url: "https://github.com/o/r/pull/52",
        number: 52,
      });
      const closed = localRun(local, "The queue drains on shutdown.", {
        url: "https://github.com/o/r/pull/53",
        number: 53,
      });
      const runMerge = mergeBranch(local, branchOf(merged), "importer.ts", MERGED_AT);
      openBranch(local, branchOf(closed), "queue.ts");

      await withGh(
        fakeGh("ticketed-only", {
          [ticket.delivery.branch!]: {
            number: 51,
            url: "https://github.com/o/r/pull/51",
            state: "MERGED",
            checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
            merge: { commit: ticketMerge, mergedAt: MERGED_AT },
          },
        }),
        async () => {
          const code = await runCommandLine(syncCommandLine, {
            argv: ["AYO-2", "--repo", ticketed.root],
            streams: recordStreams(),
            cwd: ticketed.root,
            now: NOW,
          });
          expect(code).toBe(EXIT_CODES.approve);
        },
      );
      await withGh(
        fakeGh("local-only", {
          [branchOf(merged)]: {
            number: 52,
            url: "https://github.com/o/r/pull/52",
            state: "MERGED",
            checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
            merge: { commit: runMerge, mergedAt: MERGED_AT },
          },
          [branchOf(closed)]: {
            number: 53,
            url: "https://github.com/o/r/pull/53",
            state: "CLOSED",
            checks: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
          },
        }),
        async () => {
          const code = await runCommandLine(syncCommandLine, {
            argv: ["--repo", local.root],
            streams: recordStreams(),
            cwd: local.root,
            now: NOW,
          });
          expect(code).toBe(EXIT_CODES.approve);
        },
      );
      // Nothing admitted anything here, and syncing did not quietly change that.
      expect(existsSync(join(local.dir, "tickets"))).toBe(false);

      const escapesOf = async (repo: Repo) => {
        const streams = recordStreams();
        expect(
          await runCommandLine(escapesCommandLine, {
            argv: ["--repo", repo.root, "--json"],
            streams,
            cwd: repo.root,
            now: NOW,
          }),
        ).toBe(EXIT_CODES.approve);
        return streams.json<{
          escapes: { merged: number };
          tickets: Array<Record<string, unknown>>;
        }>();
      };
      const ticketRow = (await escapesOf(ticketed)).tickets[0]!;
      const localEscapes = await escapesOf(local);
      expect(ticketRow["ticket_key"]).toBe("AYO-2");
      // The merged run is listed and the closed one is not, which is the same
      // population rule a store of tickets is read under.
      expect(localEscapes.tickets.map((row) => row["ticket_key"])).toEqual([merged.run_id]);
      expect(localEscapes.escapes.merged).toBe(1);
      const localRow = localEscapes.tickets[0]!;
      expect(Object.keys(localRow).sort()).toEqual(Object.keys(ticketRow).sort());
      expect(localRow["reverted"]).toBe(ticketRow["reverted"]);
      // And on the printed table, the run gets a line of its own.
      const printed = recordStreams();
      await runCommandLine(escapesCommandLine, { argv: ["--repo", local.root], streams: printed, cwd: local.root, now: NOW });
      expect(printed.out()).toContain(merged.run_id);
      expect(printed.out()).not.toContain("no merged tickets yet");

      const stopsOf = async (repo: Repo) => {
        const streams = recordStreams();
        expect(
          await runCommandLine(stopsCommandLine, {
            argv: ["--repo", repo.root, "--json"],
            streams,
            cwd: repo.root,
            now: NOW,
          }),
        ).toBe(EXIT_CODES.approve);
        return streams.json<{
          unattended_merges: Record<string, unknown>;
          merged_cost: { tickets: number };
          loop_merges: { merged: number };
        }>();
      };
      const ticketStops = await stopsOf(ticketed);
      const localStops = await stopsOf(local);
      // One merge each, measured the same way: the same reading of D-076's bar,
      // the same count under the cost it is read beside, and the same count of
      // what the loop merged itself.
      expect(localStops.unattended_merges).toEqual(ticketStops.unattended_merges);
      expect(localStops.merged_cost.tickets).toBe(ticketStops.merged_cost.tickets);
      expect(localStops.merged_cost.tickets).toBe(1);
      expect(localStops.loop_merges.merged).toBe(ticketStops.loop_merges.merged);
      expect(localStops.loop_merges.merged).toBe(1);
    });
  }, SPAWN_TEST_TIMEOUT_MS);
});
