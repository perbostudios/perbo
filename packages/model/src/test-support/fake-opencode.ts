import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in for `opencode acp` as the reviewer transport meets it: each
 * `session/prompt` answers with the next of `replies` — its words as one
 * message, the session's running dollars where `cost` is given, and how the
 * turn ended. A reply with `permission` has the model reach for its read tool
 * first, as OpenCode 2.0.14 does: the call is announced, then asked about. On
 * `once` the fake runs it — writes a file into the session's directory and
 * logs `executed` — and the turn goes on; on anything else the call fails and
 * the turn ends `cancelled`, as OpenCode ends one a client refused a call in,
 * unless the reply `carriesOn`: then the model answers anyway, and the turn
 * ends with the reply's words and stop reason.
 * A reply with `ran` reports that many tool calls completed that nothing was
 * asked about, each announced under `title` (`read` where none is given), and
 * the last one's completion reported twice. A reply with `error` answers the
 * `session/prompt` with that JSON-RPC error and no turn, as OpenCode answers
 * one whose turn failed.
 * After every prompt the fake logs what the session's directory holds. Every
 * line it receives, and the argv, environment and instructions it was started
 * with, go to `log`. With `exit`, the process ends with code 3 and a line on
 * stderr at the `nth` request of `method`: before answering it, or just after
 * where `answered`. Each `session/new` counted in `refuseSessions`, from 1, is
 * refused as OpenCode refuses one asked for before its catalogue has arrived.
 */
export interface FakeOpenCodeReply {
  text?: string;
  cost?: number;
  stopReason?: string;
  permission?: boolean;
  carriesOn?: boolean;
  ran?: number;
  title?: string;
  usage?: Record<string, number>;
  error?: { code: number; message: string; data?: unknown };
}

export function fakeOpenCodeReviewer(
  replies: readonly FakeOpenCodeReply[],
  options: {
    modes?: readonly string[];
    selects?: string;
    /**
     * How many directories' catalogue snapshots lack every model but one, as a
     * snapshot taken before OpenCode's plugins settle does; a model a
     * directory's snapshot lacks is refused `model not found` there.
     */
    staleSnapshots?: number;
    refuseSessions?: readonly number[];
    exit?: { method: string; nth: number; answered: boolean };
  } = {},
): { binary: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "perbo-fake-opencode-"));
  const log = join(dir, "acp.log");
  const binary = join(dir, "opencode");
  writeFileSync(
    binary,
    [
      `#!${process.execPath}`,
      "const { appendFileSync, readdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const readline = require('node:readline');",
      `const log = ${JSON.stringify(log)};`,
      `const replies = ${JSON.stringify(replies)};`,
      `const modes = ${JSON.stringify(options.modes ?? ["build", "plan"])};`,
      `const selects = ${JSON.stringify(options.selects ?? null)};`,
      `const staleSnapshots = ${JSON.stringify(options.staleSnapshots ?? 0)};`,
      `const refuseSessions = ${JSON.stringify(options.refuseSessions ?? [])}; let sessionsAsked = 0;`,
      "const snapshots = new Map(); const stale = new Map(); let sessions = 0;",
      `const exit = ${JSON.stringify(options.exit ?? null)}; let asked = 0;`,
      "const die = () => { process.stderr.write('opencode crashed\\n'); setTimeout(() => process.exit(3), 20); };",
      "const instructions = (() => { try { return require('node:fs').readFileSync(require('node:path').join(process.env.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md'), 'utf8'); } catch { return null; } })();",
      "appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), instructions }) + '\\n');",
      "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
      "let turn = 0; let pendingPrompt = null; const cwds = new Map();",
      "const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });",
      "const listing = (sessionId) => appendFileSync(log, JSON.stringify({ listing: readdirSync(cwds.get(sessionId)) }) + '\\n');",
      "const finish = (id, reply, sessionId) => {",
      "  if (reply.text !== undefined) send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm' + turn, content: { type: 'text', text: reply.text } } } });",
      "  if (reply.cost !== undefined) send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: reply.cost, currency: 'USD' } } } });",
      "  listing(sessionId);",
      "  send({ id, result: { stopReason: reply.stopReason ?? 'end_turn', usage: reply.usage ?? { inputTokens: 100, outputTokens: 20, cachedReadTokens: 30 } } });",
      "};",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      "  appendFileSync(log, line + '\\n');",
      "  const m = JSON.parse(line);",
      "  const ending = exit !== null && m.method === exit.method && ++asked === exit.nth;",
      "  if (ending && !exit.answered) { die(); return; }",
      "  if (ending) setTimeout(die, 20);",
      "  if (m.method === undefined && m.id === 'ask' && pendingPrompt) {",
      "    const p = pendingPrompt; pendingPrompt = null;",
      "    const chosen = m.result && m.result.outcome && m.result.outcome.optionId;",
      "    if (chosen === 'once' || chosen === 'always') {",
      "      writeFileSync(join(cwds.get(p.sessionId), 'read-ran.txt'), 'the read tool ran');",
      "      appendFileSync(log, JSON.stringify({ executed: 'read' }) + '\\n');",
      "      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't' + turn, status: 'completed' });",
      "      finish(p.id, p.reply, p.sessionId);",
      "    } else {",
      "      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't' + turn, status: 'failed' });",
      "      finish(p.id, p.reply.carriesOn ? p.reply : { usage: p.reply.usage, stopReason: 'cancelled' }, p.sessionId);",
      "    }",
      "    return;",
      "  }",
      "  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } });",
      "  if (m.method === 'session/new' && refuseSessions.includes(++sessionsAsked)) { send({ id: m.id, error: { code: -32603, message: 'Internal error: Internal service failure' } }); return; }",
      "  if (m.method === 'session/new') {",
      "    if (!snapshots.has(m.params.cwd)) snapshots.set(m.params.cwd, snapshots.size < staleSnapshots);",
      "    const id = 'ses_review' + (sessions++ === 0 ? '' : '_' + sessions);",
      "    cwds.set(id, m.params.cwd);",
      "    stale.set(id, snapshots.get(m.params.cwd));",
      "    const models = stale.get(id) ? ['opencode/stale-only'] : ['opencode/big-pickle', 'opencode/claude-opus-5', 'opencode/default'];",
      "    send({ id: m.id, result: { sessionId: id, configOptions: [{ id: 'model', currentValue: models[0], options: models.map((value) => ({ value, name: value })) }, { id: 'mode', options: modes.map((value) => ({ value, name: value })) }] } });",
      "  }",
      "  if (m.method === 'session/delete') send({ id: m.id, result: {} });",
      "  if (m.method === 'session/set_config_option' && stale.get(m.params.sessionId)) { send({ id: m.id, error: { code: -32602, message: 'Invalid params: model not found: ' + m.params.value } }); return; }",
      "  if (m.method === 'session/set_config_option') send({ id: m.id, result: { configOptions: [{ id: 'model', currentValue: selects ?? m.params.value }] } });",
      "  if (m.method === 'session/prompt') {",
      "    const reply = replies[turn++] ?? {};",
      "    const sessionId = m.params.sessionId;",
      "    if (reply.error) { send({ id: m.id, error: reply.error }); return; }",
      "    const ran = reply.ran ?? 0;",
      "    if (reply.permission || ran > 0) {",
      "      update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'r' + turn, content: { type: 'text', text: 'I will read src/a.ts first.' } });",
      "      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't' + turn, title: reply.title ?? 'read', kind: 'read', status: 'pending' });",
      "    }",
      "    for (let call = 0; call < ran; call++) {",
      "      const toolCallId = 't' + turn + (call === 0 ? '' : '_' + call);",
      "      if (call > 0) update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: reply.title ?? 'read', kind: 'read', status: 'pending' });",
      "      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });",
      "      if (call === ran - 1) update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });",
      "    }",
      "    if (reply.permission) { pendingPrompt = { id: m.id, reply, sessionId }; send({ id: 'ask', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't' + turn, title: 'src/a.ts', kind: 'read', rawInput: { filePath: 'src/a.ts' }, locations: [{ path: 'src/a.ts' }] }, options: [] } }); return; }",
      "    finish(m.id, reply, sessionId);",
      "  }",
      "});",
    ].join("\n"),
  );
  chmodSync(binary, 0o755);
  return { binary, log };
}
