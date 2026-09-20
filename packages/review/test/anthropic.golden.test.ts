import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anthropicModel, type AnthropicModelOptions } from "../src/provider.js";
import { expectGolden } from "./golden.js";

/**
 * The bytes the SDK transport puts on the wire.
 *
 * A capturing `fetch` records the request and answers 400, so the turn rejects
 * once the body has been built and nothing reaches a provider. Headers are not
 * recorded: the SDK versions its own, and they are not this repository's to
 * promise.
 */

const submitSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

const messages = [
  { role: "user" as const, content: "the context" },
  {
    role: "assistant" as const,
    content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a/b.ts" } }],
  },
  {
    role: "user" as const,
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "refused", is_error: true },
    ],
  },
];

interface Capture {
  url: string;
  method: string;
  body: unknown;
}

async function capture(
  options: Omit<AnthropicModelOptions, "submitSchema" | "fetch">,
  forceSubmit: boolean,
): Promise<Capture> {
  const seen: Capture[] = [];
  const model = anthropicModel({
    submitSchema,
    ...options,
    fetch: async (input, init) => {
      seen.push({
        url: input instanceof Request ? input.url : String(input),
        method: String(init?.method ?? "POST"),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "status 400" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
  });
  await expect(model.turn({ system: "S", messages, forceSubmit })).rejects.toThrow();
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousKey;
});

describe("the request the anthropic transport builds", () => {
  it("is the one recorded", async () => {
    expectGolden(new URL("./anthropic.golden.json", import.meta.url), {
      default: await capture({}, false),
      forced: await capture({}, true),
      overridden: await capture(
        { modelId: "claude-sonnet-5", maxTokens: 8000, effort: "max" },
        false,
      ),
    });
  });
});
