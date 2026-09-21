import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsTableSchema } from "@perbo/contracts";
import { runCodexAgent } from "../src/adapter-codex.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { buildPermissionProfile } from "../src/profile.js";
import { briefRecords } from "../src/test-support/records.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./support.js";

/**
 * D-106: `thread/tokenUsage/updated` is cumulative per thread (ADR-0038's
 * live test quotes 25464 for a child at its end, 90847 for the root), so the
 * attempt holds the latest figure per thread and sums across threads for the
 * final `usage` — never the last update applied, which is what a single
 * shared total would give a two-thread attempt.
 */

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { worktree: string; binary: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "perbo-codex-usage-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, ".perbo-tmp"), { recursive: true });
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), "{}");
  // The adapter looks for the login under this process's CODEX_HOME, never the child's
  // environment, so the fake login is pointed at there; unset, it would be the machine's own.
  vi.stubEnv("CODEX_HOME", home);
  const binary = join(root, "codex-fixture");
  writeFileSync(
    binary,
    String.raw`#!${process.execPath}
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread'},model:m.params.model,instructionSources:[]}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    // The child's own figure arrives twice, cumulative — the second replaces
    // the first rather than adding to it — before the root's own update.
    send({method:'thread/tokenUsage/updated',params:{threadId:'child',tokenUsage:{total:{inputTokens:1000,cachedInputTokens:0,outputTokens:0}}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:'child',tokenUsage:{total:{inputTokens:25464,cachedInputTokens:100,outputTokens:7}}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{total:{inputTokens:90847,cachedInputTokens:200,outputTokens:13}}}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
    { mode: 0o700 },
  );
  return { worktree, binary, env: { ...process.env, CODEX_HOME: home } };
}

describe("Codex usage is summed per thread, not overwritten (D-106)", () => {
  it("holds each thread's latest cumulative figure and sums them for the final usage", async () => {
    const f = fixture();
    const result = await runCodexAgent({
      binary: f.binary,
      worktree: f.worktree,
      prompt: "You are implementing one approved ticket in a Git worktree.",
      brief_records: briefRecords(),
      model: "test-model",
      profile: buildPermissionProfile({ worktree: f.worktree }),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} }), () => 0),
      env: f.env,
    });
    expect(result.termination.reason).toBe("completed");
    // 25464 (the child's own final figure, not its stale 1000) + 90847 (the root).
    expect(result.usage.input_tokens).toBe(25464 + 90847);
    expect(result.usage.cache_read_input_tokens).toBe(100 + 200);
    expect(result.usage.output_tokens).toBe(7 + 13);
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("a thread's figure never goes down (D-106)", () => {
  it("does not re-charge the ceiling for tokens already counted, once a thread's figure dips and rises again", async () => {
    const root = mkdtempSync(join(tmpdir(), "perbo-codex-usage-dip-"));
    roots.push(root);
    const worktree = join(root, "worktree");
    mkdirSync(join(worktree, ".perbo-tmp"), { recursive: true });
    const home = join(root, "codex-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    vi.stubEnv("CODEX_HOME", home);
    const binary = join(root, "codex-fixture");
    writeFileSync(
      binary,
      String.raw`#!${process.execPath}
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread'},model:m.params.model,instructionSources:[]}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    // The wire is cumulative, but a protocol gap can still report a lower
    // figure for the same thread — here, then a rise back past the first.
    send({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{total:{inputTokens:10000,cachedInputTokens:0,outputTokens:0}}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{total:{inputTokens:2000,cachedInputTokens:0,outputTokens:0}}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{total:{inputTokens:10500,cachedInputTokens:0,outputTokens:0}}}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
      { mode: 0o700 },
    );
    const result = await runCodexAgent({
      binary,
      worktree,
      prompt: "You are implementing one approved ticket in a Git worktree.",
      brief_records: briefRecords(),
      model: "test-model",
      profile: buildPermissionProfile({ worktree }),
      // Above the true peak (10500) but below what re-charging the dip's
      // rise on top of the first figure would reach (10000 + 8500 = 18500):
      // a ceiling only the bug's double count would cross.
      ceilings: new AttemptCeilings(
        LimitsTableSchema.parse({ organisation: "test", limits: { attempt_tokens: 15000 } }),
        () => 0,
      ),
      env: { ...process.env, CODEX_HOME: home },
    });
    expect(result.termination.reason).toBe("completed");
    expect(result.usage.input_tokens).toBe(10500);
  }, SPAWN_TEST_TIMEOUT_MS);
});
