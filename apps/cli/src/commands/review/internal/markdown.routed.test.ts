import { describe, expect, it } from "vitest";
import { renderReviewMarkdown } from "./markdown.js";
import {
  BLOCKING_RULE,
  ESCALATED_RULE,
  ROUTED_RULES,
  makeRoutedReview,
} from "../../../test-support/records.js";

/**
 * What `review --format markdown` shows a person, and what it only counts.
 *
 * A `remediable` finding went to the executor, which closed it; nobody has to
 * do anything about it. It is not on the surface a person reads first — one
 * line says how many there were and which review holds them — while everything
 * that blocks or escalates renders exactly as it did.
 */

const REVIEW_ID = "rev_routed00001";
const artifact = makeRoutedReview({ review_id: REVIEW_ID, changeset_id: "cs_routed00001" });
const rendered = renderReviewMarkdown(artifact);

describe("the markdown verdict", () => {
  it("shows what blocks and what escalates, with the statement each one is about", () => {
    expect(rendered).toContain(BLOCKING_RULE);
    expect(rendered).toContain("The token carries no exp claim.");
    expect(rendered).toContain(ESCALATED_RULE);
    expect(rendered).toContain("Two writers reach the counter without a lock.");
  });

  it("names no finding the executor closed, by rule id or by statement", () => {
    for (const rule of ROUTED_RULES) {
      const routed = artifact.findings.find((one) => one.rule_id === rule)!;
      expect(rendered).not.toContain(routed.rule_id);
      expect(rendered).not.toContain(routed.statement);
    }
  });

  it("counts them on one line that says which review holds them", () => {
    const lines = rendered
      .split("\n")
      .filter((line) => line.includes(REVIEW_ID) && line.includes("executor"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${ROUTED_RULES.length} findings`);
  });

  it("keeps the verdict line's counts truthful", () => {
    expect(rendered.split("\n")[0]).toContain("2 for the executor");
  });

  it("keeps a criterion whose findings all went to the executor, and does not call it empty", () => {
    expect(rendered).toContain("### ac_2 — not_met, asserted_only");
    expect(rendered).not.toMatch(/### ac_2[^#]*\bNo findings\.\s/);
  });
});
