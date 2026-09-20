import { describe, expect, it } from "vitest";
import {
  ZERO_USAGE,
  addUsage,
  costMicros,
  resolveModelCost,
  type ModelUsage,
} from "../src/provider.js";

/**
 * The price card and the rule that decides which number a review records.
 *
 * D-010 has a cost threshold, so these are the arithmetic a decision is taken
 * on rather than a statistic: a list price that moved by a factor of ten, or a
 * basis that silently became an estimate, has to fail here.
 */

const usage = (over: Partial<ModelUsage> = {}): ModelUsage => ({ ...ZERO_USAGE, ...over });

describe("costMicros", () => {
  it("prices input at 5 and output at 25 micro-dollars a token", () => {
    expect(costMicros(usage({ input_tokens: 1000, output_tokens: 200 }))).toBe(10_000);
  });

  it("prices a cache read at a tenth of input and a cache write at a quarter more", () => {
    expect(costMicros(usage({ cache_read_input_tokens: 1000 }))).toBe(500);
    expect(costMicros(usage({ cache_creation_input_tokens: 1000 }))).toBe(6_250);
  });

  it("is zero for no tokens", () => {
    expect(costMicros(ZERO_USAGE)).toBe(0);
  });
});

describe("addUsage", () => {
  it("adds field by field", () => {
    expect(
      addUsage(
        usage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 }),
        usage({ input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 }),
      ),
    ).toEqual({
      input_tokens: 11,
      output_tokens: 2,
      cache_read_input_tokens: 33,
      cache_creation_input_tokens: 4,
    });
  });
});

describe("resolveModelCost", () => {
  const tokens = usage({ input_tokens: 1000, output_tokens: 200 });

  it("takes the transport's own figure when every turn reported one", () => {
    expect(
      resolveModelCost({
        usage: tokens,
        turns: 2,
        reportedTurns: 2,
        reportedCostMicros: 4_321,
      }),
    ).toEqual({ cost_micros: 4_321, cost_basis: "transport_reported" });
  });

  it("estimates the whole review at list price when only some turns reported", () => {
    // The reported part is dropped rather than mixed with an estimate: two
    // bases in one number would describe neither.
    expect(
      resolveModelCost({
        usage: tokens,
        turns: 2,
        reportedTurns: 1,
        reportedCostMicros: 4_321,
      }),
    ).toEqual({ cost_micros: 10_000, cost_basis: "provider_list_estimate" });
  });

  it("records no figure at all for a transport that says the cost is unavailable", () => {
    expect(
      resolveModelCost({
        usage: tokens,
        turns: 2,
        reportedTurns: 0,
        reportedCostMicros: 0,
        unreportedCostBasis: "unavailable",
      }),
    ).toEqual({ cost_micros: 0, cost_basis: "unavailable" });
  });

  it("estimates a review that took no turn at zero", () => {
    expect(
      resolveModelCost({
        usage: ZERO_USAGE,
        turns: 0,
        reportedTurns: 0,
        reportedCostMicros: 0,
      }),
    ).toEqual({ cost_micros: 0, cost_basis: "provider_list_estimate" });
  });
});
