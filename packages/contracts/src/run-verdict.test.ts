import { describe, expect, it } from "vitest";
import { isRunVerdict, RUN_VERDICTS } from "./run-verdict.js";

describe("RUN_VERDICTS", () => {
  it("is the verdicts on the change for the person, and nothing that did not complete", () => {
    expect(RUN_VERDICTS).toEqual(["changes_requested", "escalated", "remediation_exhausted", "remediation_stalled"]);
    for (const outcome of RUN_VERDICTS) expect(isRunVerdict(outcome)).toBe(true);
    for (const outcome of ["approved", "level", "relevelled", "no_changes", "terminated", "base_conflict", "review_failed", undefined])
      expect(isRunVerdict(outcome)).toBe(false);
  });
});
