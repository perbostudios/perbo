// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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

/** PRB-412, paused on its one typed question, with the jobs a case gives it. */
function context(jobs: Job[], change: (detail: Detail) => void = () => undefined): TaskContext {
  const workspace = structuredClone(sample.workspace);
  const detail = structuredClone(sample.detail);
  workspace.jobs = jobs;
  workspace.refreshingRepos = [];
  change(detail);
  return { workspace, detail, repoId: sample.repoId, navigate: vi.fn(), show: vi.fn() };
}
function mount(task: TaskContext): void {
  render(
    <QueryClientProvider client={client}>
      <LoopScreen {...task} />
    </QueryClientProvider>,
  );
}
/** A run that ended `failed` before the attempt it recorded had started, as a run whose loop reached a verdict ends. */
const failedRun = (overrides: Partial<Job> = {}): Job => ({
  id: "run-" + Math.random().toString(16).slice(2),
  repoId: sample.repoId,
  key: "PRB-412",
  kind: "run",
  label: "Run engineering loop",
  state: "failed",
  startedAt: "2026-09-08T09:39:00.000Z",
  endedAt: "2026-09-08T09:45:00.000Z",
  log: "THE WHOLE RUN LOG",
  error: "THE WHOLE RUN LOG",
  resultKey: null,
  result: null,
  ...overrides,
});
/** The attempt on record as one the review asked changes of. */
const requestedChanges = (detail: Detail): void => {
  const attempt = detail.attempts.at(-1)!;
  attempt.termination = "completed: the attempt ran to its end";
  attempt.reviewDecision = "changes_requested";
  attempt.review!.decision = "changes_requested";
};
/** The fuller reason an `i` holds, whether or not it is open. */
const hint = (dot: HTMLElement): string =>
  document.getElementById(dot.getAttribute("aria-describedby")!)!.textContent ?? "";

describe("the decision card", () => {
  it("puts its buttons at the right, Save and continue rightmost", () => {
    mount(context([]));
    const dialog = screen.getByRole("dialog", { name: "Decisions required" });
    const footer = dialog.querySelector(".decision-actions")!;
    const children = [...footer.children];
    expect(children.at(-1)?.textContent).toBe("Save and continue");
    expect(children.at(-2)?.textContent).toBe("Let it decide");
    // Everything to the left of the spacer; the buttons after it.
    const spacer = children.findIndex((child) => child.classList.contains("spacer"));
    expect(spacer).toBe(children.length - 3);
    expect(children.slice(0, spacer).some((child) => child.tagName === "BUTTON")).toBe(false);
  });

  it("sends a typed answer on Enter, as Save and continue does, and nothing when nothing is typed", () => {
    mount(context([]));
    const dialog = screen.getByRole("dialog", { name: "Decisions required" });
    const box = within(dialog).getByRole("textbox", { name: "Your approach" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Decisions required" })).toBeTruthy();
    expect(screen.queryByText("Write your approach before continuing.")).toBeNull();
    fireEvent.change(box, { target: { value: "Park it on the dead-letter queue." } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Decisions required" })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    const confirm = screen.getByRole("dialog", { name: "Confirm your decisions" });
    expect(within(confirm).getByText(/Park it on the dead-letter queue\./)).toBeTruthy();
  });
});

describe("what ended the run", () => {
  it("says the review requested changes in a card, with its findings behind the i, and keeps it at the top of the steps once confirmed", () => {
    const run = failedRun();
    mount(context([run], requestedChanges));
    // The log is not the page: the verdict is.
    expect(screen.queryByText(/THE WHOLE RUN LOG/)).toBeNull();
    const card = screen.getByRole("dialog", { name: "The run ended" });
    expect(within(card).getByText(/^The review requested changes\./)).toBeTruthy();
    // The decision waits behind what ended the run.
    expect(screen.queryByRole("dialog", { name: "Decisions required" })).toBeNull();
    const dot = within(card).getByRole("button", { name: "Why the run ended" });
    fireEvent.click(dot);
    expect(dot.getAttribute("aria-expanded")).toBe("true");
    expect(hint(dot)).toContain("Where should a permanently failed email go?");

    fireEvent.click(within(card).getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog", { name: "The run ended" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Decisions required" })).toBeTruthy();
    const steps = screen.getByRole("region", { name: "Description of steps" });
    const newest = steps.firstElementChild as HTMLElement;
    expect(newest.textContent).toMatch(/^The review requested changes\./);
    expect(hint(within(newest).getByRole("button", { name: "Why the run ended" }))).toContain(
      "Where should a permanently failed email go?",
    );
    // Confirmed once: the same command's card is not said again.
    cleanup();
    mount(context([run], requestedChanges));
    expect(screen.queryByRole("dialog", { name: "The run ended" })).toBeNull();
  });

  it("says which command the guard refused, behind the i", () => {
    mount(
      context([failedRun()], (detail) => {
        detail.ticket.state = "failed";
        detail.attempts.at(-1)!.termination =
          "prohibited_action: external_communication: sending mail: grep -icE 'e-?mail' resignation-letter.md";
      }),
    );
    const card = screen.getByRole("dialog", { name: "The run ended" });
    expect(within(card).getByText(/^The attempt was terminated: the guard refused an external communication\./)).toBeTruthy();
    const dot = within(card).getByRole("button", { name: "Why the run ended" });
    fireEvent.click(dot);
    expect(hint(dot)).toBe(
      "The guard refused the command `grep -icE 'e-?mail' resignation-letter.md`: it read it as sending mail, " +
        "which is an external communication.\nSo it ended the attempt.",
    );
  });

  it("keeps a failure that is not the loop's own verdict in the command's words", () => {
    const refused = failedRun({
      // Started after the attempt on record, so that attempt is an earlier run's.
      startedAt: "2026-09-09T09:00:00.000Z",
      error: "PRB-412 was not touched: the run did not start because this machine is missing something it needs",
    });
    mount(context([refused]));
    const card = screen.getByRole("dialog", { name: "The run ended" });
    expect(within(card).getByText("The run ended before the loop recorded an attempt.", { exact: false })).toBeTruthy();
    expect(card.querySelector(".ended-log")?.textContent).toBe(refused.error);
  });

  it("titles another failed command with its own name, and says a command Perbo closed on", () => {
    const edit = failedRun({ kind: "edit", label: "Save contract edits", error: "The contract changed since you opened it." });
    mount(context([edit]));
    const card = screen.getByRole("dialog", { name: "Save contract edits failed" });
    expect(within(card).getByRole("button", { name: "Why it failed" })).toBeTruthy();
    cleanup();
    const cut = failedRun({
      state: "interrupted",
      error: "Perbo closed before the command reported an outcome. Refresh the ticket from its CLI records before starting again.",
    });
    mount(context([cut]));
    const closed = screen.getByRole("dialog", { name: "The run ended" });
    expect(closed.querySelector(".ended-sentence")?.textContent).toMatch(/^Perbo closed before the command reported an outcome\./);
    expect(closed.querySelector(".ended-log")?.textContent).toBe(cut.error);
  });
});

describe("the loop page", () => {
  it("puts its actions at the right, with Watch rightmost, and lists the steps newest first in a box of their own", () => {
    mount(
      context([], (detail) => {
        detail.ticket.history = [
          { at: "2026-09-08T09:39:00.000Z", from: "ready", to: "provisioning", note: "run started" },
          { at: "2026-09-08T09:45:00.000Z", from: "provisioning", to: "executing", note: "1 attempt executed" },
        ];
      }),
    );
    const actions = document.querySelector(".loop-actions")!;
    const children = [...actions.children];
    expect(children.at(-1)?.textContent).toBe("Watch what the agents are doing");
    expect(children.at(-2)?.textContent).toBe("Stop the loop");
    expect(children.at(-3)?.textContent).toBe("Open worktree");
    const spacer = children.findIndex((child) => child.classList.contains("spacer"));
    expect(children.slice(0, spacer).some((child) => child.tagName === "BUTTON")).toBe(false);

    const steps = screen.getByRole("region", { name: "Description of steps" });
    expect([...steps.children].map((step) => step.textContent)).toEqual(["1 attempt executed", "run started"]);
    expect(steps.closest(".loop-steps")).toBeTruthy();
    expect(document.querySelector("section.screen--loop")).toBeTruthy();
  });

  it("scrolls the steps inside their box, keeps the page scrollable as a fallback, and right-aligns a wrapped row", () => {
    const css = readFileSync(`${import.meta.dirname}/../styles.css`, "utf8");
    const rule = (selector: string): string =>
      new RegExp(`(?:^|\\n)${selector.replace(/[.>*]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    // The page itself still scrolls where the window is too short for the box.
    expect(rule(".screen--loop")).toMatch(/overflow: auto;/);
    expect(rule(".loop-actions")).toMatch(/justify-content: flex-end;/);
    expect(rule(".loop-steps > .step-history")).toMatch(/overflow-y: auto;/);
    expect(rule(".loop-steps > .step-history")).toMatch(/min-height: 0;/);
    expect(rule(".loop-body > .loop-steps")).toMatch(/flex: 1;/);
    expect(rule(".loop-body")).toMatch(/min-height: 0;/);
  });
});
