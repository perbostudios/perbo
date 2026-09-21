import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { TicketRunConfigSchema, runTicket, type TicketRunResult } from "./index.js";
import { makeContract, makeReview } from "../test-support/records.js";
import { runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * What an attempt leaves running when it ends.
 *
 * The runner starts the executor in its own process group and signals the group
 * on termination, and every check the same way. A process that called
 * `setsid(2)` is in a session of its own and outside every group the runner
 * holds, which is what a coding agent's background tasks do — so it survives,
 * and it survived a worktree that had been removed underneath it for five days
 * (SCP-263).
 *
 * Measured on this platform (Darwin 25, arm64) before these were written, with
 * a fake agent that starts three children and a parent that signals the agent's
 * process group:
 *
 *   plain child of the agent             — killed by the group signal
 *   `nohup sleep 300 &` from a shell     — killed by the group signal
 *   a child spawned in its own session   — ALIVE afterwards
 *
 * `nohup` only ignores SIGHUP; the process group is inherited either way. So
 * the survivor here is the third, and there is no `setsid(1)` on macOS to start
 * it with — Node's `detached: true` calls `setsid(2)`, which is the same thing
 * the agent's own background tasks reach.
 */

/** Whether a pid is still running. Independent of the sweep's own finder. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const end = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone, which is what the test wanted.
  }
};

/** One process the fake agent starts in its own session before it exits. */
interface Survivor {
  name: string;
  /**
   * Where it runs. `worktree` is the directory the agent was started in;
   * `beside` is that path with a suffix, so a prefix test without the
   * separator would catch it.
   */
  cwd: "worktree" | "beside";
  argv: string[];
}

/**
 * A fake agent that starts processes in their own session, writes their pids
 * where the test can read them, seals one file and exits cleanly.
 */
function agentLeaving(survivors: readonly Survivor[]): { binary: string; pids: () => Record<string, number> } {
  const dir = scratch("perbo-orphan-agent-");
  const binary = join(dir, "agent.cjs");
  const pidsFile = join(dir, "pids.json");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
"use strict";
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");

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

const pids = {};
for (const survivor of ${JSON.stringify(survivors)}) {
  const cwd = survivor.cwd === "beside" ? process.cwd() + "-beside" : process.cwd();
  mkdirSync(cwd, { recursive: true });
  // detached: setsid(2), so the child leads a session the runner never held.
  const child = spawn(survivor.argv[0], survivor.argv.slice(1), {
    cwd,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  pids[survivor.name] = child.pid;
}
writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify(pids));

const target = require("node:path").join(process.cwd(), "src", "feature.ts");
mkdirSync(require("node:path").dirname(target), { recursive: true });
writeFileSync(target, "export const total = (n) => n.length;\\n");
emit({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: target } }],
    usage: { input_tokens: 20, output_tokens: 6 },
  },
});
emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.002, permission_denials: [] });
process.exit(0);
`,
    { mode: 0o755 },
  );
  return { binary, pids: () => JSON.parse(readFileSync(pidsFile, "utf8")) as Record<string, number> };
}

/** A reviewer that approves whatever it is handed; none of this is about its judgement. */
const approve = (async () => ({
  artifact: makeReview({
    review_id: "rev_0000000000000263",
    decision: "approve",
    coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
  }),
  bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
})) as never;

function configFor(repositoryRoot: string, checkCommand: string[] = ["node", "-e", "process.exit(0)"]) {
  const root = scratch("perbo-orphans-");
  return TicketRunConfigSchema.parse({
    ticket_key: "SCP094",
    repository_root: repositoryRoot,
    base_ref: "main",
    worktree_root: join(root, "worktrees"),
    bundle_root: join(root, "bundles"),
    quarantine_root: join(root, "quarantine"),
    state_root: join(root, "state"),
    checks: [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        command: checkCommand,
        timeout_ms: 30_000,
      },
    ],
    agent_binary: "true",
    model: "double",
    max_remediation_rounds: 1,
    limits: LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 4 },
    }),
  });
}

/**
 * What the run's attempt says it ended. Read without a default: an attempt that
 * carries no such list has not recorded one.
 */
const swept = (result: TicketRunResult): Array<{ pid: number; command: string }> =>
  (result.rounds[0]?.attempt as unknown as { swept_processes: Array<{ pid: number; command: string }> })
    .swept_processes;

/** The same, off the ticket's attempts record on disk. */
const sweptOnRecord = (
  config: { state_root: string },
  ticket_id: string,
): Array<{ pid: number; command: string }> =>
  (
    JSON.parse(readFileSync(join(config.state_root, `${ticket_id}.attempts.json`), "utf8")) as {
      attempts: Array<{ swept_processes: Array<{ pid: number; command: string }> }>;
    }
  ).attempts[0]!.swept_processes;

async function runWith(input: {
  agentBinary: string;
  checkCommand?: string[];
}): Promise<{
  result: TicketRunResult;
  printed: string[];
  config: { state_root: string };
  ticket_id: string;
}> {
  const repo = runnerRepository(scratch);
  const contract = makeContract();
  contract.base.base_commit = repo.head;
  const config = configFor(repo.dir, input.checkCommand);
  config.agent_binary = input.agentBinary;
  const printed: string[] = [];
  const result = await runTicket({
    config,
    contract,
    onProgress: (line) => printed.push(line),
    hooks: { review: approve },
  });
  return { result, printed, config, ticket_id: contract.ticket_id };
}

describe("an attempt's end leaves no process running from its worktree", () => {
  it("ends one the executor started in its own session, and records what it ended", async () => {
    const agent = agentLeaving([{ name: "left", cwd: "worktree", argv: ["sleep", "300"] }]);
    const { result, printed, config, ticket_id } = await runWith({ agentBinary: agent.binary });
    const pid = agent.pids().left;
    expect(pid).toBeDefined();
    try {
      expect(alive(pid!)).toBe(false);
      expect(swept(result)).toEqual([{ pid, command: expect.stringContaining("sleep 300") }]);
      expect(sweptOnRecord(config, ticket_id)).toEqual(swept(result));
      expect(printed.filter((line) => line.includes("still running under the worktree"))).toEqual([
        expect.stringContaining("ended 1 process(es)"),
      ]);
    } finally {
      end(pid);
    }
  }, 90_000);

  it("ends one a check's command started in its own session", async () => {
    const marker = scratch("perbo-orphan-check-");
    const pidFile = join(marker, "pid.json");
    const agent = agentLeaving([]);
    const { result } = await runWith({
      agentBinary: agent.binary,
      checkCommand: [
        "node",
        "-e",
        `const {spawn}=require("node:child_process");const c=spawn("sleep",["300"],{cwd:process.cwd(),stdio:"ignore",detached:true});c.unref();` +
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
      ],
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(alive(pid)).toBe(false);
      expect(swept(result).map((entry) => entry.pid)).toContain(pid);
    } finally {
      end(pid);
    }
  }, 90_000);

  it("records an empty list and prints nothing where the worktree had nothing running under it", async () => {
    const agent = agentLeaving([]);
    const { result, printed } = await runWith({ agentBinary: agent.binary });
    expect(swept(result)).toEqual([]);
    expect(printed.filter((line) => line.includes("still running under the worktree"))).toEqual([]);
  }, 90_000);

  it("signals nothing outside the worktree path", async () => {
    const agent = agentLeaving([
      { name: "inside", cwd: "worktree", argv: ["sleep", "300"] },
      { name: "outside", cwd: "beside", argv: ["sleep", "300"] },
    ]);
    const { result } = await runWith({ agentBinary: agent.binary });
    const pids = agent.pids();
    try {
      expect(alive(pids.inside!)).toBe(false);
      // A directory whose path is the worktree's plus a suffix: outside it, and
      // inside a prefix test that forgot the separator.
      expect(alive(pids.outside!)).toBe(true);
      expect(swept(result).map((entry) => entry.pid)).toEqual([pids.inside]);
    } finally {
      end(pids.inside);
      end(pids.outside);
    }
  }, 90_000);

  it("kills a survivor that ignores the first signal", async () => {
    const agent = agentLeaving([
      {
        name: "deaf",
        cwd: "worktree",
        argv: ["node", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      },
    ]);
    const { result } = await runWith({ agentBinary: agent.binary });
    const pid = agent.pids().deaf;
    expect(pid).toBeDefined();
    try {
      expect(alive(pid!)).toBe(false);
      expect(swept(result).map((entry) => entry.pid)).toEqual([pid]);
    } finally {
      end(pid);
    }
  }, 90_000);
});
