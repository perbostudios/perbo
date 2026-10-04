import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicModel, claudeCliModel, codexCliModel, type Model } from "@perbo/model";

/**
 * Each transport that carries a schema, built for real over a provider that
 * refuses the request it is sent, each in its own structured way: the API's
 * HTTP 400 `invalid_request_error`, Claude Code's result envelope with
 * `api_error_status` 400, and Codex's failed turn with `codexErrorInfo`
 * `badRequest` and the Responses API's `invalid_json_schema` in its words.
 * Nothing reaches a provider: the API's `fetch` is a double, and the two
 * binaries are scripts in a directory of this test's own.
 *
 * OpenCode is not here: its ACP carries no schema, and its transport's
 * classification is its own module's to test.
 */
export type RefusingTransport = "anthropic" | "claude-cli" | "codex-cli";

export const REFUSING_TRANSPORTS: readonly RefusingTransport[] = ["anthropic", "claude-cli", "codex-cli"];

const dir = mkdtempSync(join(tmpdir(), "perbo-refusing-"));

const CLAUDE = join(dir, "claude.sh");
writeFileSync(
  CLAUDE,
  [
    "#!/bin/sh",
    "cat >/dev/null",
    `echo '{"type":"result","is_error":true,"api_error_status":400,"result":"API Error: 400 invalid_request_error"}'`,
    "exit 1",
    "",
  ].join("\n"),
);
chmodSync(CLAUDE, 0o755);

const CODEX = join(dir, "codex.mjs");
writeFileSync(
  CODEX,
  [
    "#!/usr/bin/env node",
    "import readline from 'node:readline';",
    "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') send({ id: message.id, result: {} });",
    "  if (message.method === 'thread/start')",
    "    send({ id: message.id, result: { thread: { id: 'thr_1' }, model: message.params.model, instructionSources: [] } });",
    "  if (message.method === 'turn/start') {",
    "    send({ id: message.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });",
    "    send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'failed', error: {",
    "      message: \"invalid_json_schema: Invalid schema for response_format: Missing 'requirement_id'\",",
    "      codexErrorInfo: 'badRequest' } } } });",
    "  }",
    "});",
    "",
  ].join("\n"),
);
chmodSync(CODEX, 0o755);

const CODEX_HOME = join(dir, "codex-home");
mkdirSync(CODEX_HOME, { recursive: true });
writeFileSync(join(CODEX_HOME, "auth.json"), "{}");

/** A home of this test's own, so Claude Code's session store is never the person's. */
const HOME = join(dir, "home");
mkdirSync(HOME, { recursive: true });

/** Removes the scripts and homes above; for a test file's `afterAll`. */
export function removeRefusingTransports(): void {
  rmSync(dir, { recursive: true, force: true });
}

/** The transport, over a provider that refuses whatever `submitSchema` it is sent. */
export function refusingModel(transport: RefusingTransport, submitSchema: Record<string, unknown>): Model {
  switch (transport) {
    case "anthropic":
      // The SDK will not build a client without a key; this one reaches no API.
      process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-not-a-real-key";
      return anthropicModel({
        submitSchema,
        maxRetries: 0,
        fetch: async () =>
          new Response(
            JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "tools.0.input_schema: invalid" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      });
    case "claude-cli":
      return claudeCliModel({ submitSchema, binary: CLAUDE, env: { PATH: process.env.PATH ?? "", HOME } });
    case "codex-cli":
      return codexCliModel({ submitSchema, binary: CODEX, codexHome: CODEX_HOME, modelId: "gpt-test" });
  }
}
