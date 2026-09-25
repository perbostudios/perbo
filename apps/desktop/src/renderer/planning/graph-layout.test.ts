import { describe, expect, it } from "vitest";
import { graphColumns, nodeSummary } from "./graph-layout.js";

/**
 * The Graph pane's own layout (D-100): columns by rank, deterministic, and
 * whole even for a record the schema would refuse.
 */
describe("the layered layout", () => {
  it("ranks each node one column after its latest predecessor, ordered by where its predecessors sit", () => {
    const nodes = [{ id: "node_1" }, { id: "node_2" }, { id: "node_3" }, { id: "node_4" }];
    const edges = [
      { from: "node_1", to: "node_3" },
      { from: "node_2", to: "node_4" },
      { from: "node_3", to: "node_4" },
    ];
    expect(graphColumns(nodes, edges)).toEqual([["node_1", "node_2"], ["node_3"], ["node_4"]]);
  });

  it("lays out a record that holds a cycle with every column an array", () => {
    const columns = graphColumns(
      [{ id: "node_1" }, { id: "node_2" }],
      [
        { from: "node_1", to: "node_2" },
        { from: "node_2", to: "node_1" },
      ],
    );
    for (let index = 0; index < columns.length; index += 1)
      expect(index in columns, `column ${index}`).toBe(true);
    expect(columns.flat().sort()).toEqual(["node_1", "node_2"]);
  });
});

describe("what a node's card says under its title (D-NEW-basic-and-epic-flows)", () => {
  it("counts its criteria and names its paths", () => {
    expect(nodeSummary({ criteria: [1, 2], paths: ["src/a/**", "src/b.ts"] })).toBe("2 criteria · src/a/** · src/b.ts");
    expect(nodeSummary({ criteria: [1], paths: [] })).toBe("1 criterion");
  });
});
