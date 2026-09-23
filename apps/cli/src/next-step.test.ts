import { describe, expect, it } from "vitest";
import { NEXT_STEPS, withoutNextStep } from "./next-step.js";

describe("withoutNextStep", () => {
  // The cut is anchored on the lines the commands write, not on the shape of a
  // line, because a report carries text the person wrote: the spec's No-Gos are
  // printed at an indent, so a No-Go that names a command would be read as one.
  // What follows it includes the count of instructions the spec aimed at the
  // drafter — so a shape-matching cut would let a spec suppress the report of
  // what it tried.
  it("keeps a report whole around a No-Go that names a command", () => {
    const report = [
      "admitted PRB-1 (plan_review)",
      "  no-gos    from the spec, kept out of the contract",
      "            perbo run must not be called from the queue worker.",
      "  flagged   2 issue-authored attempts — read as data, not followed",
      "",
      NEXT_STEPS[0],
      "  perbo approve PRB-1",
      "",
      "  spec      specs/activation-email/spec.md",
    ].join("\n");
    const kept = withoutNextStep(report);
    expect(kept).toContain("perbo run must not be called from the queue worker.");
    expect(kept).toContain("flagged   2 issue-authored attempts");
    expect(kept).toContain("specs/activation-email/spec.md");
    expect(kept).not.toContain(NEXT_STEPS[0]);
    expect(kept).not.toContain("perbo approve PRB-1");
  });
});
