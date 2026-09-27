// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import { bridge } from "../workspace/index.js";
import { TaskPage } from "./TaskPage.js";
import type { TaskView } from "../shell/route.js";
import type { AttemptView, Detail, Job, Snapshot } from "../../shared/protocol.js";

/**
 * The page a stopped run lands on (PRB-415, the sample the person stopped):
 * why the run stopped, one line each; Continue the task only after the
 * person's own stop; Plan it again as the way to change things; and the way to
 * the paused loop and back.
 */

let client: QueryClient;
let sample: { workspace: Snapshot; detail: Detail; repoId: string };
beforeAll(async () => {
  const workspace = await sampleBridge.request({ kind: "snapshot" });
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-415")!;
  const detail = await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: "PRB-415" });
  sample = { workspace, detail: { ...detail, ticket: row.ticket }, repoId: row.repoId };
});
beforeEach(() => {
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

const STARTED = "2026-09-08T04:10:00.000Z";
/** The ticket's run as a case ends it, with the attempt it recorded after it started. */
function stopped(
  run: Partial<Job>,
  attempt: Partial<AttemptView> = {},
): { workspace: Snapshot; detail: Detail } {
  const workspace = structuredClone(sample.workspace);
  const detail = structuredClone(sample.detail);
  workspace.refreshingRepos = [];
  const job = workspace.jobs.find((each) => each.key === "PRB-415" && each.kind === "run")!;
  Object.assign(job, { startedAt: STARTED, ...run });
  const last = detail.attempts.at(-1)!;
  Object.assign(last, { startedAt: "2026-09-08T04:11:00.000Z", ...attempt });
  return { workspace, detail };
}
/** The ticket's page, moving between its views as the page asks. */
function mount({ workspace, detail }: { workspace: Snapshot; detail: Detail }, start: TaskView = "auto"): void {
  client.setQueryData(["detail", sample.repoId, "PRB-415"], detail);
  function Page() {
    const [view, setView] = useState<TaskView>(start);
    return (
      <TaskPage
        workspace={workspace}
        navigate={(route) => {
          if (route.page === "task") setView(route.view ?? "auto");
        }}
        repoId={sample.repoId}
        taskKey="PRB-415"
        view={view}
        edit={false}
      />
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
}
const page = (): HTMLElement => document.querySelector<HTMLElement>('section[data-screen="stopped"]')!;
/** The reasons listed, each line's words without its `i`. */
const reasons = (): string[] =>
  [...within(page()).getByRole("list", { name: "Why the run stopped" }).querySelectorAll("li")].map(
    (line) => line.querySelector("span")!.firstChild!.textContent!.trim(),
  );
/** What the `i` on each reason holds. */
const behind = (): string[] =>
  [...within(page()).getByRole("list", { name: "Why the run stopped" }).querySelectorAll("li button")].map(
    (dot) => document.getElementById(dot.getAttribute("aria-describedby")!)!.textContent ?? "",
  );
const carryOn = (): HTMLButtonElement => screen.getByRole("button", { name: "Continue the task" }) as HTMLButtonElement;
/** The stage the wheel marks as reached. */
const wheel = (): string | null | undefined => document.querySelector(".stage-labels .current")?.textContent;

describe("the stopped page", () => {
  it("lists the person's own stop, and carries on from where they left off", async () => {
    const run = stopped({ state: "cancelled" });
    const sealed = run.detail.attempts.at(-1)!.bundles.find((bundle) => bundle.kind === "execution");
    if (!sealed) throw new Error("the stopped sample must retain an execution bundle");
    mount(run);
    expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
    expect(reasons()).toEqual(["You stopped the run."]);
    expect(behind()).toEqual([
      "The run was stopped from this desktop while its attempt was going, and the work that attempt had done is kept.",
    ]);
    expect(carryOn().disabled).toBe(false);
    expect(carryOn().title).toBe("");
    const original = bridge.request.bind(bridge);
    const sent = vi
      .spyOn(bridge, "request")
      .mockImplementation(((request: Parameters<typeof original>[0]) =>
        request.kind === "run" ? Promise.resolve(null as never) : original(request)) as typeof bridge.request);
    fireEvent.click(carryOn());
    await waitFor(() => expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(true));
    expect(sent.mock.calls.map(([request]) => request).find((request) => request.kind === "run")).toMatchObject({
      key: "PRB-415",
      approve: false,
      resumeFrom: sealed.bundle_id,
    });
  });

  const failed = (termination: string, attempt: Partial<AttemptView> = {}) =>
    stopped({ state: "failed", error: "the whole run log" }, { termination, reviewDecision: null, review: null, ...attempt });
  it.each([
    [
      "a ceiling",
      () =>
        failed("cost_ceiling_exceeded: would reach 6120000", {
          ceilings: [{ resource: "attempt_cost_micros", used: 6_120_000, ceiling: 5_000_000, hit: true }],
        }),
      ["The attempt cost $6.12 against its $5.00 limit."],
    ],
    [
      "an unlisted host",
      () => failed("unlisted_egress_host: registry.example.com is not on the resolved allow-list"),
      ["The agent reached for registry.example.com, a host the repository does not list."],
    ],
    [
      "a guard refusal",
      () =>
        failed(
          "prohibited_action: write_outside_worktree: a redirect to /tmp/out: echo a > /tmp/out; destructive_git: rewriting history: git push --force",
        ),
      [
        "The guard refused `echo a > /tmp/out`, a write outside the worktree.",
        "The guard refused `git push --force`, a destructive git operation.",
      ],
    ],
    [
      "a provider error",
      () => failed("transport_unavailable: HTTP 529 overloaded"),
      ["The model provider was unavailable, so the attempt ended without doing the work."],
    ],
    [
      "an attempt that did not complete",
      () => failed("workspace_error: the worktree could not be made"),
      ["The attempt was terminated: workspace error."],
    ],
    [
      "a limit the repository's configuration names",
      () =>
        stopped(
          {
            state: "failed",
            error:
              "the run was refused by a limit: concurrent_local_attempts would reach 2, above the limit of 1. " +
              "Raise limits.limits.concurrent_local_attempts in .perbo/config.json to allow it.",
          },
          // Refused before it recorded an attempt: the one on record is an earlier run's.
          { startedAt: "2026-09-08T04:00:00.000Z" },
        ),
      [
        "The run did not start: this repository's configuration allows one run at a time on this machine, and a run of another ticket was going.",
      ],
    ],
  ] as const)("lists %s, and holds Continue back with the sentence that points to Plan it again", (_kind, run, listed) => {
    mount(run());
    expect(reasons()).toEqual(listed);
    expect(behind().every((text) => text.length > 0)).toBe(true);
    expect(carryOn().disabled).toBe(true);
    expect(carryOn().title).toBe(
      `Continue the task carries on only from a stop you made, from Perbo closing or from a provider's usage limit, and this run stopped for ${listed.length === 1 ? "the reason" : "the reasons"} listed, ` +
        "which another attempt at the same plan would meet again. Plan it again to change the spec or the plan and start the loop over.",
    );
    // Plan it again is the way on, where the record is spent.
    expect((screen.getByRole("button", { name: "Plan it again" }) as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * Perbo closing mid-run, quit or crashed, is one event: the host ends the
   * run `interrupted` either way, and nothing about the plan or an error
   * stands in the way of carrying on.
   */
  it("carries on after Perbo closed while the run was going", () => {
    mount(stopped({ state: "interrupted", error: "Perbo closed before the command reported an outcome." }));
    expect(reasons()).toEqual(["Perbo closed while the run was going."]);
    expect(carryOn().disabled).toBe(false);
    expect(carryOn().title).toBe("");
  });

  it("says, where the record of the run is gone, that it cannot tell which stop it was", () => {
    const run = stopped({ state: "cancelled" });
    run.workspace.jobs = [];
    mount(run);
    expect(reasons()).toEqual(["Perbo holds no record of how this run ended."]);
    expect(carryOn().disabled).toBe(true);
    expect(carryOn().title).toBe(
      "Continue the task carries on only from a stop you made, from Perbo closing or from a provider's usage limit, and Perbo holds no record of " +
        "how this run ended, so it cannot tell which this was. Plan it again to change the spec or the plan and start the loop over.",
    );
    expect(carryOn().title).not.toMatch(/meet again/);
  });

  /**
   * The ticket's last run closed the gate on `outcome` with a review on
   * record that asks the person nothing — `review` shapes it, null for none
   * readable — and the declines its attempts record.
   */
  function closedGate(
    outcome: string,
    review: { decision: string } | null,
    declines: readonly string[] = [],
  ): { workspace: Snapshot; detail: Detail } {
    const run = stopped({ state: "completed", outcome: outcome as Job["outcome"], error: null });
    const template = sample.detail.attempts.findLast((attempt) => attempt.review !== null)?.review;
    for (const attempt of run.detail.attempts) {
      attempt.review = null;
      attempt.declines = [];
    }
    const last = run.detail.attempts.at(-1)!;
    if (review !== null) last.review = { ...template!, ...review, findings: [] } as AttemptView["review"];
    last.declines = declines;
    run.detail.ticket = {
      ...run.detail.ticket,
      state: "changes_requested",
      history: [
        ...run.detail.ticket.history,
        { at: "2026-09-08T04:20:00.000Z", from: "independent_review", to: "changes_requested", note: `the gate closed: ${outcome}` },
      ],
    };
    return run;
  }

  it("lands a run that closed the gate with nothing left to ask here, saying how it ended in Perbo's words", () => {
    mount(closedGate("remediation_stalled", { decision: "remediable" }));
    expect(page()).toBeTruthy();
    expect(reasons()).toEqual([
      "The refinement stalled: a round closed none of the findings it was given.",
    ]);
    expect(behind()[0]).toMatch(/Nothing on its record is left for you to answer/);
    expect(wheel()).not.toBe("decisions required");
    expect(carryOn().title).toMatch(/for the reason listed/);
  });

  it("says a run escalated on the executor's declines only where an attempt records them", () => {
    mount(closedGate("escalated", { decision: "remediable" }, ["a".repeat(64)]));
    expect(reasons()).toEqual(["The executor declined the findings left open, saying no practice determines them."]);
    expect(behind()[0]).toMatch(/perbo principle add/);
    expect(behind()[0]).not.toMatch(/Nothing on its record is left for you to answer/);
    cleanup();
    // An incomplete review that escalated with every finding the executor's: nothing was declined.
    mount(closedGate("escalated", { decision: "incomplete" }));
    expect(reasons()).toEqual(["The review escalated the run, and put nothing on its record to you."]);
    expect(behind()[0]).not.toMatch(/declined/);
  });

  it("says the review could not be read where no review is on record, rather than that nothing is asked", () => {
    mount(closedGate("remediation_stalled", null));
    expect(reasons()).toEqual(["The run's review could not be read, so nothing on it can be put to you."]);
  });

  it("has no way to the contract, and the paused loop beside Continue at the right", () => {
    mount(stopped({ state: "cancelled" }));
    const footer = page().querySelector(".stopped-actions")!;
    const buttons = [...footer.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Delete this work",
      "Plan it again",
      "View the paused loop",
      "Continue the task",
    ]);
    expect(screen.queryByRole("button", { name: "Open the contract" })).toBeNull();
    expect(footer.lastElementChild).toBe(carryOn());
    expect(carryOn().className).toContain("button--primary");
  });

  it("opens the paused loop, its Watch link as on a running ticket, and comes back", () => {
    mount(stopped({ state: "cancelled" }));
    fireEvent.click(screen.getByRole("button", { name: "View the paused loop" }));
    expect(page()).toBeNull();
    expect(document.querySelector('section[data-screen="s12"]')).not.toBeNull();
    // The person's stop heads the steps, with no card to confirm.
    expect(screen.queryByRole("dialog", { name: "The run ended" })).toBeNull();
    expect(screen.getByText("You stopped the run.")).toBeTruthy();
    const watch = screen.getByRole("button", { name: "Watch what the agents are doing" });
    expect(watch.className).toContain("button--primary");
    fireEvent.click(watch);
    expect(document.querySelector('section[data-screen="s12b"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to the paused loop" }));
    expect(document.querySelector('section[data-screen="s12"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to the stopped loop" }));
    expect(page()).not.toBeNull();
    expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
  });

  it("keeps the wheel where a run stopped at review round 2 had taken it, here and on the paused loop", () => {
    const log =
      "  worktree /tmp/w on ayo/task at 123\n  executing\n  sealing the change set\n  check test: passed\n  review round 0\n" +
      "  remediation round 1 of at most 6\n  sealing the change set\n  check test: passed\n  review round 1\n";
    mount(stopped({ state: "cancelled", log }));
    expect(wheel()).toBe("review");
    expect(document.querySelectorAll(".stage-labels .complete")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "View the paused loop" }));
    expect(wheel()).toBe("review");
  });
});

/**
 * Plan it again's confirmation in the words of the stop it follows: the
 * branch the runs left named where the records name one, and Continue the
 * task named as the way to keep the work only where it is offered.
 */
describe("Plan it again's confirmation", () => {
  beforeEach(() => {
    // jsdom has no <dialog> implementation; the confirmation only needs open and close.
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
      HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
    }
  });
  const asked = async (): Promise<string | null | undefined> => {
    fireEvent.click(screen.getByRole("button", { name: "Plan it again" }));
    return (await screen.findByRole("dialog", { name: "Plan it again" })).querySelector("p")?.textContent;
  };

  it("does not offer Continue the task as the way to keep the work after a stop it cannot carry on from", async () => {
    mount(stopped({ state: "failed", error: "the whole run log" }, { termination: "stalled", reviewDecision: null, review: null }));
    expect(carryOn().disabled).toBe(true);
    expect(await asked()).toBe(
      "Plan “Retire the legacy CSV importer” again? The work its runs built will no longer be accessible in Perbo " +
        "and remains only as the branch retry-activation-email in git. Its ticket, contract and plan, every attempt " +
        "it recorded and the evidence those attempts sealed are discarded. The spec is kept and planned again, and " +
        "nothing the runs built is carried into the new plan.",
    );
  });

  it("says the work stays on any branch the run left where no branch is recorded", async () => {
    const run = stopped({ state: "cancelled" });
    run.detail.ticket = { ...run.detail.ticket, delivery: { ...run.detail.ticket.delivery, branch: null } };
    const summary = await sampleBridge.request({ kind: "taskSummary", repoId: sample.repoId, key: "PRB-415" });
    client.setQueryData(["summary", sample.repoId, "PRB-415"], { ...summary, branch: null });
    mount(run);
    expect(carryOn().disabled).toBe(false);
    expect(await asked()).toBe(
      "Plan “Retire the legacy CSV importer” again? The work its runs built will no longer be accessible in Perbo " +
        "and remains only in git, on any branch the run left. Its ticket, contract and plan, every attempt it " +
        "recorded and the evidence those attempts sealed are discarded. The spec is kept and planned again, and " +
        "nothing the runs built is carried into the new plan. Continue the task keeps that work instead.",
    );
  });
});

/**
 * D-NEW-pass-a-limited-loop-on on the sample host: a run a provider's usage
 * limit ended says so with the reset the provider stated, and carries on two
 * ways — on another connection at once, through the contract's model picker
 * for the role that was limited, or on the same connection once the reset has
 * passed.
 */
describe("a run a provider's usage limit ended", () => {
  beforeEach(() => {
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
      HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
    }
  });
  const QUOTED = "You've hit your session limit · resets 4:30am (Europe/London)";
  /** A reset still ahead, and its label in the zone the provider stated. */
  const AHEAD = { until: "2099-01-02T04:30:00.000Z", label: "Fri 2 Jan, 04:30 (Europe/London)" };
  const PASSED = { until: "2020-01-03T04:30:00.000Z", label: "Fri 3 Jan, 04:30 (Europe/London)" };
  function limited(
    role: "executor" | "reviewer",
    provider: string,
    until: string,
    waited = false,
  ): { workspace: Snapshot; detail: Detail } {
    return stopped(
      { state: "failed", error: "the whole run log" },
      {
        termination: role === "executor" ? `transport_unavailable: the provider refused: ${QUOTED}` : "completed: done",
        reviewDecision: role === "executor" ? null : "error",
        review: role === "executor" ? null : sample.detail.attempts.at(-1)!.review,
        usageLimit: { role, provider, model: "sonnet-class", until, zone: "Europe/London", quoted: QUOTED, waited },
      },
    );
  }
  const foot = (): string[] =>
    [...page().querySelectorAll(".stopped-actions button")].map((button) => button.textContent ?? "");
  const passOn = (): HTMLButtonElement =>
    screen.getByRole("button", { name: "Continue on another model" }) as HTMLButtonElement;
  const option = (name: RegExp): HTMLElement => screen.getByRole("option", { name });
  /** The run requests the page sends, the sample host answering them. */
  const sent = () => {
    const original = bridge.request.bind(bridge);
    return vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      original(request)) as typeof bridge.request);
  };
  const runs = (spy: ReturnType<typeof sent>) =>
    spy.mock.calls.map(([request]) => request).filter((request) => request.kind === "run");

  it("says the executor's limit in one sentence, and carries the work on to another connection", async () => {
    const run = limited("executor", "claude-cli", AHEAD.until);
    const bundle = run.detail.attempts.at(-1)!.bundles.find((entry) => entry.kind === "execution")!;
    const before = await sampleBridge.request({ kind: "detail", repoId: sample.repoId, key: "PRB-415" });
    mount(run);
    expect(reasons()).toEqual([
      `Claude Code, the executor's connection, reached its usage limit, which the provider says resets ${AHEAD.label}.`,
    ]);
    expect(behind()[0]).toContain(QUOTED);
    // Two ways on, the other connection the highlighted one at the far right.
    await waitFor(() => expect(passOn().disabled).toBe(false));
    expect(foot()).toEqual([
      "Delete this work",
      "Plan it again",
      "View the paused loop",
      "Continue the task",
      "Continue on another model",
    ]);
    expect(page().querySelector(".stopped-actions")!.lastElementChild).toBe(passOn());
    expect(passOn().className).toContain("button--primary");
    // The same connection is offered, and held until the reset the provider stated.
    expect(carryOn().disabled).toBe(true);
    expect(carryOn().className).not.toContain("button--primary");
    expect(carryOn().title).toContain(`The usage limit on Claude Code holds until ${AHEAD.label}`);

    fireEvent.click(passOn());
    const dialog = await screen.findByRole("dialog", { name: "Continue on another model" });
    expect(dialog.textContent).toContain(`Claude Code reached its usage limit, which covers every model it runs until ${AHEAD.label}`);
    expect(dialog.textContent).not.toContain("The reviewer's model is part of");
    // The executor's picker, open on another connection signed in for it.
    const picker = within(dialog).getByRole("group", { name: "executor model selection" });
    expect(within(picker).getByRole("combobox", { name: "executor provider" }).textContent).toContain("Codex");
    fireEvent.click(within(picker).getByRole("combobox", { name: "executor provider" }));
    // The limited connection is there, marked, and not to be chosen — nor any of its models.
    const held = option(/^Claude Code/);
    expect(held.textContent).toBe(`Claude Code · subscription · limited until ${AHEAD.label}`);
    expect(held.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(held);
    expect(within(picker).getByRole("combobox", { name: "executor provider" }).textContent).toContain("Codex");
    fireEvent.click(option(/^OpenCode/));
    await waitFor(() => expect(within(picker).getByRole("combobox", { name: "Model" }).textContent).toContain("Big Pickle"));
    fireEvent.click(within(picker).getByRole("combobox", { name: "Model" }));
    expect(screen.queryByRole("option", { name: /Sonnet|Opus 5\.5/ })).toBeNull();
    fireEvent.click(option(/^Claude Opus 5$/));
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));

    const spy = sent();
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue on OpenCode" }));
    await waitFor(() => expect(runs(spy)).toHaveLength(1));
    expect(runs(spy)[0]).toMatchObject({
      kind: "run",
      key: "PRB-415",
      approve: false,
      resumeFrom: bundle.bundle_id,
      models: { executorProvider: "opencode-cli", executorModel: "opencode/claude-opus-5", reviewerProvider: "codex-cli" },
    });
    // Written to the ticket's models; the contract is as it was approved.
    const after = await sampleBridge.request({ kind: "snapshot" });
    expect(after.taskModels?.[sample.repoId + ":PRB-415"]).toMatchObject({
      executorProvider: "opencode-cli",
      executorModel: "opencode/claude-opus-5",
    });
    const kept = await sampleBridge.request({ kind: "detail", repoId: sample.repoId, key: "PRB-415" });
    expect(kept.contract).toEqual(before.contract);
    expect(kept.digest).toBe(before.digest);
  });

  it("opens the reviewer's picker for a review its provider refused, saying its model is part of the review's evidence", async () => {
    mount(limited("reviewer", "codex-cli", AHEAD.until));
    expect(reasons()).toEqual([
      `Codex, the reviewer's connection, reached its usage limit, which the provider says resets ${AHEAD.label}.`,
    ]);
    await waitFor(() => expect(passOn().disabled).toBe(false));
    fireEvent.click(passOn());
    const dialog = await screen.findByRole("dialog", { name: "Continue on another model" });
    expect(dialog.textContent).toContain(
      "The reviewer's model is part of what the review's evidence records: the review this run takes is recorded " +
        "as the model you choose here.",
    );
    const picker = within(dialog).getByRole("group", { name: "reviewer model selection" });
    expect(within(dialog).queryByRole("group", { name: "executor model selection" })).toBeNull();
    fireEvent.click(within(picker).getByRole("combobox", { name: "reviewer provider" }));
    expect(option(/^Codex/).getAttribute("aria-disabled")).toBe("true");
    expect(option(/^Codex/).textContent).toContain(`limited until ${AHEAD.label}`);
    fireEvent.click(option(/^Claude Code/));
    // The connection's own catalog, Opus 5.5 first where it is offered (D-093).
    await waitFor(() => expect(within(picker).getByRole("combobox", { name: "Model" }).textContent).toContain("Opus 5.5"));
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    const spy = sent();
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue on Claude Code" }));
    await waitFor(() => expect(runs(spy)).toHaveLength(1));
    expect(runs(spy)[0]).toMatchObject({
      resumeFrom: expect.stringMatching(/^bundle_/),
      models: { reviewerProvider: "claude-cli", reviewerModel: "claude-opus-5-5", executorProvider: "claude-cli" },
    });
  });

  it("says a review refused again after its reset in its own sentence, the same connection free to carry on", async () => {
    mount(limited("reviewer", "codex-cli", PASSED.until, true));
    expect(reasons()).toEqual([
      `Codex, the reviewer's connection, refused the review again after its usage limit reset ${PASSED.label}.`,
    ]);
    await waitFor(() => expect(passOn().disabled).toBe(false));
    expect(carryOn().disabled).toBe(false);
  });

  it("offers Continue the task on the same connection once the stated reset has passed", async () => {
    mount(limited("executor", "claude-cli", PASSED.until));
    await waitFor(() => expect(passOn().disabled).toBe(false));
    expect(carryOn().disabled).toBe(false);
    expect(carryOn().title).toBe("");
  });

  it("says where no other connection runs the role, and offers only Continue the task after the reset", async () => {
    const original = bridge.request.bind(bridge);
    vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind === "providers"
        ? original(request).then((providers) =>
            (providers as Array<{ id: string }>).filter((provider) => provider.id === "claude"),
          )
        : original(request)) as typeof bridge.request);
    mount(limited("executor", "claude-cli", AHEAD.until));
    expect(
      await screen.findByText(
        `No other connection that runs the executor is signed in, so the task carries on on Claude Code once its limit resets ${AHEAD.label}.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue on another model" })).toBeNull();
    expect(page().querySelector(".stopped-actions")!.lastElementChild).toBe(carryOn());
    expect(carryOn().className).toContain("button--primary");
    expect(carryOn().disabled).toBe(true);
  });

  it("offers neither for a stop that was not a usage limit", async () => {
    mount(stopped({ state: "failed", error: "the whole run log" }, { termination: "transport_unavailable: HTTP 529 overloaded", reviewDecision: null, review: null }));
    expect(reasons()).toEqual(["The model provider was unavailable, so the attempt ended without doing the work."]);
    expect(screen.queryByRole("button", { name: "Continue on another model" })).toBeNull();
    expect(screen.queryByText(/No other connection/)).toBeNull();
    expect(carryOn().disabled).toBe(true);
    expect(carryOn().title).toMatch(/^Continue the task carries on only from a stop you made/);
  });
});
