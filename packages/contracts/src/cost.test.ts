import { describe, expect, it } from "vitest";
import {
  addRolls,
  CostBasisSchema,
  costLabel,
  costOf,
  costPhrase,
  CostRollSchema,
  ReviewCostBasisSchema,
  rollCosts,
  rollLabel,
  type Cost,
} from "./cost.js";

describe("a cost and its basis", () => {
  it("carries a figure only where the basis carries dollars", () => {
    expect(costOf({ micros: 40_000, basis: "transport_reported" })).toEqual({
      micros: 40_000,
      basis: "transport_reported",
      partial: false,
    });
    expect(costOf({ micros: 40_000, basis: "provider_list_estimate", partial: true })).toEqual({
      micros: 40_000,
      basis: "provider_list_estimate",
      partial: true,
    });
    expect(costOf({ micros: 40_000, basis: "unavailable" }).micros).toBeNull();
    expect(costOf({ micros: 0, basis: "not_incurred" }).micros).toBeNull();
  });

  it("admits not_incurred, refuses a basis nobody defined, and stays in step with the model basis", () => {
    expect(CostBasisSchema.parse("not_incurred")).toBe("not_incurred");
    expect(CostBasisSchema.safeParse("free").success).toBe(false);
    expect([...CostBasisSchema.options]).toEqual([
      ...ReviewCostBasisSchema.options,
      "not_incurred",
    ]);
  });
});

describe("costs added up", () => {
  const reported = (micros: number, partial = false): Cost =>
    costOf({ micros, basis: "transport_reported", partial });
  const estimated = (micros: number): Cost => costOf({ micros, basis: "provider_list_estimate" });
  const unavailable = (): Cost => costOf({ micros: 0, basis: "unavailable" });
  const notIncurred = (): Cost => costOf({ micros: 0, basis: "not_incurred" });

  it("counts nothing for no components", () => {
    expect(rollCosts([])).toEqual({
      micros: 0,
      components: 0,
      priced: 0,
      reported: 0,
      estimated: 0,
      unavailable: 0,
      partial: 0,
    });
  });

  it("leaves not_incurred out, counts unavailable without summing it, and names the partial ones", () => {
    expect(
      rollCosts([
        reported(100_000),
        notIncurred(),
        unavailable(),
        estimated(70_000),
        reported(50_000, true),
      ]),
    ).toEqual({
      micros: 220_000,
      components: 4,
      priced: 3,
      reported: 2,
      estimated: 1,
      unavailable: 1,
      partial: 1,
    });
  });

  it("adds two rolls field by field, the way rolling both at once does", () => {
    const left = [reported(100_000), unavailable()];
    const right = [estimated(70_000), notIncurred(), reported(50_000, true)];
    expect(addRolls(rollCosts(left), rollCosts(right))).toEqual(rollCosts([...left, ...right]));
    expect(addRolls(rollCosts(left), rollCosts(right))).toEqual({
      micros: 220_000,
      components: 4,
      priced: 3,
      reported: 2,
      estimated: 1,
      unavailable: 1,
      partial: 1,
    });
  });

  it("keeps a key a later version of the producer adds out of the parsed roll", () => {
    expect(
      CostRollSchema.parse({
        micros: 1,
        components: 1,
        priced: 1,
        reported: 1,
        estimated: 0,
        unavailable: 0,
        partial: 0,
        cached: 4,
      }),
    ).not.toHaveProperty("cached");
  });
});

describe("a cost as a person reads it", () => {
  it("says the word alone where there are no dollars, and never $0.0000", () => {
    expect(costPhrase(costOf({ micros: 40_000, basis: "unavailable" }))).toBe("cost unavailable");
    expect(costPhrase(costOf({ micros: 0, basis: "not_incurred" }))).toBe("not incurred");
    expect(costLabel(costOf({ micros: 40_000, basis: "unavailable" }))).toBe("unavailable");
    expect(costLabel(costOf({ micros: 0, basis: "not_incurred" }))).toBe("not incurred");
  });

  it("names the basis beside the amount, and partial in place of it", () => {
    expect(costPhrase(costOf({ micros: 40_000, basis: "transport_reported" }))).toBe(
      "$0.0400 reported",
    );
    expect(costPhrase(costOf({ micros: 40_000, basis: "provider_list_estimate" }))).toBe(
      "$0.0400 estimated",
    );
    expect(
      costPhrase(costOf({ micros: 40_000, basis: "transport_reported", partial: true })),
    ).toBe("$0.0400 partial");
    expect(costLabel(costOf({ micros: 40_000, basis: "transport_reported" }))).toBe(
      "$0.0400 reported",
    );
  });

  it("quotes a review card to three decimals when asked", () => {
    expect(
      costPhrase(costOf({ micros: 43_000, basis: "provider_list_estimate" }), { digits: 3 }),
    ).toBe("$0.043 estimated");
  });

  it("says of a subtotal what it adds up to and what is missing from it", () => {
    expect(rollLabel(rollCosts([]))).toBe("not incurred");
    expect(rollLabel(rollCosts([costOf({ micros: 0, basis: "unavailable" })]))).toBe(
      "unavailable — 1 component(s) unpriced",
    );
    expect(
      rollLabel(
        rollCosts([
          costOf({ micros: 200_000, basis: "transport_reported" }),
          costOf({ micros: 100_000, basis: "provider_list_estimate" }),
          costOf({ micros: 100_000, basis: "provider_list_estimate" }),
          costOf({ micros: 70_000, basis: "provider_list_estimate" }),
        ]),
      ),
    ).toBe("$0.4700 — 4 of 4 priced, 1 reported, 3 estimated");
    expect(
      rollLabel(
        rollCosts([
          costOf({ micros: 200_000, basis: "transport_reported", partial: true }),
          costOf({ micros: 0, basis: "unavailable" }),
        ]),
      ),
    ).toBe("$0.2000 — 1 of 2 priced, 1 partial, 1 unavailable");
  });
});
