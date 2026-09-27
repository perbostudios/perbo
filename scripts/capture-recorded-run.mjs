// Captures the recorded run the desktop's loop page is tested against
// (`apps/desktop/src/renderer/tasks/fixtures/recorded-run.json`): the stderr
// `perbo run` prints — the job log the desktop reads while a run goes — and the
// `perbo inspect --json` report of the records that run left.
//
// The run is the CLI's own, from `apps/cli/dist`: a contract with no ticket
// behind it, over the runner's loop, with a scripted executor, reviewer and
// closure verifier. The executor is a real program the runner spawns, which
// runs the write guard's hook before its one call; the reviewer routes one
// finding back and the verifier closes it, so round 0 is executed, sealed,
// checked and reviewed, and one remediation round is sealed, checked and
// verified closed. Nothing reaches a provider.
//
// What differs from one capture to the next — the capture directory, the ids a
// run mints, the instants it records, the durations it measured and the commits
// it sealed — is written in a fixed form, each value mapped the same way
// wherever it appears, so a join by id or by commit still holds and instants
// keep their order.
//
//   pnpm -r build                                     the CLI and what it runs
//   node scripts/capture-recorded-run.mjs             capture and write the fixture
//   node scripts/capture-recorded-run.mjs --check     capture and fail where the fixture differs

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_DIST = join(REPO_ROOT, "apps", "cli", "dist");
export const FIXTURE = join(REPO_ROOT, "apps", "desktop", "src", "renderer", "tasks", "fixtures", "recorded-run.json");

/** The capture directory as the fixture names it, whatever this machine's temporary directory is. */
const STATED_ROOT = "/tmp/perbo-capture";
const OUTCOME = "The feature module exports a computed total";
const CRITERION = "total() returns the sum of its inputs :: total([1,2]) is 3 :: test";
/** When the contract is minted, and when the repository's one commit was made. */
const MINTED = new Date("2026-09-27T00:37:00.000Z");

/** Git with a fixed identity and clock, so the repository's commit is the same on every capture. */
const gitEnv = () => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Perbo Capture",
  GIT_AUTHOR_EMAIL: "capture@perbo.invalid",
  GIT_COMMITTER_NAME: "Perbo Capture",
  GIT_COMMITTER_EMAIL: "capture@perbo.invalid",
  GIT_AUTHOR_DATE: "2026-09-27T00:30:00Z",
  GIT_COMMITTER_DATE: "2026-09-27T00:30:00Z",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});
const git = (dir, ...argv) => execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnv() });

/** A repository with one commit, a `.perbo/config.json` and no ticket store. */
function repository(root, agent) {
  const dir = join(root, "capture-repo");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(dir, "src", "index.ts"), "export const version = 1;\n");
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial");
  mkdirSync(join(dir, ".perbo"), { recursive: true });
  writeFileSync(
    join(dir, ".perbo", "config.json"),
    `${JSON.stringify(
      {
        agent_binary: agent,
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
        limits: { organisation: "capture", limits: { concurrent_local_attempts: 4 } },
        materialization_manifest: {
          manifest_version: 1,
          repository_id: "repo_capture",
          source_checkout: dir,
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
        },
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

/**
 * The executor: a program that runs the write guard's `PreToolUse` hook out of
 * its own `--settings` file before its one call, performs the call only where
 * the answer is not `deny`, and reports what Claude Code's stream reports — a
 * subscription credential, seven input and two output tokens a turn, $0.004.
 */
function executor(root) {
  const binary = join(root, "agent", "agent.cjs");
  mkdirSync(dirname(binary), { recursive: true });
  const calls = [{ tool: "Write", input: { file_path: "src/feature.ts", content: "export const total = 1;\n" } }];
  writeFileSync(
    binary,
    `#!/usr/bin/env node
"use strict";
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
if (process.argv.includes("--version")) {
  process.stdout.write("capture-agent 1.0.0\\n");
  process.exit(0);
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [], plugins: [], skills: [], agents: [], memory_paths: null });
const settings = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--settings") + 1], "utf8"));
const hook = settings.hooks.PreToolUse[0].hooks[0].command;
const denials = [];
let index = 0;
for (const call of ${JSON.stringify(calls)}) {
  index += 1;
  const id = "toolu_capture_" + index;
  const stdin = JSON.stringify({ session_id: "capture", cwd: process.cwd(), hook_event_name: "PreToolUse", tool_name: call.tool, tool_input: call.input, tool_use_id: id });
  const printed = execFileSync("/bin/sh", ["-c", hook], { input: stdin, encoding: "utf8" }).trim();
  const answer = printed.length > 0 ? JSON.parse(printed) : null;
  const allowed = answer === null || answer.hookSpecificOutput.permissionDecision === "allow";
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: call.tool, input: call.input }], usage: { input_tokens: 7, output_tokens: 2 } } });
  if (!allowed) {
    denials.push({ tool_name: call.tool, tool_use_id: id, tool_input: call.input });
    continue;
  }
  mkdirSync(dirname(call.input.file_path), { recursive: true });
  writeFileSync(call.input.file_path, call.input.content || "");
}
emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.004, permission_denials: denials });
process.exit(0);
`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return binary;
}

/**
 * The reviewer: one verdict routing one finding back to the executor, priced
 * on a stated basis — the transport's report — so `perbo inspect`'s total and
 * the run's `tally:` lines count the same dollars from the same records.
 */
const reviewer = async (request) => ({
  artifact: {
    schema_version: 1,
    review_id: "rev_0000000000000001",
    created_at: MINTED.toISOString(),
    target: {
      type: "changeset",
      id: request.changeset?.changeset_id ?? "cs_0000000000000001",
      base_commit: "abc1234",
      head_commit: request.head_commit ?? "def5678",
    },
    plan_id: "plan_capture",
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
      { criterion_id: "ac_1", status: "not_met", verification_strength: "asserted_only", evidence: null, note: null },
    ],
    findings: [
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
    decision: "remediable",
    confidence: 0.9,
    cost_micros: 210_000,
    latency_ms: 100,
    model: {
      provider: "stub",
      model_id: "stub",
      prompt_version: "reviewer_v2",
      input_tokens: 1,
      output_tokens: 1,
      cost_basis: "transport_reported",
    },
    error: null,
  },
  bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
});

/** The closure verifier: every finding it is handed, closed, at a listed price. */
const verifier = async (input) => ({
  prompt_version: "closure_verify_v1",
  per_finding: input.findings.map((entry) => ({ finding_key: entry.key, status: "closed", pointer: "src/feature.ts" })),
  deterministic_failure: null,
  all_closed: true,
  open_keys: [],
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  cost_micros: 30,
  cost_basis: "provider_list_estimate",
});

/** Run the CLI's `perbo run` in this process, with the reviewer and verifier above; its stderr is the log. */
async function capture() {
  for (const entry of ["commands/run/index.js", "command-line/terminal.js", "main.js"]) {
    if (!existsSync(join(CLI_DIST, entry))) throw new Error(`apps/cli/dist/${entry} is missing: run \`pnpm -r build\` first`);
  }
  const { executeCommandLine } = await import(pathToFileURL(join(CLI_DIST, "commands", "run", "index.js")).href);
  const { runCommandLine } = await import(pathToFileURL(join(CLI_DIST, "command-line", "terminal.js")).href);

  const made = join(tmpdir(), "perbo-capture");
  rmSync(made, { recursive: true, force: true });
  mkdirSync(made, { recursive: true });
  const root = realpathSync(made);
  try {
    const repo = repository(root, executor(root));
    const override = join(root, "capture.config.json");
    writeFileSync(override, JSON.stringify({ worktree_root: join(root, "capture-worktrees") }));

    const out = [];
    const err = [];
    const code = await runCommandLine(executeCommandLine, {
      argv: ["--repo", repo, "--outcome", OUTCOME, "--criterion", CRITERION, "--path", "src/**", "--config", override, "--json"],
      streams: { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false },
      cwd: repo,
      now: MINTED,
      deps: {
        preflight: () => ({ ok: true, findings: [], tools: {}, github: null }),
        hooks: { review: reviewer, verify: verifier },
      },
    });
    const run = JSON.parse(out.join(""));
    if (code !== 0 || run.outcome !== "approved") {
      throw new Error(`the captured run did not end approved (exit ${code}, ${run.outcome}): ${err.join("")}`);
    }
    const report = JSON.parse(
      execFileSync(process.execPath, [join(CLI_DIST, "main.js"), "inspect", run.ticket_id, "--repo", repo, "--json"], {
        encoding: "utf8",
        env: gitEnv(),
      }),
    );
    return normalise({ log: err.join(""), report }, [root, made]);
  } finally {
    rmSync(made, { recursive: true, force: true });
  }
}

/** A stand-in of the same length and alphabet, the same for the same value on every capture. */
const standIn = (kind, index, length) =>
  createHash("sha256").update(`${kind}:${index}`).digest("hex").repeat(Math.ceil(length / 64)).slice(0, length);

/**
 * The capture with what varies between captures written in a fixed form.
 *
 * Text first: the capture directory becomes `/tmp/perbo-capture`; each minted
 * id (`att_…`, `ticket_local_…`, `bnd_…`, the local run's hex) and each commit
 * — whole or as the prefix a line prints — becomes a stand-in chosen by the
 * order it first appears, so every mention of one value maps to the same
 * stand-in, and this machine's temporary directory `/tmp`. Then the report:
 * each instant becomes the fixed start plus one second per distinct instant, in
 * order, and each measured duration and retained size a fixed one.
 */
function normalise(captured, roots) {
  // A retained artifact's digest is of bytes that hold what the run measured,
  // so two artifacts can share one on one capture and not on the next: each is
  // named by its place in the report instead.
  let digests = 0;
  const digest = (value) => {
    if (Array.isArray(value)) return value.forEach(digest);
    if (value === null || typeof value !== "object") return;
    if (typeof value.name === "string" && typeof value.sha256 === "string") value.sha256 = standIn("artifact", digests++, 64);
    Object.values(value).forEach(digest);
  };
  digest(captured.report);
  let text = JSON.stringify(captured);
  for (const root of roots) text = text.split(root).join(STATED_ROOT);
  // The write guard's settings, in a directory the runner makes under this machine's temporary directory.
  for (const temporary of new Set([realpathSync(tmpdir()), tmpdir()])) text = text.split(temporary).join("/tmp");
  text = text.replace(/perbo-guard-[A-Za-z0-9]{6}/g, "perbo-guard-XXXXXX");

  // Hex runs of seven or more characters holding a letter: ids, commits and hashes.
  const runs = [];
  for (const match of text.matchAll(/(?<![0-9a-zA-Z])[0-9a-f]{7,}(?![0-9a-zA-Z])/g)) {
    if (/[a-f]/.test(match[0]) && !runs.includes(match[0])) runs.push(match[0]);
  }
  const longest = [...runs].sort((a, b) => b.length - a.length);
  const mapped = new Map();
  let assigned = 0;
  for (const run of runs) {
    const whole = longest.find((other) => other.length > run.length && other.startsWith(run));
    if (whole === undefined) mapped.set(run, standIn("hex", assigned++, run.length));
  }
  for (const run of runs) {
    const whole = longest.find((other) => other.length > run.length && other.startsWith(run) && mapped.has(other));
    if (whole !== undefined) mapped.set(run, mapped.get(whole).slice(0, run.length));
  }
  text = text.replace(/(?<![0-9a-zA-Z])[0-9a-f]{7,}(?![0-9a-zA-Z])/g, (value) => mapped.get(value) ?? value);

  // Instants, in order, one second apart from the minting.
  const instants = [...new Set(text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g) ?? [])].sort();
  const at = new Map(instants.map((instant, index) => [instant, new Date(MINTED.getTime() + index * 1000).toISOString()]));
  text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (instant) => at.get(instant));

  // What the run measured: each duration, each wall-clock ceiling's use, and
  // the size of each retained artifact, which holds those durations.
  const fixed = JSON.parse(text);
  const measured = (value) => {
    if (Array.isArray(value)) return value.forEach(measured);
    if (value === null || typeof value !== "object") return;
    if (typeof value.resource === "string" && value.resource.endsWith("_ms") && typeof value.used === "number") value.used = 1000;
    if (typeof value.name === "string" && typeof value.sha256 === "string" && typeof value.bytes === "number") value.bytes = 1000;
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner === "number" && ["duration_ms", "latency_ms", "wall_clock_ms"].includes(key)) value[key] = 1000;
      else measured(inner);
    }
  };
  measured(fixed.report);
  return fixed;
}

const render = (captured) => `${JSON.stringify(captured, null, 2)}\n`;

async function main(argv) {
  const check = argv.includes("--check");
  const rendered = render(await capture());
  if (!check) {
    writeFileSync(FIXTURE, rendered);
    process.stdout.write(`wrote ${FIXTURE}\n`);
    return 0;
  }
  const committed = existsSync(FIXTURE) ? readFileSync(FIXTURE, "utf8") : "";
  if (committed === rendered) {
    process.stdout.write("the recorded run is what the CLI produces\n");
    return 0;
  }
  const a = committed.split("\n");
  const b = rendered.split("\n");
  const line = a.findIndex((text, index) => text !== b[index]);
  process.stderr.write(
    `${FIXTURE} differs from a fresh capture at line ${line + 1}:\n  committed: ${a[line] ?? "(end)"}\n  captured:  ${b[line] ?? "(end)"}\n` +
      "regenerate it with `node scripts/capture-recorded-run.mjs`\n",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
