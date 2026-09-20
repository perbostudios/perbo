import { describe, expect, it } from "vitest";
import { attemptId } from "@perbo/contracts";
import { attemptIdFor } from "./state.js";

const ROOT = "att_0000000000000001";

describe("the id of one attempt of one round", () => {
  it("is the run's own root for the first attempt of round 0", () => {
    expect(attemptIdFor({ root: ROOT, round: 0, transport_retry: 0, ceiling_continuation: 0 })).toBe(
      ROOT,
    );
  });

  it("seeds a later round from the root and the round", () => {
    expect(attemptIdFor({ root: ROOT, round: 2, transport_retry: 0, ceiling_continuation: 0 })).toBe(
      attemptId(`${ROOT}|round|2`),
    );
  });

  it("seeds the continuation before the retry, so one position mints one id", () => {
    expect(attemptIdFor({ root: ROOT, round: 1, transport_retry: 3, ceiling_continuation: 2 })).toBe(
      attemptId(`${ROOT}|round|1|continue|2|transport|3`),
    );
  });

  it("mints a different id for every position of the same round", () => {
    const ids = new Set(
      [
        { transport_retry: 0, ceiling_continuation: 0 },
        { transport_retry: 1, ceiling_continuation: 0 },
        { transport_retry: 0, ceiling_continuation: 1 },
        { transport_retry: 1, ceiling_continuation: 1 },
      ].map((position) => attemptIdFor({ root: ROOT, round: 1, ...position })),
    );
    expect(ids.size).toBe(4);
  });
});
