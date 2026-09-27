import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in for `opencode acp`, answering the Agent Client Protocol the way
 * OpenCode 2.0.14 was measured to (D-134).
 *
 * Each `session/prompt` plays the next entry of `turns`, in order. A `say` is
 * an `agent_message_chunk` of the message it names; a `call` announces a tool
 * call as OpenCode does before it asks; an `ask` is a
 * `session/request_permission` the fake waits on — answered `once`, it reports
 * the call completed and goes on; answered anything else, it reports the call
 * failed and ends the turn `cancelled`, as OpenCode ends a turn a client
 * refused a call in, unless the step says to ignore the answer and report the
 * call completed anyway; `$CWD` in a location stands for the directory the
 * session was opened in. `ran` reports a call completed that nothing asked about;
 * `cost` is a `usage_update` carrying the session's running dollars.
 *
 * Every line the fake receives, its argv and its environment are appended to
 * the log, so a test reads what the client actually sent.
 */
export type FakeOpenCodeStep =
  | { say: string; message?: string }
  | { call: string; title: string; kind: string }
  | {
      ask: string;
      kind: string;
      title?: string;
      rawInput?: Record<string, unknown>;
      locations?: string[];
      /** Report the call completed whatever the client answered, as a session that ignores its answers would. */
      ignoreAnswer?: boolean;
    }
  | { ran: string; title: string; kind: string }
  | { cost: number };

export interface FakeOpenCodeScript {
  /** The modes `session/new` reports; OpenCode's own two where omitted. */
  modes?: readonly string[];
  /**
   * How many directories' catalogue snapshots lack the model, as a snapshot
   * taken before OpenCode's plugins settle does. OpenCode takes one snapshot a
   * directory, at its first session, and keeps it: a model its snapshot lacks
   * is refused `model not found` there however often it is asked for.
   */
  staleSnapshots?: number;
  /** The `session/new`, counted from 1, at which the process ends with code 3 and a line on stderr, unanswered. */
  exitAtSession?: number;
  /** The `session/new`, counted from 1, just after answering which the process ends the same way. */
  exitAfterSession?: number;
  /** Each `session/new`, counted from 1, refused as OpenCode refuses one asked for before its catalogue has arrived. */
  refuseSessions?: readonly number[];
  /** Each turn's steps, and how it ends where nothing refused it. */
  turns: ReadonlyArray<{ steps: readonly FakeOpenCodeStep[]; stop?: string; usage?: Record<string, number> }>;
}

export interface FakeOpenCode {
  binary: string;
  log: string;
  /** Every JSON line the fake received, parsed. */
  received(): Array<Record<string, unknown>>;
  /** The environment and argv the fake was started with as an ACP server. */
  started(): { argv: string[]; env: Record<string, string>; cwd: string };
}

export function fakeOpenCode(root: string, script: FakeOpenCodeScript): FakeOpenCode {
  const binary = join(root, "opencode-fixture");
  const log = join(root, "opencode-fixture.log");
  writeFileSync(
    binary,
    String.raw`#!${process.execPath}
const { appendFileSync } = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const script = ${JSON.stringify(script)};
appendFileSync(log, JSON.stringify({ started: { argv: process.argv.slice(2), env: process.env, cwd: process.cwd() } }) + '\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
let next = 1000;
const waiting = new Map();
const ask = (params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method: 'session/request_permission', params }); });
let turn = 0; let cwd = '';
const snapshots = new Map(); const stale = new Map(); let sessions = 0; let asked = 0;
const crash = () => { process.stderr.write('opencode crashed\n'); setTimeout(() => process.exit(3), 20); };
async function play(id, sessionId) {
  const entry = script.turns[turn++] ?? { steps: [] };
  for (const step of entry.steps) {
    if ('say' in step) update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: step.message ?? 'm' + turn, content: { type: 'text', text: step.say } });
    if ('call' in step) update(sessionId, { sessionUpdate: 'tool_call', toolCallId: step.call, title: step.title, kind: step.kind, status: 'pending', rawInput: {} });
    if ('ran' in step) {
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: step.ran, title: step.title, kind: step.kind, status: 'pending', rawInput: {} });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: step.ran, status: 'completed' });
    }
    if ('cost' in step) update(sessionId, { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: step.cost, currency: 'USD' } });
    if ('ask' in step) {
      const answer = await ask({ sessionId, toolCall: { toolCallId: step.ask, title: step.title ?? step.kind, kind: step.kind, status: 'pending', rawInput: step.rawInput ?? {}, locations: (step.locations ?? []).map((path) => ({ path: path.replace('$CWD', cwd) })) }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] });
      const chosen = answer && answer.outcome && answer.outcome.optionId;
      if (chosen !== 'once' && chosen !== 'always' && !step.ignoreAnswer) {
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: step.ask, status: 'failed' });
        send({ id, result: { stopReason: 'cancelled', usage: entry.usage } });
        return;
      }
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: step.ask, status: 'completed' });
    }
  }
  send({ id, result: { stopReason: entry.stop ?? 'end_turn', usage: entry.usage } });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(log, line + '\n');
  const m = JSON.parse(line);
  if (m.method === undefined && waiting.has(m.id)) { const resolve = waiting.get(m.id); waiting.delete(m.id); resolve(m.result); return; }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === 'session/new') asked += 1;
  if (m.method === 'session/new' && asked === script.exitAfterSession) crash();
  if (m.method === 'session/new' && asked === script.exitAtSession) { crash(); return; }
  if (m.method === 'session/new' && (script.refuseSessions ?? []).includes(asked)) { send({ id: m.id, error: { code: -32603, message: 'Internal error: Internal service failure' } }); return; }
  if (m.method === 'session/new') {
    cwd = m.params.cwd;
    if (!snapshots.has(cwd)) snapshots.set(cwd, snapshots.size < (script.staleSnapshots ?? 0) ? 'stale' : 'settled');
    const id = 'ses_' + (++sessions);
    stale.set(id, snapshots.get(cwd) === 'stale');
    const models = stale.get(id) ? ['opencode/stale-only'] : ['opencode/big-pickle', 'opencode/claude-opus-5'];
    send({ id: m.id, result: { sessionId: id, configOptions: [{ id: 'model', currentValue: models[0], options: models.map((value) => ({ value, name: value })) }, { id: 'mode', currentValue: 'build', options: (script.modes ?? ['build', 'plan']).map((value) => ({ value, name: value })) }] } });
  }
  if (m.method === 'session/delete') send({ id: m.id, result: {} });
  if (m.method === 'session/set_config_option') {
    if (stale.get(m.params.sessionId)) send({ id: m.id, error: { code: -32602, message: 'Invalid params: model not found: ' + m.params.value } });
    else send({ id: m.id, result: { configOptions: [{ id: 'model', currentValue: m.params.value }] } });
  }
  if (m.method === 'session/prompt') void play(m.id, m.params.sessionId);
});
`,
    "utf8",
  );
  chmodSync(binary, 0o755);
  const lines = (): Array<Record<string, unknown>> =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return {
    binary,
    log,
    received: () => lines().filter((line) => !("started" in line)),
    started: () => {
      // The adapter asks `--version` first, for the record's fingerprint.
      const served = lines().find(
        (line) => "started" in line && (line["started"] as { argv: string[] }).argv[0] === "acp",
      );
      if (served === undefined) throw new Error("the fake OpenCode was never started as an ACP server");
      return served["started"] as { argv: string[]; env: Record<string, string>; cwd: string };
    },
  };
}
