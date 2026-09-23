import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anthropicModel } from "./anthropic.js";

/**
 * The SDK transport's error accounting. A fake `fetch` stands in for the
 * network: what is under test is what the transport reports about a failure,
 * not the model.
 */

const request = {
  system: "system prompt",
  messages: [{ role: "user" as const, content: "the context" }],
  forceSubmit: false,
};

const apiError = (status: number) =>
  new Response(
    JSON.stringify({ type: "error", error: { type: "api_error", message: `status ${status}` } }),
    { status, headers: { "content-type": "application/json" } },
  );

let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousKey;
});

describe("the anthropic transport's attempt count", () => {
  it("reports the requests actually made, not the retry budget", async () => {
    let calls = 0;
    const model = anthropicModel({
      submitSchema: { type: "object" },
      maxRetries: 3,
      fetch: async () => {
        calls += 1;
        // A 400 is never retried, so one request is the whole story.
        return apiError(400);
      },
    });
    await expect(model.turn(request)).rejects.toMatchObject({
      name: "ProviderError",
      attempts: 1,
      kind: "provider_unavailable",
    });
    expect(calls).toBe(1);
  });

  it("counts every retry the SDK made", async () => {
    let calls = 0;
    const model = anthropicModel({
      submitSchema: { type: "object" },
      maxRetries: 1,
      fetch: async () => {
        calls += 1;
        return apiError(500);
      },
    });
    await expect(model.turn(request)).rejects.toMatchObject({ attempts: 2 });
    expect(calls).toBe(2);
  }, 20_000);
});
