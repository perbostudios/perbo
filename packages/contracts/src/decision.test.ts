import { describe, expect, it } from "vitest";
import {
  answersReview,
  decidable,
  decisionChoicesFor,
  DECISION_CHOICES,
  NEVER_HANDED_FAMILIES,
  routedToPerson,
} from "./decision.js";
import { FINDING_ROUTINGS, REVIEW_DECISIONS } from "./review.js";

/**
 * D-132: which findings take a
 * person's answer, on which reviews, and which answers each takes. `perbo
 * verdict --decide`, the loop and the desktop all read these, so each is
 * pinned here, where they live.
 */

describe("which findings are a person's to answer", () => {
  it("is an open finding routed blocks or escalates, and no other routing", () => {
    const asked = FINDING_ROUTINGS.filter((routing) => routedToPerson({ status: "open", routing }));
    expect([...asked].sort()).toEqual(["blocks", "escalates"]);
  });

  it("is never one already resolved or waived", () => {
    for (const status of ["resolved", "waived"] as const) {
      expect(routedToPerson({ status, routing: "blocks" }), status).toBe(false);
    }
  });
});

describe("which reviews take an answer", () => {
  it("is a review that judged the whole change and stopped for a person", () => {
    const taking = REVIEW_DECISIONS.filter((decision) => decidable({ decision }));
    expect([...taking].sort()).toEqual(["changes_requested", "escalate"]);
  });
});

describe("the answers a finding takes", () => {
  it("is only shipping it as it is, in a family the executor is never handed", () => {
    expect([...NEVER_HANDED_FAMILIES].sort()).toEqual(["context", "security"]);
    for (const family of NEVER_HANDED_FAMILIES) {
      expect(decisionChoicesFor(`${family}.secret_in_diff`), family).toEqual(["ship_as_is"]);
    }
  });

  it("is all three in any other family, whose name only starts like one", () => {
    for (const rule of ["product.preference", "scope.outside_allowed", "securityish.rule", "contextual.rule", "norule"]) {
      expect(decisionChoicesFor(rule), rule).toEqual(DECISION_CHOICES);
    }
  });
});

describe("which answers answer a review", () => {
  const review = { review_id: "rev_0000000000000002", recorded_at: "2026-09-24T09:00:00.000Z" };

  it("is one taken at or after the review was recorded, and never before", () => {
    expect(answersReview({ decided_at: "2026-09-24T09:00:00.000Z", review_id: null }, review)).toBe(true);
    expect(answersReview({ decided_at: "2026-09-24T08:59:59.999Z", review_id: null }, review)).toBe(false);
  });

  it("is held to the review it names, where it names one", () => {
    const after = "2026-09-24T09:30:00.000Z";
    expect(answersReview({ decided_at: after, review_id: "rev_0000000000000002" }, review)).toBe(true);
    expect(answersReview({ decided_at: after, review_id: "rev_0000000000000001" }, review)).toBe(false);
  });
});
