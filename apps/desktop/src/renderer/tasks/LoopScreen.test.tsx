// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { spokenLine, tallyLine, type Tally } from "@perbo/contracts/browser";
import { sampleBridge } from "../../sample-host/bridge.js";
import { RequestSchema, TYPED_TEXT_MAX_CHARS, type Detail, type Job, type Snapshot } from "../../shared/protocol.js";
import { typeInto } from "../../test-support/typing.js";
import { ANSWER_TOO_LONG, LoopScreen, OPTIONS_FAILED } from "./LoopScreen.js";
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
/** The steps as the page lists them, top first. */
const listed = (): HTMLElement[] =>
  [...screen.getByRole("region", { name: "Description of steps" }).children] as HTMLElement[];
/** What a step says, without its `i` or its time. */
const said = (step: HTMLElement): string => step.children[1]!.firstChild!.textContent ?? "";
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

  it("asks for a principle alone where the loop acts on no answer", async () => {
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
      // The person's own words, whether the field is open or the Architect's
      // answers came first and it opens from Something else.
      expect(
        within(dialog).getByRole("radio", { name: /^(Something else|Tell it what the product should do)/ }),
        name,
      ).toBeTruthy();
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
  it("says what ended a run in a card, with the fuller reason behind the i, and keeps it at the top of the steps once confirmed", () => {
    const run = failedRun();
    const stalled = (detail: Detail): void => {
      detail.ticket.state = "failed";
      const attempt = detail.attempts.at(-1)!;
      attempt.termination = "stalled: no tool activity for 612000ms";
      attempt.ceilings = [{ resource: "attempt_stall_ms", used: 612_000, ceiling: 600_000, hit: true }];
    };
    mount(context([run], stalled));
    // The log is not the page: what the attempt recorded is.
    expect(screen.queryByText(/THE WHOLE RUN LOG/)).toBeNull();
    const card = screen.getByRole("dialog", { name: "The run ended" });
    expect(within(card).getByText(/^The attempt stalled for 10 minutes, past its 10-minute limit\./)).toBeTruthy();
    const dot = within(card).getByRole("button", { name: "Why the run ended" });
    fireEvent.click(dot);
    expect(dot.getAttribute("aria-expanded")).toBe("true");
    expect(hint(dot)).toMatch(/^The agent showed no tool activity for 10 minutes/);

    fireEvent.click(within(card).getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog", { name: "The run ended" })).toBeNull();
    const steps = screen.getByRole("region", { name: "Description of steps" });
    const newest = steps.firstElementChild as HTMLElement;
    expect(newest.textContent).toMatch(/^The attempt stalled for 10 minutes/);
    expect(hint(within(newest).getByRole("button", { name: "Why the run ended" }))).toMatch(/^The agent showed no tool activity/);
    // Confirmed once: the same command's card is not said again.
    cleanup();
    mount(context([run], stalled));
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
    expect(closed.querySelector(".ended-sentence")?.textContent).toMatch(/^Perbo closed while the run was going\./);
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
        detail.attempts = [];
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
    expect(listed().map(said)).toEqual(["1 attempt executed", "run started"]);
    expect(listed().map((step) => step.querySelector("time")?.dateTime)).toEqual([
      "2026-09-08T09:45:00.000Z",
      "2026-09-08T09:39:00.000Z",
    ]);
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

describe("the steps a run goes through", () => {
  const start = Date.parse("2026-09-08T09:40:00.000Z");
  const minute = (n: number): string => new Date(start + n * 60_000).toISOString();
  /** A run's log as the CLI prints it: the runner's stage lines, with the executor's and the reviewer's words among them. */
  const lines = [
    "worktree /tmp/perbo/412 on perbo/412-activation-mail at 1234567",
    "executing",
    spokenLine("executor", "I will check retry: the dead-letter path first.")!,
    "Read packages/queue/retry.ts",
    "sealing the change set",
    "check Tests: pnpm test",
    "review round 0",
    spokenLine("reviewer", "Where should a permanently failed email go?")!,
  ];
  const run = (log: string, overrides: Partial<Job> = {}): Job =>
    failedRun({
      id: "run-steps",
      state: "running",
      startedAt: minute(0),
      endedAt: null,
      error: null,
      log,
      ...overrides,
    });
  /** PRB-412 with no attempt on record and a state change at `moved`. */
  const fresh = (detail: Detail): void => {
    detail.attempts = [];
    detail.ticket.history = [{ at: minute(2.5), from: "ready", to: "provisioning", note: "worktree provisioned and materialized" }];
  };
  const STAGES = ["Review round 1", "Running check Tests", "Sealing the change set", "Executing", "Provisioning the worktree"];

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists each stage a live run announces as it arrives, newest first with its time, and none of the agents' words", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const view = render(
      <QueryClientProvider client={client}>
        <LoopScreen {...context([run("")], fresh)} />
      </QueryClientProvider>,
    );
    lines.forEach((_, index) => {
      vi.setSystemTime(start + (index + 1) * 60_000);
      act(() =>
        view.rerender(
          <QueryClientProvider client={client}>
            <LoopScreen {...context([run(lines.slice(0, index + 1).map((each) => `  ${each}\n`).join(""))], fresh)} />
          </QueryClientProvider>,
        ),
      );
    });
    const steps = listed();
    expect(steps.map(said)).toEqual([...STAGES.slice(0, 3), "worktree provisioned and materialized", ...STAGES.slice(3)]);
    // Each at the moment it arrived; the state change keeps its place by its own.
    expect(steps.map((step) => step.querySelector("time")?.dateTime)).toEqual([
      minute(7),
      minute(6),
      minute(5),
      minute(2.5),
      minute(2),
      minute(1),
    ]);
    expect(steps[0]!.className).toBe("current");
    expect(steps.slice(1).every((step) => step.className === "complete")).toBe(true);
    const text = screen.getByRole("region", { name: "Description of steps" }).textContent ?? "";
    for (const words of ["dead-letter", "permanently failed", "retry.ts", "Running check retry"]) expect(text).not.toContain(words);
    // The review is still going: what it found is not known yet.
    expect(within(steps[0]!).queryByRole("button")).toBeNull();
  });

  it("rebuilds the same stages from the records once the run ended, with the check's result and the review's count behind the i", () => {
    const ended = run(lines.map((each) => `  ${each}\n`).join(""), { state: "completed", endedAt: minute(9) });
    mount(
      context([ended], (detail) => {
        fresh(detail);
        const attempt = detail.attempts.length ? detail.attempts[0]! : structuredClone(sample.detail.attempts[0]!);
        detail.attempts = [
          {
            ...attempt,
            run: 1,
            round: 0,
            startedAt: minute(1),
            checks: [{ name: "Tests", status: "passed", detail: "pnpm test\n\n12 passed" }],
            // The executor's four minutes, after which the change set is sealed and checked.
            bundles: [
              {
                kind: "execution",
                subject_id: attempt.id,
                created_at: minute(6),
                inputs: { round_kind: "execute" },
                usage: { wall_clock_ms: 4 * 60_000 },
              } as never,
            ],
            verification: null,
            review: { ...attempt.review!, created_at: minute(6) },
          },
        ];
      }),
    );
    const steps = listed();
    expect(steps.map(said)).toEqual([...STAGES.slice(0, 3), "worktree provisioned and materialized", ...STAGES.slice(3)]);
    expect(steps.map((step) => step.querySelector("time")?.dateTime)).toEqual([
      minute(6),
      minute(5),
      minute(5),
      minute(2.5),
      minute(1),
      minute(1),
    ]);
    expect(hint(within(steps[0]!).getByRole("button", { name: "What the runner recorded" }))).toBe(
      "The review left one finding open.",
    );
    expect(hint(within(steps[1]!).getByRole("button", { name: "What the runner recorded" }))).toBe(
      "Result: passed.\n\npnpm test\n\n12 passed",
    );
    expect(within(steps[2]!).queryByRole("button")).toBeNull();
    const text = screen.getByRole("region", { name: "Description of steps" }).textContent ?? "";
    expect(text).not.toContain("Where should a permanently failed email go?");
  });
});

describe("the strip of commands, spend and files", () => {
  const START = "2026-09-08T09:40:00.000Z";
  /** The strip's tiles, by their names. */
  const strip = (): Record<string, string> =>
    Object.fromEntries(
      [...document.querySelectorAll(".metric-strip > div")].map((tile) => [
        tile.querySelector("dt")!.textContent,
        tile.querySelector("dd")!.textContent,
      ]),
    );
  const tally = (over: Partial<Tally>): string =>
    "  " + tallyLine({ commands: 0, files: 0, input_tokens: 0, output_tokens: 0, micros: 0, unpriced: 0, partial: 0, ...over }) + "\n";
  const run = (log: string, ended = false): Job =>
    failedRun({
      id: "run-strip",
      state: ended ? "completed" : "running",
      startedAt: START,
      endedAt: ended ? "2026-09-08T09:50:00.000Z" : null,
      error: null,
      log,
    });
  /** PRB-412 with nothing on record, so the strip starts at zero, and a 12-minute stall window. */
  const fresh = (detail: Detail): void => {
    detail.attempts = [];
    detail.effective.stallMinutes = 12;
  };
  const page = (job: Job, change: (detail: Detail) => void = fresh) => (
    <QueryClientProvider client={client}>
      <LoopScreen {...context([job], change)} />
    </QueryClientProvider>
  );

  it("counts along with a live run's tally, reads none of the agents' words, and ends on the same figures from the records", () => {
    const view = render(page(run("  executing\n")));
    expect(strip()).toMatchObject({ Commands: "0", Spent: "$0.00 0 tokens · stops after 12 min idle", "Files touched": "0" });

    let log = "  executing\n" + tally({ commands: 1, files: 1, input_tokens: 1200, output_tokens: 34, unpriced: 1 });
    act(() => view.rerender(page(run(log))));
    // Nothing priced yet: the tokens alone.
    expect(strip()).toMatchObject({ Commands: "1", Spent: "1,234 tokens stops after 12 min idle", "Files touched": "1" });

    log +=
      "  " + spokenLine("executor", tally({ commands: 99, files: 99, micros: 9_000_000 }).trim())! + "\n" +
      "  Codex ls src\n" +
      tally({ commands: 4, files: 2, input_tokens: 4000, output_tokens: 321, micros: 1_500_000 });
    act(() => view.rerender(page(run(log))));
    const live = strip();
    expect(live).toMatchObject({ Commands: "4", Spent: "$1.50 4,321 tokens · stops after 12 min idle", "Files touched": "2" });
    expect(live["Est. time remaining"]).toBe("Not estimated");

    // The run ended and the records hold its attempt: the tiles read them, and say the same.
    act(() =>
      view.rerender(
        page(run(log, true), (detail) => {
          fresh(detail);
          const attempt = structuredClone(sample.detail.attempts[0]!);
          detail.attempts = [
            {
              ...attempt,
              startedAt: "2026-09-08T09:40:05.000Z",
              // Five asked for, one refused: the strip counts the four admitted, as the tally did.
              ceilings: [{ resource: "attempt_commands", used: 5, ceiling: null, hit: false }],
              admittedCommands: 4,
              changes: [
                { path: "src/a.ts", change_kind: "modified", additions: 1, deletions: 0 },
                { path: "src/b.ts", change_kind: "added", additions: 3, deletions: 0 },
              ],
              bundles: [
                { kind: "execution", subject_id: attempt.id, created_at: "2026-09-08T09:45:00.000Z", inputs: {}, usage: { input_tokens: 3900, output_tokens: 300, cost_micros: 1_200_000, cost_basis: "transport_reported", wall_clock_ms: 1 } },
                { kind: "review", subject_id: "rev_1", created_at: "2026-09-08T09:46:00.000Z", inputs: {}, usage: { input_tokens: 100, output_tokens: 21, cost_micros: 300_000, cost_basis: "provider_list_estimate", wall_clock_ms: 1 } },
              ] as never,
            },
          ];
        }),
      ),
    );
    expect(strip()).toEqual(live);
  });
});

describe("the Architect's answers on the decision card (D-NEW-decision-options)", () => {
  const offered = [
    { text: "Drop a permanently failed email after the last retry and log it.", recommended: false },
    { text: "Park a permanently failed email on the dead-letter queue and alert on-call.", recommended: true },
    { text: "Hand a permanently failed email to the support inbox to resend.", recommended: false },
  ];
  const findingKey = (): string => sample.detail.attempts.findLast((attempt) => attempt.review)!.review!.findings[0]!.key;
  const answers = (options = offered) => ({
    key: "PRB-412",
    review_id: "rev_sample",
    findings: [{ finding_key: findingKey(), options }],
    cached: false,
  });
  /**
   * The bridge with the options request answered by `reply`, and a decision
   * kept here rather than sent on: sent, the sample host would start the loop
   * and move the ticket every later case reads.
   */
  function answering(reply: () => Promise<unknown>) {
    const through = sampleBridge.request.bind(sampleBridge);
    const request = vi.spyOn(sampleBridge, "request").mockImplementation((async (call: { kind: string }) =>
      call.kind === "decisionOptions"
        ? reply()
        : call.kind === "decide"
          ? failedRun({ kind: "decide", state: "running", endedAt: null })
          : through(call as never)) as never);
    const calls = () => request.mock.calls.map(([call]) => call);
    return {
      asked: () => calls().filter((call) => call.kind === "decisionOptions"),
      decided: () => {
        const decided = calls().find((call) => call.kind === "decide");
        if (decided?.kind !== "decide") throw new Error("nothing was decided");
        return decided;
      },
    };
  }
  afterEach(() => vi.restoreAllMocks());
  const dialog = (): HTMLElement => screen.getByRole("dialog", { name: "Decisions required" });
  /** Each radio's answer, as the card lists them, top first. */
  const radios = (): string[] =>
    within(dialog())
      .getAllByRole("radio")
      .map((radio) => radio.closest("label")!.querySelector("strong")!.textContent ?? "");

  it("asks once as the card opens, offers the typed field meanwhile, then lists the answers with the recommended one first", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const bridge = answering(() => new Promise((done) => (resolve = done)));
    mount(context([]));
    // While the Architect is asked, the field is there at once.
    expect(within(dialog()).getByRole("textbox", { name: "Your approach" })).toBeTruthy();
    expect(within(dialog()).getByRole("status").textContent).toMatch(/The Architect is suggesting answers/);
    expect(bridge.asked()).toEqual([
      { kind: "decisionOptions", repoId: sample.repoId, key: "PRB-412", findings: [findingKey()] },
    ]);
    expect(RequestSchema.safeParse(bridge.asked()[0]).success).toBe(true);
    await act(async () => resolve(answers()));
    await within(dialog()).findByRole("radio", { name: new RegExp("^" + offered[1]!.text) });
    // The recommended one first and the Architect's order under it; Ship as it
    // is where the finding takes it; Something else last, its field closed.
    expect(radios()).toEqual([
      offered[1]!.text,
      offered[0]!.text,
      offered[2]!.text,
      "Ship as it is",
      "Something else — tell it what to do",
    ]);
    const recommended = within(dialog()).getAllByText("recommended");
    expect(recommended).toHaveLength(1);
    expect(recommended[0]!.closest("label")!.textContent).toContain(offered[1]!.text);
    expect(within(dialog()).queryByRole("textbox", { name: "Your approach" })).toBeNull();
    expect(within(dialog()).queryByRole("status")).toBeNull();
    // Every answer whole, as the Architect wrote it.
    for (const option of offered) expect(within(dialog()).getByText(option.text).textContent).toBe(option.text);
    expect(bridge.asked()).toHaveLength(1);
  });

  it("keeps Let it decide off the answers, as the button beside Save and continue, and says it by that name", async () => {
    answering(async () => answers());
    mount(context([]));
    await within(dialog()).findByRole("radio", { name: new RegExp("^" + offered[1]!.text) });
    expect(radios().some((name) => /let it decide|architect/i.test(name))).toBe(false);
    expect(within(dialog()).queryByText(/Architect.s call/)).toBeNull();
    const footer = [...dialog().querySelector(".decision-actions")!.children];
    expect(footer.at(-1)?.textContent).toBe("Save and continue");
    expect(footer.at(-2)?.textContent).toBe("Let it decide");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Let it decide" }));
    const confirm = screen.getByRole("dialog", { name: "Confirm your decisions" });
    expect(within(confirm).getByText("Let it decide — the executor chooses within the contract")).toBeTruthy();
  });

  it("sends a picked answer as the person's approach, exactly as typing it would, and moves on with Save and continue", async () => {
    const bridge = answering(async () => answers());
    mount(context([]));
    const pick = await within(dialog()).findByRole("radio", { name: new RegExp("^" + offered[0]!.text) });
    fireEvent.click(pick);
    expect((pick as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save and continue" }));
    const confirm = screen.getByRole("dialog", { name: "Confirm your decisions" });
    // Offered, not written: the confirmation says it as it was picked.
    expect(within(confirm).getByText(offered[0]!.text)).toBeTruthy();
    expect(within(confirm).queryByText("written by you, not offered")).toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm and resume" }));
    const decided = bridge.decided();
    expect(decided.decisions).toEqual([{ findingKey: findingKey(), choice: "approach", answer: offered[0]!.text }]);
    expect(decided.answer.endsWith("\n" + offered[0]!.text)).toBe(true);
    expect(RequestSchema.safeParse(decided).success).toBe(true);
  });

  it("opens the typed field from Something else, with the caret in it, and sends what is typed", async () => {
    const bridge = answering(async () => answers());
    mount(context([]));
    await within(dialog()).findByRole("radio", { name: new RegExp("^" + offered[1]!.text) });
    fireEvent.click(within(dialog()).getByRole("radio", { name: /^Something else/ }));
    const box = within(dialog()).getByRole("textbox", { name: "Your approach" });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "Keep it for a week, then drop it." } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Confirm your decisions" })).getByRole("button", {
        name: "Confirm and resume",
      }),
    );
    expect(bridge.decided().decisions[0]).toMatchObject({ choice: "approach", answer: "Keep it for a week, then drop it." });
  });

  it("walks the answers with the arrow keys without opening the field in passing, and picks one with Enter", async () => {
    answering(async () => answers());
    mount(context([]));
    await within(dialog()).findByRole("radio", { name: new RegExp("^" + offered[1]!.text) });
    const own = within(dialog()).getByRole("radio", { name: /^Something else/ });
    // An arrow key's step is reported as a click on the answer it reaches.
    fireEvent.keyDown(own, { key: "ArrowDown" });
    fireEvent.click(own);
    fireEvent.keyUp(own, { key: "ArrowDown" });
    expect((own as HTMLInputElement).checked).toBe(true);
    expect(document.activeElement).not.toBe(within(dialog()).getByRole("textbox", { name: "Your approach" }));
    const recommended = within(dialog()).getByRole("radio", { name: new RegExp("^" + offered[1]!.text) });
    fireEvent.keyDown(recommended, { key: "Enter" });
    expect((recommended as HTMLInputElement).checked).toBe(true);
    // A pick clicked again is taken back, as the chat's card takes it back.
    fireEvent.click(recommended);
    expect((recommended as HTMLInputElement).checked).toBe(false);
  });

  it("offers Ship as it is only where the finding takes it, and asks nothing about a finding with no principle to offer", async () => {
    const lastReview = (detail: Detail) => detail.attempts.findLast((attempt) => attempt.review)!.review!;
    // A principle alone: answers, and no Ship as it is.
    answering(async () => answers());
    mount(context([], (detail) => void (lastReview(detail).findings[0]!.routing = "advisory")));
    await within(dialog()).findByRole("radio", { name: new RegExp("^" + offered[1]!.text) });
    expect(radios()).not.toContain("Ship as it is");
    expect(radios()).toContain("Something else — tell it what to do");
    cleanup();
    client.clear();
    vi.restoreAllMocks();
    // Never handed to the executor: Ship as it is alone, and nothing asked.
    const bridge = answering(async () => answers());
    mount(context([], (detail) => void (lastReview(detail).findings[0]!.rule_id = "security.secret_in_diff")));
    expect(radios()).toEqual(["Ship as it is"]);
    expect(bridge.asked()).toEqual([]);
  });

  it("says in one sentence that the answers could not be fetched, with why behind the i, and keeps the typed field", async () => {
    const bridge = answering(async () => {
      throw new Error("error: the Architect cannot be asked on this machine");
    });
    mount(context([]));
    const status = await within(dialog()).findByText(OPTIONS_FAILED);
    const dot = within(status).getByRole("button", { name: "Why they could not be fetched" });
    expect(hint(dot)).toBe("error: the Architect cannot be asked on this machine");
    const box = within(dialog()).getByRole("textbox", { name: "Your approach" });
    expect(radios()).toEqual(["Ship as it is", "Tell it what the product should do"]);
    fireEvent.change(box, { target: { value: "Park it and tell on-call." } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save and continue" }));
    expect(screen.getByRole("dialog", { name: "Confirm your decisions" })).toBeTruthy();
    expect(bridge.asked()).toHaveLength(1);
  });

  it("says why an answer longer than the room the message leaves cannot be picked, beside it and whole", async () => {
    answering(async () => answers());
    // The one message every answer goes down in, headed by the task and the
    // question, leaves exactly the shortest answer's room.
    const shortest = Math.min(...offered.map((option) => option.text.length));
    const heading = "For task PRB-412:\n1. ".length + "\n".length;
    mount(
      context([], (detail) => {
        detail.attempts.findLast((attempt) => attempt.review)!.review!.findings[0]!.statement = "w".repeat(
          TYPED_TEXT_MAX_CHARS - heading - shortest,
        );
      }),
    );
    await within(dialog()).findByRole("radio", { name: new RegExp("^" + offered[1]!.text) });
    for (const option of offered) {
      const radio = within(dialog()).getByRole("radio", { name: new RegExp("^" + option.text) }) as HTMLInputElement;
      const fits = option.text.length <= shortest;
      expect(radio.disabled, option.text).toBe(!fits);
      expect(radio.closest("label")!.querySelector("p")?.textContent ?? null, option.text).toBe(
        fits ? null : ANSWER_TOO_LONG,
      );
    }
  });

  it("does not ask again for a set it already has when the card opens again", async () => {
    const bridge = answering(async () => answers());
    mount(context([]));
    await within(dialog()).findByRole("radio", { name: new RegExp("^" + offered[1]!.text) });
    cleanup();
    // Long enough for a query nothing holds any more to be let go.
    await act(() => new Promise((done) => setTimeout(done, 20)));
    mount(context([]));
    // There at once, from what was fetched.
    expect(within(dialog()).getByRole("radio", { name: new RegExp("^" + offered[1]!.text) })).toBeTruthy();
    expect(bridge.asked()).toHaveLength(1);
  });
});
