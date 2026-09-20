import { anthropicModel } from "./anthropic.js";
import { claudeCliModel } from "./claude-cli.js";
import { codexCliModel } from "./codex-cli.js";
import type { Model } from "./turn.js";

/**
 * Which wire a model call takes.
 *
 * One choice, in one place: the reviewer's, the verifier's, the drafter's and
 * the command line's were the same three-way conditional written out four
 * times, which is how a provider comes to exist on three of them.
 */

export const MODEL_PROVIDERS = ["anthropic", "claude-cli", "codex-cli"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface CreateModelOptions {
  /** JSON Schema for `submit_review`, built by the caller from its own plan. */
  submitSchema: Record<string, unknown>;
  /**
   * The model to call. Absent, null or empty leaves the transport's own
   * default: a configuration file carries `null` for unset and an empty flag
   * gives `""`, and neither is a model id.
   */
  modelId?: string | null | undefined;
}

export function createModel(provider: ModelProvider, options: CreateModelOptions): Model {
  const named = options.modelId
    ? { submitSchema: options.submitSchema, modelId: options.modelId }
    : { submitSchema: options.submitSchema };
  switch (provider) {
    case "claude-cli":
      return claudeCliModel(named);
    case "codex-cli":
      return codexCliModel(named);
    case "anthropic":
      return anthropicModel(named);
  }
}
