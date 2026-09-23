import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { codexCliModel } from "./codex-cli.js";
import { ProviderError } from "./failure.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./test-support/spawn-timeout.js";
import { READ_FILE_TOOL, SUBMIT_REVIEW_TOOL } from "./turn.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-codex-provider-test-"));
const authHome = join(scratch, "auth-home");
mkdirSync(authHome, { recursive: true });
writeFileSync(join(authHome, "auth.json"), "{}");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function fakeCodex(
  turns: Array<{
    structured: unknown;
    status?: string;
    error?: string;
    rerouteTo?: string;
  }>,
  instructionSources: string[] = [],
  threadModel = "gpt-5.6-terra",
): string {
  counter += 1;
  const path = join(scratch, "fake-codex-" + counter + ".mjs");
  const script = [
    "#!/usr/bin/env node",
    "import { existsSync, realpathSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import readline from 'node:readline';",
    "const turns = " + JSON.stringify(turns) + ";",
    "const instructionSources = " + JSON.stringify(instructionSources) + ";",
    "const threadModel = " + JSON.stringify(threadModel) + ";",
    "const callerCwd = " + JSON.stringify(process.cwd()) + ";",
    "let turn = 0;",
    "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "const lines = readline.createInterface({ input: process.stdin });",
    "lines.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') {",
    "    if (message.params.capabilities?.experimentalApi !== true || message.params.capabilities?.requestAttestation !== false) {",
    "      send({ id: message.id, error: { code: -1, message: 'required client capabilities missing' } });",
    "      return;",
    "    }",
    "    send({ id: message.id, result: { userAgent: 'fake' } });",
    "    return;",
    "  }",
    "  if (message.method === 'thread/start') {",
    "    const argv = process.argv.slice(2);",
    "    const isolated = argv.includes('shell_tool') && argv.includes('unified_exec') &&",
    "      argv.includes('agents.enabled=false') && argv.includes('app-server') &&",
    "      realpathSync(message.params.cwd) === process.cwd() &&",
    "      realpathSync(message.params.cwd) !== realpathSync(callerCwd) &&",
    "      message.params.ephemeral === true && message.params.allowProviderModelFallback === false &&",
    "      message.params.baseInstructions === 'system prompt' &&",
    "      message.params.approvalPolicy === 'never' && message.params.sandbox === 'read-only' &&",
    "      Array.isArray(message.params.environments) && message.params.environments.length === 0 &&",
    "      Array.isArray(message.params.dynamicTools) && message.params.dynamicTools.length === 0 &&",
    "      Array.isArray(message.params.selectedCapabilityRoots) && message.params.selectedCapabilityRoots.length === 0 &&",
    "      Array.isArray(message.params.runtimeWorkspaceRoots) &&",
    "      existsSync(join(process.env.CODEX_HOME ?? '', 'auth.json')) &&",
    "      process.env.CODEX_THREAD_ID === undefined &&",
    "      process.env.PERBO_TEST_LEAK === undefined;",
    "    if (!isolated) {",
    "      send({ id: message.id, error: { code: -1, message: 'reviewer was not isolated' } });",
    "      return;",
    "    }",
    "    send({ id: message.id, result: { thread: { id: 'thr_1' }, model: threadModel, instructionSources } });",
    "    return;",
    "  }",
    "  if (message.method === 'turn/start') {",
    "    const id = 'turn_' + (turn + 1);",
    "    const selected = turns[turn] ?? { structured: null, status: 'failed', error: 'no turn' };",
    "    turn += 1;",
    "    const isolated = realpathSync(message.params.cwd) === process.cwd() &&",
    "      message.params.approvalPolicy === 'never' &&",
    "      message.params.sandboxPolicy?.type === 'readOnly' &&",
    "      message.params.sandboxPolicy?.networkAccess === false &&",
    "      Array.isArray(message.params.environments) && message.params.environments.length === 0 &&",
    "      message.params.model === 'gpt-5.6-terra' && message.params.effort === 'medium' &&",
    "      message.params.input?.[0]?.type === 'text' &&",
    "      Array.isArray(message.params.input?.[0]?.text_elements) &&",
    "      typeof message.params.outputSchema === 'object';",
    "    if (!isolated) {",
    "      send({ id: message.id, error: { code: -1, message: 'turn was not isolated' } });",
    "      return;",
    "    }",
    "    send({ id: message.id, result: { turn: { id, status: 'inProgress' } } });",
    "    if (selected.structured !== null) {",
    "      send({ method: 'item/completed', params: { turnId: id, item: { type: 'agentMessage', text: JSON.stringify(selected.structured) } } });",
    "    }",
    "    send({ method: 'thread/tokenUsage/updated', params: { turnId: id, tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 10, outputTokens: 20 } } } });",
    "    if (selected.rerouteTo) {",
    "      send({ method: 'model/rerouted', params: { threadId: 'thr_1', turnId: id, fromModel: 'gpt-5.6-terra', toModel: selected.rerouteTo, reason: 'modelUnavailable' } });",
    "    }",
    "    send({ method: 'turn/completed', params: { turn: { id, status: selected.status ?? 'completed', error: selected.error ? { message: selected.error } : null } } });",
    "  }",
    "});",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const request = {
  system: "system prompt",
  messages: [{ role: "user" as const, content: "the context" }],
  forceSubmit: false,
};

const review = {
  coverage: [],
  findings: [],
  check_assertions: [],
  overall_confidence: 0.9,
};

describe("the codex-cli transport", () => {
  it("isolates Codex and maps constrained output onto the review tool contract", async () => {
    const previous = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = "must-not-leak";
    // Not a Codex variable at all: the environment is an allow-list, so an
    // unlisted name is dropped whatever its prefix.
    process.env.PERBO_TEST_LEAK = "must-not-leak";
    try {
      const model = codexCliModel({
        submitSchema: { type: "object" },
        binary: fakeCodex([
          {
            structured: {
              next: "submit_review",
              read_paths: [],
              review,
            },
          },
        ]),
        codexHome: authHome,
      });
      const result = await model.turn(request);
      expect(model.provider).toBe("codex-cli");
      expect(model.model_id).toBe("gpt-5.6-terra");
      expect(model.unreported_cost_basis).toBe("unavailable");
      expect(result.toolCalls).toEqual([
        { id: "cli_submit", name: SUBMIT_REVIEW_TOOL, input: review },
      ]);
      expect(result.usage).toEqual({
        input_tokens: 60,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
      });
      expect(result.reported_cost_micros).toBeUndefined();
    } finally {
      delete process.env.PERBO_TEST_LEAK;
      if (previous === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previous;
    }
  });

  it("keeps the thread open when the model says submit_review but submits nothing", async () => {
    // With the thread closed after the first turn, the second turn would start a
    // fresh process whose scripted turns begin again at the first: the same
    // empty submit. Only a thread that stayed open reaches the second script.
    const model = codexCliModel({
      submitSchema: { type: "object" },
      binary: fakeCodex([
        { structured: { next: "submit_review", read_paths: [], review: null } },
        { structured: { next: "submit_review", read_paths: [], review } },
      ]),
      codexHome: authHome,
    });
    const first = await model.turn(request);
    expect(first.toolCalls).toEqual([]);
    const second = await model.turn(request);
    expect(second.toolCalls.map((call) => call.name)).toEqual([SUBMIT_REVIEW_TOOL]);
  });

  it("maps read requests without exposing Codex file or shell tools", async () => {
    const model = codexCliModel({
      submitSchema: { type: "object" },
      binary: fakeCodex([
        {
          structured: {
            next: "read_files",
            read_paths: ["a/b.ts", "a/c.ts"],
            review: null,
          },
        },
        {
          structured: {
            next: "submit_review",
            read_paths: [],
            review,
          },
        },
      ]),
      codexHome: authHome,
    });
    const result = await model.turn(request);
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      READ_FILE_TOOL,
      READ_FILE_TOOL,
    ]);
    expect(result.toolCalls.map((call) => call.input)).toEqual([
      { path: "a/b.ts" },
      { path: "a/c.ts" },
    ]);
    await model.turn({ ...request, forceSubmit: true });
  });

  it("fails closed when the isolated thread reports an instruction source", async () => {
    const model = codexCliModel({
      submitSchema: { type: "object" },
      binary: fakeCodex([], ["/repo/AGENTS.md"]),
      codexHome: authHome,
    });
    await expect(model.turn(request)).rejects.toThrow(/loaded instruction files/);
  });

  it("fails closed when Codex starts or reroutes to a different model", async () => {
    const wrongAtStart = codexCliModel({
      submitSchema: { type: "object" },
      binary: fakeCodex([], [], "gpt-5.6-luna"),
      codexHome: authHome,
    });
    await expect(wrongAtStart.turn(request)).rejects.toThrow(/instead of registered/);

    const rerouted = codexCliModel({
      submitSchema: { type: "object" },
      binary: fakeCodex([
        {
          structured: { next: "submit_review", read_paths: [], review },
          rerouteTo: "gpt-5.6-luna",
        },
      ]),
      codexHome: authHome,
    });
    await expect(rerouted.turn(request)).rejects.toThrow(/rerouted the registered model/);
  });

  it("reports an unavailable credential before starting a model turn", async () => {
    const model = codexCliModel({
      submitSchema: { type: "object" },
      binary: fakeCodex([]),
      codexHome: join(scratch, "missing-auth"),
    });
    await expect(model.turn(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it("maps an upstream usage limit to budget exhaustion", async () => {
    const model = codexCliModel({
      submitSchema: { type: "object" },
      binary: fakeCodex([
        { structured: null, status: "failed", error: "UsageLimitExceeded" },
      ]),
      codexHome: authHome,
    });
    await expect(model.turn(request)).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
  });
}, SPAWN_TEST_TIMEOUT_MS);
