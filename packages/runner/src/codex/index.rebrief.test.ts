import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsTableSchema } from "@perbo/contracts";
import { codexNotificationHandler, type CodexItem } from "./index.js";
import { reinjectedBrief } from "../brief.js";
import { AttemptCeilings } from "../ceilings.js";
import { CodexExecutorSession } from "./internal/rpc.js";
import { EgressLog } from "../egress.js";
import { briefRecords } from "../test-support/records.js";

/**
 * D-096 on Codex: a thread whose context was compacted gets the brief again.
 *
 * Codex has no settings file of the runner's and no session-start hook the
 * runner routes, so both the main thread and every child thread the attempt
 * owns are served by the same mechanism: the app-server completes a
 * `contextCompaction` item on the thread, and the runner answers it with
 * `thread/inject_items` on that same thread (ADR-0038: item notifications
 * carry the thread they happened on).
 *
 * Driven against a fake app-server that speaks the real protocol envelope, so
 * what is asserted is the request that leaves the runner rather than a call
 * into a double.
 */

const BRIEF = "You are implementing one approved ticket in a Git worktree.";
const RECORDS = briefRecords();
const REBRIEF = reinjectedBrief(BRIEF, RECORDS);

const roots: string[] = [];
const sessions: CodexExecutorSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A fake app-server that compacts: one ordinary tool item, then a
 * `contextCompaction` on the root thread and another on a child thread.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "perbo-rebrief-codex-"));
  roots.push(root);
  writeFileSync(join(root, "auth.json"), "{}");
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
  if (m.method === 'thread/inject_items') send({id:m.id,result:{}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'c1',type:'commandExecution',command:'git status --short',cwd:${JSON.stringify(root)}}}});
    send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id:'k1',type:'contextCompaction'}}});
    send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'k1',type:'contextCompaction'}}});
    send({method:'item/completed',params:{threadId:'child',item:{id:'k2',type:'contextCompaction'}}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
    { mode: 0o700 },
  );

  const reinjections: Array<{ target: string | null }> = [];
  /** The injections in flight, so a case can wait for the app-server's replies. */
  const injected: Array<Promise<void>> = [];
  const stops: string[] = [];
  let session: CodexExecutorSession | null = null;
  const handle = codexNotificationHandler({
    ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} }), () => 0),
    items: new Map<string, CodexItem>(),
    transcript: [],
    redact: (text) => text,
    record: () => undefined,
    egress: new EgressLog([]),
    stop: (reason) => stops.push(reason),
    progress: () => undefined,
    rebrief: (threadId) => {
      reinjections.push({ target: threadId });
      injected.push(session!.injectItems(threadId!, REBRIEF));
    },
    onSubagentStarted: () => undefined,
    spoke: () => undefined,
    rootThread: () => null,
  });
  session = new CodexExecutorSession({
    binary,
    env: process.env,
    codexHome: root,
    worktree: root,
    timeoutMs: 10_000,
    onUsage: () => undefined,
    onEvent: handle,
    approve: () => false,
  });
  sessions.push(session);
  return {
    session,
    reinjections,
    injected,
    stops,
    messages: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> }),
  };
}

describe("a compacted Codex thread is briefed again (D-096)", () => {
  it("answers each contextCompaction with thread/inject_items on that thread", async () => {
    const f = fixture();
    const thread = await f.session.start("test-model", "Approved instructions");
    expect(await f.session.turn(thread, "test-model", BRIEF)).toBe("Finished");
    // The turn completes before the app-server has answered the injections;
    // what is asserted below is the request it received, so wait for them.
    await Promise.all(f.injected);

    const injected = f
      .messages()
      .filter((message) => message.method === "thread/inject_items")
      .map((message) => message.params as { threadId: string; items: Array<{ text: string }> });

    // One per compaction: the attempt's own thread, and the child thread.
    expect(injected.map((request) => request.threadId)).toEqual(["thread", "child"]);
    for (const request of injected) {
      expect(request.items).toHaveLength(1);
      expect(request.items[0]!.text).toBe(REBRIEF);
    }
    expect(f.reinjections.map((entry) => entry.target)).toEqual(["thread", "child"]);
    // The capability guard is not tripped by a compaction item.
    expect(f.stops).toEqual([]);
  }, 30_000);

  it("injects nothing for any other item, started or completed", async () => {
    const f = fixture();
    const thread = await f.session.start("test-model", "Approved instructions");
    await f.session.turn(thread, "test-model", BRIEF);
    await Promise.all(f.injected);
    // Four items complete; only the two compactions are answered.
    expect(
      f.messages().filter((message) => message.method === "thread/inject_items"),
    ).toHaveLength(2);
  }, 30_000);
});
