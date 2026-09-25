import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import { branchName } from "@perbo/workspace";
import { gitEnvironment, initRepository } from "@perbo/test-support";
import { admitCommandLine } from "../admit.js";
import { type ExecuteDeps, executeCommandLine } from "./index.js";
import { readTicket, storeDir, writeTicket } from "../../store/tickets.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";
import { UsageError } from "../../usage-error.js";

/**
 * `perbo run --ticket <KEY> --publish-retained` at the command line
 * (D-NEW-publish-a-retained-branch-later).
 *
 * PRB-8's path: a run with publishing off ends approved at `pr_open`, its
 * branch retained on this machine and no pull request. The command pushes that
 * branch and opens its pull request through the runner's delivery, running
 * nothing, and records the pull request on the ticket, which stays at
 * `pr_open`. `gh` is a program on PATH that logs its argv and answers
 * `pr create`; the push is hooked, since there is no remote.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-publish-retained-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnvironment() }).trim();

const OUTCOME = "The feature module exports a computed total";
const PULL_REQUEST_URL = "https://github.com/o/r/pull/8";

/** An executor that writes one file, as a real program the runner spawns. */
function agent(dir: string): string {
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
emit({ type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [], plugins: [], skills: [], agents: [], memory_paths: null });
const input = { file_path: "src/feature.ts", content: "export const total = 1;\\n" };
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_fake_1", name: "Write", input }], usage: { input_tokens: 7, output_tokens: 2 } } });
const path = join(process.cwd(), input.file_path);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, input.content);
emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.004, permission_denials: [] });
process.exit(0);
`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return binary;
}

/**
 * A `gh` on PATH that appends each argv, one argument to a line, to `log`,
 * answers `pr create` with {@link PULL_REQUEST_URL}, and fails everything
 * else: there is no pull request on the branch yet.
 */
function fakeGh(dir: string, log: string): string {
  const bin = join(dir, "gh-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done`,
      `printf -- '--\\n' >> "${log}"`,
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      `  echo "${PULL_REQUEST_URL}"`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

const okPreflight = (_request: PreflightRequest): PreflightResult => ({ ok: true, findings: [], tools: {}, github: null });

/** A reviewer that approves the commit it was handed, with no provider behind it. */
const approving = async (request: { changeset?: { changeset_id: string }; head_commit?: string }) => ({
  artifact: {
    schema_version: 1,
    review_id: "rev_0000000000000008",
    created_at: "2026-09-24T21:06:00.000Z",
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
      { criterion_id: "ac_1", status: "met", verification_strength: "directly_verified", evidence: null, note: null },
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
    model: { provider: "stub", model_id: "stub", prompt_version: "reviewer_v2", input_tokens: 1, output_tokens: 1 },
    error: null,
  },
  bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
});

interface Fixture {
  repo: string;
  config: string;
  gh: string;
  ghLog: string;
  key: string;
  ticket_id: string;
}

/** A repository with PRB-1 admitted and approved, and what a run of it needs. */
function fixture(name: string): Fixture {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  const repo = join(dir, "repo");
  initRepository(repo, {
    files: { "package.json": JSON.stringify({ name: "fixture" }), "src/index.ts": "export const version = 1;\n" },
  });
  const admitted = recordStreams();
  const code = runCommandLine(admitCommandLine, {
    argv: [
      "--repo", repo,
      "--outcome", OUTCOME,
      "--criterion", "total() returns the sum of its inputs :: total([1,2]) is 3 :: test",
      "--path", "src/**",
      "--approve",
      "--json",
    ],
    streams: admitted,
    cwd: repo,
  });
  if (code !== EXIT_CODES.approve) throw new Error(admitted.err());
  const key = admitted.json<{ ticket: { key: string } }>().ticket.key;
  const config = join(dir, "run.json");
  writeFileSync(
    config,
    JSON.stringify({
      worktree_root: join(dir, "worktrees"),
      agent_binary: agent(dir),
      model: "double",
      materialization_manifest: {
        manifest_version: 1,
        repository_id: "repo_fixture",
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
        isolation: { mode: "parallel", port_range_size: 0, port_range_start: 41_000, port_range_end: 41_009, database_schema_prefix: null },
      },
      limits: { organisation: "test", limits: { concurrent_local_attempts: 4 } },
    }),
  );
  const ghLog = join(dir, "gh.log");
  return {
    repo,
    config,
    gh: fakeGh(dir, ghLog),
    ghLog,
    key,
    ticket_id: readTicket(storeDir(repo, null), key).ticket_id,
  };
}

const originalPath = process.env.PATH;

/** `perbo run` over `argv`, with `gh` on PATH, and what it printed. */
async function run(
  at: Fixture,
  argv: readonly string[],
  deps: Partial<ExecuteDeps>,
): Promise<{ code: number; out: string; err: string }> {
  const streams = recordStreams();
  process.env.PATH = `${at.gh}:${originalPath ?? ""}`;
  try {
    const code = await runCommandLine(executeCommandLine, {
      argv: ["--repo", at.repo, "--ticket", at.key, "--config", at.config, "--json", ...argv],
      streams,
      cwd: at.repo,
      deps: { preflight: okPreflight, ...deps },
    });
    return { code, out: streams.out(), err: streams.err() };
  } finally {
    process.env.PATH = originalPath;
  }
}

/** Run 1: approved with publishing off, so the branch is retained and nothing opened. */
async function retained(at: Fixture): Promise<string> {
  const first = await run(at, [], { hooks: { review: approving as never } });
  expect(first.code, first.err).toBe(0);
  const ticket = readTicket(storeDir(at.repo, null), at.key);
  expect(ticket.state).toBe("pr_open");
  expect(ticket.delivery.pull_request_url).toBeNull();
  expect(ticket.delivery.branch).not.toBeNull();
  return ticket.delivery.branch!;
}

/** The push, recorded rather than sent: there is no remote. */
function recordedPush() {
  const pushed: string[] = [];
  return {
    pushed,
    push: (async (request: { branch: string }) => {
      pushed.push(request.branch);
      return { pushed: true, detail: "recorded" };
    }) as never,
  };
}

/** Each `gh` invocation's argv, as the fake logged it. */
const ghCalls = (at: Fixture): string[][] =>
  existsSync(at.ghLog)
    ? readFileSync(at.ghLog, "utf8")
        .split("--\n")
        .filter((call) => call.length > 0)
        .map((call) => call.split("\n").filter((arg) => arg.length > 0))
    : [];

/** Every review a run of this ticket asks for fails the test: publishing reviews nothing. */
const noReview = (async () => {
  throw new Error("publishing a retained branch reviews nothing");
}) as never;

const TIMEOUT_MS = 180_000;

describe("perbo run --publish-retained", () => {
  it("is a flag and takes no value", () => {
    expect(executeCommandLine.read(["--ticket", "PRB-8", "--publish-retained"]).input.publishRetained).toBe(true);
    expect(executeCommandLine.read(["--ticket", "PRB-8"]).input.publishRetained).toBe(false);
  });

  it("takes --ticket, and refuses --relevel and --resume-from beside it", async () => {
    const at = fixture("flags");
    const refusal = async (argv: readonly string[]) => {
      const streams = recordStreams();
      return runCommandLine(executeCommandLine, {
        argv: ["--repo", at.repo, "--config", at.config, "--json", ...argv],
        streams,
        cwd: at.repo,
        deps: { preflight: okPreflight },
      });
    };
    await expect(refusal(["--contract", join(at.repo, "contract.json"), "--publish-retained"])).rejects.toThrow(
      new UsageError(
        "--publish-retained takes --ticket: it publishes the branch an admitted ticket's run retained, and only a " +
          "ticket names one",
      ),
    );
    await expect(refusal(["--ticket", at.key, "--publish-retained", "--relevel"])).rejects.toThrow(
      new UsageError("--publish-retained and --relevel are alternatives: publishing a retained branch runs nothing"),
    );
    await expect(
      refusal(["--ticket", at.key, "--publish-retained", "--resume-from", "bundle_0000000000000001"]),
    ).rejects.toThrow(
      new UsageError("--publish-retained and --resume-from are alternatives: publishing a retained branch runs nothing"),
    );
  }, TIMEOUT_MS);

  it("pushes an approved run's retained branch, opens its pull request and records it, the ticket staying at pr_open", async () => {
    const at = fixture("published");
    const branch = await retained(at);
    const before = readTicket(storeDir(at.repo, null), at.key);
    const { pushed, push } = recordedPush();

    const asked: PreflightRequest[] = [];
    const published = await run(at, ["--publish-retained"], {
      hooks: { push, review: noReview },
      preflight: (request) => {
        asked.push(request);
        return okPreflight(request);
      },
    });

    expect(published.code, published.err).toBe(0);
    // It publishes and runs nothing, so the machine is asked for `git` and
    // `gh` before anything is pushed, and for no agent, reviewer or install.
    expect(asked).toEqual([
      { agentBinary: null, agentProvider: null, reviewerProvider: null, needsGh: true, installBinary: null },
    ]);
    expect(pushed).toEqual([branch]);
    // `gh pr create` with the branch, the base and the body as argv elements.
    const create = ghCalls(at).find((call) => call[0] === "pr" && call[1] === "create")!;
    expect(create.slice(0, 6)).toEqual(["pr", "create", "--head", branch, "--base", "main"]);
    expect(create).toContain(`${at.key}: ${OUTCOME}`);
    expect(create.join("\n")).toContain("Verdict **approve**");
    const reported = JSON.parse(published.out) as { outcome: string; pull_request: { url: string; number: number } };
    expect(reported.outcome).toBe("approved");
    expect(reported.pull_request).toEqual({ url: PULL_REQUEST_URL, number: 8 });

    const after = readTicket(storeDir(at.repo, null), at.key);
    expect(after.state).toBe("pr_open");
    expect(after.history).toEqual(before.history);
    expect(after.delivery).toMatchObject({
      branch,
      pull_request_url: PULL_REQUEST_URL,
      pull_request_number: 8,
      state: "open",
      opened_by: "loop",
      arm: "loop",
    });
    expect(published.err).toContain(`${at.key} is still pr_open; its pull request is ${PULL_REQUEST_URL}`);

    // Published once: a second press has nothing retained to publish.
    await expect(run(at, ["--publish-retained"], { hooks: { push, review: noReview } })).rejects.toThrow(
      new UsageError(`${at.key} already has its pull request, ${PULL_REQUEST_URL}`),
    );
    expect(pushed).toEqual([branch]);
  }, TIMEOUT_MS);

  it("refuses a ticket whose run has not ended approved or escalated before asking the machine anything, and pushes nothing", async () => {
    const at = fixture("ready");
    const { pushed, push } = recordedPush();
    // A machine missing what a run needs: the ticket's refusal is still the one said.
    const asked: PreflightRequest[] = [];
    const lacking = (request: PreflightRequest): PreflightResult => {
      asked.push(request);
      return {
        ok: false,
        findings: [{ severity: "blocking", reason: "gh_missing", detail: "`gh` is not on PATH", fix: "install gh" }],
        tools: {},
        github: null,
      };
    };

    await expect(run(at, ["--publish-retained"], { hooks: { push }, preflight: lacking })).rejects.toThrow(
      new UsageError(`${at.key} is ready: only a run that ended approved or escalated retains a branch to publish`),
    );
    expect(asked).toEqual([]);
    expect(pushed).toEqual([]);
    expect(readTicket(storeDir(at.repo, null), at.key).state).toBe("ready");
  }, TIMEOUT_MS);

  it("reads the ticket again under the run lock, and refuses what a run that ended in between left", async () => {
    const at = fixture("moved-between");
    await retained(at);
    const { pushed, push } = recordedPush();
    const OTHER = "https://github.com/o/r/pull/9";

    // Between the first reading and the lock, a run of the ticket published:
    // the machine is asked what it has after the first reading, before the lock.
    const refused = await run(at, ["--publish-retained"], {
      hooks: { push, review: noReview },
      preflight: (request) => {
        const dir = storeDir(at.repo, null);
        const ticket = readTicket(dir, at.key);
        writeTicket(dir, { ...ticket, delivery: { ...ticket.delivery, pull_request_url: OTHER, pull_request_number: 9 } });
        return okPreflight(request);
      },
    });

    expect(refused.code).toBe(EXIT_CODES.did_not_complete);
    expect(refused.err).toContain(
      `${at.key}'s retained branch was not published: ${at.key} already has its pull request, ${OTHER}. Nothing was pushed`,
    );
    expect(pushed).toEqual([]);
    expect(ghCalls(at).some((call) => call[1] === "create")).toBe(false);
  }, TIMEOUT_MS);

  it("refuses a branch carrying a commit the loop did not make, and leaves the ticket as it was", async () => {
    const at = fixture("foreign");
    // A person's commit on the ticket's branch before the loop ran.
    const branch = branchName({ ticket_key: at.key, ticket_id: at.ticket_id, outcome: OUTCOME });
    const hand = join(scratch, "foreign-hand");
    git(at.repo, "worktree", "add", "-q", "-b", branch, hand, "HEAD");
    mkdirSync(join(hand, "src"), { recursive: true });
    writeFileSync(join(hand, "src", "person.ts"), "export const person = true;\n");
    git(hand, "add", "-A");
    git(hand, "commit", "-qm", "by hand: src/person.ts");
    git(at.repo, "worktree", "remove", "--force", hand);
    expect(await retained(at)).toBe(branch);
    const before = readTicket(storeDir(at.repo, null), at.key);
    const { pushed, push } = recordedPush();

    const refused = await run(at, ["--publish-retained"], { hooks: { push } });

    expect(refused.code).toBe(EXIT_CODES.did_not_complete);
    expect(refused.err).toMatch(
      new RegExp(`${at.key}'s retained branch was not published: .* carries 1 commit the loop did not make: [0-9a-f]{12} by hand: src/person\\.ts`),
    );
    expect(pushed).toEqual([]);
    expect(ghCalls(at).some((call) => call[1] === "create")).toBe(false);
    expect(readTicket(storeDir(at.repo, null), at.key)).toEqual(before);
  }, TIMEOUT_MS);

  it("refuses where the base has moved past what the run judged, and leaves the ticket as it was", async () => {
    const at = fixture("base-moved");
    await retained(at);
    mkdirSync(dirname(join(at.repo, "README.md")), { recursive: true });
    writeFileSync(join(at.repo, "README.md"), "the base moved\n");
    git(at.repo, "add", "README.md");
    git(at.repo, "commit", "-qm", "the base moved");
    const before = readTicket(storeDir(at.repo, null), at.key);
    const { pushed, push } = recordedPush();

    const refused = await run(at, ["--publish-retained"], { hooks: { push } });

    expect(refused.code).toBe(EXIT_CODES.did_not_complete);
    expect(refused.err).toMatch(/main has moved to [0-9a-f]{12}, which .* does not carry: the base has moved past what the run judged/);
    expect(refused.err).toContain(`perbo run --ticket ${at.key} --publish`);
    expect(pushed).toEqual([]);
    expect(readTicket(storeDir(at.repo, null), at.key)).toEqual(before);
  }, TIMEOUT_MS);
});
