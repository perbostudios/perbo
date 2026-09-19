import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsTableSchema } from "@perbo/contracts";
import { runCodexAgent } from "../src/adapter-codex.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { buildPermissionProfile } from "../src/profile.js";
import { briefRecords, SPAWN_TEST_TIMEOUT_MS } from "./support.js";

/**
 * D-106, through `runCodexAgent` itself, against a fake app-server that
 * speaks the real protocol envelope: a subagent's own start is reported to
 * its parent as a `subAgentActivity` item (ADR-0038's live test), never
 * announced by a `thread/started` of its own, so this is the one place both
 * the reactive nesting stop and the role lookup have anything to work from.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix: string): { worktree: string; binary: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, ".perbo-tmp"), { recursive: true });
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), "{}");
  return { worktree, binary: join(root, "codex-fixture"), env: { ...process.env, CODEX_HOME: home } };
}

const run = (f: { worktree: string; binary: string; env: NodeJS.ProcessEnv }) =>
  runCodexAgent({
    binary: f.binary,
    worktree: f.worktree,
    prompt: "You are implementing one approved ticket in a Git worktree.",
    brief_records: briefRecords(),
    model: "test-model",
    profile: buildPermissionProfile({ worktree: f.worktree }),
    ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} }), () => 0),
    env: f.env,
  });

describe("a subagent may not start a subagent, reactively (D-106)", () => {
  it("ends the attempt when a subAgentActivity is reported by a thread that is not the root", async () => {
    const f = scratch("perbo-codex-nesting-");
    writeFileSync(
      f.binary,
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
    // The root starts a first-generation child, which is fine —
    send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'sa1',type:'subAgentActivity',kind:'started',agentPath:'/root/child_1',agentThreadId:'child-1'}}});
    // — and that child starts one of its own: a second generation.
    send({method:'item/started',params:{threadId:'child-1',turnId:'turn',item:{id:'sa2',type:'subAgentActivity',kind:'started',agentPath:'/root/child_2',agentThreadId:'child-2'}}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
      { mode: 0o700 },
    );
    const result = await run(f);
    expect(result.termination.reason).toBe("prohibited_action");
    expect(result.termination.detail).toContain("child-1");
    expect(result.termination.detail).toContain("child-2");
    expect(result.prohibited).toEqual([
      expect.objectContaining({ action: "enable_own_tooling" }),
    ]);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("does not end the attempt for a first-generation child, spawned by the root itself", async () => {
    const f = scratch("perbo-codex-first-gen-");
    writeFileSync(
      f.binary,
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
    send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'sa1',type:'subAgentActivity',kind:'started',agentPath:'/root/child_1',agentThreadId:'child-1'}}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
      { mode: 0o700 },
    );
    const result = await run(f);
    expect(result.termination.reason).toBe("completed");
    expect(result.prohibited).toEqual([]);
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("a subAgentActivity reported with no threadId on the event itself (D-106)", () => {
  it("neither stops the attempt nor stays silent about the gap", async () => {
    const f = scratch("perbo-codex-no-thread-");
    writeFileSync(
      f.binary,
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
    // No threadId on the envelope at all — the protocol gap this case is about.
    send({method:'item/started',params:{turnId:'turn',item:{id:'sa1',type:'subAgentActivity',kind:'started',agentPath:'/root/child_1',agentThreadId:'child-1'}}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
      { mode: 0o700 },
    );
    const progressLines: string[] = [];
    const result = await runCodexAgent({
      binary: f.binary,
      worktree: f.worktree,
      prompt: "You are implementing one approved ticket in a Git worktree.",
      brief_records: briefRecords(),
      model: "test-model",
      profile: buildPermissionProfile({ worktree: f.worktree }),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} }), () => 0),
      env: f.env,
      onProgress: (line) => progressLines.push(line),
    });
    // Not stopped: an attempt this guard could not fully verify is not the
    // same as one caught doing something prohibited.
    expect(result.termination.reason).toBe("completed");
    expect(result.prohibited).toEqual([]);
    // Not silent: the gap is named, on both channels the attempt reports on.
    expect(
      result.transcript.some((line) => line.includes("child-1") && line.includes("threadId")),
    ).toBe(true);
    expect(progressLines.some((line) => line.includes("child-1") && line.includes("threadId"))).toBe(
      true,
    );
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("a command record names the agent that ran it (D-106 criterion 3)", () => {
  it("looks up a child thread's role once, and names it on that thread's own command records", async () => {
    const f = scratch("perbo-codex-records-");
    writeFileSync(
      f.binary,
      String.raw`#!${process.execPath}
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let threadReads = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread'},model:m.params.model,instructionSources:[]}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'sa1',type:'subAgentActivity',kind:'started',agentPath:'/root/child_1',agentThreadId:'child-1'}}});
  }
  if (m.method === 'thread/read') {
    threadReads += 1;
    send({id:m.id,result:{thread:{id:m.params.threadId,agentRole:'perbo-implementer'}}});
    // The role's answer and the child's own first command are sent back to
    // back, so the pipe hands the runner both in one chunk: the command's
    // record is made before the lookup's promise has settled, and is
    // corrected by it.
    send({method:'item/completed',params:{threadId:'child-1',turnId:'turn',item:{id:'c1',type:'commandExecution',command:'echo hi',cwd:${JSON.stringify(f.worktree)}}}});
    // The root's own command, on the attempt's own thread, names no agent.
    send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'c2',type:'commandExecution',command:'echo root',cwd:${JSON.stringify(f.worktree)}}}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
      { mode: 0o700 },
    );
    const result = await run(f);
    expect(result.termination.reason).toBe("completed");
    const child = result.commands.find((command) => command.detail === "echo hi");
    const root = result.commands.find((command) => command.detail === "echo root");
    expect(child?.agent).toBe("perbo-implementer");
    expect(root?.agent).toBeNull();
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("a role lookup still in flight when the turn ends (D-106 criterion 3)", () => {
  it("is waited for before the attempt's records are read, so the record carries the role", async () => {
    const f = scratch("perbo-codex-late-role-");
    writeFileSync(
      f.binary,
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
    send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'sa1',type:'subAgentActivity',kind:'started',agentPath:'/root/child_1',agentThreadId:'child-1'}}});
    send({method:'item/completed',params:{threadId:'child-1',turnId:'turn',item:{id:'c1',type:'commandExecution',command:'echo hi',cwd:${JSON.stringify(f.worktree)}}}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
  // The role's answer lands after the turn has already completed.
  if (m.method === 'thread/read') setTimeout(() => send({id:m.id,result:{thread:{id:m.params.threadId,agentRole:'perbo-implementer'}}}), 150);
});
`,
      { mode: 0o700 },
    );
    const result = await run(f);
    expect(result.termination.reason).toBe("completed");
    const child = result.commands.find((command) => command.detail === "echo hi");
    expect(child?.agent).toBe("perbo-implementer");
  }, SPAWN_TEST_TIMEOUT_MS);
});
