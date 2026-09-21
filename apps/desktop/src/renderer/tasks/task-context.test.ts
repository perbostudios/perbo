import { describe, expect, it } from "vitest";
import { costLabel } from "./task-context.js";

describe("costLabel", () => {
  it("calls a total all-in only where every component of it is priced", () => {
    expect(costLabel({ cost: { micros: 1_230_000, partial: false, unavailable: 0 } })).toBe("$1.23");
    expect(costLabel({ cost: { micros: 1_230_000, partial: true, unavailable: 1 } })).toBe(
      "at least $1.23",
    );
  });

  it("shows no figure where nothing in the run is priced", () => {
    expect(costLabel({ cost: { micros: 0, partial: true, unavailable: 1 } })).toBe("Unavailable");
  });
});
