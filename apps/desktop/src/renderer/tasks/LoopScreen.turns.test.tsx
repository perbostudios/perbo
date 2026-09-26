// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { Detail, Job, Snapshot } from "../../shared/protocol.js";
import { LoopScreen } from "./LoopScreen.js";
import type { TaskContext } from "./task-context.js";

let client: QueryClient;
let sample: { workspace: Snapshot; detail: Detail; repoId: string };
beforeAll(async () => {
  const workspace = await sampleBridge.request({ kind: "snapshot" });
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
  const detail = await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: "PRB-412" });
  sample = { workspace, detail, repoId: row.repoId };
});
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

const live = (key: string | null, kind: string): Job => ({
  id: crypto.randomUUID(),
  repoId: sample.repoId,
  key,
  kind,
  label: "Run engineering loop",
  state: "running",
  startedAt: new Date().toISOString(),
  endedAt: null,
  log: "",
  error: null,
  resultKey: null,
  result: null,
});

/** PRB-412's decision, answered and at its confirm, beside the jobs given. */
function atTheConfirm(jobs: Job[]): HTMLButtonElement {
  const workspace = structuredClone(sample.workspace);
  workspace.jobs = jobs;
  workspace.refreshingRepos = [];
  const context: TaskContext = { workspace, detail: structuredClone(sample.detail), repoId: sample.repoId, navigate: vi.fn(), show: vi.fn() };
  render(
    <QueryClientProvider client={client}>
      <LoopScreen {...context} />
    </QueryClientProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Decisions required" });
  const box = within(dialog).getByRole("textbox", { name: "Your approach" });
  fireEvent.change(box, { target: { value: "Park it on the dead-letter queue." } });
  fireEvent.keyDown(box, { key: "Enter" });
  const confirm = screen.getByRole("dialog", { name: "Confirm your decisions" });
  return within(confirm).getByRole("button", { name: "Confirm and resume" }) as HTMLButtonElement;
}

/**
 * D-049, D-101: a ticket's decision waits only for that ticket's own run,
 * decision or publication, and for a readiness check of its repository;
 * another ticket's run is in nobody's way.
 */
describe("a decision beside a run", () => {
  it("is sent while another ticket's run is under way", () => {
    expect(atTheConfirm([live("PRB-404", "run")]).disabled).toBe(false);
  });

  it("waits while a readiness check of its repository is under way", () => {
    expect(atTheConfirm([{ ...live(null, "doctor"), label: "Check repository readiness" }]).disabled).toBe(true);
  });
});
