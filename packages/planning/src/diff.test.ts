import {
  PlanContractP1Schema,
  PlanContractSchema,
  type PlanContractWithCriteria,
} from "@perbo/contracts";
import { describe, expect, it } from "vitest";
import { contractDifferences, contractEditCount } from "./diff.js";

// The P1 schema rather than the union, because every assertion below reads the
// criteria a P0 contract does not have.
const base = (): PlanContractWithCriteria =>
  PlanContractP1Schema.parse({
    plan_id: "plan_diff",
    version: 1,
    ticket_id: "ticket_diff",
    level: "P1",
    outcome: "Search results are paginated.",
    acceptance_criteria: [
      {
        id: "ac_1",
        text: "A search returns at most 25 hits per page.",
        expected_verification: { kind: "test", assertion: "a 140-hit query returns 25" },
      },
      {
        id: "ac_2",
        text: "The total number of matches is reported.",
        expected_verification: { kind: "test", assertion: "total is 140" },
      },
    ],
    scope: {
      repository_id: "repo_diff",
      paths_allowed: ["packages/search/**"],
      paths_prohibited: [".github/**"],
      generated_paths: [],
      expansion_budget_files: 3,
    },
    base: {
      base_commit: "a1b2c3d",
      context_manifest_hash: `sha256:${"0".repeat(64)}`,
      captured_at: "2026-08-27T09:00:00Z",
    },
  });

describe("contractEditCount", () => {
  it("is zero when nothing a person edits changed", () => {
    expect(contractEditCount(base(), base()).count).toBe(0);
  });

  it("counts the outcome, each criterion touched and each scope glob moved", () => {
    const before = base();
    const after = PlanContractSchema.parse({
      ...before,
      outcome: "Search results are paginated at 25 per page.",
      acceptance_criteria: [
        before.acceptance_criteria[0],
        {
          ...before.acceptance_criteria[1],
          expected_verification: { kind: "query", assertion: "the count column is 140" },
        },
        {
          id: "ac_3",
          text: "Paging past the end is empty.",
          expected_verification: { kind: "test", assertion: "page 7 of 140 is []" },
        },
      ],
      scope: {
        ...before.scope,
        paths_allowed: ["packages/search/**", "packages/api/**"],
      },
    });
    const diff = contractEditCount(before, after);
    // outcome, ac_2 reworded, ac_3 added, one glob added
    expect(diff.count).toBe(4);
    expect(diff.changes).toEqual([
      "outcome reworded",
      "ac_2 reworded",
      "ac_3 added",
      "scope +packages/api/**",
    ]);
  });

  it("counts a removed criterion and a removed glob", () => {
    const before = base();
    const after = PlanContractSchema.parse({
      ...before,
      acceptance_criteria: [before.acceptance_criteria[0]],
      scope: { ...before.scope, paths_allowed: ["packages/api/**"], paths_prohibited: [] },
    });
    const diff = contractEditCount(before, after);
    // ac_2 removed, one glob removed, one added, one prohibition removed
    expect(diff.count).toBe(4);
    expect(diff.changes).toContain("ac_2 removed");
    expect(diff.changes).toContain("scope -packages/search/**");
    expect(diff.changes).toContain("prohibited -.github/**");
  });

  it("does not count identity, base or level: those are not edits a person makes", () => {
    const before = base();
    const after = PlanContractSchema.parse({
      ...before,
      version: 2,
      base: { ...before.base, captured_at: "2026-08-28T09:00:00Z" },
    });
    expect(contractEditCount(before, after).count).toBe(0);
  });
});

describe("contractDifferences", () => {
  it("names nothing when the two documents are the same, whatever order their keys are in", () => {
    expect(contractDifferences(base(), base())).toEqual([]);
    const reordered = PlanContractSchema.parse(
      Object.fromEntries(Object.entries(base()).reverse()),
    );
    expect(contractDifferences(base(), reordered)).toEqual([]);
  });

  it("names the path of every field that differs, sorted and nested", () => {
    const before = base();
    const after = PlanContractSchema.parse({
      ...before,
      outcome: "Search results are paginated at 25 per page.",
      acceptance_criteria: [
        {
          ...before.acceptance_criteria[0],
          expected_verification: { kind: "test", assertion: "a 140-hit query returns 20" },
        },
        before.acceptance_criteria[1],
      ],
      scope: { ...before.scope, expansion_budget_files: 5 },
    });
    expect(contractDifferences(before, after)).toEqual([
      "acceptance_criteria[0].expected_verification.assertion",
      "outcome",
      "scope.expansion_budget_files",
    ]);
  });

  it("names a removed element at its own index, not everything after it", () => {
    const before = base();
    const after = PlanContractSchema.parse({
      ...before,
      acceptance_criteria: [before.acceptance_criteria[0]],
    });
    expect(contractDifferences(before, after)).toEqual(["acceptance_criteria[1]"]);
  });

  it("names the fields a person never types, which are the ones nothing else checks", () => {
    const before = base();
    const after = PlanContractSchema.parse({
      ...before,
      level: "P2",
      data_impact: "none",
      security_impact: "none",
      rollout: "a human merges it",
      rollback: "git revert",
      estimated_recurring_cost_micros: 0,
      base: { ...before.base, base_commit: "d4e5f6a" },
    });
    // `contractEditCount` counts none of these; the integrity comparison must.
    expect(contractEditCount(before, after).count).toBe(0);
    expect(contractDifferences(before, after)).toContain("base.base_commit");
    expect(contractDifferences(before, after)).toContain("level");
  });
});
