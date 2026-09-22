import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";

const scratch = scratchDirectories("perbo-runner-");

const PidsSchema = z.object({ agent: z.number().int(), child: z.number().int() });
const ResultSchema = z.object({
  type: z.literal("result"),
  reason: z.string(),
  listenersRestored: z.boolean(),
});

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

describe.skipIf(process.platform === "win32")("cancelling the runner process", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "forwards %s to the detached Claude group and records cancellation",
    async (signal) => {
      const root = scratch("perbo-cancel-runner-");
      const binary = join(root, "agent.cjs");
      const pidsFile = join(root, "pids.json");
      const entry = join(root, "runner.mjs");
      writeFileSync(binary, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('fixture-agent 1.0.0\\n');
  process.exit(0);
}
// The child keeps the output pipes open and ignores the first termination signal.
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
child.once('message', () => {
  writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ agent: process.pid, child: child.pid }));
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', mcp_servers: [], plugins: [], skills: [], agents: [] }) + '\\n');
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
      // The package's test task depends on its build; this child exercises real OS signals.
      writeFileSync(entry, `
import { runAgent } from ${JSON.stringify(new URL("../dist/adapter.js", import.meta.url).href)};
import { AttemptCeilings } from ${JSON.stringify(new URL("../dist/ceilings.js", import.meta.url).href)};
import { buildPermissionProfile } from ${JSON.stringify(new URL("../dist/profile.js", import.meta.url).href)};

const worktree = ${JSON.stringify(root)};
const before = ['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal));
const result = await runAgent({
  binary: ${JSON.stringify(binary)}, worktree, prompt: 'Controlled cancellation check', model: 'fixture',
  profile: buildPermissionProfile({ worktree }),
  ceilings: new AttemptCeilings({ organisation: 'test', limits: {}, kill_switches: {} }),
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
  onProgress: line => { if (line.startsWith('agent ready:')) process.send({ type: 'ready' }); },
});
process.send({ type: 'result', reason: result.termination.reason,
  listenersRestored: ['SIGTERM', 'SIGINT'].every((signal, index) => process.listenerCount(signal) === before[index]),
});
process.disconnect();
`);
      const runner = fork(entry, [], {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const messages: unknown[] = [];
      runner.on("message", (message: unknown) => messages.push(message));
      const closed = once(runner, "close");
      try {
        const [ready] = await once(runner, "message", { signal: AbortSignal.timeout(10_000) });
        expect(ready).toEqual({ type: "ready" });
        const cancelledClose = once(runner, "close", { signal: AbortSignal.timeout(10_000) });
        signalGroup(runner.pid, signal);
        const [code, exitSignal] = await cancelledClose;
        expect({ code, exitSignal }).toEqual({ code: 0, exitSignal: null });
        const result = messages.map((message) => ResultSchema.safeParse(message)).find((value) => value.success);
        expect(result?.data).toEqual({ type: "result", reason: "cancelled", listenersRestored: true });
        const pids = PidsSchema.parse(JSON.parse(readFileSync(pidsFile, "utf8")));
        await expect.poll(() => alive(pids.agent) || alive(pids.child), { timeout: 5000 }).toBe(false);
      } finally {
        signalGroup(runner.pid, "SIGKILL");
        if (existsSync(pidsFile)) {
          const pids = PidsSchema.parse(JSON.parse(readFileSync(pidsFile, "utf8")));
          signalGroup(pids.agent, "SIGKILL");
        }
        await closed;
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
