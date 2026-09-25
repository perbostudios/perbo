import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsTableSchema, readSpoken } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";
import { runCodexAgent } from "./index.js";
import { AttemptCeilings } from "../ceilings.js";
import { buildPermissionProfile } from "../profile.js";

/**
 * The executor's words on Codex, through `runCodexAgent` itself: each message
 * the root thread completes is said as a progress line as it arrives, and a
 * child thread's is not the executor's (D-106): it is recorded marked as the
 * subagent's.
 */

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { worktree: string; binary: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "perbo-codex-spoken-"));
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
  if (m.method === 'thread/read') send({id:m.id,result:{thread:{id:m.params.threadId,agentRole:'perbo-implementer'}}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'m1',type:'agentMessage',text:''}}});
    send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'m1',type:'agentMessage',text:'Reading the mailer.\nThe key sk-live-SECRET stays out.'}}});
    send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'sa1',type:'subAgentActivity',kind:'started',agentPath:'/root/child_1',agentThreadId:'child-1'}}});
    send({method:'item/completed',params:{threadId:'child-1',turnId:'turn',item:{id:'m2',type:'agentMessage',text:'A child summary.'}}});
    send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
    { mode: 0o700 },
  );
  return { worktree, binary, env: { ...process.env, CODEX_HOME: home } };
}

describe("the executor's words on Codex, as the run prints them", () => {
  it(
    "says each message the root thread completes, redacted and in order, and no child's",
    async () => {
      const f = fixture();
      const lines: string[] = [];
      const result = await runCodexAgent({
        binary: f.binary,
        worktree: f.worktree,
        prompt: "You are implementing one approved ticket in a Git worktree.",
        model: "test-model",
        profile: buildPermissionProfile({ worktree: f.worktree }),
        ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} }), () => 0),
        env: f.env,
        onProgress: (line) => lines.push(line),
        redact: (text) => text.replaceAll("sk-live-SECRET", "[redacted]"),
      });
      expect(result.termination.reason).toBe("completed");
      expect(lines.filter((line) => /[\n\r]/.test(line))).toEqual([]);
      expect(lines.map(readSpoken).filter((line) => line !== null)).toEqual([
        { speaker: "executor", words: "Reading the mailer.\nThe key [redacted] stays out." },
        { speaker: "executor", words: "Finished" },
      ]);
      // The record keeps the child's words too, marked as a subagent's, so
      // what reads it back lists the executor's alone (D-106).
      const said = result.transcript
        .map((line) => JSON.parse(line) as { item: { type: string; text?: string }; subagent?: boolean })
        .filter((line) => line.item.type === "agentMessage")
        .map((line) => [line.item.text, line.subagent ?? false]);
      expect(said).toEqual([
        ["Reading the mailer.\nThe key [redacted] stays out.", false],
        ["A child summary.", true],
        ["Finished", false],
      ]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
