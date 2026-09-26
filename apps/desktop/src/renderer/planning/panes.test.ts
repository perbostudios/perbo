import { describe, expect, it } from "vitest";
import { checkedLanding, confirmRoute, contractState, draftedLanding, flowFor, leftAt } from "./panes.js";
import type { OpenDraft, Snapshot } from "../../shared/protocol.js";

/** One planning, as the drafts list carries it, with its ticket's row where it has one. */
function planning(over: Partial<OpenDraft> = {}, updated = "2026-09-01T10:00:00.000Z"): Pick<Snapshot, "drafts" | "tasks"> {
  const draft: OpenDraft = {
    id: "s-1",
    repoId: "repo-1",
    key: "PRB-1",
    admitted: true,
    outcome: "Something is true.",
    phase: "editing",
    nodes: 0,
    drift: null,
    scope: { paths: ["src/**"], prohibited: [] },
    specSlug: "something",
    title: "Something",
    lastPane: null,
    confirmed: null, read: null,
    spec: "0011223344556677",
    impact: null,
    ...over,
  };
  return {
    drafts: [draft],
    tasks:
      draft.key === null
        ? []
        : ([{ repoId: draft.repoId, ticket: { key: draft.key, updated_at: updated } }] as unknown as Snapshot["tasks"]),
  };
}
const tabs = (workspace: Pick<Snapshot, "drafts" | "tasks">, current: Parameters<typeof flowFor>[2] = null): string[] =>
  flowFor(workspace, "s-1", current).panes.map((pane) => pane.label);
/** The planning with its contract reached at the state it is in. */
function reached(workspace: Pick<Snapshot, "drafts" | "tasks">): Pick<Snapshot, "drafts" | "tasks"> {
  const draft = workspace.drafts![0]!;
  return { ...workspace, drafts: [{ ...draft, lastPane: "contract", confirmed: contractState(workspace, draft) }] };
}

describe("the tabs a planning offers (D-NEW-basic-and-epic-flows)", () => {
  it("offers the Spec and the Explorer and nothing else while the spec is written", () => {
    expect(tabs(planning({ key: null }))).toEqual(["Spec", "Explorer"]);
    // Not even a contract asked for by address: there is none yet.
    expect(tabs(planning({ key: null }), "contract")).toEqual(["Spec", "Explorer"]);
  });

  it("offers a flat plan no Graph, Impact only where its check found something, and its contract while on it", () => {
    expect(tabs(planning())).toEqual(["Spec", "Explorer"]);
    expect(tabs(planning({ impact: 0 }))).toEqual(["Spec", "Explorer"]);
    expect(tabs(planning({ impact: 2 }))).toEqual(["Spec", "Explorer", "Impact"]);
    expect(tabs(planning({ impact: 2 }), "contract")).toEqual(["Spec", "Explorer", "Impact", "Confirm contract"]);
  });

  it("offers a flat plan Problems only while the reading has some open, as its lowest tab", () => {
    expect(tabs(planning({ drift: null }))).not.toContain("Problems");
    expect(tabs(planning({ drift: { open: 0, resolved: true } }))).not.toContain("Problems");
    expect(tabs(planning({ drift: { open: 1, resolved: false } }))).toEqual(["Spec", "Explorer", "Problems"]);
    expect(tabs(planning({ impact: 1, drift: { open: 1, resolved: false } }), "contract")).toEqual([
      "Spec",
      "Explorer",
      "Impact",
      "Confirm contract",
      "Problems",
    ]);
  });

  it("offers an epic its Graph, the Explorer and Impact, and Problems while any are open, below the contract", () => {
    expect(tabs(planning({ nodes: 2 }))).toEqual(["Spec", "Graph", "Explorer", "Impact"]);
    expect(tabs(planning({ nodes: 2, drift: { open: 2, resolved: false } }), "contract")).toEqual([
      "Spec",
      "Graph",
      "Explorer",
      "Impact",
      "Confirm contract",
      "Problems",
    ]);
    expect(tabs(planning({ nodes: 2, drift: { open: 0, resolved: true } }), "contract")).not.toContain("Problems");
  });

  it("keeps the contract a tab until something changes, and not after, until it is reached again", () => {
    const left = reached(planning());
    expect(tabs(left)).toContain("Confirm contract");
    expect(leftAt(left, "s-1")).toBe("contract");
    // The spec's words moved.
    const spec = { ...left, drafts: [{ ...left.drafts![0]!, spec: "ffeeddccbbaa9988" }] };
    expect(tabs(spec)).not.toContain("Confirm contract");
    expect(leftAt(spec, "s-1")).toBeNull();
    // A mark in the Explorer.
    const marked = { ...left, drafts: [{ ...left.drafts![0]!, scope: { paths: ["src/**", "docs/**"], prohibited: [] } }] };
    expect(tabs(marked)).not.toContain("Confirm contract");
    // An edit of the plan, which moves its ticket.
    const edited = reached(planning({ nodes: 2 }));
    const moved = { ...edited, tasks: [{ ...edited.tasks[0]!, ticket: { ...edited.tasks[0]!.ticket, updated_at: "2026-09-01T11:00:00.000Z" } }] };
    expect(tabs(edited)).toContain("Confirm contract");
    expect(tabs(moved)).not.toContain("Confirm contract");
    // Reached again once the change was checked, at the state it is now in.
    expect(tabs(reached(spec))).toContain("Confirm contract");
    expect(tabs(reached(moved))).toContain("Confirm contract");
  });

  it("takes a path marked prohibited in the Explorer for a change, as it does one allowed", () => {
    const left = reached(planning());
    const prohibited = { ...left, drafts: [{ ...left.drafts![0]!, scope: { paths: ["src/**"], prohibited: ["src/secrets/**"] } }] };
    expect(tabs(prohibited)).not.toContain("Confirm contract");
    expect(tabs(reached(prohibited))).toContain("Confirm contract");
  });

  it("does not take the order of a scope for a change to it", () => {
    const left = reached(planning({ scope: { paths: ["a/**", "b/**"], prohibited: [] } }));
    const reordered = { ...left, drafts: [{ ...left.drafts![0]!, scope: { paths: ["b/**", "a/**"], prohibited: [] } }] };
    expect(tabs(reordered)).toContain("Confirm contract");
  });
});

describe("where a plan lands", () => {
  it("lands a checked basic ticket on Impact where its check flagged paths, else on its contract, and never on Problems", () => {
    expect(checkedLanding({ flagged: true })).toBe("impact");
    expect(checkedLanding({ flagged: false })).toBe("contract");
  });

  it("lands a plan drafted again on its Graph for an epic and on its contract for a basic ticket, inside the planning", () => {
    expect(draftedLanding({ sessionId: "s-1", nodes: 3 })).toEqual({ page: "planning", sessionId: "s-1", pane: "graph" });
    expect(draftedLanding({ sessionId: "s-1", nodes: 0 })).toEqual({ page: "planning", sessionId: "s-1", pane: "contract" });
  });
});

describe("what a basic ticket's Confirm contract reads (D-NEW-basic-and-epic-flows)", () => {
  it("goes to a basic ticket's contract, where it is read, and through the reading for an epic", () => {
    const way = { repoId: "repo-1", key: "PRB-1", sessionId: "s-1", approved: false };
    expect(confirmRoute({ ...way, basic: true })).toEqual({ page: "planning", sessionId: "s-1", pane: "contract" });
    expect(confirmRoute({ ...way, basic: false })).toEqual({ page: "planning", sessionId: "s-1", pane: "drift" });
    expect(confirmRoute({ ...way, approved: true, basic: true })).toEqual({ page: "task", repoId: "repo-1", key: "PRB-1", view: "contract" });
  });
});
