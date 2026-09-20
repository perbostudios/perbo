import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { codexCliModel } from "../src/provider-codex-cli.js";
import { expectGolden } from "./golden.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./spawn-timeout.js";

/**
 * Every JSON-RPC request the codex-cli transport sends over one thread: the
 * handshake, the thread it starts and the two turns it takes on it.
 *
 * The fake app-server answers as Codex does and appends each line it received
 * to a log, so what is recorded is what the process was actually told. The
 * isolated home and the scratch directory are minted per run and are recorded
 * as placeholders.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-codex-golden-"));
const authHome = join(scratch, "auth-home");
mkdirSync(authHome, { recursive: true });
writeFileSync(join(authHome, "auth.json"), "{}");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const submitSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

const log = join(scratch, "rpc.log");

function fakeCodex(turns: unknown[]): string {
  const path = join(scratch, "fake-codex.mjs");
  const script = [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    "import readline from 'node:readline';",
    "const log = " + JSON.stringify(log) + ";",
    "const turns = " + JSON.stringify(turns) + ";",
    "let turn = 0;",
    "appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');",
    "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "const lines = readline.createInterface({ input: process.stdin });",
    "lines.on('line', (line) => {",
    "  appendFileSync(log, line + '\\n');",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') {",
    "    send({ id: message.id, result: { userAgent: 'fake' } });",
    "    return;",
    "  }",
    "  if (message.method === 'thread/start') {",
    "    send({ id: message.id, result: { thread: { id: 'thr_1' }, model: message.params.model, instructionSources: [] } });",
    "    return;",
    "  }",
    "  if (message.method === 'turn/start') {",
    "    const id = 'turn_' + (turn + 1);",
    "    const selected = turns[turn] ?? null;",
    "    turn += 1;",
    "    send({ id: message.id, result: { turn: { id, status: 'inProgress' } } });",
    "    send({ method: 'item/completed', params: { turnId: id, item: { type: 'agentMessage', text: JSON.stringify(selected) } } });",
    "    send({ method: 'thread/tokenUsage/updated', params: { turnId: id, tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 10, outputTokens: 20 } } } });",
    "    send({ method: 'turn/completed', params: { turn: { id, status: 'completed', error: null } } });",
    "  }",
    "});",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/** The directories the transport mints per run, as fixed text. */
function normalise(text: string): string {
  return text
    .replace(/"[^"]*perbo-codex-review-[A-Za-z0-9]+"/g, '"<scratch>"')
    .replace(/"[^"]*perbo-codex-home-[A-Za-z0-9]+"/g, '"<codex-home>"');
}

const request = {
  system: "system prompt",
  messages: [{ role: "user" as const, content: "the context" }],
  forceSubmit: false,
};

describe("the requests the codex-cli transport sends", () => {
  it(
    "are the ones recorded",
    async () => {
      const model = codexCliModel({
        submitSchema,
        binary: fakeCodex([
          { next: "read_files", read_paths: ["a/b.ts"], review: null },
          { next: "submit_review", read_paths: [], review: { ok: true } },
        ]),
        codexHome: authHome,
      });
      const first = await model.turn(request);
      expect(first.toolCalls.map((call) => call.name)).toEqual(["read_file"]);
      const second = await model.turn({
        ...request,
        messages: [
          ...request.messages,
          {
            role: "assistant" as const,
            content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a/b.ts" } }],
          },
          {
            role: "user" as const,
            content: [{ type: "tool_result", tool_use_id: "t1", content: "the file" }],
          },
        ],
        forceSubmit: true,
      });
      expect(second.toolCalls.map((call) => call.name)).toEqual(["submit_review"]);

      expectGolden(
        new URL("./codex-cli.golden.json", import.meta.url),
        readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(normalise(line)) as unknown),
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
