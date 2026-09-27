// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { egressQuestionLine, egressSettledLine } from "@perbo/contracts";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { Detail, Job, Snapshot } from "../../shared/protocol.js";
import { LoopScreen } from "./LoopScreen.js";
import type { TaskContext } from "./task-context.js";

/**
 * A run the CLI ended on a verdict for the person (exit 2) completed, paused
 * for them: the loop page says so and opens the decision at once, with no card
 * saying the run ended. A run that did not complete (exit 3) failed, and says
 * what ended it first.
 */

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

/** PRB-412, whose review put a question to the person, with the run a case ends and the state its records say. */
function mount(run: Partial<Job>, state: Detail["ticket"]["state"] = "changes_requested"): void {
  const workspace = structuredClone(sample.workspace);
  const detail = structuredClone(sample.detail);
  detail.ticket.state = state;
  workspace.refreshingRepos = [];
  workspace.jobs = [
    {
      id: "run-1",
      repoId: sample.repoId,
      key: "PRB-412",
      kind: "run",
      label: "Run engineering loop",
      state: "completed",
      startedAt: "2026-09-08T09:39:00.000Z",
      endedAt: "2026-09-08T09:45:00.000Z",
      log: "  ceilings commands none\n  egress allow-list: registry.npmjs.org",
      error: null,
      resultKey: null,
      result: null,
      ...run,
    },
  ];
  const context: TaskContext = { workspace, detail, repoId: sample.repoId, navigate: vi.fn(), show: vi.fn() };
  render(
    <QueryClientProvider client={client}>
      <LoopScreen {...context} />
    </QueryClientProvider>,
  );
}

describe("a run paused for the person", () => {
  it("opens the decision at once, titled as the pause, with no card saying the run ended", () => {
    mount({ outcome: "escalated" });
    expect(screen.getByRole("heading", { name: "Paused for a decision" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Decisions required" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "The run ended" })).toBeNull();
    // The decisions are the step after the review.
    expect(document.querySelector(".stage-labels .current")?.textContent).toBe("decisions required");
    expect([...document.querySelectorAll(".stage-labels .complete")].map((step) => step.textContent)).toEqual([
      "contract",
      "execution",
      "checks",
      "review",
    ]);
  });

  it("is the pause from the moment it ends, while the records still say the stage the run started at", () => {
    mount({ outcome: "escalated" }, "provisioning");
    expect(screen.getByRole("heading", { name: "Paused for a decision" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "The run ended" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Ready to recover this task" })).toBeNull();
  });

  it("says what ended a run that did not complete before anything else", () => {
    mount({ state: "failed", error: "the run did not complete: terminated" });
    expect(screen.getByRole("dialog", { name: "The run ended" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Decisions required" })).toBeNull();
  });
});

describe("a journey that ended", () => {
  it.each([
    ["pr_open", "The review is ready"],
    ["merged", "Merged"],
    ["closed", "Closed without merge"],
  ] as const)("fills the wheel at %s, every step done, titled %s rather than the last stage", (state, title) => {
    mount({ log: "  executing\n  check test: passed\n  review round 1\n" }, state);
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(document.querySelector(".stage-labels .current")).toBeNull();
    expect(document.querySelectorAll(".stage-labels .complete")).toHaveLength(6);
    expect((document.querySelector(".progress-track > span") as HTMLElement).style.width).toBe("100%");
  });
});

describe("a run waiting on the person's answer about a host", () => {
  const question = { key: "egq_0123456789abcdef", host: "registry.example.com", command: "curl https://registry.example.com" };
  const ran = "  worktree /tmp/w on ayo/task at 123\n  executing\n  check test: passed\n";
  it("is paused for a decision while the question is open, and back at the step the log names once answered", () => {
    mount({ state: "running", endedAt: null, log: ran + `  ${egressQuestionLine(question)}\n` }, "verifying");
    expect(screen.getByRole("heading", { name: "Paused for a decision" })).toBeTruthy();
    expect(document.querySelector(".stage-labels .current")?.textContent).toBe("decisions required");
    cleanup();
    mount(
      { state: "running", endedAt: null, log: ran + `  ${egressQuestionLine(question)}\n  ${egressSettledLine(question, "allowed")}\n` },
      "verifying",
    );
    expect(screen.getByRole("heading", { name: "Running deterministic checks" })).toBeTruthy();
    expect(document.querySelector(".stage-labels .current")?.textContent).toBe("checks");
  });
});
