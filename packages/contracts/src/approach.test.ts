import { describe, expect, it } from "vitest";
import {
  APPROACH_SCHEMA_VERSION,
  ApproachRecordSchema,
  approachProblems,
  findCycle,
} from "./approach.js";

const record = {
  schema_version: APPROACH_SCHEMA_VERSION,
  ticket_id: "ticket_01J8QJ",
  plan_id: "plan_01J8QK",
  edges: [
    { from: "node_1", to: "node_2" },
    { from: "node_2", to: "node_3" },
  ],
  no_gos: ["No retry of a failed send."],
};

describe("the approach record", () => {
  it("is the order between nodes and the spec's No-Gos, and nothing else", () => {
    expect(ApproachRecordSchema.parse(record).edges).toHaveLength(2);
    expect(ApproachRecordSchema.parse({ ...record, edges: [], no_gos: [] }).no_gos).toEqual([]);
    for (const field of ["nodes", "criteria", "outcome", "transcript"]) {
      expect(ApproachRecordSchema.safeParse({ ...record, [field]: "anything" }).success).toBe(false);
    }
  });

  it("refuses an edge with an end missing", () => {
    expect(
      ApproachRecordSchema.safeParse({ ...record, edges: [{ from: "node_1" }] }).success,
    ).toBe(false);
    expect(
      ApproachRecordSchema.safeParse({ ...record, edges: [{ from: "node_1", to: "" }] }).success,
    ).toBe(false);
  });

  it("refuses a self-loop", () => {
    const result = ApproachRecordSchema.safeParse({
      ...record,
      edges: [{ from: "node_1", to: "node_1" }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("node_1");
  });

  it("refuses a duplicate edge", () => {
    const result = ApproachRecordSchema.safeParse({
      ...record,
      edges: [
        { from: "node_1", to: "node_2" },
        { from: "node_1", to: "node_2" },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("duplicate");
  });

  it("refuses a cycle", () => {
    const result = ApproachRecordSchema.safeParse({
      ...record,
      edges: [
        { from: "node_1", to: "node_2" },
        { from: "node_2", to: "node_3" },
        { from: "node_3", to: "node_1" },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("cycle");
  });
});

describe("the cycle check", () => {
  it("names the cycle it found, and nothing on a graph that has none", () => {
    expect(findCycle([{ from: "a", to: "b" }])).toBeNull();
    expect(
      findCycle([
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ]),
    ).toBeNull();
    expect(
      findCycle([
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ]),
    ).toEqual(["a", "b", "a"]);
  });

  it("works over node indices as it does over node ids, so one check serves both", () => {
    expect(
      findCycle([
        { from: 0, to: 1 },
        { from: 1, to: 0 },
      ]),
    ).toEqual([0, 1, 0]);
  });
});

describe("the approach against the plan it belongs to", () => {
  const nodes = [
    { id: "node_1", title: "one", criteria: ["ac_1"], paths: ["packages/a/**"] },
    { id: "node_2", title: "two", criteria: ["ac_2"], paths: ["packages/a/**"] },
  ];

  it("has nothing to report when every edge end is a node of the plan", () => {
    expect(
      approachProblems(
        ApproachRecordSchema.parse({ ...record, edges: [{ from: "node_1", to: "node_2" }] }),
        nodes,
      ),
    ).toEqual([]);
  });

  it("names an edge end the plan has no node for", () => {
    const problems = approachProblems(
      ApproachRecordSchema.parse({ ...record, edges: [{ from: "node_1", to: "node_9" }] }),
      nodes,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("node_9");
  });
});
