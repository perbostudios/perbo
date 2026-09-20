import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsTableSchema } from "@perbo/contracts";
import { runCodexAgent } from "../src/adapter-codex.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { buildPermissionProfile } from "../src/profile.js";
import { briefRecords, SPAWN_TEST_TIMEOUT_MS } from "./support.js";

/**
 * D-096 on Codex, through `runCodexAgent` itself: a compaction that completes
 * as the turn ends still gets its brief back before the session is disposed,
 * and the attempt records it only once the app-server has taken it.
 *
 * The fake app-server answers `thread/inject_items` late — after it has
 * reported the turn complete — which is the window a teardown that did not
 * wait would close on the injection. It can also refuse it, or never answer.
 */

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Answer = "late" | "refused" | "never";

function fixture(answer: Answer = "late"): { worktree: string; binary: string; log: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "perbo-rebrief-run-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, ".perbo-tmp"), { recursive: true });
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), "{}");
  // The adapter looks for the login under this process's CODEX_HOME, never the child's
  // environment, so the fake login is pointed at there; unset, it would be the machine's own.
  vi.stubEnv("CODEX_HOME", home);
  const log = join(root, "protocol.jsonl");
  const binary = join(root, "codex-fixture");
  writeFileSync(
    binary,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); fs.appendFileSync(log, line + '\n');
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread'},model:m.params.model,instructionSources:[]}});
  // Answered late, after the turn has been reported complete; or refused; or never answered.
  if (m.method === 'thread/inject_items') {
    const answer = ${JSON.stringify(answer)};
    if (answer === 'late') setTimeout(() => { fs.appendFileSync(log, JSON.stringify({answered:'thread/inject_items'}) + '\n'); send({id:m.id,result:{}}); }, 400);
    if (answer === 'refused') send({id:m.id,error:{code:-32000,message:'thread is not accepting items'}});
  }
  if (m.method === 'turn/start') {
    // One write under PIPE_BUF (512 bytes on macOS), so the turn's events
    // reach the runner in one chunk and the turn is complete before anything
    // the runner sent in answer to them can be received here.
    const chunk = [
      {id:m.id,result:{turn:{id:'turn'}}},
      {method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'k1',type:'contextCompaction'}}},
      {method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}},
      {method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}},
    ].map((message) => JSON.stringify(message) + '\n').join('');
    if (Buffer.byteLength(chunk) >= 512) throw new Error('the turn no longer fits one atomic pipe write');
    process.stdout.write(chunk);
  }
});
`,
    { mode: 0o700 },
  );
  return { worktree, binary, log, env: { ...process.env, CODEX_HOME: home } };
}

const run = (f: ReturnType<typeof fixture>, options: { limits?: Record<string, number>; clock?: () => number; onProgress?: (line: string) => void } = {}) =>
  runCodexAgent({
    binary: f.binary,
    worktree: f.worktree,
    prompt: "You are implementing one approved ticket in a Git worktree.",
    brief_records: briefRecords(),
    model: "test-model",
    profile: buildPermissionProfile({ worktree: f.worktree }),
    ceilings: new AttemptCeilings(
      LimitsTableSchema.parse({ organisation: "test", limits: options.limits ?? {} }),
      options.clock ?? (() => 0),
    ),
    env: f.env,
    // `onProgress` is optional on the request, so an absent one is left out
    // rather than passed as undefined.
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

describe("a Codex re-briefing at the end of a turn (D-096)", () => {
  it("is delivered before the session is disposed, and recorded once it was", async () => {
    const f = fixture();
    const result = await run(f);
    expect(result.termination.reason).toBe("completed");
    const lines = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    // The injection was asked for, and the app-server answered it.
    expect(lines.filter((line) => line.method === "thread/inject_items")).toHaveLength(1);
    expect(lines.filter((line) => line.answered === "thread/inject_items")).toHaveLength(1);
    // And the attempt counts it, once.
    expect(result.reinjections?.map((entry) => entry.target)).toEqual(["thread"]);
    expect(result.reinjections?.[0]?.mechanism).toBe("thread_inject_items");
  }, SPAWN_TEST_TIMEOUT_MS);

  it("is not recorded where the app-server refuses it, and the turn still completes", async () => {
    const f = fixture("refused");
    const lines: string[] = [];
    const result = await run(f, { onProgress: (line) => lines.push(line) });
    expect(result.termination.reason).toBe("completed");
    expect(result.reinjections).toEqual([]);
    expect(lines.filter((line) => line.includes("was not delivered"))).toEqual([
      "The re-briefing of thread was not delivered: thread is not accepting items",
    ]);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("leaves a completed turn completed where a ceiling ends the wait for an answer that never comes", async () => {
    const f = fixture("never");
    const lines: string[] = [];
    // The clock stands still until the fake has been asked for the injection.
    // The runner asks while it reads the chunk that also completes the turn,
    // so by the time the fake has the request the turn's outcome is known;
    // then the clock is past the stall window, and the ceiling is reached
    // while the wait for the answer is all that is left.
    const asked = (): boolean =>
      existsSync(f.log) && readFileSync(f.log, "utf8").includes('"thread/inject_items"');
    const clock = (): number => (asked() ? 10 * 60_000 : 0);
    const result = await run(f, { limits: { attempt_stall_ms: 1_000 }, clock, onProgress: (line) => lines.push(line) });
    expect(result.termination.reason).toBe("completed");
    expect(result.final_message).toBe("Finished");
    expect(result.reinjections).toEqual([]);
    expect(lines.some((line) => line.startsWith("The re-briefing of thread was not delivered: "))).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);
});
