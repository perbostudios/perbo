import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `opencode acp`, faked (D-134).
 *
 * A separate process that speaks the Agent Client Protocol over stdio the way
 * OpenCode 2.0.14 was measured to, and invokes no model. It reads the chat's
 * tool server from the configuration it was started with, connects to it over
 * MCP's HTTP transport and lists the tools as the session opens, as OpenCode
 * does, and plays one script across the session's turns: a message, a file
 * change or a command it asks the client about, and a call to one of the
 * chat's own tools over that server. A refused call ends the turn `cancelled`,
 * as OpenCode ends one; the next turn goes on from the step after it. An
 * admitted file change is performed here, because OpenCode performs it.
 *
 * Every answer goes to a log the test reads, with the argv, the environment
 * and the tools the server listed, so what is asserted is what went over the
 * wire.
 */
export type OpenCodeStep =
  | { kind: "say"; text: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "command"; command: string }
  | { kind: "call"; tool: string; input: Record<string, unknown> }
  /** A call through the tool server without the process's token. */
  | { kind: "tokenless" }
  /** The turn ends here; the next goes on from the step after it. */
  | { kind: "await" };

/** What one step that asked for something was answered with. */
export interface OpenCodeAnswer {
  kind: OpenCodeStep["kind"];
  /** `once` or `reject` for a permission; null for a tool call. */
  decision: string | null;
  /** A tool call's result text. */
  text: string | null;
  isError: boolean | null;
  /** The HTTP status a tool call got. */
  status: number | null;
}

export interface FakeOpenCode {
  binary: string;
  answers(): OpenCodeAnswer[];
  /** The argv, environment, tools listed and turns the fake was sent. */
  seen(): {
    argv: string[];
    env: Record<string, string>;
    instructions: string | null;
    listed: string[];
    prompts: string[];
    resumed: string | null;
    /** The scratch directories a catalogue snapshot was asked for in, in order. */
    scratch: string[];
    /** Every model the chat's own session refused as not found. */
    modelRefused: string[];
    /** Every model the chat's own session was set to. */
    selected: string[];
  };
}

export function fakeOpenCode(options: {
  root: string;
  steps: readonly OpenCodeStep[];
  sessionId: string;
  /** How many `session/resume` requests are refused before one is answered, as OpenCode refuses one on a cold catalogue. */
  refuseResumes?: number;
  /** The primary agents a session reports as its modes; OpenCode's own two where omitted. */
  modes?: readonly string[];
  /**
   * How many directories' catalogue snapshots lack the chat's model, as a
   * snapshot taken before OpenCode's plugins settle does; a model a
   * directory's snapshot lacks is refused `model not found` there.
   */
  staleSnapshots?: number;
  /** The scratch session, counted from 1, at which the process ends with code 3 and a line on stderr, unanswered. */
  exitAtScratch?: number;
}): FakeOpenCode {
  mkdirSync(options.root, { recursive: true });
  const binary = join(options.root, "opencode");
  const log = join(options.root, "fake.log");
  writeFileSync(
    binary,
    String.raw`#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const steps = ${JSON.stringify(options.steps)};
const sessionId = ${JSON.stringify(options.sessionId)};
let refuseResumes = ${JSON.stringify(options.refuseResumes ?? 0)};
const modeOption = { id: 'mode', currentValue: 'build', options: ${JSON.stringify(options.modes ?? ["build", "plan"])}.map((value) => ({ value, name: value })) };
const staleSnapshots = ${JSON.stringify(options.staleSnapshots ?? 0)};
const exitAtScratch = ${JSON.stringify(options.exitAtScratch ?? null)};
const snapshots = new Map(); let staleSession = false; let scratchSessions = 0;
const configOptionsFor = (directory) => {
  if (!snapshots.has(directory)) snapshots.set(directory, snapshots.size < staleSnapshots);
  const models = snapshots.get(directory) ? ['opencode/stale-only'] : ['opencode/big-pickle', 'opencode/claude-opus-5'];
  return [{ id: 'model', currentValue: models[0], options: models.map((value) => ({ value, name: value })) }, modeOption];
};
let connected = false;
// OpenCode 2 writes its database under opencode/ in its data directory as it starts.
if (process.env.XDG_DATA_HOME) { mkdirSync(require('node:path').join(process.env.XDG_DATA_HOME, 'opencode'), { recursive: true }); writeFileSync(require('node:path').join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'), ''); }
const note = (entry) => appendFileSync(log, JSON.stringify(entry) + '\n');
const instructions = (() => { try { return require('node:fs').readFileSync(require('node:path').join(process.env.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md'), 'utf8'); } catch { return null; } })();
note({ started: { argv: process.argv.slice(2), env: process.env, instructions } });
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const server = config.mcp && config.mcp.servers && config.mcp.servers.perbo_interview;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let mcpId = 0;
const mcp = async (method, params, token) => {
  const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token === null ? {} : { authorization: token ?? server.headers.Authorization }) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpId, method, params }) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
};
const connect = async () => {
  if (!server || connected) return;
  connected = true;
  await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
  const listed = await mcp('tools/list', {});
  note({ listed: listed.body.result.tools.map((tool) => tool.name) });
};
let cursor = 0; let next = 1000; let cwd = process.cwd();
const waiting = new Map();
const ask = (toolCall) => new Promise((done) => { const id = next++; waiting.set(id, done); send({ id, method: 'session/request_permission', params: { sessionId, toolCall, options: [] } }); });
const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } });
async function play(id) {
  while (cursor < steps.length) {
    const step = steps[cursor++];
    const callId = 'call-' + cursor;
    if (step.kind === 'await') break;
    if (step.kind === 'say') { update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-' + cursor, content: { type: 'text', text: step.text } }); continue; }
    if (step.kind === 'call' || step.kind === 'tokenless') {
      update({ sessionUpdate: 'tool_call', toolCallId: callId, title: 'perbo_interview_' + (step.tool || 'x'), kind: 'other', status: 'pending', rawInput: {} });
      const result = step.kind === 'call' ? await mcp('tools/call', { name: step.tool, arguments: step.input }) : await mcp('tools/list', {}, null);
      const body = result.body && result.body.result;
      note({ answer: { kind: step.kind, decision: null, text: body ? body.content.map((part) => part.text).join('\n') : null, isError: body ? body.isError === true : null, status: result.status } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: callId, status: body && !body.isError ? 'completed' : 'failed' });
      continue;
    }
    const target = step.kind === 'write' ? resolve(cwd, step.path) : null;
    update({ sessionUpdate: 'tool_call', toolCallId: callId, title: step.kind === 'write' ? 'write' : 'shell', kind: step.kind === 'write' ? 'edit' : 'execute', status: 'pending', rawInput: {} });
    const answer = await ask(step.kind === 'write'
      ? { toolCallId: callId, kind: 'edit', title: target, rawInput: { filePath: target, content: step.content }, locations: [{ path: target }] }
      : { toolCallId: callId, kind: 'execute', title: step.command, rawInput: { command: step.command, cwd } });
    const decision = answer && answer.outcome ? answer.outcome.optionId : null;
    note({ answer: { kind: step.kind, decision, text: null, isError: null, status: null } });
    if (decision !== 'once') { update({ sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'failed' }); send({ id, result: { stopReason: 'cancelled' } }); return; }
    if (target) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, step.content); }
    update({ sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed' });
  }
  send({ id, result: { stopReason: 'end_turn' } });
}
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && waiting.has(m.id)) { const done = waiting.get(m.id); waiting.delete(m.id); done(m.result); return; }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (m.method === 'session/new' && m.params.cwd.includes('catalogue-') && scratchSessions + 1 === exitAtScratch) { note({ scratch: m.params.cwd }); process.stderr.write('opencode crashed\n'); setTimeout(() => process.exit(3), 20); return; }
  if (m.method === 'session/new' && m.params.cwd.includes('catalogue-')) { note({ scratch: m.params.cwd }); send({ id: m.id, result: { sessionId: 'scratch-' + (++scratchSessions), configOptions: configOptionsFor(m.params.cwd) } }); return; }
  if (m.method === 'session/delete') { note({ deleted: m.params.sessionId }); send({ id: m.id, result: {} }); return; }
  if (m.method === 'session/new') { cwd = m.params.cwd; const configOptions = configOptionsFor(cwd); staleSession = configOptions[0].options.length === 1; await connect(); send({ id: m.id, result: { sessionId, configOptions } }); }
  if (m.method === 'session/resume' && refuseResumes > 0) { refuseResumes -= 1; note({ resumeRefused: m.params.sessionId }); send({ id: m.id, error: { code: -32603, message: 'Internal error: Internal service failure' } }); return; }
  if (m.method === 'session/resume') { cwd = m.params.cwd; note({ resumed: m.params.sessionId }); const configOptions = configOptionsFor(cwd); staleSession = configOptions[0].options.length === 1; await connect(); send({ id: m.id, result: { configOptions } }); }
  if (m.method === 'session/set_config_option' && staleSession) { note({ modelRefused: m.params.value }); send({ id: m.id, error: { code: -32602, message: 'Invalid params: model not found: ' + m.params.value } }); return; }
  if (m.method === 'session/set_config_option') { note({ selected: m.params.value }); send({ id: m.id, result: { configOptions: [{ id: 'model', currentValue: m.params.value }] } }); }
  if (m.method === 'session/prompt') { note({ prompt: m.params.prompt[0].text }); void play(m.id); }
});
`,
    "utf8",
  );
  chmodSync(binary, 0o755);
  const entries = (): Array<Record<string, unknown>> =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return {
    binary,
    answers: () => entries().flatMap((entry) => ("answer" in entry ? [entry["answer"] as OpenCodeAnswer] : [])),
    seen: () => {
      const all = entries();
      const started = all.find((entry) => "started" in entry)?.["started"] as
        | { argv: string[]; env: Record<string, string>; instructions: string | null }
        | undefined;
      return {
        argv: started?.argv ?? [],
        env: started?.env ?? {},
        instructions: started?.instructions ?? null,
        listed: (all.find((entry) => "listed" in entry)?.["listed"] as string[] | undefined) ?? [],
        prompts: all.flatMap((entry) => ("prompt" in entry ? [entry["prompt"] as string] : [])),
        resumed: (all.find((entry) => "resumed" in entry)?.["resumed"] as string | undefined) ?? null,
        scratch: all.flatMap((entry) => ("scratch" in entry ? [entry["scratch"] as string] : [])),
        modelRefused: all.flatMap((entry) => ("modelRefused" in entry ? [entry["modelRefused"] as string] : [])),
        selected: all.flatMap((entry) => ("selected" in entry ? [entry["selected"] as string] : [])),
      };
    },
  };
}
