// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { App, type Route, type TaskView } from "../src/renderer/shell/App.js";
import type { Detail, Snapshot } from "../src/shared/protocol.js";
import { runnerProgress } from "../src/renderer/presentation.js";
import { HomePage } from "../src/renderer/tasks/HomePage.js";
import { TaskPage } from "../src/renderer/tasks/TaskPage.js";
import { previewBridge } from "../src/renderer/preview.js";
import { isLive } from "../src/shared/jobs.js";

// A CI runner renders this app several times slower than a laptop, and the
// library's default one-second `findBy` timeout reads as a missing button
// there. Five seconds is what the explicit waits in this file already allow.
configure({ asyncUtilTimeout: 5000 });

let client: QueryClient;
let decisionDetail: Detail;
beforeAll(async () => {
  // Keep the recorded review independent of earlier flows that finish this sample run.
  const workspace = await previewBridge.request({ kind: "snapshot" });
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
  decisionDetail = structuredClone(await previewBridge.request({
    kind: "detail", repoId: row.repoId, key: row.ticket.key,
  }));
});
beforeEach(() => {
  sessionStorage.clear();
  localStorage.removeItem("perbo:preview-editing");
  location.hash = "home";
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount() {
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function mountTaskFromHome(workspace: Snapshot, repoId: string, detail: Detail): void {
  client.setQueryData(["detail", repoId, detail.ticket.key], detail);
  function HomeTask() {
    const [route, navigate] = useState<Route>({ page: "home" });
    return route.page === "task" ? (
      <TaskPage
        workspace={workspace}
        navigate={navigate}
        repoId={route.repoId}
        taskKey={route.key}
        view={route.view ?? "auto"}
        edit={false}
      />
    ) : <HomePage workspace={workspace} navigate={navigate} archive={false} />;
  }
  render(<QueryClientProvider client={client}><HomeTask /></QueryClientProvider>);
}

describe("interactive desktop flows", () => {
  it("drafts, lets the engineer edit criteria, compiles, and shows the contract before execution", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Plan a piece of work" })).getByRole("button", { name: /example\/webstore/ }));
    fireEvent.change(await screen.findByLabelText("Outcome"), {
      target: {
        value: "New users receive an activation email within sixty seconds.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Draft the criteria" }));
    await screen.findByText("Drafting your acceptance criteria");
    await screen.findByRole(
      "heading",
      { name: "Acceptance criteria" },
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit criterion 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 1" }), {
      target: { value: "Every new signup queues exactly one email." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const admitted = (await previewBridge.request({ kind: "snapshot" })).drafts!.find((draft) => draft.key)!;
    expect(admitted.key).toMatch(/^PRB-/);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    await waitFor(() => expect(within(picker).getAllByRole("button")[0]!.textContent).toContain(admitted.key!.replace(/^PRB-/, "#")));
    fireEvent.keyDown(picker, { key: "Enter" });
    await screen.findByRole("heading", { name: "Acceptance criteria" });
    expect(
      screen.getByText("Every new signup queues exactly one email."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Compile the contract",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Compile the contract" }),
    );
    await screen.findByText("Compiling your contract");
    await screen.findByRole(
      "button",
      { name: "Approve · start the loop" },
      { timeout: 5000 },
    );
    expect(
      screen.getByText("Every new signup queues exactly one email."),
    ).toBeTruthy();
    expect(document.querySelector('[data-screen="s11"]')).toBeTruthy();
    expect(screen.queryByText("Run engineering loop")).toBeNull();
    expect(location.hash).toContain(admitted.key!);
  });

  it("keeps decisions pending when leaving, allows editing the summary, and resumes after confirmation", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Answer" }));
    let dialog = await screen.findByRole("dialog", {
      name: "Decisions required",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save and continue" }),
    );
    expect(
      within(dialog).getByText("Choose an approach before continuing."),
    ).toBeTruthy();
    // Picking "Something else" hands the box under it the caret: saying the
    // answer is not on the list is already the start of writing one.
    fireEvent.click(
      within(dialog).getByRole("radio", { name: /Something else/ }),
    );
    expect(document.activeElement).toBe(
      within(dialog).getByRole("textbox", { name: "Your approach" }),
    );
    fireEvent.click(within(dialog).getAllByRole("radio")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(await screen.findByRole("button", { name: "Answer" }));
    dialog = await screen.findByRole("dialog", { name: "Decisions required" });
    expect(
      (within(dialog).getAllByRole("radio")[0] as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save and continue" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Let it decide" }),
    );
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Your approach" }),
      { target: { value: "Use thirty seconds and document it." } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save and continue" }),
    );
    dialog = await screen.findByRole("dialog", {
      name: "Confirm your decisions",
    });
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "edit" })[2]!,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Your approach" }), {
      target: { value: "Use one minute and document it." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByText(/Use one minute and document it./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and resume" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(async () => {
      const workspace = await previewBridge.request({ kind: "snapshot" });
      expect(workspace.tasks.find((task) => task.ticket.key === "PRB-412")?.ticket.state)
        .toBe("pr_open");
    }, { timeout: 5000 });
  });

  it("lets the engineer select versioned skills in the existing executor picker", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Change executor model" }),
    );
    const picker = await screen.findByRole("group", {
      name: "executor model selection",
    });
    fireEvent.click(
      within(picker).getByText("Engineering skills · 0 selected"),
    );
    fireEvent.click(
      within(picker).getByRole("checkbox", { name: /Codebase design/ }),
    );
    await waitFor(() =>
      expect(
        within(picker).getByText("Engineering skills · 1 selected"),
      ).toBeTruthy(),
    );
  });

  it("never presents a completed local-only run as a published pull request", async () => {
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const row = workspace.tasks.find((row) => row.ticket.key === "PRB-377")!;
    delete row.summary;
    row.ticket.delivery = {
      ...row.ticket.delivery,
      state: "none",
      pull_request_url: null,
      pull_request_number: null,
    };
    workspace.mode = "desktop";
    workspace.tasks = [row];
    const detail = await previewBridge.request({
      kind: "detail",
      repoId: row.repoId,
      key: row.ticket.key,
    });
    detail.ticket = row.ticket;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const home = render(
      <HomePage
        workspace={workspace}
        navigate={() => undefined}
        archive={false}
      />,
      { wrapper },
    );
    expect(screen.getByText(/No pull request was created/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review result" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Merge" }),
    ).toBeNull();
    home.unmount();
    client.setQueryData(["detail", row.repoId, row.ticket.key], detail);
    render(
      <TaskPage
        workspace={workspace}
        navigate={() => undefined}
        repoId={row.repoId}
        taskKey={row.ticket.key}
        view="merge"
        edit={false}
      />,
      { wrapper },
    );
    expect(
      screen.getByRole("heading", { name: "Review the result" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Merge on GitHub" }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Refresh from GitHub",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("reports observed review and refinement instead of an earlier provisioning state", () => {
    const log =
      "  worktree /tmp/example on ayo/task at 123\n  executing\n  check test: pnpm test\n  review round 0\n  read package.json\n";
    expect(runnerProgress(log)?.stage).toBe(6);
    expect(
      runnerProgress(log + "  remediation round 1 of at most 6\n")?.stage,
    ).toBe(5);
    expect(runnerProgress("  ceilings commands 200\n")).toBeNull();
  });

  it.each(
    (["provisioning", "executing", "verifying", "independent_review"] as const).flatMap((state) =>
      (["interrupted", "failed", "cancelled", "unrecorded", "running"] as const).map((outcome) => ({ state, outcome })),
    ),
  )(
    "offers recovery for an idle $state task and preserves an active $outcome run",
    async ({ state, outcome }) => {
      const workspace = await previewBridge.request({ kind: "snapshot" });
      const row = workspace.tasks[0]!;
      const detail = await previewBridge.request({
        kind: "detail",
        repoId: row.repoId,
        key: row.ticket.key,
      });
      workspace.mode = "desktop";
      detail.ticket.state = state;
      detail.ticket.approved_at = new Date().toISOString();
      workspace.jobs = outcome === "unrecorded" ? [] : [{
        id: "interrupted-run",
        repoId: row.repoId,
        key: row.ticket.key,
        resultKey: null,
        kind: "run",
        label: "Run engineering loop",
        state: outcome,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        log: "",
        error: "The previous command did not return a result.",
        result: null,
      }];
      client.setQueryData(["detail", row.repoId, row.ticket.key], detail);
      function ReopenedTask() {
        const [view, setView] = useState<TaskView>("auto");
        return (
          <TaskPage
            workspace={workspace}
            navigate={(route) => {
              if (route.page === "task") setView(route.view ?? "auto");
            }}
            repoId={row.repoId}
            taskKey={row.ticket.key}
            view={view}
            edit={false}
          />
        );
      }
      render(<QueryClientProvider client={client}><ReopenedTask /></QueryClientProvider>);
      if (outcome === "running") {
        expect(screen.queryByRole("button", { name: "Review and recover" })).toBeNull();
        expect((screen.getByRole("button", { name: "Stop the loop" }) as HTMLButtonElement).disabled).toBe(false);
        return;
      }
      expect(screen.getByRole("heading", { name: "Ready to recover this task" })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Stop the loop" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Review and recover" }));
      expect(screen.getByRole("button", { name: "Start the loop" })).toBeTruthy();
      expect(detail.ticket.state).toBe(state);
      expect(workspace.jobs[0]?.state).toBe(outcome === "unrecorded" ? undefined : outcome);
    },
  );

  it.each(["failed", "unrecorded", "running", "stopping"] as const)(
    "uses the same recovery state on Home and the loop after a %s run",
    async (outcome) => {
      const workspace = await previewBridge.request({ kind: "snapshot" });
      const row = workspace.tasks.find((task) => task.ticket.key === "PRB-398")!;
      const newer = workspace.tasks.find((task) => task.ticket.key === "PRB-421")!;
      const detail = structuredClone(await previewBridge.request({
        kind: "detail", repoId: row.repoId, key: row.ticket.key,
      }));
      workspace.mode = "desktop";
      workspace.titles = {};
      row.ticket.state = "provisioning";
      row.ticket.updated_at = "2026-09-01T00:00:00.000Z";
      newer.ticket.state = "ready";
      newer.ticket.updated_at = "2026-09-09T00:00:00.000Z";
      delete row.summary;
      delete newer.summary;
      workspace.tasks = [newer, row];
      workspace.jobs = outcome === "unrecorded" ? [] : [{
        id: "home-run",
        repoId: row.repoId,
        key: row.ticket.key,
        resultKey: null,
        kind: "run",
        label: "Run engineering loop",
        state: outcome,
        startedAt: "2026-09-01T00:00:00.000Z",
        endedAt: outcome === "failed" ? "2026-09-01T00:01:00.000Z" : null,
        log: "",
        error: outcome === "failed" ? "The previous command failed." : null,
        result: null,
      }];
      detail.ticket = row.ticket;
      detail.attempts = [];
      mountTaskFromHome(workspace, row.repoId, detail);
      const card = screen.getByRole("button", { name: row.ticket.title });
      if (outcome === "running" || outcome === "stopping") {
        expect(screen.queryByRole("button", { name: "Review and recover" })).toBeNull();
        expect(screen.queryByText("1 ticket needs action")).toBeNull();
        expect(document.querySelector(".task-card")).not.toBe(card);
        fireEvent.click(within(card).getByRole("button", { name: "Watch" }));
        expect(screen.queryByRole("button", { name: "Review and recover" })).toBeNull();
        expect((screen.getByRole("button", { name: "Stop the loop" }) as HTMLButtonElement).disabled)
          .toBe(outcome === "stopping");
        return;
      }
      expect(screen.getByText("1 ticket needs action")).toBeTruthy();
      expect(document.querySelector(".task-card")).toBe(card);
      expect(within(card).getByText(/needs recovery/)).toBeTruthy();
      fireEvent.click(within(card).getByRole("button", { name: "Review and recover" }));
      expect(screen.getByRole("button", { name: "Start the loop" })).toBeTruthy();
      expect(detail.ticket.state).toBe("provisioning");
      expect(workspace.jobs[0]?.state).toBe(outcome === "unrecorded" ? undefined : outcome);
    },
  );

  it.each(["changes_requested", "pr_open", "provisioning"] as const)(
    "keeps canonical %s routing when an earlier run job failed",
    async (state) => {
      const workspace = await previewBridge.request({ kind: "snapshot" });
      const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
      const detail = structuredClone(decisionDetail);
      const attempt = detail.attempts.at(-1)!;
      if (!attempt.review?.findings.some((finding) => finding.closure === "human"))
        throw new Error("The fixture must carry a recorded human decision");
      const question = attempt.review.findings[0]!.statement;
      workspace.mode = "desktop";
      workspace.titles = {};
      workspace.tasks = [row];
      delete row.summary;
      row.ticket.state = state;
      row.ticket.delivery.pull_request_url = null;
      detail.ticket = row.ticket;
      if (state === "pr_open") {
        attempt.review.decision = "approve";
        attempt.review.findings = [];
        attempt.reviewDecision = "approve";
      }
      workspace.jobs = [{
        id: "completed-verdict",
        repoId: row.repoId,
        key: row.ticket.key,
        resultKey: null,
        kind: "run",
        label: "Run engineering loop",
        state: "failed",
        startedAt: "2026-09-01T00:00:00.000Z",
        endedAt: "2026-09-01T00:01:00.000Z",
        log: "",
        error: "CLI exited with code 2.",
        result: null,
      }];
      mountTaskFromHome(workspace, row.repoId, detail);
      const card = screen.getByRole("button", { name: row.ticket.title });
      if (state === "changes_requested") {
        expect(within(card).queryByRole("button", { name: "Review and recover" })).toBeNull();
        fireEvent.click(within(card).getByRole("button", { name: "Answer" }));
        const dialog = screen.getByRole("dialog", { name: "Decisions required" });
        expect(within(dialog).getByText(question)).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Paused for a decision" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Review and recover" })).toBeNull();
      } else if (state === "pr_open") {
        expect(within(card).queryByRole("button", { name: "Review and recover" })).toBeNull();
        fireEvent.click(within(card).getByRole("button", { name: "Review result" }));
        expect(screen.getByRole("heading", { name: "Review the result" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Start the loop" })).toBeNull();
      } else {
        fireEvent.click(within(card).getByRole("button", { name: "Review and recover" }));
        expect(screen.getByRole("button", { name: "Start the loop" })).toBeTruthy();
        expect(screen.queryByRole("dialog", { name: "Decisions required" })).toBeNull();
      }
      expect(workspace.jobs).toHaveLength(1);
      expect(workspace.jobs[0]?.state).toBe("failed");
      expect(detail.ticket.state).toBe(state);
    },
  );

  it.each(["PRB-398", "PRB-404"])(
    "preserves the %s preview activity when no native job exists",
    async (key) => {
      const workspace = await previewBridge.request({ kind: "snapshot" });
      const row = workspace.tasks.find((task) => task.ticket.key === key)!;
      const detail = structuredClone(await previewBridge.request({
        kind: "detail", repoId: row.repoId, key,
      }));
      workspace.mode = "preview";
      workspace.jobs = [];
      workspace.tasks = [row];
      if (!row.summary?.description || !detail.sample?.current)
        throw new Error("The activity preview must retain its supplied presentation");
      mountTaskFromHome(workspace, row.repoId, detail);
      expect(screen.getByText(row.summary.description)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Review and recover" })).toBeNull();
      expect(screen.queryByText("1 ticket needs action")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Watch" }));
      expect(screen.getByRole("heading", { name: detail.sample.current })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Review and recover" })).toBeNull();
    },
  );

  /** Starts the sample loop on a ticket, and stops it when the test is done with it. */
  async function runInProgress(key: string) {
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const row = workspace.tasks.find((task) => task.ticket.key === key)!;
    const detail = await previewBridge.request({ kind: "detail", repoId: row.repoId, key });
    const job = await previewBridge.request({
      kind: "run", repoId: row.repoId, key, digest: detail.digest,
      approve: true, publish: false, resumeFrom: null,
    });
    return {
      row, job,
      // The sample loop settles itself; a stop after that is refused as it is by the host, so only a live one is stopped.
      stop: async () => {
        const live = (await previewBridge.request({ kind: "snapshot" })).jobs.find((entry) => entry.id === job.id && isLive(entry));
        if (live) await previewBridge.request({ kind: "cancel", jobId: job.id });
      },
    };
  }

  it("drafts in planning mode while a run is going (SCP-335)", async () => {
    const running = await runInProgress("PRB-398");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Plan a piece of work" })).getByRole("button", { name: /example\/webstore/ }));
    fireEvent.change(await screen.findByLabelText("Outcome"), {
      target: { value: "Every export carries the month it covers." },
    });
    const start = await screen.findByRole("button", { name: "Draft the criteria" });
    expect((start as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(start);
    await screen.findByText("Drafting your acceptance criteria");
    // Both are in flight: the run was never in the way of the drafting.
    const live = (await previewBridge.request({ kind: "snapshot" })).jobs
      .filter((entry) => ["running", "stopping"].includes(entry.state));
    expect(live.map((entry) => entry.kind).sort()).toEqual(["draft", "run"]);
    expect(live.some((entry) => entry.id === running.job.id)).toBe(true);
    await screen.findByRole("heading", { name: "Acceptance criteria" }, { timeout: 5000 });
    await running.stop();
  });

  it("refuses a second run while one is going, and says which one is in the way (SCP-335)", async () => {
    const running = await runInProgress("PRB-404");
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const row = workspace.tasks.find((task) => task.ticket.key === "PRB-421")!;
    const detail = structuredClone(await previewBridge.request({
      kind: "detail", repoId: row.repoId, key: row.ticket.key,
    }));
    const state = row.ticket.state;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    client.setQueryData(["detail", row.repoId, row.ticket.key], detail);
    const contract = (snapshot: Snapshot) => render(
      <TaskPage workspace={snapshot} navigate={() => undefined}
        repoId={row.repoId} taskKey={row.ticket.key} view="contract" edit={false} />,
      { wrapper },
    );
    // The run the person can see disables the button that would start another.
    const aware = contract(workspace);
    expect((screen.getByRole("button", { name: /start the loop/i }) as HTMLButtonElement).disabled).toBe(true);
    aware.unmount();
    // A view that has not caught up still asks, and reads the refusal.
    contract({ ...workspace, jobs: [] });
    const start = screen.getByRole("button", { name: /start the loop/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(await screen.findByText(
      "Run engineering loop is already running. Wait for it to finish or stop it before starting this one.",
    )).toBeTruthy();
    // The refused run left the ticket where it was.
    const after = (await previewBridge.request({ kind: "snapshot" })).tasks
      .find((task) => task.ticket.key === "PRB-421")!;
    expect(after.ticket.state).toBe(state);
    await running.stop();
  });
});

/**
 * The repository's files, reached from the contract and read-only there.
 *
 * Scope is one of the four fields approval freezes, and it reads as globs; the
 * files those globs reach are what a person is actually approving. Marking is
 * deliberately absent: a mark writes the editing session's draft and reaches
 * the contract only through a compile, while approval sends the contract
 * file's digest, which a mark never changes.
 */
describe("the files a contract's scope reaches", () => {
  it("opens from the contract read-only, says what is in scope, and goes back", async () => {
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const row = workspace.tasks[0]!;
    const detail = structuredClone(
      await previewBridge.request({ kind: "detail", repoId: row.repoId, key: row.ticket.key }),
    );
    detail.ticket = { ...row.ticket, state: "plan_review", approved_at: null };
    detail.attempts = [];
    client.setQueryData(["detail", row.repoId, row.ticket.key], detail);
    function AtTheContract() {
      const [view, setView] = useState<TaskView>("contract");
      return (
        <TaskPage
          workspace={workspace}
          navigate={(next) => setView(next.page === "task" ? next.view ?? "contract" : "contract")}
          repoId={row.repoId}
          taskKey={row.ticket.key}
          view={view}
          edit={false}
        />
      );
    }
    render(
      <QueryClientProvider client={client}>
        <AtTheContract />
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Browse the files this scope reaches" }),
    );
    const tree = await screen.findByRole("tree", { name: "Tracked files" });

    // Read-only: none of the planning pane's mark controls came with it.
    expect(screen.queryByRole("group", { name: "Mark for this draft" })).toBeNull();
    expect(screen.queryByText("For this draft")).toBeNull();

    // What it says instead is whether this contract reaches a row. A collapsed
    // folder is not reached by a glob that points inside it, so the files the
    // glob names are what is asked for — the filter flattens the tree to them.
    const inside = detail.contract.scope.paths_allowed[0]!.replace(/[*?[\]].*$/, "").replace(/\/$/, "");
    fireEvent.change(screen.getByLabelText("Filter files"), { target: { value: inside } });
    await waitFor(() =>
      expect(within(tree).queryAllByText("in scope").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to the contract" }));
    await screen.findByText(/Four fields freeze when you approve/);
  });
});

/**
 * Throwing the planning away takes the ticket it drafted with it.
 *
 * Discarding used to mark the session discarded and nothing else, so a ticket
 * that planning had already drafted stayed on the board with no way back to
 * the plan it came from — a delete that deleted the way in and not the thing.
 */
describe("discarding a plan", () => {
  it("deletes the ticket it drafted, and leaves one that has run", async () => {
    const before = await previewBridge.request({ kind: "snapshot" });
    const row = before.tasks.find((each) => each.ticket.state === "plan_review") ?? before.tasks[0]!;
    const session = await previewBridge.request({
      kind: "editingOpen",
      target: { kind: "ticket", repoId: row.repoId, key: row.ticket.key },
    });
    expect(session.key).toBe(row.ticket.key);

    await previewBridge.request({ kind: "editingDiscard", id: session.id });
    const after = await previewBridge.request({ kind: "snapshot" });
    expect(after.tasks.some((each) => each.ticket.key === row.ticket.key)).toBe(false);
    expect(after.drafts?.some((draft) => draft.id === session.id) ?? false).toBe(false);
  });

  it("keeps a ticket whose loop has run, because that is work and not a draft", async () => {
    const before = await previewBridge.request({ kind: "snapshot" });
    const run = before.tasks.find(
      (each) => !["draft", "specifying", "plan_review", "ready", "plan_invalid"].includes(each.ticket.state),
    );
    if (!run) return;
    const session = await previewBridge.request({
      kind: "editingOpen",
      target: { kind: "ticket", repoId: run.repoId, key: run.ticket.key },
    });
    await previewBridge.request({ kind: "editingDiscard", id: session.id });
    const after = await previewBridge.request({ kind: "snapshot" });
    expect(after.tasks.some((each) => each.ticket.key === run.ticket.key)).toBe(true);
  });
});

/**
 * An approved contract's scope is frozen, and the freeze is the CLI's:
 * `perbo edit` refuses every state but plan_review. Nothing on the mark path
 * asked, so a mark against an approved ticket was taken and could never be
 * compiled in.
 *
 * The standing list is the one exception, and it is the half that has to be
 * shown as well: it is the repository's list rather than this ticket's, and
 * D-105 has the guard read it again when a run starts, so it binds an approved
 * ticket and is written from one.
 */
describe("marking a path on an approved contract", () => {
  it("is refused, while the repository's own standing list stays writable", async () => {
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const row = workspace.tasks.find((each) => each.ticket.approved_at) ?? workspace.tasks[0]!;
    row.ticket = { ...row.ticket, approved_at: "2026-09-01T00:00:00.000Z" };
    const session = await previewBridge.request({
      kind: "editingOpen",
      target: { kind: "ticket", repoId: row.repoId, key: row.ticket.key },
    });
    await expect(
      previewBridge.request({
        kind: "explorerMark",
        id: session.id,
        revision: session.revision,
        path: "packages/",
        mark: "allowed",
        always: null,
      }),
    ).rejects.toThrow(/approved, so its scope is frozen/);

    // The same path, on the repository's list rather than this contract's
    // scope: taken, recorded in the draft's history with the rest, and on the
    // list with the draft that wrote it, which is what lets it be taken off
    // again. A refusal that reached here would leave a person unable to
    // prohibit a path for the repository from any approved ticket.
    const marked = await previewBridge.request({
      kind: "explorerMark",
      id: session.id,
      revision: session.revision,
      path: "packages/",
      mark: "prohibited",
      always: true,
    });
    expect(marked.history.at(-1)?.summary).toBe("Always prohibit packages/** in this repository");
    expect(marked.form.draft.prohibited).toContain("packages/**");
    const listing = await previewBridge.request({ kind: "explorerList", repoId: row.repoId });
    expect(listing.standing.find((entry) => entry.path === "packages/**")?.draft).toBe(session.id);
  });
});
