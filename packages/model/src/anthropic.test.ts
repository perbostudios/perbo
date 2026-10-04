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

const apiError = (status: number, type = "api_error") =>
  new Response(
    JSON.stringify({ type: "error", error: { type, message: `status ${status}` } }),
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
      kind: "request_refused",
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

describe("a request the API refuses", () => {
  it("is request_refused, read from the status and the body's type, and asked once", async () => {
    let calls = 0;
    const model = anthropicModel({
      submitSchema: { type: "object" },
      maxRetries: 3,
      fetch: async () => {
        calls += 1;
        return apiError(400, "invalid_request_error");
      },
    });
    await expect(model.turn(request)).rejects.toMatchObject({ name: "ProviderError", kind: "request_refused" });
    expect(calls).toBe(1);
  });

  it("is not a provider that could not serve: an overload stays provider_unavailable", async () => {
    const model = anthropicModel({
      submitSchema: { type: "object" },
      maxRetries: 0,
      fetch: async () => apiError(529, "overloaded_error"),
    });
    await expect(model.turn(request)).rejects.toMatchObject({ kind: "provider_unavailable" });
  });
});
