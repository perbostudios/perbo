import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexExecutorSession } from "../src/codex/internal/rpc.js";
import { buildAgentEnvironment, buildPermissionProfile } from "../src/profile.js";

const roots: string[] = [];
const sessions: CodexExecutorSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(
  mode: "normal" | "reroute" | "instructions" | "hang" | "oversized" = "normal",
  environment?: (worktree: string) => NodeJS.ProcessEnv,
) {
  const root = mkdtempSync(join(tmpdir(), "perbo-rpc-test-"));
  roots.push(root);
  writeFileSync(join(root, "auth.json"), "{}");
  const log = join(root, "protocol.jsonl");
  const environmentFile = join(root, "environment.json");
  const binary = join(root, "codex-fixture");
  // A separate process speaks the real protocol envelope. It does not invoke a model.
  writeFileSync(
    binary,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)}, log = ${JSON.stringify(log)};
fs.writeFileSync(${JSON.stringify(environmentFile)}, JSON.stringify(Object.fromEntries(
  ['PERBO_WORKTREE', 'PERBO_PORT_START', 'PERBO_PORT_END', 'PERBO_DB_SCHEMA', 'CI',
   'TMPDIR', 'CODEX_HOME', 'GH_TOKEN', 'OPENAI_BASE_URL'].flatMap(name =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]])
)));
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); fs.appendFileSync(log, line + '\n');
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread'},model:m.params.model,instructionSources:mode === 'instructions' ? ['untrusted AGENTS.md'] : []}});
  if (m.method === 'thread/read') send({id:m.id,result:{thread:{id:m.params.threadId,agentRole: m.params.threadId === 'roleless-child' ? null : 'perbo-implementer'}}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    if (mode === 'hang') {
      send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn',status:'inProgress'}}});
      return;
    }
    if (mode === 'oversized') { process.stdout.write('x'.repeat(2_000_001)); return; }
    send({method:'item/started',params:{turnId:'turn',item:{id:'patch',type:'fileChange',changes:[{path:'src/a.ts',kind:{type:'add'},diff:'+ ok'}]}}});
    send({id:'approval',method:'item/fileChange/requestApproval',params:{itemId:'patch',turnId:'turn',threadId:'thread'}});
    send({id:'capability',method:'item/tool/call',params:{tool:'untrusted'}});
  }
  if (m.id === 'approval') {
    send({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{total:{inputTokens:20,cachedInputTokens:5,outputTokens:3}}}});
    if (mode === 'reroute') send({method:'model/rerouted',params:{toModel:'a-different-model'}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
    { mode: 0o700 },
  );
  const events: string[] = [],
    usage: number[] = [],
    usageThreads: string[] = [];
  const turnStarted = Promise.withResolvers<void>();
  const session = new CodexExecutorSession({
    binary,
    env: environment?.(root) ?? process.env,
    codexHome: root,
    worktree: root,
    timeoutMs: mode === "hang" ? 1500 : 5000,
    onUsage: (threadId, value) => {
      usageThreads.push(threadId);
      usage.push(value.inputTokens);
    },
    onEvent: (method) => {
      events.push(method);
      if (method === "turn/started") turnStarted.resolve();
    },
    approve: () => false,
  });
  sessions.push(session);
  return {
    session,
    root,
    events,
    usage,
    usageThreads,
    turnStarted: turnStarted.promise,
    environment: () => JSON.parse(readFileSync(environmentFile, "utf8")) as Record<string, string>,
    messages: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("Codex native execution protocol", () => {
  it("carries the runner's leased environment to the process while excluding host overrides", async () => {
    const f = fixture("normal", (worktree) => ({
      ...buildAgentEnvironment({
        base: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        profile: buildPermissionProfile({ worktree, provider: "codex-cli" }),
        worktree,
        ports: { start: 41000, end: 41031 },
        database_schema: "ayo_attempt",
      }).env,
      GH_TOKEN: "fixture-credential-not-for-the-agent",
      OPENAI_BASE_URL: "https://override.invalid",
      CODEX_HOME: "/untrusted-provider-home",
    }));
    await f.session.start("test-model", "Approved instructions");
    const environment = f.environment();
    expect(environment).toMatchObject({
      PERBO_WORKTREE: f.root,
      PERBO_PORT_START: "41000",
      PERBO_PORT_END: "41031",
      PERBO_DB_SCHEMA: "ayo_attempt",
      CI: "1",
    });
    expect(environment.TMPDIR).toContain(f.root);
    expect(environment.CODEX_HOME).not.toBe("/untrusted-provider-home");
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("OPENAI_BASE_URL");
  });
  it("keeps native actions in the CLI, refuses an approval and records usage", async () => {
    const f = fixture();
    const thread = await f.session.start("test-model", "Approved instructions");
    expect(
      await f.session.turn(thread, "test-model", "Approved contract"),
    ).toBe("Finished");
    expect(f.session.credentialClass).toBe("subscription");
    expect(f.usage).toEqual([20]);
    expect(f.usageThreads).toEqual(["thread"]);
    const messages = f.messages();
    expect(messages.find((message) => message.id === "approval")).toMatchObject(
      { result: { decision: "decline" } },
    );
    expect(
      messages.find((message) => message.id === "capability"),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      messages.find((message) => message.method === "thread/start"),
    ).toMatchObject({
      params: {
        cwd: f.root,
        sandbox: "read-only",
        approvalPolicy: "untrusted",
        dynamicTools: [],
        selectedCapabilityRoots: [],
      },
    });
  });
  it("reads a child thread's own role, and null where Codex reports none (D-106)", async () => {
    const f = fixture();
    await f.session.start("test-model", "Approved instructions");
    expect(await f.session.threadRead("child-1")).toBe("perbo-implementer");
    expect(await f.session.threadRead("roleless-child")).toBeNull();
  });
  it("rejects a provider model fallback even when its event has no turn id", async () => {
    const f = fixture("reroute");
    const thread = await f.session.start("test-model", "Approved instructions");
    await expect(
      f.session.turn(thread, "test-model", "Contract"),
    ).rejects.toThrow("rerouted");
  });
  it("refuses a session that loaded external instructions before any model turn", async () => {
    const f = fixture("instructions");
    await expect(
      f.session.start("test-model", "Approved instructions"),
    ).rejects.toThrow("instruction sources");
    expect(
      f.messages().some((message) => message.method === "turn/start"),
    ).toBe(false);
  });
  it("terminates a provider that does not finish a turn", async () => {
    // Process startup still uses real IO; only the session deadline is driven
    // by the test, so a loaded host cannot spend it before the turn starts.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = fixture("hang");
      const thread = await f.session.start("test-model", "Approved instructions");
      let settled = false;
      const turn = f.session.turn(thread, "test-model", "Contract");
      void turn.then(() => { settled = true; }, () => { settled = true; });
      const timeout = expect(turn).rejects.toThrow("timed out");
      await f.turnStarted;
      await vi.advanceTimersByTimeAsync(1499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await timeout;
      await f.session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds a provider event before a newline arrives", async () => {
    const f = fixture("oversized");
    const thread = await f.session.start("test-model", "Approved instructions");
    await expect(
      f.session.turn(thread, "test-model", "Contract"),
    ).rejects.toThrow("capture limit");
  });
});
