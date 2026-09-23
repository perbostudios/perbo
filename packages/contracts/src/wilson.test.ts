import { describe, expect, it } from "vitest";
import { wilsonInterval } from "./wilson.js";

describe("the Wilson score interval", () => {
  it("reads 1 of 2 and 3 of 3 at the published bounds", () => {
    const one = wilsonInterval(1, 2);
    expect(one.point).toBe(0.5);
    expect(one.low).toBeCloseTo(0.0945, 3);
    expect(one.high).toBeCloseTo(0.9055, 3);
    const all = wilsonInterval(3, 3);
    expect(all.high).toBe(1);
    expect(all.low).toBeCloseTo(0.4385, 3);
  });

  it("has no value at n = 0 rather than a fabricated one", () => {
    expect(Number.isNaN(wilsonInterval(0, 0).point)).toBe(true);
  });
});
