// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { sizeEstimate } from "@perbo/contracts/browser";
import { GraphPane } from "./GraphPane.js";
import { bridge } from "../workspace/index.js";
import { editingForm } from "../../shared/contract-editing.js";
import { EditingSessionSchema } from "../../shared/protocol.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { useContractEditing } from "../contract-editor.js";
import type { Change, GraphView, Job } from "../../shared/protocol.js";

const repoId = "90000000-0000-4000-8000-000000000001";
const sessionId = "90000000-0000-4000-8000-000000000002";
const jobId = "90000000-0000-4000-8000-000000000003";
const key = "PRB-901";

afterEach(() => { vi.useRealTimers(); cleanup(); vi.restoreAllMocks(); nodes = []; });

let nodes: GraphView["nodes"] = [];
const graph = (): GraphView => ({
  key, state: "planning", approved: false, outcome: "A sample plan", nodes, criteria: nodes.flatMap((node) => node.criteria),
  edges: [], pathsAllowed: [], size: sizeEstimate({ nodes: 0, criteria: 0, files: 0, packages: 0 }),
  editCount: 0, history: [], digest: "0".repeat(64),
  live: { attempt: null, nodes: [], outside: [], note: null },
});

async function pane() {
  const workspace = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
  const form = editingForm(workspace.settings);
  const editor: ReturnType<typeof useContractEditing> = {
    session: EditingSessionSchema.parse({
      version: 1, id: sessionId, repoId, key, digest: null, revision: 0, resumeNew: false,
      lastPane: null, confirmed: null, read: null, impact: null, named: null, drift: null, change: null, interviewModel: null,
      form, phase: "editing", error: null, operation: null,
    }),
    form, repoId, record: undefined, loading: false, saving: false, submitting: null, error: null,
    update: () => undefined, submit: () => undefined, stop: () => undefined,
    discard: async () => true, retry: async () => undefined,
  };
  const listeners = new Set<(change: Change) => void>();
  vi.spyOn(bridge, "subscribe").mockImplementation((next) => {
    listeners.add(next);
    return () => { listeners.delete(next); };
  });
  let reads = 0;
  vi.spyOn(bridge, "request").mockImplementation(async (input) => {
    if (input.kind !== "graphRead") throw new Error("Unexpected request " + input.kind);
    reads += 1;
    return graph() as never;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: "always" } } });
  render(
    <QueryClientProvider client={client}>
      <GraphPane workspace={workspace} navigate={() => undefined} editor={editor} />
    </QueryClientProvider>,
  );
  await waitFor(() => { expect(reads).toBe(1); });
  return { emit: (change: Change) => { for (const listener of [...listeners]) listener(change); }, reads: () => reads };
}

const job = (): Job => ({
  id: jobId, repoId, key, kind: "run", label: "Run", state: "running",
  startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, log: "", error: null, result: null, resultKey: null,
});

/**
 * D-095: progress updates do not trigger repository reads. The pane follows a
 * run through the workspace refresh, which reads on a records change and on
 * the poll; a run's progress arrives many times a minute and moves nothing in
 * the store, so nothing is read for it here either.
 */
describe("the Graph pane's reads", () => {
  it("reads nothing while a run reports progress", async () => {
    const view = await pane();
    // The clock a read could be held behind is this test's, so nothing here
    // measures how loaded the machine is: every timer a progress update could
    // have armed runs, and the queue a read resolves through is flushed, before
    // the count is read.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let sequence = 1; sequence <= 20; sequence++)
      view.emit({ kind: "progress", sequence, job: { ...job(), log: "progress " + String(sequence) } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(view.reads()).toBe(1);
  });
});

describe("a node on the Graph pane (D-NEW-basic-and-epic-flows)", () => {
  it("says under its title how many criteria it covers and the paths expected to satisfy them", async () => {
    const criterion = { id: "ac_1", text: "It holds.", kind: "test" as const, assertion: "It holds.", requirement: null, manual: null };
    nodes = [{ id: "node_1", title: "First part", criteria: [criterion], paths: ["src/a/**", "src/b.ts"], page: null }];
    await pane();
    const node = await screen.findByRole("button", { name: "Node node_1: First part" });
    expect(node.textContent).toContain("1 criterion · src/a/** · src/b.ts");
  });
});
