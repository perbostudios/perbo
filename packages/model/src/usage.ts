import type { ReviewCostBasis } from "@perbo/contracts";

/**
 * What a model call costs, and which of the two ways of knowing it the record
 * carries.
 */

/** One home for the basis: the contract the artifact is written against. */
export type ModelCostBasis = ReviewCostBasis;

/**
 * What a transport that reports no dollars of its own wants its turns
 * accounted for as. `transport_reported` is not among them: it is the answer
 * for a transport that did report.
 */
export type UnreportedCostBasis = Exclude<ModelCostBasis, "transport_reported">;

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** The model `PRICE_MICROS_PER_TOKEN` is the list price of. */
export const PRICED_MODEL_ID = "claude-opus-5";

/**
 * Claude API list prices, in micro-dollars per token. $5 / $25 per million for
 * Claude Opus 5; cache reads are a tenth of the input rate and cache writes a
 * quarter more. Recorded per review because D-010 has a cost threshold and a
 * cost nobody measured is not a number.
 */
export const PRICE_MICROS_PER_TOKEN = {
  input: 5,
  output: 25,
  cache_read: 0.5,
  cache_creation: 6.25,
} as const;

export function costMicros(usage: ModelUsage): number {
  return Math.round(
    usage.input_tokens * PRICE_MICROS_PER_TOKEN.input +
      usage.output_tokens * PRICE_MICROS_PER_TOKEN.output +
      usage.cache_read_input_tokens * PRICE_MICROS_PER_TOKEN.cache_read +
      usage.cache_creation_input_tokens * PRICE_MICROS_PER_TOKEN.cache_creation,
  );
}

export function resolveModelCost(args: {
  usage: ModelUsage;
  turns: number;
  reportedTurns: number;
  reportedCostMicros: number;
  unreportedCostBasis?: UnreportedCostBasis | undefined;
}): { cost_micros: number; cost_basis: ModelCostBasis } {
  if (args.turns > 0 && args.reportedTurns === args.turns) {
    return {
      cost_micros: args.reportedCostMicros,
      cost_basis: "transport_reported",
    };
  }
  if (args.unreportedCostBasis === "unavailable") {
    return { cost_micros: 0, cost_basis: "unavailable" };
  }
  return {
    cost_micros: costMicros(args.usage),
    cost_basis: "provider_list_estimate",
  };
}

export const ZERO_USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}
