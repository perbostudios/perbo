import { describe, expect, it } from "vitest";
import { GRAPH_EDIT_OPS, GraphEditSchema } from "./graph-edit.js";

const verification = { kind: "test" as const, assertion: "the assertion that proves it" };

describe("a graph edit", () => {
  it("is one of the eight operations and nothing else", () => {
    expect([...GRAPH_EDIT_OPS]).toEqual([
      "add_node",
      "split_node",
      "merge_nodes",
      "delete_node",
      "set_criterion",
      "set_node_paths",
      "add_edge",
      "remove_edge",
    ]);
    expect(GraphEditSchema.safeParse({ op: "rename_plan", title: "x" }).success).toBe(false);
  });

  it("adds a node from criteria already in the plan, or from ones it writes", () => {
    expect(
      GraphEditSchema.parse({
        op: "add_node",
        title: "Queue the email",
        paths: ["packages/queue/**"],
        criteria: ["ac_1"],
      }).op,
    ).toBe("add_node");
    expect(
      GraphEditSchema.parse({
        op: "add_node",
        title: "Queue the email",
        paths: ["packages/queue/**"],
        new_criteria: [{ text: "the queue holds one message", expected_verification: verification }],
      }).op,
    ).toBe("add_node");
    // A node with no criterion at all is not a node.
    expect(
      GraphEditSchema.safeParse({
        op: "add_node",
        title: "Queue the email",
        paths: ["packages/queue/**"],
      }).success,
    ).toBe(false);
  });

  it("splits into exactly two halves, each with its title, criteria and paths", () => {
    const split = {
      op: "split_node",
      id: "node_1",
      into: [
        { title: "first half", criteria: ["ac_1"], paths: ["packages/queue/**"] },
        { title: "second half", criteria: ["ac_2"], paths: ["packages/auth/**"] },
      ],
    };
    expect(GraphEditSchema.parse(split).op).toBe("split_node");
    expect(
      GraphEditSchema.safeParse({ ...split, into: [split.into[0]] }).success,
    ).toBe(false);
  });

  it("merges exactly two nodes, named as two ids", () => {
    expect(GraphEditSchema.parse({ op: "merge_nodes", ids: ["node_1", "node_2"] }).op).toBe(
      "merge_nodes",
    );
    expect(GraphEditSchema.safeParse({ op: "merge_nodes", ids: ["node_1"] }).success).toBe(false);
    expect(
      GraphEditSchema.safeParse({ op: "merge_nodes", ids: ["node_1", "node_1"] }).success,
    ).toBe(false);
  });

  it("deletes a node by saying where each of its criteria goes", () => {
    expect(
      GraphEditSchema.parse({ op: "delete_node", id: "node_2", move_criteria_to: "node_1" }).op,
    ).toBe("delete_node");
    expect(
      GraphEditSchema.parse({ op: "delete_node", id: "node_2", delete_criteria: ["ac_3"] }).op,
    ).toBe("delete_node");
  });

  it("states a criterion's text and how it is proven", () => {
    expect(
      GraphEditSchema.parse({
        op: "set_criterion",
        id: "ac_1",
        text: "a signup queues exactly one email",
        expected_verification: verification,
      }).op,
    ).toBe("set_criterion");
    expect(
      GraphEditSchema.safeParse({ op: "set_criterion", id: "ac_1", text: "" }).success,
    ).toBe(false);
  });

  it("sets a node's paths, and adds or removes one edge", () => {
    expect(
      GraphEditSchema.parse({ op: "set_node_paths", id: "node_1", paths: ["packages/a/**"] }).op,
    ).toBe("set_node_paths");
    expect(
      GraphEditSchema.safeParse({ op: "set_node_paths", id: "node_1", paths: [] }).success,
    ).toBe(false);
    expect(GraphEditSchema.parse({ op: "add_edge", from: "node_1", to: "node_2" }).op).toBe(
      "add_edge",
    );
    expect(GraphEditSchema.parse({ op: "remove_edge", from: "node_1", to: "node_2" }).op).toBe(
      "remove_edge",
    );
    expect(
      GraphEditSchema.safeParse({ op: "add_edge", from: "node_1", to: "node_1" }).success,
    ).toBe(false);
  });
});
