import { z } from "zod";

/**
 * How hard a model thinks, in each provider's own words: the values its CLI or
 * API takes, in ascending order. A provider absent from a model's catalog row
 * reports no levels for that model, and nothing is sent for it.
 *
 * - `claude-cli`: `claude --effort <level>`.
 * - `codex-cli`: the `effort` of a `codex app-server` `turn/start`.
 * - `anthropic`: the Messages API's `output_config.effort`.
 */
export const EFFORT_LEVELS = {
  "claude-cli": ["low", "medium", "high", "xhigh", "max"],
  "codex-cli": ["low", "medium", "high", "xhigh", "max", "ultra"],
  anthropic: ["low", "medium", "high", "xhigh", "max"],
} as const;

export type EffortProvider = keyof typeof EFFORT_LEVELS;
export const EffortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;
export type ProviderEffort<P extends EffortProvider> = (typeof EFFORT_LEVELS)[P][number];

/** The name a person reads for a level. */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/** Whether `provider` takes `effort`. */
export function effortFits(provider: EffortProvider, effort: string): effort is EffortLevel {
  return (EFFORT_LEVELS[provider] as readonly string[]).includes(effort);
}
