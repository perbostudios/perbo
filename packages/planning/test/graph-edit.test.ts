import { describe, expect, it } from "vitest";
import { PlanContractSchema, planNodes, type PlanContract } from "@perbo/contracts";
import { PlanningError, applyGraphEdit, emptyApproach, undoGraphEdit } from "../src/index.js";

/**
 * The validated edit path lives here rather than in `perbo edit` (D-100),
 * because two surfaces apply the same operations: `perbo edit --graph-edit`
 * and the desktop's browser preview, which has no command line to shell out to.
 */

const contract: PlanContract = PlanContractSchema.parse({
  plan_id: "plan_1",
  version: 1,
  ticket_id: "ticket_1",
  level: "P1",
  outcome: "New users receive an activation email",
  acceptance_criteria: [
    {
      id: "ac_1",
      text: "A signup queues exactly one activation email",
      expected_verification: { kind: "test", assertion: "signup.test.ts" },
    },
    {
      id: "ac_2",
      text: "A failed send is retried three times",
      expected_verification: { kind: "test", assertion: "retry.test.ts" },
    },
  ],
  scope: {
    repository_id: "repo_1",
    paths_allowed: ["packages/auth/**", "packages/queue/**"],
    paths_prohibited: [],
    generated_paths: [],
    expansion_budget_files: 3,
  },
  base: {
    base_commit: "a".repeat(40),
    context_manifest_hash: `sha256:${"b".repeat(64)}`,
    captured_at: "2026-09-08T09:40:00.000Z",
  },
});
const state = { contract, approach: emptyApproach(contract) };

describe("the graph edit path, as a package", () => {
  it("applies an operation, records what it touched, and undoes it", () => {
    const added = applyGraphEdit(state, {
      op: "add_node",
      title: "Queue one email per signup",
      criteria: ["ac_1"],
      paths: ["packages/auth/**"],
    });
    // The plan had no graph, so the criterion left over is grouped as well.
    expect(planNodes(added.contract).map((node) => node.id)).toEqual(["node_1", "node_2"]);
    expect(added.keys).toContain("node:node_1");

    const back = undoGraphEdit(added, added.before);
    expect(planNodes(back.contract)).toHaveLength(0);
  });

  it("refuses an edit the schema would not take, as a planning failure with no stack", () => {
    const thrown = (): unknown => {
      try {
        applyGraphEdit(state, { op: "add_edge", from: "node_9", to: "node_8" });
        return null;
      } catch (error) {
        return error;
      }
    };
    const error = thrown();
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as Error).message).toContain("node_9");
  });
});
