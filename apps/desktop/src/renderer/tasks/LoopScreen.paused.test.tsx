// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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

/**
 * PRB-15 as the founder met it: the review routed eleven findings to the
 * executor (`remediable`), the first refinement round closed eight, the second
 * closed none, and the run ended `remediation_stalled` — a pause for the
 * person. The findings the loop left open are theirs (D-132), so the card asks
 * each with the three answers, and the Architect is asked about exactly them.
 * A run that closed the gate with nothing left to ask is not a pause.
 */
describe("a refinement that stalled", () => {
  const RULES = [
    "verification.execution_missing",
    "verification.containment_proxy",
    "verification.tag_clear_nondiscriminating",
    "verification.offline_load_not_blocked",
    "verification.browser_execution_missing",
    "verification.prompt_order_incomplete",
    "verification.no_key_membership_missing",
    "verification.containment_is_ancestry_only",
    "criterion.not_met",
    "sky.celestial_objects_occluded",
    "verification.execution_missing_2",
  ];
  const KEYS = RULES.map((_rule, at) => at.toString(16).repeat(64));
  const [FIRST, , , , FIFTH, , , , , , LAST] = KEYS;
  const STILL_OPEN = [FIRST!, FIFTH!, LAST!];
  const STALLED = "the gate closed: remediation_stalled";

  /** PRB-15's detail: its review, its two verified rounds, and the row its run wrote. */
  function stalledDetail(rounds: Array<{ given: string[]; open: string[] }>, note = STALLED): Detail {
    const detail = structuredClone(sample.detail);
    const template = detail.attempts[0]!;
    const finding = template.review!.findings[0]!;
    const review = {
      ...template.review!,
      review_id: "rev_ae72ea99e02fe90f",
      decision: "remediable" as const,
      findings: KEYS.map((key, at) => ({
        ...finding,
        key,
        rule_id: RULES[at]!,
        routing: "remediable" as const,
        closure: "executor" as const,
        blocking: false,
        status: "open" as const,
        statement: `Finding ${at + 1} of PRB-15's review.`,
      })),
    };
    const bundle = (subject_id: string, created_at: string, inputs: Record<string, string>) =>
      ({
        bundle_id: `bundle_${subject_id}`,
        kind: "review",
        subject_id,
        created_at,
        inputs,
        artifacts: [],
        usage: { input_tokens: 1, output_tokens: 1, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 1 },
      }) as never;
    detail.attempts = [
      { ...template, id: "att_6431e1fd3c812114", round: 0, review, bundles: [bundle(review.review_id, "2026-09-27T12:48:05.305Z", {})] },
      ...rounds.map(({ given, open }, at) => ({
        ...template,
        id: `att_round${at + 1}`,
        round: at + 1,
        review: null,
        reviewDecision: null,
        verification: {
          all_closed: open.length === 0,
          deterministic_failure: null,
          open_keys: open,
          per_finding: given.map((finding_key) => ({
            finding_key,
            status: open.includes(finding_key) ? "not_closed" : "closed",
            pointer: "",
          })),
        },
        bundles: [
          bundle(`cv_att_round${at + 1}`, `2026-09-27T12:5${at + 1}:00.000Z`, {
            findings_given: given.join(","),
            findings_open: open.join(","),
          }),
        ],
      })),
    ];
    detail.ticket.state = "changes_requested";
    detail.ticket.history = [
      ...detail.ticket.history,
      { at: "2026-09-27T12:53:04.517Z", from: "independent_review", to: "changes_requested", note },
    ];
    detail.verdicts = [];
    return detail;
  }
  /** The loop page over PRB-15's records, after its run completed with exit 2. */
  function mountStalled(detail: Detail): TaskContext {
    const workspace = structuredClone(sample.workspace);
    workspace.refreshingRepos = [];
    workspace.jobs = [
      {
        id: "run-15",
        repoId: sample.repoId,
        key: "PRB-412",
        kind: "run",
        label: "Run engineering loop",
        state: "completed",
        outcome: "remediation_stalled",
        startedAt: "2026-09-27T12:39:04.011Z",
        endedAt: "2026-09-27T12:53:05.000Z",
        log: "",
        error: null,
        resultKey: null,
        result: null,
      },
    ];
    const context: TaskContext = { workspace, detail, repoId: sample.repoId, navigate: vi.fn(), show: vi.fn() };
    render(
      <QueryClientProvider client={client}>
        <LoopScreen {...context} />
      </QueryClientProvider>,
    );
    return context;
  }
  const PRB_15 = [
    { given: KEYS, open: STILL_OPEN },
    { given: STILL_OPEN, open: STILL_OPEN },
  ];
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["the three the rounds left open, as PRB-15's records hold them", PRB_15, STILL_OPEN],
    ["all eleven, where no round closed any", [{ given: KEYS, open: KEYS }, { given: KEYS, open: KEYS }], KEYS],
  ])("asks %s, each with the three answers, and asks the Architect about exactly them", (_case, rounds, asked) => {
    const request = vi.spyOn(sampleBridge, "request").mockImplementation((async () => new Promise(() => undefined)) as never);
    mountStalled(stalledDetail(rounds));
    expect(screen.getByRole("heading", { name: "Paused for a decision" })).toBeTruthy();
    const dialog = screen.getByRole("dialog", { name: "Decisions required" });
    expect(dialog.textContent).toContain(`1 of ${asked.length}`);
    // The three answers: the person's approach, Let it decide, and Ship as it is.
    expect(within(dialog).getByRole("textbox", { name: "Your approach" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Let it decide" })).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: /^Ship as it is/ })).toBeTruthy();
    const options = request.mock.calls.map(([call]) => call).filter((call) => call.kind === "decisionOptions");
    expect(options).toEqual([{ kind: "decisionOptions", repoId: sample.repoId, key: "PRB-412", findings: asked }]);
    expect(document.querySelector(".stage-labels .current")?.textContent).toBe("decisions required");
  });

  it("puts the decision rightmost as the primary, with Review the result beside it", () => {
    vi.spyOn(sampleBridge, "request").mockImplementation((async () => new Promise(() => undefined)) as never);
    mountStalled(stalledDetail(PRB_15));
    const row = [...document.querySelector(".loop-actions")!.querySelectorAll("button")];
    expect(row.map((button) => button.textContent)).toEqual([
      "Open worktree",
      "Stop the loop",
      "Watch what the agents are doing",
      "Review the result",
      "Answer",
    ]);
    expect(row.at(-1)!.className).toMatch(/primary/);
    expect(row.filter((button) => /primary/.test(button.className))).toHaveLength(1);
  });

  it("says how every run ended in Perbo's words, never an outcome's name", () => {
    vi.spyOn(sampleBridge, "request").mockImplementation((async () => new Promise(() => undefined)) as never);
    mountStalled(stalledDetail(PRB_15));
    const steps = [...screen.getByRole("region", { name: "Description of steps" }).children].map(
      (step) => step.children[1]!.firstChild!.textContent ?? "",
    );
    expect(steps).toContain(
      "The refinement stalled: a round closed none of the findings it was given.",
    );
    for (const step of steps) {
      expect(step).not.toMatch(/^[a-z_]+$/);
      expect(step).not.toMatch(/remediation_stalled|the gate closed/);
    }
  });

  it("is not a pause where the rounds closed every finding and nothing is left to ask: it is a stop, and says why", () => {
    const context = mountStalled(stalledDetail([{ given: KEYS, open: [] }]));
    expect(screen.queryByRole("heading", { name: "Paused for a decision" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Decisions required" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Ready to recover this task" })).toBeTruthy();
    expect(document.querySelector(".stage-labels .current")?.textContent).not.toBe("decisions required");
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(context.show).not.toHaveBeenCalled();
  });
});
