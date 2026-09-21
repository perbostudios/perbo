import { describe, expect, it } from "vitest";
import { EditingTargetSchema, GRAPH_NODE_STATES, RequestSchema } from "./protocol.js";

/**
 * The Graph pane's requests are closed (ADR-0023): a renderer names a
 * repository and a ticket, and — for an edit — one operation from
 * `GraphEditSchema`. A field the schema does not declare is refused at the
 * boundary, so nothing path-shaped or command-shaped can ride along beside the
 * edit and reach the CLI as an argument.
 */

const repoId = "80000000-0000-4000-8000-000000000001";
const key = "PRB-1";
const add = { op: "add_edge", from: "node_1", to: "node_2" } as const;

describe("the Graph pane's protocol", () => {
  it("takes a repository id and a ticket key to read, edit and undo", () => {
    expect(RequestSchema.safeParse({ kind: "graphRead", repoId, key }).success).toBe(true);
    expect(RequestSchema.safeParse({ kind: "graphEdit", repoId, key, edit: add }).success).toBe(true);
    expect(RequestSchema.safeParse({ kind: "graphUndo", repoId, key, edit: 2 }).success).toBe(true);
  });

  it("refuses a field it does not declare, and an edit that is not one operation", () => {
    for (const request of [
      { kind: "graphRead", repoId, key, path: "src/index.ts" },
      { kind: "graphRead", repoId, key, store: "/etc" },
      { kind: "graphEdit", repoId, key, edit: add, author: "somebody" },
      { kind: "graphEdit", repoId, key, edit: add, args: ["--repo", "/etc"] },
      { kind: "graphEdit", repoId, key, edit: { ...add, extra: 1 } },
      { kind: "graphEdit", repoId, key, edit: { op: "make_coffee" } },
      { kind: "graphEdit", repoId, key },
      { kind: "graphUndo", repoId, key, edit: 0 },
      { kind: "graphUndo", repoId, key, edit: "2" },
    ])
      expect(RequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
  });

  /**
   * SCP-317 puts the run's records on `graphRead`'s reply rather than behind a
   * request of its own, so the request still names a repository and a ticket
   * and nothing that could choose which records are read; the vocabulary a
   * node's state is drawn from is declared here and closed, the most conclusive
   * record first.
   */
  it("declares a closed vocabulary for a node's state, and takes no field for choosing records", () => {
    expect([...GRAPH_NODE_STATES]).toEqual([
      "finding_open",
      "checks_failed",
      "covered",
      "checks_passed",
      "changed",
      "untouched",
    ]);
    for (const request of [
      { kind: "graphRead", repoId, key, attempt: "att_0000000000000001" },
      { kind: "graphRead", repoId, key, changeset: "cs_0000000000000001" },
      { kind: "graphRead", repoId, key, live: true },
      { kind: "graphRead", repoId, key, bundles: "/tmp/bundles" },
    ])
      expect(RequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
  });

  it("names a ticket to open planning mode over, and nothing else", () => {
    expect(EditingTargetSchema.safeParse({ kind: "planning", repoId, key }).success).toBe(true);
    expect(EditingTargetSchema.safeParse({ kind: "planning", repoId, key, path: "x" }).success).toBe(
      false,
    );
    expect(EditingTargetSchema.safeParse({ kind: "planning", repoId }).success).toBe(false);
  });
});
