import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openCodeCliModel } from "./opencode.js";
import { expectGolden } from "./test-support/golden.js";
import { fakeOpenCodeReviewer } from "./test-support/fake-opencode.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./test-support/spawn-timeout.js";

/**
 * What the opencode-cli transport hands OpenCode over one session: the argv,
 * the configuration and the instructions it starts it with, and every
 * JSON-RPC request of the handshake, the session and its two turns. The
 * directories minted per run are recorded as placeholders.
 */

const submitSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

const request = {
  system: "system prompt",
  messages: [{ role: "user" as const, content: "the context" }],
  forceSubmit: false,
};

function normalise(text: string): string {
  return text.replace(/"[^"]*perbo-opencode-review-[A-Za-z0-9]+([^"]*)"/g, '"<root>$1"');
}

describe("the requests the opencode-cli transport sends", () => {
  it(
    "are the ones recorded",
    async () => {
      const fake = fakeOpenCodeReviewer([
        { text: JSON.stringify({ next: "read_files", read_paths: ["a/b.ts"], review: null }) },
        { text: JSON.stringify({ next: "submit_review", read_paths: [], review: { ok: true } }) },
      ]);
      const model = openCodeCliModel({ submitSchema, binary: fake.binary });
      expect((await model.turn(request)).toolCalls.map((call) => call.name)).toEqual(["read_file"]);
      const second = await model.turn({
        ...request,
        messages: [
          ...request.messages,
          { role: "assistant" as const, content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a/b.ts" } }] },
          { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "t1", content: "the file" }] },
        ],
        forceSubmit: true,
      });
      expect(second.toolCalls.map((call) => call.name)).toEqual(["submit_review"]);
      const [started, ...lines] = readFileSync(fake.log, "utf8").split("\n").filter(Boolean);
      const start = JSON.parse(started!) as { argv: string[]; env: Record<string, string>; instructions: string };
      expectGolden(new URL("./opencode.golden.json", import.meta.url), [
        {
          argv: start.argv,
          config: JSON.parse(start.env["OPENCODE_CONFIG_CONTENT"]!) as unknown,
          project_config_off: start.env["OPENCODE_DISABLE_PROJECT_CONFIG"],
          instructions: start.instructions,
        },
        ...lines.map((line) => JSON.parse(normalise(line)) as unknown),
      ]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
