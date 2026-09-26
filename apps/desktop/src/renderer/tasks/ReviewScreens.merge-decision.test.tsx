// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { Detail, Job, Request, Snapshot } from "../../shared/protocol.js";
import { setPlatformForTests } from "../../shared/shortcuts.js";
import { bridge } from "../workspace/index.js";
import { MergeScreen, SYNC_EVERY_MS, SYNC_POLLS } from "./ReviewScreens.js";
import type { TaskContext } from "./task-context.js";

/** PRB-377's pull request is open, #418 on the sample's webstore. */
const KEY = "PRB-377";

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the merge screen after Merge on GitHub", () => {
  let sample: { workspace: Snapshot; detail: Detail; repoId: string };
  beforeAll(async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const row = workspace.tasks.find((task) => task.ticket.key === KEY)!;
    const detail = await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: KEY });
    sample = { workspace, detail, repoId: row.repoId };
  });
  const syncJob = (state: Job["state"]): Job =>
    ({
      id: "sync-" + state,
      repoId: sample.repoId,
      key: KEY,
      kind: "sync",
      label: "Refresh from GitHub",
      state,
      startedAt: new Date().toISOString(),
      endedAt: state === "running" ? null : new Date().toISOString(),
      log: "",
      error: state === "failed" ? "gh: not signed in" : null,
      resultKey: null,
      result: null,
    }) as Job;
  /** The merge screen over PRB-377, its host answering every request at once and recording it. */
  function mergeScreen() {
    const sent: Request[] = [];
    vi.spyOn(bridge, "request").mockImplementation((async (request: Request) => {
      sent.push(request);
      return request.kind === "sync" ? syncJob("running") : null;
    }) as typeof bridge.request);
    const show = vi.fn();
    const task = (jobs: Job[], merged: boolean): TaskContext => {
      const workspace = structuredClone(sample.workspace);
      const detail = structuredClone(sample.detail);
      workspace.jobs = jobs;
      workspace.refreshingRepos = [];
      if (merged) detail.ticket.delivery = { ...detail.ticket.delivery, state: "merged" };
      return { workspace, detail, repoId: sample.repoId, navigate: vi.fn(), show };
    };
    const page = (context: TaskContext) => (
      <QueryClientProvider client={client}>
        <MergeScreen {...context} />
      </QueryClientProvider>
    );
    const rendered = render(page(task([], false)));
    return {
      sent,
      show,
      syncs: () => sent.filter((request) => request.kind === "sync").length,
      rerender: (jobs: Job[], merged = false) => rendered.rerender(page(task(jobs, merged))),
    };
  }
  const press = async (): Promise<void> => {
    fireEvent.click(screen.getByRole("button", { name: "Merge on GitHub" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
  };
  const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it("opens the pull request, checks GitHub every few seconds, a bounded number of times, and says so", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const page = mergeScreen();
    await press();
    expect(page.sent.map((request) => request.kind)).toContain("openPullRequest");
    expect(screen.getByText(/Perbo checks GitHub every few seconds and moves on as soon as it sees the merge/)).toBeTruthy();
    expect(page.syncs()).toBe(0);
    await wait(SYNC_EVERY_MS);
    expect(page.syncs()).toBe(1);
    await wait(SYNC_EVERY_MS);
    expect(page.syncs()).toBe(2);
    await wait(SYNC_EVERY_MS * (SYNC_POLLS + 5));
    expect(page.syncs()).toBe(SYNC_POLLS);
    // The checks ran out on a pull request GitHub still reports open.
    page.rerender([syncJob("completed")]);
    expect(screen.getByText("The pull request is still open on GitHub. Merge it there, then refresh its status here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh merge status" }));
    await wait(0);
    expect(page.syncs()).toBe(SYNC_POLLS + 1);
  });

  it("waits for a check still running before the next, and lands on the merged page as soon as the merge is seen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const page = mergeScreen();
    await press();
    await wait(SYNC_EVERY_MS);
    expect(page.syncs()).toBe(1);
    page.rerender([syncJob("running")]);
    await wait(SYNC_EVERY_MS * 3);
    expect(page.syncs()).toBe(1);
    expect(page.show).not.toHaveBeenCalledWith("complete");
    page.rerender([syncJob("completed")], true);
    expect(page.show).toHaveBeenCalledWith("complete");
    await wait(SYNC_EVERY_MS * 3);
    expect(page.syncs()).toBe(1);
  });

  it("checks again when the person comes back, and says the pull request is still open where it is", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const page = mergeScreen();
    await press();
    page.rerender([syncJob("completed")]);
    // Still checking on its own: nothing yet says the person is back.
    expect(screen.queryByText(/still open on GitHub/)).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await wait(0);
    expect(page.syncs()).toBe(1);
    expect(screen.getByText("The pull request is still open on GitHub. Merge it there, then refresh its status here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh merge status" })).toBeTruthy();
    // A check that failed says why.
    page.rerender([syncJob("failed")]);
    expect(screen.getByText(/gh: not signed in/)).toBeTruthy();
  });
});

/**
 * The whole app over a sample host of its own, opened on PRB-377's merge
 * screen, with every request it sends recorded.
 */
async function mergeApp() {
  vi.resetModules();
  const { sampleBridge: host } = await import("../../sample-host/bridge.js");
  const shared = window.perbo;
  window.perbo = host;
  onTestFinished(() => {
    if (shared) window.perbo = shared;
    else delete window.perbo;
  });
  const { App } = await import("../shell/App.js");
  const { bridge: appBridge } = await import("../workspace/index.js");
  const { homeGroup, homeRows } = await import("./ticket-workspace.js");
  const sent = vi.spyOn(appBridge, "request");
  const snapshot = await host.request({ kind: "snapshot" });
  const repoId = snapshot.tasks.find((row) => row.ticket.key === KEY)!.repoId;
  location.hash = ["task", repoId, KEY, "merge"].join("/");
  // As the app mounts: StrictMode's second mount of a page is no leave.
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
  await screen.findByRole("heading", { name: "Merge?" });
  const archives = () =>
    sent.mock.calls.map(([request]) => request).filter((request) => request.kind === "archive");
  const callOffs = () =>
    sent.mock.calls.map(([request]) => request).filter((request) => request.kind === "callOff");
  const row = async () => {
    const now = await host.request({ kind: "snapshot" });
    const found = now.tasks.find((task) => task.ticket.key === KEY)!;
    return {
      filed: now.archived?.includes(repoId + ":" + KEY) ?? false,
      onHome: homeRows(now).some((task) => task.ticket.key === KEY),
      group: homeGroup(now, found),
    };
  };
  return { host, repoId, archives, callOffs, row };
}
const header = (): string => document.querySelector(".page-header")!.textContent ?? "";
const box = (): HTMLElement => screen.getByRole("checkbox", { name: "Archive ticket" });

describe("the merge decision's pages", () => {
  it("lands Don't merge on the called-off page: the repository as text with its diff, Go now beside Create another ticket, and the box saying where the ticket goes", async () => {
    const app = await mergeApp();
    fireEvent.click(screen.getByRole("button", { name: "Don’t merge" }));
    expect(await screen.findByRole("heading", { name: "The merge is called off" })).toBeTruthy();
    // The press is the merge decision, recorded before the page says so.
    expect(app.callOffs()).toEqual([{ kind: "callOff", repoId: app.repoId, key: KEY }]);
    expect(document.querySelector("section[data-screen='s18']")).toBeTruthy();
    expect(header()).toMatch(/^#377\s*(Merged|Not merged)\s*example\/webstore \+\d+ −\d+$/);
    expect(document.querySelector(".page-header .repo-tag")).toBeNull();
    const actions = [...document.querySelectorAll(".completion-actions > .button")].map((button) => button.textContent);
    expect(actions).toEqual(["Go now", "Create another ticket"]);
    expect(screen.getByText("Returning you to the work list.")).toBeTruthy();
    expect(box().getAttribute("aria-checked")).toBe("true");
    const filedIn = (): string => [...document.querySelectorAll(".completion-facts > div")].at(-1)!.textContent!;
    expect(filedIn()).toBe("Filed inArchive");
    expect(screen.getByText(/the ticket is filed in the archive as you leave, with the diff, the review findings and the cost\./)).toBeTruthy();
    fireEvent.click(box());
    expect(filedIn()).toBe("Filed inHome");
    expect(screen.getByText(/the ticket stays on Home with the diff, the review findings and the cost\./)).toBeTruthy();
    fireEvent.click(box());
    expect(filedIn()).toBe("Filed inArchive");
    // Nothing is filed while the person is still on the page.
    expect(app.archives()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Go now" }));
    await waitFor(() => expect(app.archives()).toEqual([{ kind: "archive", repoId: app.repoId, keys: [KEY], archived: true }]));
    await waitFor(async () => expect(await app.row()).toMatchObject({ filed: true, onHome: false }));
    expect(await screen.findByText(`#${KEY.slice(4)} filed in the archive`)).toBeTruthy();
  });

  it("leaves a called-off ticket in Home's completed group when the box is unchecked, with Archive on its card", async () => {
    const app = await mergeApp();
    fireEvent.click(screen.getByRole("button", { name: "Don’t merge" }));
    await screen.findByRole("heading", { name: "The merge is called off" });
    fireEvent.click(box());
    fireEvent.click(screen.getByRole("button", { name: "Go now" }));
    await screen.findByText("Backfill the audit table");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.archives()).toEqual([]);
    expect(await app.row()).toEqual({ filed: false, onHome: true, group: "decided" });
    const card = screen.getByText("Backfill the audit table").closest("article")!;
    expect(card.querySelector(".stage-ring")!.getAttribute("aria-label")).toBe("Completed");
    fireEvent.click(within(card).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(app.archives()).toEqual([{ kind: "archive", repoId: app.repoId, keys: [KEY], archived: true }]));
    await waitFor(async () => expect(await app.row()).toMatchObject({ filed: true, onHome: false }));
  });

  it("lands Merge on GitHub on the merged page once a check sees the merge, and files it on the Home key", async () => {
    const app = await mergeApp();
    fireEvent.click(screen.getByRole("button", { name: "Merge on GitHub" }));
    expect(await screen.findByText(/Perbo checks GitHub every few seconds/)).toBeTruthy();
    // The sample host's check finds the merge.
    expect(await screen.findByRole("heading", { name: "example/webstore#418 is merged" }, { timeout: SYNC_EVERY_MS + 8000 })).toBeTruthy();
    expect(document.querySelector("section[data-screen='s17']")).toBeTruthy();
    expect(header()).toMatch(/^#377\s*(Merged|Not merged)\s*example\/webstore \+\d+ −\d+$/);
    expect(screen.getByText(/contract, findings and cost — is filed in the archive as you leave\./)).toBeTruthy();
    setPlatformForTests(true);
    try {
      fireEvent.keyDown(window, { key: "2", metaKey: true });
    } finally {
      setPlatformForTests(null);
    }
    await waitFor(() => expect(app.archives()).toEqual([{ kind: "archive", repoId: app.repoId, keys: [KEY], archived: true }]));
    await waitFor(async () => expect(await app.row()).toMatchObject({ filed: true, onHome: false }));
  }, 30_000);

  /** PRB-377 merged on the sample host, and its merged page open. */
  async function mergedPage() {
    const app = await mergeApp();
    const job = await app.host.request({ kind: "sync", repoId: app.repoId, key: KEY });
    await waitFor(async () => {
      const now = await app.host.request({ kind: "snapshot" });
      expect(now.jobs.find((entry) => entry.id === job.id)?.state).toBe("completed");
    });
    act(() => {
      location.hash = ["task", app.repoId, KEY, "complete"].join("/");
    });
    await screen.findByRole("heading", { name: "example/webstore#418 is merged" });
    return app;
  }

  it("files the merged ticket on the timed return", async () => {
    const app = await mergedPage();
    expect(screen.getByText(/^[0-3]s$/)).toBeTruthy();
    await waitFor(() => expect(location.hash).toBe("#home"), { timeout: 6000 });
    await waitFor(() => expect(app.archives()).toHaveLength(1));
    await waitFor(async () => expect(await app.row()).toMatchObject({ filed: true, onHome: false }));
  });

  it("leaves the merged ticket in Home's completed group when the box is unchecked, and holds the timed return once the box is touched", async () => {
    const app = await mergedPage();
    fireEvent.click(box());
    expect([...document.querySelectorAll(".completion-facts > div")].at(-1)!.textContent).toBe("Filed inHome");
    expect(screen.getByText(/stays with the ticket on Home until you archive it\./)).toBeTruthy();
    expect(screen.getByText("Staying here until you go.")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(screen.getByRole("heading", { name: "example/webstore#418 is merged" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go now" }));
    await screen.findByText("Backfill the audit table");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.archives()).toEqual([]);
    expect(await app.row()).toEqual({ filed: false, onHome: true, group: "decided" });
  });

  it("opens Create from Create another ticket, and files the ticket as its choice leaves the page", async () => {
    const app = await mergedPage();
    fireEvent.click(screen.getByRole("button", { name: "Create another ticket" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    // The picker is over the page: nothing is left yet, and nothing filed.
    expect(screen.getByRole("heading", { name: "example/webstore#418 is merged" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.archives()).toEqual([]);
    fireEvent.click(picker.querySelector<HTMLElement>(".picker-row")!);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "example/webstore#418 is merged" })).toBeNull());
    await waitFor(() => expect(app.archives()).toHaveLength(1));
    await waitFor(async () => expect(await app.row()).toMatchObject({ filed: true, onHome: false }));
  });
});
