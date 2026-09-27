import { describe, expect, it } from "vitest";
import { PlanContractSchema, type ReviewArtifact } from "@perbo/contracts";
import { makeReview } from "../../../test-support/records.js";
import { WIDTH } from "../../../text.js";
import { renderArtifact } from "./card.js";

/**
 * The review card never cuts what a person reads (D-NEW-nothing-shown-is-cut):
 * a check's command and summary, and a finding's location, go under their
 * row, wrapped, where they do not fit it.
 */

const contract = PlanContractSchema.parse({
  plan_id: "plan_card",
  version: 1,
  ticket_id: "ticket_card",
  level: "P1",
  outcome: "search results are paginated",
  acceptance_criteria: [
    { id: "ac_1", text: "A search returns at most 25 hits per page.", expected_verification: { kind: "test", assertion: "25" } },
  ],
  scope: {
    repository_id: "repo_card",
    paths_allowed: ["packages/search/**"],
    paths_prohibited: [],
    generated_paths: [],
    expansion_budget_files: 3,
  },
  base: { base_commit: "a1b2c3d", context_manifest_hash: `sha256:${"0".repeat(64)}`, captured_at: "2026-08-27T09:00:00Z" },
});

const long = (what: string) => `${what} ${"that runs on past any column the card could give it ".repeat(3)}END`;

const card = (artifact: ReviewArtifact): string => {
  const text = renderArtifact(artifact, contract, { color: false, version: "test" });
  for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(WIDTH);
  return text.replace(/\s+/g, " ");
};

describe("the review card, whole", () => {
  it("prints a check's command and summary whole", () => {
    const command = "pnpm exec vitest run --project unit --reporter verbose";
    const summary = long("Tests 1 failed | 311 passed");
    const artifact = makeReview({ review_id: "rev_card000000001", changeset_id: "cs_card00000001", decision: "remediable", cost_basis: "unavailable" });
    artifact.checks = [{ ...artifact.checks[0]!, status: "failed", command, summary }];
    const out = card(artifact);
    expect(out).toContain(command);
    expect(out).toContain(summary);
  });

  it("marks where a check's name is cut to its column", () => {
    const artifact = makeReview({ review_id: "rev_card000000003", changeset_id: "cs_card00000003", decision: "remediable", cost_basis: "unavailable" });
    artifact.checks = [{ ...artifact.checks[0]!, name: "typecheck:desktop-renderer" }];
    expect(card(artifact)).toContain(" typecheck:desk… ");
  });

  it("prints a finding's location whole, blocking or not", () => {
    const file = long("packages/search/src/a/deeply/nested/directory/query.ts").replace(/ /g, "-");
    const artifact = makeReview({ review_id: "rev_card000000002", changeset_id: "cs_card00000002", decision: "remediable", cost_basis: "unavailable" });
    artifact.findings = [
      { ...artifact.findings[0]!, file: `${file}-routed` },
      { ...artifact.findings[0]!, key: "f".repeat(64), blocking: true, routing: "blocks", file: `${file}-blocking` } as never,
    ];
    const out = card(artifact).replace(/ /g, "");
    expect(out).toContain(`${file}-routed`);
    expect(out).toContain(`${file}-blocking`);
  });
});
