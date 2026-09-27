import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in for `opencode acp` as the reviewer transport meets it: each
 * `session/prompt` answers with the next of `replies` — its words as one
 * message, the session's running dollars where `cost` is given, and how the
 * turn ended. A reply that asks for `permission` puts one to the client first;
 * one with `tool` announces a tool call. Every line it receives, and the argv,
 * environment and instructions it was started with, go to `log`.
 */
export interface FakeOpenCodeReply {
  text?: string;
  cost?: number;
  stopReason?: string;
  permission?: boolean;
  tool?: boolean;
  usage?: Record<string, number>;
}

export function fakeOpenCodeReviewer(
  replies: readonly FakeOpenCodeReply[],
  options: { modes?: readonly string[]; selects?: string } = {},
): { binary: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "perbo-fake-opencode-"));
  const log = join(dir, "acp.log");
  const binary = join(dir, "opencode");
  writeFileSync(
    binary,
    [
      `#!${process.execPath}`,
      "const { appendFileSync } = require('node:fs');",
      "const readline = require('node:readline');",
      `const log = ${JSON.stringify(log)};`,
      `const replies = ${JSON.stringify(replies)};`,
      `const modes = ${JSON.stringify(options.modes ?? ["build", "plan"])};`,
      `const selects = ${JSON.stringify(options.selects ?? null)};`,
      "const instructions = (() => { try { return require('node:fs').readFileSync(require('node:path').join(process.env.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md'), 'utf8'); } catch { return null; } })();",
      "appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), instructions }) + '\\n');",
      "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
      "let turn = 0; let pendingPrompt = null;",
      "const finish = (id, reply, sessionId) => {",
      "  if (reply.text !== undefined) send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm' + turn, content: { type: 'text', text: reply.text } } } });",
      "  if (reply.cost !== undefined) send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: reply.cost, currency: 'USD' } } } });",
      "  send({ id, result: { stopReason: reply.stopReason ?? 'end_turn', usage: reply.usage ?? { inputTokens: 100, outputTokens: 20, cachedReadTokens: 30 } } });",
      "};",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      "  appendFileSync(log, line + '\\n');",
      "  const m = JSON.parse(line);",
      "  if (m.method === undefined && m.id === 'ask' && pendingPrompt) { const p = pendingPrompt; pendingPrompt = null; finish(p.id, { ...p.reply, stopReason: 'cancelled' }, p.sessionId); return; }",
      "  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } });",
      "  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'ses_review', configOptions: [{ id: 'model', currentValue: 'opencode/default', options: [] }, { id: 'mode', options: modes.map((value) => ({ value, name: value })) }] } });",
      "  if (m.method === 'session/set_config_option') send({ id: m.id, result: { configOptions: [{ id: 'model', currentValue: selects ?? m.params.value }] } });",
      "  if (m.method === 'session/prompt') {",
      "    const reply = replies[turn++] ?? {};",
      "    const sessionId = m.params.sessionId;",
      "    if (reply.tool) send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'read', kind: 'read', status: 'pending' } } });",
      "    if (reply.permission) { pendingPrompt = { id: m.id, reply, sessionId }; send({ id: 'ask', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't', kind: 'execute', rawInput: { command: 'cat /etc/passwd' } } } }); return; }",
      "    finish(m.id, reply, sessionId);",
      "  }",
      "});",
    ].join("\n"),
  );
  chmodSync(binary, 0o755);
  return { binary, log };
}
