import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphView, type GraphDeps } from "./graph.js";
import { ticketPath } from "../repository/layout.js";
import type { Execute } from "../repository/git.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Ticket } from "@perbo/contracts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const at = "2026-09-19T09:00:00.000Z";
function repository(): RegisteredRepository {
  const root = mkdtempSync(join(tmpdir(), "perbo-graph-"));
  temporary.push(root);
  const path = join(root, "checkout");
  mkdirSync(join(path, ".perbo", "tickets"), { recursive: true });
  return { id: "80000000-0000-4000-8000-000000000001", name: "checkout", path };
}
const contract = {
  plan_id: "plan_00000000000001",
  version: 1,
  ticket_id: "ticket_1",
  level: "P1",
  outcome: "Make errors actionable",
  acceptance_criteria: [
    {
      id: "ac_1",
      text: "The retry button is visible",
      expected_verification: { kind: "test", assertion: "The retry button is visible" },
    },
    {
      id: "ac_2",
      text: "A person checks the copy",
      expected_verification: {
        kind: "manual",
        assertion: "A person checks the copy",
        manual_reviewer: "Lian",
        manual_reason: "Wording",
      },
    },
  ],
  nodes: [
    { id: "node_1", title: "Show the retry", criteria: ["ac_1"], paths: ["src/**"] },
    { id: "node_2", title: "Word the message", criteria: ["ac_2"], paths: ["docs/**"] },
  ],
  scope: {
    repository_id: "repo_00000000000001",
    paths_allowed: ["src/**", "docs/**"],
    paths_prohibited: ["infra/**"],
    generated_paths: [],
    expansion_budget_files: 3,
  },
  base: {
    base_commit: "a".repeat(40),
    context_manifest_hash: `sha256:${"b".repeat(64)}`,
    captured_at: at,
  },
};
const ticket = {
  key: "PRB-1",
  ticket_id: "ticket_1",
  state: "ready",
  approved_at: null,
  plan_version: 1,
  admission: { spec: { path: "specs/retry/spec.md" }, edit_count: 2 },
} as unknown as Ticket;
function deps(over: Partial<GraphDeps> = {}): GraphDeps {
  return {
    tickets: {
      ticket: () => Promise.resolve(ticket),
      contract: () => ({ contract: contract as never, digest: "d".repeat(64) }),
      bundles: () => Promise.resolve([]),
    },
    execute: (() =>
      Promise.resolve({
        code: 0,
        stdout: "src/main.ts\0docs/readme.md\0",
        stderr: "",
        cancelled: false,
      })) as Execute,
    ...over,
  };
}

describe("graphView", () => {
  it("carries the contract's nodes, its criteria and the scope it allows", async () => {
    const repo = repository();
    const view = await graphView(deps(), repo, "PRB-1");
    expect(view.nodes.map((node) => node.id)).toEqual(["node_1", "node_2"]);
    expect(view.nodes[0]?.criteria.map((each) => each.id)).toEqual(["ac_1"]);
    expect(view.pathsAllowed).toEqual(["src/**", "docs/**"]);
    expect(view.digest).toBe("d".repeat(64));
    expect(view.editCount).toBe(2);
  });

  it("says who checks a criterion a person verifies", async () => {
    const repo = repository();
    const view = await graphView(deps(), repo, "PRB-1");
    expect(view.criteria[1]?.manual).toEqual({ reviewer: "Lian", reason: "Wording" });
    expect(view.criteria[0]?.manual).toBeNull();
  });

  it("has no order where the plan has never had a graph", async () => {
    const repo = repository();
    expect((await graphView(deps(), repo, "PRB-1")).edges).toEqual([]);
  });

  it("reads the order the approach record holds", async () => {
    const repo = repository();
    writeFileSync(
      ticketPath(repo, "PRB-1", ".approach.json"),
      JSON.stringify({
        schema_version: 1,
        ticket_id: "ticket_1",
        plan_id: "plan_00000000000001",
        edges: [{ from: "node_1", to: "node_2" }],
        no_gos: [],
      }),
    );
    expect((await graphView(deps(), repo, "PRB-1")).edges).toEqual([
      { from: "node_1", to: "node_2" },
    ]);
  });

  it("refuses an approach record belonging to another plan", async () => {
    const repo = repository();
    const record = {
      schema_version: 1,
      ticket_id: "ticket_1",
      plan_id: "plan_00000000000001",
      edges: [],
      no_gos: [],
    };
    // Either half naming another plan is the same refusal: the record says
    // which ticket and which plan it orders, and both must be this one.
    for (const over of [{ ticket_id: "ticket_0000000000000000" }, { plan_id: "plan_0000000000000000" }]) {
      writeFileSync(ticketPath(repo, "PRB-1", ".approach.json"), JSON.stringify({ ...record, ...over }));
      await expect(graphView(deps(), repo, "PRB-1"), JSON.stringify(over)).rejects.toThrow(
        "approach record belongs to another plan",
      );
    }
  });

  it("refuses an approach record that is not one", async () => {
    const repo = repository();
    writeFileSync(ticketPath(repo, "PRB-1", ".approach.json"), "{not json");
    await expect(graphView(deps(), repo, "PRB-1")).rejects.toThrow(
      "could not be read as an order between its nodes",
    );
  });

  it("says a draft record that is not one could not be read, rather than the parser's line", async () => {
    const repo = repository();
    writeFileSync(ticketPath(repo, "PRB-1", ".draft.json"), "{not json");
    await expect(graphView(deps(), repo, "PRB-1")).rejects.toThrow(
      "draft record could not be read",
    );
  });

  it("carries the page beside a node where the spec folder holds one", async () => {
    const repo = repository();
    mkdirSync(join(repo.path, "specs", "retry", "nodes"), { recursive: true });
    writeFileSync(join(repo.path, "specs", "retry", "nodes", "node_1.md"), "# Show the retry\n");
    const view = await graphView(deps(), repo, "PRB-1");
    expect(view.nodes[0]?.page).toEqual({
      path: "specs/retry/nodes/node_1.md",
      text: "# Show the retry\n",
    });
    expect(view.nodes[1]?.page).toBeNull();
  });

  it("counts the plan's size over the repository's tracked files", async () => {
    const repo = repository();
    expect((await graphView(deps(), repo, "PRB-1")).size).toBeTruthy();
  });
});
