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
import { ANSWERS_OWED_NOTE } from "@perbo/contracts/browser";

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
      `Continue the task carries on only from a stop you made or from Perbo closing, and this run stopped for ${listed.length === 1 ? "the reason" : "the reasons"} listed, ` +
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
      "Continue the task carries on only from a stop you made or from Perbo closing, and Perbo holds no record of " +
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
    review: { decision: string; findings?: unknown[] } | null,
    declines: readonly { finding_key: string; reason: string }[] = [],
  ): { workspace: Snapshot; detail: Detail } {
    const run = stopped({ state: "completed", outcome: outcome as Job["outcome"], error: null });
    const template = sample.detail.attempts.findLast((attempt) => attempt.review !== null)?.review;
    for (const attempt of run.detail.attempts) {
      attempt.review = null;
      attempt.declines = [];
    }
    const last = run.detail.attempts.at(-1)!;
    if (review !== null) {
      last.review = { ...template!, ...review, findings: review.findings ?? [] } as AttemptView["review"];
      // The review's own bundle, recorded before the attempt that followed it started.
      last.bundles = [
        ...last.bundles,
        {
          ...last.bundles[0]!,
          bundle_id: "bundle_closedgate0001",
          kind: "review",
          subject_id: last.review!.review_id,
          created_at: "2026-09-08T04:10:30.000Z",
          inputs: {},
        },
      ];
    }
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
    // A stop, not a decision: the stage it stopped at, under its own name, in the stopped colour.
    expect(wheel()).toBe("review");
    expect(document.querySelector(".stage-labels .current")!.classList.contains("is-stopped")).toBe(true);
    expect(document.querySelector(".stage-labels .is-decision")).toBeNull();
    expect(carryOn().title).toMatch(/for the reason listed/);
  });

  it("lands an escalation that asks nothing here, and one the executor declined a finding on never (D-065)", () => {
    // An incomplete review that escalated with every finding the executor's: nothing is asked.
    mount(closedGate("escalated", { decision: "incomplete" }));
    expect(reasons()).toEqual(["The review escalated the run, and put nothing on its record to you."]);
    expect(behind()[0]).not.toMatch(/declined|principle add/);
    cleanup();
    // A finding the executor declined is the person's question: a pause, not a stop.
    const template = sample.detail.attempts.findLast((attempt) => attempt.review !== null)!.review!.findings[0]!;
    const declined = { ...template, key: "e".repeat(64), routing: "remediable", status: "open", closure: "executor" };
    mount(
      closedGate("escalated", { decision: "remediable", findings: [declined] }, [
        { finding_key: declined.key, reason: "A person must decide whether review runs the suite." },
      ]),
    );
    expect(document.querySelector('section[data-screen="stopped"]')).toBeNull();
    expect(screen.getByRole("dialog", { name: "Decisions required" }).textContent).toContain(
      "A person must decide whether review runs the suite.",
    );
  });

  it("reads how the run ended past a later run the loop refused for owed answers, which started nothing", () => {
    const run = closedGate("escalated", { decision: "incomplete" });
    run.detail.ticket = {
      ...run.detail.ticket,
      history: [
        ...run.detail.ticket.history,
        { at: "2026-09-08T04:30:00.000Z", from: "changes_requested", to: "ready", note: "new attempt after changes_requested" },
        { at: "2026-09-08T04:30:00.001Z", from: "ready", to: "provisioning", note: "run started against plan_1" },
        { at: "2026-09-08T04:30:01.000Z", from: "provisioning", to: "changes_requested", note: ANSWERS_OWED_NOTE },
      ],
    };
    mount(run);
    expect(reasons()).toEqual(["The review escalated the run, and put nothing on its record to you."]);
  });

  it("says the review could not be read where no review is on record, rather than that nothing is asked", () => {
    mount(closedGate("remediation_stalled", null));
    expect(reasons()).toEqual(["The run's review could not be read, so nothing on it can be put to you."]);
  });

  /**
   * The page's rule for its hovers: a hover, or the `i` behind a reason,
   * names a button only where that button can be pressed. Read off the page
   * as a person meets it, for every stop it can show.
   */
  const NAMED: ReadonlyArray<[RegExp, string]> = [
    [/Continue the task/, "Continue the task"],
    [/Plan it again/, "Plan it again"],
    [/Delete this work|delete the work/i, "Delete this work"],
    [/Refresh from GitHub/, "Refresh from GitHub"],
  ];
  const everyHoverNamesALiveButton = (): void => {
    // A disabled button's own hover says why it is disabled: it names itself,
    // and what it names besides is what this holds to the rule.
    const hovers = [
      ...[...page().querySelectorAll<HTMLElement>("[title]")].map((element) => ({
        text: element.title,
        own: element.textContent ?? "",
      })),
      ...behind().map((text) => ({ text, own: "" })),
    ].filter(({ text }) => text.length > 0);
    for (const { text, own } of hovers)
      for (const [mention, name] of NAMED)
        if (mention.test(text) && name !== own) {
          const button = screen.queryByRole("button", { name }) as HTMLButtonElement | null;
          expect(button, `"${text}" names ${name}`).not.toBeNull();
          expect(button!.disabled, `"${text}" names ${name}, which is disabled`).toBe(false);
        }
  };
  it.each([
    ["the person's stop", () => stopped({ state: "cancelled" })],
    ["Perbo closing", () => stopped({ state: "interrupted", error: "Perbo closed before the command reported an outcome." })],
    ["a failure", () => stopped({ state: "failed", error: "the whole run log" }, { termination: "stalled", reviewDecision: null, review: null })],
    [
      "a limit refusal",
      () =>
        stopped(
          {
            state: "failed",
            error:
              "the run was refused by a limit: concurrent_local_attempts would reach 2, above the limit of 1. " +
              "Raise limits.limits.concurrent_local_attempts in .perbo/config.json to allow it.",
          },
          { startedAt: "2026-09-08T04:00:00.000Z" },
        ),
    ],
    ["a changes-requested stop with nothing to ask", () => closedGate("remediation_stalled", { decision: "remediable" })],
    ["an escalation that asks nothing", () => closedGate("escalated", { decision: "incomplete" })],
    ["an unreadable review", () => closedGate("remediation_stalled", null)],
    [
      "a run whose record is gone",
      () => {
        const run = stopped({ state: "cancelled" });
        run.workspace.jobs = [];
        return run;
      },
    ],
  ] as const)("names in its hovers only buttons that can be pressed, after %s", (_stop, run) => {
    mount(run());
    everyHoverNamesALiveButton();
  });

  it("offers Plan it again where the loop ended on a verdict nobody can answer, and Continue says why not", () => {
    mount(closedGate("remediation_stalled", { decision: "remediable" }));
    expect((screen.getByRole("button", { name: "Plan it again" }) as HTMLButtonElement).disabled).toBe(false);
    expect(carryOn().disabled).toBe(true);
    expect(carryOn().title).toMatch(/Plan it again to change the spec or the plan and start the loop over\.$/);
    // Not a pause: the loop it opens is not a paused one.
    expect(screen.getByRole("button", { name: "View the loop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View the paused loop" })).toBeNull();
  });

  /** An escalated run that published (D-065): its pull request is open on GitHub. */
  const published = () => {
    const run = closedGate("escalated", { decision: "incomplete" });
    run.detail.ticket = {
      ...run.detail.ticket,
      delivery: { ...run.detail.ticket.delivery, state: "open", pull_request_number: 15, pull_request_url: "https://github.com/o/r/pull/15" },
    };
    return run;
  };

  it("offers neither Delete nor Plan it again while its pull request is open, and says why in one sentence naming it", () => {
    mount(published());
    expect(screen.queryByRole("button", { name: "Delete this work" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan it again" })).toBeNull();
    expect(
      within(page()).getAllByText(
        "PRB-415's pull request #15 is open, and that is a record this machine does not own. Close or merge it " +
          "on GitHub, then Refresh from GitHub; the work can be deleted or planned again after that.",
      ).length,
    ).toBeGreaterThan(0);
    expect(behind()[0]).not.toMatch(/Plan it again/);
    everyHoverNamesALiveButton();
  });

  it("offers Refresh from GitHub while the pull request reads open, and Delete and Plan it again once it reads closed", async () => {
    const run = published();
    mount(run);
    const original = bridge.request.bind(bridge);
    const sent = vi
      .spyOn(bridge, "request")
      .mockImplementation(((request: Parameters<typeof original>[0]) =>
        request.kind === "sync" ? Promise.resolve(null as never) : original(request)) as typeof bridge.request);
    fireEvent.click(screen.getByRole("button", { name: "Refresh from GitHub" }));
    await waitFor(() => expect(sent.mock.calls.some(([request]) => request.kind === "sync")).toBe(true));
    expect(sent.mock.calls.map(([request]) => request).find((request) => request.kind === "sync")).toEqual({
      kind: "sync",
      repoId: sample.repoId,
      key: "PRB-415",
    });
    cleanup();
    // What the sync read: GitHub reports the pull request closed.
    run.detail.ticket = { ...run.detail.ticket, delivery: { ...run.detail.ticket.delivery, state: "closed" } };
    mount(run);
    expect(screen.queryByRole("button", { name: "Refresh from GitHub" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete this work" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Plan it again" }) as HTMLButtonElement).disabled).toBe(false);
    everyHoverNamesALiveButton();
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

  it("keeps the wheel at the verification a run stopped after its second review had reached, in the stopped colour, here and on the paused loop", () => {
    const log =
      "  worktree /tmp/w on ayo/task at 123\n  executing\n  sealing the change set\n  check test: passed\n  review round 0\n" +
      "  remediation round 1 of at most 6\n  sealing the change set\n  check test: passed\n  review round 1\n";
    // The attempts on record are an earlier run's: this run's log is what says how far it went.
    mount(stopped({ state: "cancelled", log }, { startedAt: "2026-09-08T04:09:00.000Z" }));
    expect(wheel()).toBe("verification");
    expect(document.querySelector(".stage-labels .current")!.classList.contains("is-stopped")).toBe(true);
    expect(document.querySelectorAll(".stage-labels .complete")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "View the paused loop" }));
    expect(wheel()).toBe("verification");
    expect(document.querySelector(".stage-labels .current")!.classList.contains("is-stopped")).toBe(true);
  });
  it("marks the stage the loop was at when it stopped, behind the fill at the furthest stage it reached", () => {
    const log =
      "  worktree /tmp/w on ayo/task at 123\n  executing\n  sealing the change set\n  check test: passed\n  review round 0\n" +
      "  remediation round 1 of at most 6\n  sealing the change set\n  check test: passed\n  review round 1\n" +
      "  remediation round 2 of at most 6\n";
    // The attempts on record are an earlier run's: this run's log is what says how far it went.
    mount(stopped({ state: "cancelled", log }, { startedAt: "2026-09-08T04:09:00.000Z" }));
    expect(wheel()).toBe("refinement");
    expect(document.querySelector(".stage-labels .current")!.classList.contains("is-stopped")).toBe(true);
    expect([...document.querySelectorAll(".stage-labels .complete")].map((step) => step.textContent)).toEqual([
      "contract",
      "execution",
      "review",
    ]);
    expect((document.querySelector(".progress-track > span") as HTMLElement).style.width).toBe("80%");
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
