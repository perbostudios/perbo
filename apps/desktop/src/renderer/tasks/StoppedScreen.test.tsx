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
