import { describe, expect, it } from "vitest";
import { incompleteReviewCauses } from "./review.js";
import { finding, review } from "./test-support/fakes.js";

describe("what made an incomplete review incomplete", () => {
  it("lists the criteria the review could not resolve, in the order it listed them", () => {
    const causes = incompleteReviewCauses(
      review({
        coverage: [
          { criterion_id: "ac_2", status: "cannot_determine" },
          { criterion_id: "ac_1", status: "met" },
          { criterion_id: "ac_3", status: "cannot_determine" },
        ],
      }),
    );

    expect(causes.unresolved).toEqual(["ac_2", "ac_3"]);
  });

  it("takes a finding that names no criterion as a cause of every unresolved one", () => {
    const whole = finding({ key: "a".repeat(64), criterion_id: null });
    const causes = incompleteReviewCauses(
      review({
        findings: [whole],
        coverage: [
          { criterion_id: "ac_1", status: "cannot_determine" },
          { criterion_id: "ac_2", status: "cannot_determine" },
        ],
      }),
    );

    expect(causes.causes.map((entry) => entry.key)).toEqual([whole.key]);
    expect(causes.unexplained).toEqual([]);
  });

  it("calls a criterion unexplained when no remediable finding cites it", () => {
    const cited = finding({ key: "b".repeat(64), criterion_id: "ac_1" });
    const causes = incompleteReviewCauses(
      review({
        findings: [cited],
        coverage: [
          { criterion_id: "ac_1", status: "cannot_determine" },
          { criterion_id: "ac_2", status: "cannot_determine" },
        ],
      }),
    );

    expect(causes.causes.map((entry) => entry.key)).toEqual([cited.key]);
    expect(causes.unexplained).toEqual(["ac_2"]);
  });

  it("files each citing finding once, however many criteria it explains", () => {
    const whole = finding({ key: "c".repeat(64), criterion_id: null });
    const causes = incompleteReviewCauses(
      review({
        findings: [whole],
        coverage: [
          { criterion_id: "ac_1", status: "cannot_determine" },
          { criterion_id: "ac_2", status: "cannot_determine" },
          { criterion_id: "ac_3", status: "cannot_determine" },
        ],
      }),
    );

    expect(causes.causes).toHaveLength(1);
  });
});
