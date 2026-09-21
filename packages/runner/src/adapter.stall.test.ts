import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";
import { runAgent } from "./adapter.js";
import { AttemptCeilings } from "./ceilings.js";
import { buildPermissionProfile } from "./profile.js";
import { fakeAgent } from "./test-support/fake-agent.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The stall detector, and the cost cap that outlived the other ceilings
 * (SCP-323, D-096).
 *
 * Nothing bounds how long an attempt runs, what it spends or how many turns it
 * takes. What is left is a hang: an executor whose process is alive and whose
 * stream has said nothing for `attempt_stall_ms`. These drive the real adapter
 * against executors whose streams are written by hand, because the surface
 * under test is the one that reads that stream.
 */

const table = (limits: Record<string, number> = {}) =>
  LimitsTableSchema.parse({ organisation: "test", limits });

let sequence = 0;

/**
 * An executor that writes the given lines and then outlives the attempt, so the
 * runner's own termination is what ends it. `--version` is answered without the
 * wait: the adapter fingerprints the binary before it runs it.
 */
function streamExecutor(worktree: string, lines: readonly string[], linger: boolean): string {
  sequence += 1;
  const binary = join(worktree, `executor-${sequence}`);
  writeFileSync(
    binary,
    `#!/bin/sh\ncase "$1" in --version) echo 'fake-executor 1.0.0'; exit 0 ;; esac\n` +
      `printf '%s\\n' "$@" > "${binary}.argv"\n` +
      `cat <<'JSON'\n${lines.join("\n")}\nJSON\n` +
      (linger ? "sleep 60\n" : ""),
    { mode: 0o755 },
  );
  return binary;
}

/** The init line, which is where the runner reads what the executor is billed on. */
const init = (apiKeySource: string): string =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    apiKeySource,
    mcp_servers: [],
    plugins: [],
    skills: [],
    agents: [],
    memory_paths: null,
  });

/** One assistant envelope carrying the transport's cumulative charge. */
const charged = (dollars: number): string =>
  JSON.stringify({
    type: "assistant",
    total_cost_usd: dollars,
    message: {
      content: [{ type: "text", text: "working" }],
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    },
  });

const runStream = async (
  worktree: string,
  lines: readonly string[],
  limits: Record<string, number> = {},
  linger = true,
) => {
  const binary = streamExecutor(worktree, lines, linger);
  const result = await runAgent({
    binary,
    worktree,
    prompt: "irrelevant",
    model: "claude-opus-5",
    profile: buildPermissionProfile({ worktree }),
    ceilings: new AttemptCeilings(table(limits)),
    env: { PATH: process.env.PATH ?? "" },
  });
  const argv = readFileSync(`${binary}.argv`, "utf8").split("\n");
  return { ...result, argv };
};

/** The result line the transport ends a finished attempt with. */
const finished = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  total_cost_usd: 0.01,
});

describe("an attempt that keeps working is never stopped", () => {
  it(
    "runs for hours of tool calls under a stall window of one",
    async () => {
      const worktree = scratch("perbo-stall-steady-");
      const agent = fakeAgent(scratch, [
        { kind: "shell", commands: Array.from({ length: 60 }, () => "git status") },
      ]);
      /**
       * A clock a minute later on every read. The attempt's own measure of
       * itself is therefore hours, while the gap between one tool call and the
       * next stays the two or three reads the runner makes in between — which
       * is what the stall window is measured against.
       */
      let reads = 0;
      const ceilings = new AttemptCeilings(
        table({ attempt_stall_ms: 60 * 60 * 1000 }),
        () => Date.parse("2026-01-01T00:00:00Z") + reads++ * 60_000,
      );

      const result = await runAgent({
        binary: agent.binary,
        worktree,
        prompt: "do the thing",
        model: "claude-opus-5",
        profile: buildPermissionProfile({ worktree }),
        ceilings,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      });

      expect(result.termination.reason).toBe("completed");
      expect(result.commands).toHaveLength(60);
      // Longer than every ceiling this ticket removed, and stopped by none of
      // them: the attempt measured itself in hours and nothing tested it.
      expect(ceilings.counts().wall_clock_ms).toBeGreaterThan(60 * 60 * 1000);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("an attempt that has stopped saying anything", () => {
  it(
    "terminates as stalled, naming the resource and the window",
    async () => {
      const worktree = scratch("perbo-stall-hang-");
      const result = await runStream(
        worktree,
        [init("none"), charged(0.01)],
        { attempt_stall_ms: 500 },
      );

      expect(result.termination.reason).toBe("stalled");
      expect(result.termination.detail).toContain("attempt_stall_ms");
      expect(result.termination.detail).toContain("above the limit of 500");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "kills the process group, so what the executor started dies with it",
    async () => {
      const worktree = scratch("perbo-stall-group-");
      const pidsFile = join(worktree, "pids.json");
      sequence += 1;
      const binary = join(worktree, `executor-group-${sequence}`);
      writeFileSync(
        binary,
        `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('fixture-agent 1.0.0\\n');
  process.exit(0);
}
const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000);"], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ agent: process.pid, child: child.pid }));
process.stdout.write(${JSON.stringify(init("none"))} + '\\n');
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );

      const result = await runAgent({
        binary,
        worktree,
        prompt: "irrelevant",
        model: "claude-opus-5",
        profile: buildPermissionProfile({ worktree }),
        ceilings: new AttemptCeilings(table({ attempt_stall_ms: 500 })),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      });

      expect(result.termination.reason).toBe("stalled");
      expect(existsSync(pidsFile)).toBe(true);
      const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as {
        agent: number;
        child: number;
      };
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await expect
        .poll(() => alive(pids.agent) || alive(pids.child), { timeout: 5_000 })
        .toBe(false);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

/**
 * The window is measured from the last tool activity, not from the start of the
 * attempt — the difference between a stall detector and the wall clock it
 * replaced.
 */
describe("what resets the stall window", () => {
  it(
    "counts a tool result on the Claude stream, which is the executor being answered",
    async () => {
      const worktree = scratch("perbo-stall-results-");
      sequence += 1;
      const binary = join(worktree, `executor-results-${sequence}`);
      // The executor's prompt arrives as argv, so every `user` event on the
      // stream is a tool answering; this one shows nothing else for three
      // seconds, three ticks of the detector, under a window of 600 ms.
      writeFileSync(
        binary,
        `#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('fixture-agent 1.0.0\\n');
  process.exit(0);
}
process.stdout.write(${JSON.stringify(init("none"))} + '\\n');
let answered = 0;
const timer = setInterval(() => {
  answered += 1;
  process.stdout.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + answered, content: 'ok' }] },
  }) + '\\n');
  if (answered === 20) {
    clearInterval(timer);
    process.stdout.write(${JSON.stringify(finished)} + '\\n');
    process.exit(0);
  }
}, 150);
`,
        { mode: 0o700 },
      );

      const result = await runAgent({
        binary,
        worktree,
        prompt: "irrelevant",
        model: "claude-opus-5",
        profile: buildPermissionProfile({ worktree }),
        ceilings: new AttemptCeilings(table({ attempt_stall_ms: 600 })),
        env: { PATH: process.env.PATH ?? "" },
      });

      expect(result.termination.reason).toBe("completed");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  const stall = () => {
    let now = 0;
    const ceilings = new AttemptCeilings(table({ attempt_stall_ms: 1_000 }), () => now);
    return { ceilings, at: (value: number) => (now = value) };
  };

  it("starts the window at the attempt, so an executor that never calls a tool stalls", () => {
    const { ceilings, at } = stall();
    at(1_001);
    expect(ceilings.tick()?.reason).toBe("stalled");
  });

  it("restarts it at every tool call, however long the attempt has run", () => {
    const { ceilings, at } = stall();
    for (const instant of [900, 1_800, 2_700, 3_600, 100_000]) {
      at(instant);
      ceilings.noteToolActivity();
      expect(ceilings.tick()).toBeNull();
    }
    at(100_900);
    expect(ceilings.tick()).toBeNull();
    at(101_001);
    expect(ceilings.tick()?.reason).toBe("stalled");
  });
});

/**
 * D-096: a cost cap means something only where the executor is billed per
 * token. The credential the attempt records is what says which it was.
 */
describe("the cost cap and the credential the executor authenticated with", () => {
  it(
    "stops an API-key attempt at the $5 default nothing configured",
    async () => {
      const worktree = scratch("perbo-stall-apikey-");
      const result = await runStream(worktree, [
        init("ANTHROPIC_API_KEY"),
        charged(6),
      ]);

      expect(result.invocation.credential_class).toBe("user_api_key");
      expect(result.termination.reason).toBe("cost_ceiling_exceeded");
      expect(result.termination.detail).toContain("above the limit of 5000000");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "leaves a subscription attempt alone at a charge no cap would allow",
    async () => {
      const worktree = scratch("perbo-stall-subscription-");
      // The executor exits of its own accord, so nothing but the cost cap could
      // have stopped it, and there is no hang for the detector to find.
      const result = await runStream(worktree, [init("none"), charged(600)], {}, false);

      expect(result.invocation.credential_class).toBe("subscription");
      expect(result.termination.reason).not.toBe("cost_ceiling_exceeded");
      expect(result.usage.cost_micros).toBe(600_000_000);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "hands the executor no `--max-budget-usd`, whatever the repository set: the counter is the cap",
    async () => {
      const worktree = scratch("perbo-stall-flag-");
      const { argv, termination } = await runStream(
        worktree,
        [init("ANTHROPIC_API_KEY"), charged(3)],
        { attempt_cost_micros: 2_500_000 },
        false,
      );
      expect(argv).not.toContain("--max-budget-usd");
      expect(termination.reason).toBe("cost_ceiling_exceeded");
      expect(termination.detail).toContain("above the limit of 2500000");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "leaves a subscription attempt alone even under a cap the repository set",
    async () => {
      const worktree = scratch("perbo-stall-subscription-set-");
      const result = await runStream(
        worktree,
        [init("none"), charged(600)],
        { attempt_cost_micros: 500 },
        false,
      );

      expect(result.termination.reason).not.toBe("cost_ceiling_exceeded");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
