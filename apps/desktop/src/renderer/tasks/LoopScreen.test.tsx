// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import { RequestSchema, TYPED_TEXT_MAX_CHARS, type Detail, type Job, type Snapshot } from "../../shared/protocol.js";
import { typeInto } from "../../test-support/typing.js";
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

describe("the three answers a question takes", () => {
  /** PRB-412's one question answered by `pick`, confirmed, and the request it sent. */
  const sent = async (pick: () => void, change?: (detail: Detail) => void) => {
    // The decision is kept here rather than sent on: sent, the sample host
    // would start the loop and move the ticket every later case reads.
    const through = sampleBridge.request.bind(sampleBridge);
    const request = vi.spyOn(sampleBridge, "request").mockImplementation((async (call: { kind: string }) =>
      call.kind === "decide" ? failedRun({ kind: "decide", state: "running", endedAt: null }) : through(call as never)) as never);
    try {
      mount(context([], change));
      pick();
      const confirm = await screen.findByRole("dialog", { name: "Confirm your decisions" });
      fireEvent.click(within(confirm).getByRole("button", { name: "Confirm and resume" }));
      const decided = request.mock.calls.map(([call]) => call).find((call) => call.kind === "decide");
      if (decided?.kind !== "decide") throw new Error("nothing was decided");
      return decided;
    } finally {
      request.mockRestore();
    }
  };
  const answered = async (pick: () => void): Promise<{ choice: string; answer: string }> =>
    (await sent(pick)).decisions[0]!;

  it("sends a typed approach as the person's own", async () => {
    const decision = await answered(() => {
      const dialog = screen.getByRole("dialog", { name: "Decisions required" });
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Your approach" }), {
        target: { value: "Park it on the dead-letter queue." },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    });
    expect(decision).toMatchObject({ choice: "approach", answer: "Park it on the dead-letter queue." });
  });

  it("holds a typed approach to the room the answer leaves where it is typed, and sends it whole without a refusal (D-NEW-nothing-shown-is-cut)", async () => {
    let held = "";
    const request = await sent(() => {
      const dialog = screen.getByRole("dialog", { name: "Decisions required" });
      const box = within(dialog).getByRole("textbox", { name: "Your approach" }) as HTMLTextAreaElement;
      typeInto(box, "w".repeat(TYPED_TEXT_MAX_CHARS + 50));
      held = box.value;
      fireEvent.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    });
    // Every answer goes down together as one principle, headed by the task and
    // each question's title: the box holds what that leaves, and not a
    // character more.
    expect(held).toBe("w".repeat(held.length));
    expect(held.length).toBeLessThan(TYPED_TEXT_MAX_CHARS);
    expect(request.answer).toHaveLength(TYPED_TEXT_MAX_CHARS);
    expect(request.answer.endsWith(held)).toBe(true);
    expect(request.decisions[0]).toMatchObject({ choice: "approach", answer: held });
    expect(RequestSchema.safeParse(request).success).toBe(true);
  });

  it("sends Let it decide as the approach left to the executor", async () => {
    const decision = await answered(() => {
      const dialog = screen.getByRole("dialog", { name: "Decisions required" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Let it decide" }));
    });
    expect(decision.choice).toBe("let_it_decide");
    expect(decision.answer).toMatch(/^Choose an approach within the approved contract and scope/);
  });

  it("offers Ship as it is as a third choice, never the one selected, and says what it does", async () => {
    mount(context([]));
    const dialog = screen.getByRole("dialog", { name: "Decisions required" });
    const ship = within(dialog).getByRole("radio", { name: /^Ship as it is/ }) as HTMLInputElement;
    expect(ship.checked).toBe(false);
    expect(within(dialog).getByText(/the change is delivered as the review saw it/)).toBeTruthy();
    cleanup();
    const decision = await answered(() => {
      const again = screen.getByRole("dialog", { name: "Decisions required" });
      fireEvent.click(within(again).getByRole("radio", { name: /^Ship as it is/ }));
      fireEvent.click(within(again).getByRole("button", { name: "Save and continue" }));
    });
    expect(decision.choice).toBe("ship_as_is");
  });

  it("offers only Ship as it is on a finding the executor is never handed", () => {
    mount(
      context([], (detail) => {
        detail.attempts.findLast((attempt) => attempt.review)!.review!.findings[0]!.rule_id = "security.secret_in_diff";
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Decisions required" });
    expect(within(dialog).queryByRole("textbox", { name: "Your approach" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Let it decide" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Ship as it is/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    expect(screen.getByRole("dialog", { name: "Confirm your decisions" })).toBeTruthy();
  });

  it("asks for a principle alone where the loop acts on no answer, as it always has", async () => {
    const lastReview = (detail: Detail) => detail.attempts.findLast((attempt) => attempt.review)!.review!;
    const cases: Record<string, (detail: Detail) => void> = {
      // A finding only its closer names a person.
      advisory: (detail) => {
        lastReview(detail).findings[0]!.routing = "advisory";
      },
      // A finding routed to a person, on a review that did not judge the whole change.
      incomplete: (detail) => {
        lastReview(detail).decision = "incomplete";
      },
      error: (detail) => {
        lastReview(detail).decision = "error";
      },
    };
    for (const [name, change] of Object.entries(cases)) {
      mount(context([], change));
      const dialog = screen.getByRole("dialog", { name: "Decisions required" });
      expect(within(dialog).getByRole("textbox", { name: "Your approach" }), name).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Let it decide" }), name).toBeTruthy();
      expect(within(dialog).queryByRole("radio", { name: /^Ship as it is/ }), name).toBeNull();
      cleanup();
      const request = await sent(() => {
        const again = screen.getByRole("dialog", { name: "Decisions required" });
        fireEvent.click(within(again).getByRole("button", { name: "Let it decide" }));
      }, change);
      expect(request.decisions, name).toEqual([]);
      expect(request.answer, name).toMatch(/Choose an approach within the approved contract and scope/);
      cleanup();
      sessionStorage.clear();
    }
  });

  it("asks nothing a standing answer already shipped as it is", () => {
    mount(
      context([], (detail) => {
        const attempt = detail.attempts.findLast((entry) => entry.review)!;
        const review = attempt.review!;
        // The loop takes an answer as of the review's bundle, and so does this.
        attempt.bundles = [
          { kind: "review", subject_id: review.review_id, created_at: review.created_at, usage: { wall_clock_ms: 0 } } as never,
        ];
        detail.verdicts = review.findings.map((finding) => ({
          review: { reference: "PRB-412" },
          finding_key: finding.key,
          decision: "decide",
          choice: "ship_as_is",
          decided_at: review.created_at,
          superseded_at: null,
        }));
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Decisions required" })).toBeNull();
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
