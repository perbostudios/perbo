import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configuredReviewer, probeReviewer } from "./probe.js";

/**
 * `perbo doctor --probe` on the opencode-cli reviewer: one turn through the
 * transport a review would take, against a stand-in for `opencode acp` that
 * answers it the way OpenCode 2.0.14 does, or fails the way a missing model
 * does.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-probe-opencode-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fake(answer: "verdict" | "refuses"): string {
  const binary = join(mkdtempSync(join(scratch, "bin-")), "opencode");
  writeFileSync(
    binary,
    `#!${process.execPath}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's', configOptions: [{ id: 'model', options: [{ value: 'opencode/big-pickle' }, { value: 'opencode/nope' }] }] } });
  if (m.method === 'session/delete') send({ id: m.id, result: {} });
  if (m.method === 'session/set_config_option') send({ id: m.id, result: { configOptions: [{ id: 'model', currentValue: m.params.value }] } });
  if (m.method === 'session/prompt') {
    if (${JSON.stringify(answer)} === 'refuses') { send({ id: m.id, error: { code: -32000, message: 'Model not found: opencode/nope' } }); return; }
    send({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: JSON.stringify({ next: 'submit_review', read_paths: [], review: { ok: true } }) } } } });
    send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 1 } } });
  }
});
`,
  );
  chmodSync(binary, 0o755);
  return binary;
}

describe("the reviewer probe on OpenCode", () => {
  it("answers ok where one turn through the transport comes back with a verdict", async () => {
    const result = await probeReviewer({
      provider: "opencode-cli",
      model: "opencode/big-pickle",
      binary: fake("verdict"),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result).toMatchObject({ ok: true, provider: "opencode-cli", model: "opencode/big-pickle" });
  });

  it("says what to do where OpenCode refuses the model", async () => {
    const result = await probeReviewer({
      provider: "opencode-cli",
      model: "opencode/nope",
      binary: fake("refuses"),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fix).toMatch(/opencode models|OPENCODE_API_KEY|OpenCode/);
  });

  it("reads opencode-cli as a reviewer a repository pinned", () => {
    expect(configuredReviewer({ reviewer_provider: "opencode-cli" }, { provider: "claude-cli", model: "m" })).toMatchObject({
      provider: "opencode-cli",
      keys: ["reviewer_provider"],
    });
  });
});
