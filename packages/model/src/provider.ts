import {
  EFFORT_LEVELS,
  effortFits,
  type EffortLevel,
  type EffortProvider,
  type ProviderEffort,
} from "@perbo/contracts";
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
  /**
   * How hard the model thinks, in the provider's own words (`EFFORT_LEVELS`).
   * Absent or null sends nothing on Claude Code; Codex starts at medium and
   * the API at high.
   */
  effort?: EffortLevel | null | undefined;
}

export function createModel(provider: ModelProvider, options: CreateModelOptions): Model {
  const named = options.modelId
    ? { submitSchema: options.submitSchema, modelId: options.modelId }
    : { submitSchema: options.submitSchema };
  switch (provider) {
    case "claude-cli":
      return claudeCliModel({ ...named, ...fitted("claude-cli", options.effort) });
    case "codex-cli":
      return codexCliModel({ ...named, ...fitted("codex-cli", options.effort) });
    case "anthropic":
      return anthropicModel({ ...named, ...fitted("anthropic", options.effort) });
  }
}

/**
 * An effort as the provider takes it, or nothing where none is configured. A
 * caller validates its configuration before it builds a model, so an effort
 * the provider does not take is a defect and refused here rather than sent.
 */
function fitted<P extends EffortProvider>(
  provider: P,
  effort: EffortLevel | null | undefined,
): { effort?: ProviderEffort<P> } {
  if (effort === null || effort === undefined) return {};
  if (!effortFits(provider, effort))
    throw new Error(`${provider} takes ${EFFORT_LEVELS[provider].join(", ")}, not ${effort}`);
  return { effort: effort as ProviderEffort<P> };
}
