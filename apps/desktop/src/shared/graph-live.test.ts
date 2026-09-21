import { describe, expect, it } from "vitest";
import { assembleLiveGraph } from "./graph-live.js";
import type { LiveNodeInput, LiveRecords, LiveReview } from "./graph-live.js";

const FINDING = "d".repeat(64);
const REVIEWED_AT = "2026-01-02T00:00:00.000Z";

const nodes: LiveNodeInput[] = [
  { id: "node_1", paths: ["packages/queue/**"], criteria: ["ac_3"] },
  { id: "node_2", paths: ["packages/auth/**"], criteria: ["ac_1"] },
];

function review(over: Partial<LiveReview> = {}): LiveReview {
  return {
    planVersion: 2,
    createdAt: REVIEWED_AT,
    coverage: [
      {
        criterion_id: "ac_3",
        status: "met",
        verification_strength: "directly_verified",
        evidence: { location: { file: "packages/queue/retry.test.ts", line: 142 } },
      },
      { criterion_id: "ac_1", status: "met", verification_strength: "directly_verified", evidence: { ref: "unit" } },
    ],
    findings: [
      { key: FINDING, criterion_id: "ac_3", status: "open", statement: "Where should a permanently failed email go?" },
    ],
    ...over,
  };
}

function records(over: Partial<LiveRecords> = {}): LiveRecords {
  return {
    attempt: "attempt_1",
    changed: ["packages/queue/retry.ts", "packages/auth/signup.ts", "docs/activation-email.md"],
    sealed: true,
    checks: [],
    review: review(),
    closures: [],
    ...over,
  };
}

describe("what a run's records say about a plan's graph", () => {
  it("leaves a finding open while nothing has closed it", () => {
    const view = assembleLiveGraph(nodes, records(), 2);
    expect(view.attempt).toBe("attempt_1");
    expect(view.nodes[0]!.state).toBe("finding_open");
    expect(view.nodes[0]!.criteria[0]!.finding).toBe("Where should a permanently failed email go?");
  });

  /**
   * D-061: a review artifact is immutable, so a round that answers one of its
   * findings records the closure beside it rather than a second review.
   */
  it("closes a finding a round after the review answered", () => {
    const view = assembleLiveGraph(
      nodes,
      records({ closures: [{ createdAt: "2026-01-03T00:00:00.000Z", closed: [FINDING] }] }),
      2,
    );
    expect(view.nodes[0]!.state).not.toBe("finding_open");
    expect(view.nodes[0]!.criteria[0]!.finding).toBeNull();
  });

  it("does not let a closure older than the review answer it", () => {
    const view = assembleLiveGraph(
      nodes,
      records({ closures: [{ createdAt: "2026-01-01T00:00:00.000Z", closed: [FINDING] }] }),
      2,
    );
    expect(view.nodes[0]!.state).toBe("finding_open");
    expect(view.nodes[0]!.criteria[0]!.finding).toBe("Where should a permanently failed email go?");
  });

  it("reads no criterion from a review of a plan that has been re-drafted since", () => {
    const view = assembleLiveGraph(nodes, records({ review: review({ planVersion: 1 }) }), 2);
    expect(view.note).toMatch(/re-drafted since it was reviewed/);
    for (const node of view.nodes) {
      expect(node.state).not.toBe("finding_open");
      for (const criterion of node.criteria) {
        expect(criterion.state).toBe("unbound");
        expect(criterion.finding).toBeNull();
      }
    }
  });

  it("counts a check narrowed to a node's own files and not one that could not be narrowed", () => {
    const scoped = (scope: string): LiveRecords =>
      records({ checks: [{ name: "Tests", status: "failed", node: { id: "node_2", scope } }] });
    expect(assembleLiveGraph(nodes, scoped("files"), 2).nodes[1]!.checks).toEqual([
      { name: "Tests", status: "failed" },
    ]);
    expect(assembleLiveGraph(nodes, scoped("files"), 2).nodes[1]!.state).toBe("checks_failed");
    expect(assembleLiveGraph(nodes, scoped("task"), 2).nodes[1]!.checks).toEqual([]);
    expect(assembleLiveGraph(nodes, scoped("task"), 2).nodes[1]!.state).not.toBe("checks_failed");
  });

  it("says so when a sealed change set could not be read", () => {
    const view = assembleLiveGraph(nodes, records({ changed: null, sealed: true }), 2);
    expect(view.note).toMatch(/sealed change set is not in the bundle store/);
    expect(view.nodes.every((node) => node.changed.length === 0)).toBe(true);
  });

  it("carries the paths no node names as outside, and nothing for a flat plan", () => {
    expect(assembleLiveGraph(nodes, records(), 2).outside).toEqual(["docs/activation-email.md"]);
    expect(assembleLiveGraph([], records(), 2).outside).toEqual([]);
  });

  it("reads every node as untouched before a run", () => {
    const view = assembleLiveGraph(
      nodes,
      { attempt: null, changed: [], sealed: false, checks: [], review: null, closures: [] },
      2,
    );
    expect(view.attempt).toBeNull();
    expect(view.note).toBeNull();
    for (const node of view.nodes) {
      expect(node.state).toBe("untouched");
      expect(node.criteria.every((criterion) => criterion.state === "unbound")).toBe(true);
    }
  });

  it("reads a review with no plan version of its own as an account of the plan it is beside", () => {
    const view = assembleLiveGraph(nodes, records({ review: review({ planVersion: undefined }) }), 2);
    expect(view.note).toBeNull();
    expect(view.nodes[0]!.criteria[0]!.state).toBe("met");
    expect(view.nodes[0]!.criteria[0]!.evidence).toBe("packages/queue/retry.test.ts:142");
  });
});
