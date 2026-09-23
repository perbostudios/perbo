import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL } from "./defaults.js";
import { MODEL_PROVIDERS, createModel } from "./provider.js";

/**
 * The one provider → transport choice. It was written out four times, and a
 * fourth copy is how a provider gets added to three of them.
 */

const submitSchema = { type: "object" };

const DEFAULTS: Record<(typeof MODEL_PROVIDERS)[number], string> = {
  anthropic: DEFAULT_CLAUDE_MODEL,
  "claude-cli": DEFAULT_CLAUDE_MODEL,
  "codex-cli": DEFAULT_CODEX_MODEL,
};

let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousKey;
});

describe("createModel", () => {
  it("names three providers, and builds the transport each one names", () => {
    expect([...MODEL_PROVIDERS]).toEqual(["anthropic", "claude-cli", "codex-cli"]);
    for (const provider of MODEL_PROVIDERS) {
      expect(createModel(provider, { submitSchema }).provider).toBe(provider);
    }
  });

  it("leaves the transport's own default where no model is named", () => {
    // `null` is what a configuration file carries for "unset" and `""` is what
    // an empty flag gives; neither is a model id.
    for (const provider of MODEL_PROVIDERS) {
      for (const modelId of [undefined, null, ""] as const) {
        expect(createModel(provider, { submitSchema, modelId }).model_id, provider).toBe(
          DEFAULTS[provider],
        );
      }
    }
  });

  it("uses the model it is given", () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(createModel(provider, { submitSchema, modelId: "a-named-model" }).model_id).toBe(
        "a-named-model",
      );
    }
  });
});

describe("createModel's effort", () => {
  it("builds a transport for an effort its provider takes, and for none", () => {
    expect(createModel("codex-cli", { submitSchema, effort: "ultra" }).provider).toBe("codex-cli");
    expect(createModel("claude-cli", { submitSchema, effort: "xhigh" }).provider).toBe("claude-cli");
    expect(createModel("anthropic", { submitSchema, effort: null }).provider).toBe("anthropic");
  });

  it("refuses an effort its provider does not take rather than send it", () => {
    expect(() => createModel("claude-cli", { submitSchema, effort: "ultra" })).toThrow(
      /claude-cli takes low, medium, high, xhigh, max, not ultra/,
    );
    expect(() => createModel("anthropic", { submitSchema, effort: "ultra" })).toThrow(/anthropic takes/);
  });
});
