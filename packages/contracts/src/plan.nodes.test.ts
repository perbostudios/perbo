import { describe, expect, it } from "vitest";
import { NodeIdSchema, RequirementIdSchema } from "./ids.js";
import {
  PlanContractSchema,
  PlanNodeSchema,
  planNodes,
  unknownRequirementIds,
} from "./plan.js";

/** The canonical P1 from docs/04, with four criteria to group. */
const criterion = (n: number) => ({
  id: `ac_${n}`,
  text: `criterion ${n} states what must be true.`,
  expected_verification: { kind: "test" as const, assertion: `assertion ${n}` },
});

const flat = {
  plan_id: "plan_01J8QK",
  version: 1,
  ticket_id: "ticket_01J8QJ",
  level: "P1" as const,
  outcome: "New users receive an activation email within 60s of signup.",
  acceptance_criteria: [criterion(1), criterion(2), criterion(3), criterion(4)],
  scope: {
    repository_id: "repo_01J8QH",
    paths_allowed: ["packages/auth/**", "packages/queue/**"],
    paths_prohibited: [".github/**"],
    generated_paths: ["pnpm-lock.yaml"],
    expansion_budget_files: 3,
  },
  base: {
    base_commit: "a1b2c3d",
    context_manifest_hash: `sha256:${"0".repeat(64)}`,
    captured_at: "2026-08-26T12:00:00Z",
  },
};

const graphed = {
  ...flat,
  nodes: [
    { id: "node_1", title: "Queue the email", criteria: ["ac_1", "ac_2"], paths: ["packages/queue/**"] },
    { id: "node_2", title: "Guard the duplicate", criteria: ["ac_3", "ac_4"], paths: ["packages/auth/**"] },
  ],
};

describe("a plan node", () => {
  it("is exactly an id, a title, its criteria and its paths", () => {
    expect(PlanNodeSchema.parse(graphed.nodes[0]).id).toBe("node_1");
    for (const field of ["steps", "order", "depends_on", "estimate"]) {
      expect(PlanNodeSchema.safeParse({ ...graphed.nodes[0], [field]: "anything" }).success).toBe(
        false,
      );
    }
  });

  it("carries at least one criterion and at least one path, each criterion once", () => {
    expect(PlanNodeSchema.safeParse({ ...graphed.nodes[0], criteria: [] }).success).toBe(false);
    expect(PlanNodeSchema.safeParse({ ...graphed.nodes[0], paths: [] }).success).toBe(false);
    expect(
      PlanNodeSchema.safeParse({ ...graphed.nodes[0], criteria: ["ac_1", "ac_1"] }).success,
    ).toBe(false);
  });

  it("has a plan-local prefixed id", () => {
    expect(NodeIdSchema.safeParse("node_1").success).toBe(true);
    expect(NodeIdSchema.safeParse("ac_1").success).toBe(false);
    expect(NodeIdSchema.safeParse("node_").success).toBe(false);
  });
});

describe("a plan with nodes", () => {
  it("accepts a graph whose nodes partition the criteria inside the allowed scope", () => {
    const parsed = PlanContractSchema.parse(graphed);
    expect(planNodes(parsed).map((node) => node.id)).toEqual(["node_1", "node_2"]);
  });

  it("still accepts a plan with no nodes at all", () => {
    const parsed = PlanContractSchema.parse(flat);
    expect(planNodes(parsed)).toEqual([]);
  });

  it("refuses a node id used twice", () => {
    const twice = {
      ...graphed,
      nodes: [graphed.nodes[0], { ...graphed.nodes[1], id: "node_1" }],
    };
    expect(PlanContractSchema.safeParse(twice).success).toBe(false);
  });

  it("refuses a node criterion the plan does not carry", () => {
    const stray = {
      ...graphed,
      nodes: [{ ...graphed.nodes[0], criteria: ["ac_1", "ac_9"] }, graphed.nodes[1]],
    };
    const result = PlanContractSchema.safeParse(stray);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("ac_9");
  });

  it("refuses a criterion that is in two nodes", () => {
    const shared = {
      ...graphed,
      nodes: [graphed.nodes[0], { ...graphed.nodes[1], criteria: ["ac_2", "ac_3", "ac_4"] }],
    };
    const result = PlanContractSchema.safeParse(shared);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("ac_2");
  });

  it("refuses a criterion outside every node", () => {
    const uncovered = {
      ...graphed,
      nodes: [graphed.nodes[0], { ...graphed.nodes[1], criteria: ["ac_3"] }],
    };
    const result = PlanContractSchema.safeParse(uncovered);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("ac_4");
  });

  it("refuses a node path outside the allowed scope", () => {
    const outside = {
      ...graphed,
      nodes: [{ ...graphed.nodes[0], paths: ["packages/billing/**"] }, graphed.nodes[1]],
    };
    const result = PlanContractSchema.safeParse(outside);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("packages/billing/**");
  });

  it("refuses an empty node list: a plan either groups its criteria or does not", () => {
    expect(PlanContractSchema.safeParse({ ...graphed, nodes: [] }).success).toBe(false);
  });

  it("carries nodes at P2 and P3 too, and none at P0", () => {
    const p2 = {
      ...graphed,
      level: "P2" as const,
      data_impact: "none",
      security_impact: "none",
      rollout: "a human merges",
      rollback: "git revert",
      estimated_recurring_cost_micros: 0,
    };
    expect(PlanContractSchema.parse(p2).level).toBe("P2");
    const p0 = {
      plan_id: flat.plan_id,
      version: 1,
      ticket_id: flat.ticket_id,
      level: "P0" as const,
      outcome: "list the open pull requests",
      scope: flat.scope,
      base: flat.base,
      budget: { max_cost_micros: 50_000, max_wall_clock_ms: 20_000 },
      nodes: graphed.nodes,
    };
    expect(PlanContractSchema.safeParse(p0).success).toBe(false);
  });
});

describe("the requirement a criterion was drafted from", () => {
  it("is optional, and shaped R1 upward", () => {
    expect(RequirementIdSchema.safeParse("R1").success).toBe(true);
    expect(RequirementIdSchema.safeParse("R12").success).toBe(true);
    expect(RequirementIdSchema.safeParse("R0").success).toBe(false);
    expect(RequirementIdSchema.safeParse("R01").success).toBe(false);
    expect(RequirementIdSchema.safeParse("requirement 1").success).toBe(false);
    const cited = {
      ...flat,
      acceptance_criteria: [{ ...criterion(1), requirement_id: "R1" }, criterion(2)],
    };
    expect(PlanContractSchema.parse(cited).level).toBe("P1");
    expect(
      PlanContractSchema.safeParse({
        ...flat,
        acceptance_criteria: [{ ...criterion(1), requirement_id: "R0" }],
      }).success,
    ).toBe(false);
  });

  it("is checked against the ids the spec carries, which the schema cannot know", () => {
    const cited = PlanContractSchema.parse({
      ...flat,
      acceptance_criteria: [
        { ...criterion(1), requirement_id: "R1" },
        { ...criterion(2), requirement_id: "R7" },
      ],
    });
    expect(unknownRequirementIds(cited, ["R1", "R2"])).toEqual([
      { criterion_id: "ac_2", requirement_id: "R7" },
    ]);
    expect(unknownRequirementIds(cited, ["R1", "R7"])).toEqual([]);
  });

  it("is absent from a plan drafted from an issue, which cites nothing", () => {
    const drafted = PlanContractSchema.parse(flat);
    expect(unknownRequirementIds(drafted, [])).toEqual([]);
  });
});
