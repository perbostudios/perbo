import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Codex app server, faked (SCP-312).
 *
 * A separate process that speaks the app-server's own JSON-RPC envelope over
 * stdio and invokes no model: it answers `initialize`, `thread/start` and
 * `thread/resume`, and drives one script per turn — an agent message, a file
 * change it asks approval for, a command it asks approval for, and a call to
 * one of the interview's own tools. Each step waits for the interview's answer
 * before the next, as the real server's turn does, and every answer is written
 * to a log the test reads, so what is asserted is what went back over the wire.
 *
 * The counterpart of `interview-sdk.ts` for the other transport: no session is
 * started, nothing is sent anywhere, and an accepted file change is performed
 * here because the real server performs it.
 */

/** One thing the fake server does inside a turn. */
export type ServerStep =
  | { kind: "say"; text: string }
  | { kind: "fileChange"; path: string; content: string; movePath?: string }
  | { kind: "command"; command: string; cwd?: string }
  /**
   * A command announced on an item and then asked about with neither the
   * command nor the directory on the request itself, which is how the app
   * server asks once the item has said what the act is.
   */
  | { kind: "itemOnlyCommand"; command: string; cwd: string }
  | { kind: "tool"; tool: string; arguments: Record<string, unknown> }
  /** A call to one of the interview's own tools carrying no arguments at all. */
  | { kind: "toolNoArguments"; tool: string }
  /** An approval request of a shape the interview is not built to answer. */
  | { kind: "unknownRequest"; method: string; params: Record<string, unknown> }
  /** A file change asking to widen the boundary for the rest of the session. */
  | { kind: "grantRoot"; path: string; content: string; root: string }
  /**
   * A command approval carrying one more field: an escalation the interview
   * never grants, or a proposal it never takes. `value` is what the field
   * holds; absent, a one-line list stands in for whatever the real server
   * would put there.
   */
  | { kind: "escalation"; command: string; field: string; value?: unknown }
  /** The same two questions in the app server's older shape. */
  | { kind: "legacyCommand"; command: readonly string[] }
  /**
   * The older shape's patch: its changes are on the request, keyed by path.
   * With `movePath`, each is an update moving its file there, which is the one
   * change in that shape that lands somewhere other than the key.
   */
  | { kind: "legacyPatch"; paths: readonly string[]; grantRoot?: string; movePath?: string }
  /** A blank line between two messages, which is not a message. */
  | { kind: "blank" }
  /** A file change asked about with no item announced to say what it changes. */
  | { kind: "unannouncedChange" }
  /** An approval whose payload is not the shape its method takes. */
  | { kind: "malformed"; method: string }
  /** A command approval carrying no command, and naming no announced item. */
  | { kind: "commandlessApproval" };

/** What the server was answered, one entry per request it made. */
export interface ServerAnswer {
  kind: ServerStep["kind"];
  /** The approval decision, or null for a request that took another shape. */
  decision: string | null;
  /** A dynamic tool call's result text, or a JSON-RPC error message. */
  text: string | null;
  /** A dynamic tool call's `success`, or null. */
  success: boolean | null;
  /** A JSON-RPC error code, where the interview answered with one. */
  errorCode: number | null;
}

export interface FakeAppServer {
  /** The binary to spawn, which is this fake. */
  binary: string;
  /** The `CODEX_HOME` whose `auth.json` the transport links. */
  codexHome: string;
  /** What each request the server made was answered with, in order. */
  answers(): ServerAnswer[];
  /** The parameters of the `thread/start` or `thread/resume` the session made. */
  opened(): { method: string; params: Record<string, unknown> };
  /** The parameters of the `initialize` the session opened the handshake with. */
  initialized(): Record<string, unknown>;
  /** Every line the interview sent, for a test reading the invocation. */
  sent(): Array<Record<string, unknown>>;
  /** The argv and environment the session started this process with. */
  invocation(): {
    argv: string[];
    env: Record<string, string>;
    /** What the home the session made holds. */
    home: string[];
    /** Its permissions, read while the session was running, since it goes after. */
    homeMode: number | null;
  };
}

/**
 * Write the fake, its script and its logs into `root`, and say where they are.
 *
 * `steps` are replayed on every turn the session starts; a session with no
 * turn opens a thread and stops, which is what an interview that was started
 * and not spoken to does.
 */
export function fakeAppServer(input: {
  root: string;
  steps: readonly ServerStep[];
  /** The thread id `thread/start` answers with. */
  threadId: string;
}): FakeAppServer {
  mkdirSync(input.root, { recursive: true });
  const codexHome = join(input.root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), "{}\n");
  const script = join(input.root, "script.json");
  const answerLog = join(input.root, "answers.jsonl");
  const openedLog = join(input.root, "opened.json");
  const initializeLog = join(input.root, "initialize.json");
  const sentLog = join(input.root, "sent.jsonl");
  const invocationLog = join(input.root, "invocation.json");
  writeFileSync(
    script,
    JSON.stringify({ steps: input.steps, threadId: input.threadId }),
  );
  const binary = join(input.root, "codex-app-server");
  writeFileSync(
    binary,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const script = JSON.parse(fs.readFileSync(${JSON.stringify(script)}, 'utf8'));
const answerLog = ${JSON.stringify(answerLog)};
const openedLog = ${JSON.stringify(openedLog)};
const initializeLog = ${JSON.stringify(initializeLog)};
const sentLog = ${JSON.stringify(sentLog)};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
fs.writeFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  env: Object.fromEntries(Object.keys(process.env).filter((name) =>
    name.startsWith('CODEX_') || name.startsWith('OPENAI_') || name === 'PERBO_INTERVIEW')
    .map((name) => [name, process.env[name]])),
  home: (() => { try { return fs.readdirSync(process.env.CODEX_HOME ?? '.'); } catch { return []; } })(),
  homeMode: (() => { try { return fs.statSync(process.env.CODEX_HOME ?? '.').mode & 0o777; } catch { return null; } })(),
}));
/** Requests this server is waiting on, by the id it gave them. */
const pending = new Map();
let nextId = 1;
let cwd = process.cwd();
let turns = 0;
/** One request to the client, resolved when it answers. */
const ask = (method, params) => new Promise((resolve) => {
  const id = 'req-' + nextId++;
  pending.set(id, resolve);
  send({ id, method, params });
});
const note = (kind, answer) => {
  const error = answer && answer.error ? answer.error : null;
  const result = answer && answer.result ? answer.result : null;
  fs.appendFileSync(answerLog, JSON.stringify({
    kind,
    decision: result && typeof result.decision === 'string' ? result.decision
      : result && result.decision ? JSON.stringify(result.decision) : null,
    text: error ? (error.message ?? null)
      : result && Array.isArray(result.contentItems)
        ? result.contentItems.map((item) => item.text ?? '').join('\n')
        : null,
    success: result && typeof result.success === 'boolean' ? result.success : null,
    errorCode: error && typeof error.code === 'number' ? error.code : null,
  }) + '\n');
};
async function runTurn(turnId) {
  let item = 0;
  for (const step of script.steps) {
    const itemId = 'item-' + (item++);
    if (step.kind === 'blank') {
      // A line that is not a message. The real server's stdout carries these
      // between messages and the client is expected to pass over them.
      process.stdout.write('\n');
      continue;
    }
    if (step.kind === 'say') {
      send({ method: 'item/completed', params: { threadId: script.threadId, turnId,
        item: { id: itemId, type: 'agentMessage', text: step.text } } });
      continue;
    }
    if (step.kind === 'fileChange' || step.kind === 'grantRoot') {
      const changes = [{ path: step.path, kind: step.movePath
        ? { type: 'update', move_path: step.movePath }
        : { type: 'add' }, diff: '+' + step.content }];
      send({ method: 'item/started', params: { threadId: script.threadId, turnId, startedAtMs: 1,
        item: { id: itemId, type: 'fileChange', status: 'inProgress', changes } } });
      const answer = await ask('item/fileChange/requestApproval', {
        itemId, threadId: script.threadId, turnId, startedAtMs: 1,
        ...(step.kind === 'grantRoot' ? { grantRoot: step.root } : {}),
      });
      note(step.kind, answer);
      const accepted = answer && answer.result && answer.result.decision === 'accept';
      if (accepted) {
        for (const change of changes) {
          const target = path.resolve(cwd, change.kind.move_path ?? change.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, step.content);
        }
      }
      continue;
    }
    if (step.kind === 'command' || step.kind === 'escalation') {
      const command = step.command;
      const where = step.cwd ? path.resolve(cwd, step.cwd) : cwd;
      send({ method: 'item/started', params: { threadId: script.threadId, turnId, startedAtMs: 1,
        item: { id: itemId, type: 'commandExecution', status: 'inProgress', command, cwd: where,
          commandActions: [] } } });
      const answer = await ask('item/commandExecution/requestApproval', {
        itemId, threadId: script.threadId, turnId, startedAtMs: 1, command, cwd: where,
        ...(step.kind === 'escalation'
          ? { [step.field]: step.value === undefined ? ['echo hello'] : step.value }
          : {}),
      });
      note(step.kind, answer);
      continue;
    }
    if (step.kind === 'itemOnlyCommand') {
      const where = path.resolve(cwd, step.cwd);
      send({ method: 'item/started', params: { threadId: script.threadId, turnId, startedAtMs: 1,
        item: { id: itemId, type: 'commandExecution', status: 'inProgress', command: step.command,
          cwd: where, commandActions: [] } } });
      // The request names the item and nothing else: what is about to run, and
      // where, are on the item the server already announced.
      note(step.kind, await ask('item/commandExecution/requestApproval', {
        itemId, threadId: script.threadId, turnId, startedAtMs: 1 }));
      continue;
    }
    if (step.kind === 'legacyCommand') {
      note(step.kind, await ask('execCommandApproval', { callId: itemId, command: step.command,
        conversationId: script.threadId, cwd, parsedCmd: [] }));
      continue;
    }
    if (step.kind === 'legacyPatch') {
      const fileChanges = {};
      for (const target of step.paths) {
        fileChanges[target] = step.movePath
          ? { type: 'update', unified_diff: '', move_path: step.movePath }
          : { type: 'add', content: 'x' };
      }
      note(step.kind, await ask('applyPatchApproval', { callId: itemId,
        conversationId: script.threadId, fileChanges,
        ...(step.grantRoot ? { grantRoot: step.grantRoot } : {}) }));
      continue;
    }
    if (step.kind === 'unannouncedChange') {
      note(step.kind, await ask('item/fileChange/requestApproval', {
        itemId, threadId: script.threadId, turnId, startedAtMs: 1 }));
      continue;
    }
    if (step.kind === 'commandlessApproval') {
      note(step.kind, await ask('item/commandExecution/requestApproval', {
        threadId: script.threadId, turnId, itemId: 'item-none', cwd: cwd,
      }));
      continue;
    }
    if (step.kind === 'malformed') {
      note(step.kind, await ask(step.method, { itemId: 7 }));
      continue;
    }
    if (step.kind === 'tool') {
      const answer = await ask('item/tool/call', {
        callId: 'call-' + itemId, threadId: script.threadId, turnId,
        tool: step.tool, namespace: null, arguments: step.arguments,
      });
      note(step.kind, answer);
      continue;
    }
    if (step.kind === 'toolNoArguments') {
      // Nothing under an arguments key: a call to a tool that takes no fields
      // is what the server sends this way.
      note(step.kind, await ask('item/tool/call', {
        callId: 'call-' + itemId, threadId: script.threadId, turnId,
        tool: step.tool, namespace: null }));
      continue;
    }
    if (step.kind === 'unknownRequest') {
      const answer = await ask(step.method, { ...step.params, threadId: script.threadId, turnId });
      note(step.kind, answer);
      continue;
    }
  }
  send({ method: 'turn/completed', params: { threadId: script.threadId,
    turn: { id: turnId, status: 'completed' } } });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim().length === 0) return;
  const message = JSON.parse(line);
  fs.appendFileSync(sentLog, line + '\n');
  if (message.id !== undefined && message.method === undefined) {
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
    return;
  }
  if (message.method === 'initialize') {
    fs.writeFileSync(initializeLog, JSON.stringify(message.params ?? {}));
    return send({ id: message.id, result: {} });
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    fs.writeFileSync(openedLog, JSON.stringify({ method: message.method, params: message.params }));
    if (typeof message.params.cwd === 'string') cwd = message.params.cwd;
    const id = message.method === 'thread/resume' ? message.params.threadId : script.threadId;
    return send({ id: message.id, result: { thread: { id }, model: message.params.model ?? 'fake-model',
      modelProvider: 'openai', cwd, approvalPolicy: message.params.approvalPolicy ?? 'untrusted',
      approvalsReviewer: 'user', sandbox: message.params.sandbox ?? 'read-only',
      instructionSources: [] } });
  }
  if (message.method === 'turn/start') {
    const turnId = 'turn-' + (turns++);
    send({ id: message.id, result: { turn: { id: turnId } } });
    void runTurn(turnId);
    return;
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'no ' + message.method } });
});
`,
    { mode: 0o700 },
  );
  const lines = (path: string): Array<Record<string, unknown>> => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  return {
    binary,
    codexHome,
    answers: () => lines(answerLog) as unknown as ServerAnswer[],
    opened: () =>
      JSON.parse(readFileSync(openedLog, "utf8")) as {
        method: string;
        params: Record<string, unknown>;
      },
    initialized: () =>
      JSON.parse(readFileSync(initializeLog, "utf8")) as Record<string, unknown>,
    sent: () => lines(sentLog),
    invocation: () =>
      JSON.parse(readFileSync(invocationLog, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
        home: string[];
        homeMode: number | null;
      },
  };
}
