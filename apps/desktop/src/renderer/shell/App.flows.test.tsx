// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { App } from "./App.js";
import type { Route, TaskView } from "./route.js";
import type { Detail, Snapshot } from "../../shared/protocol.js";
import { runnerProgress } from "../../shared/runner-progress.js";
import { HomePage } from "../tasks/HomePage.js";
import { TaskPage } from "../tasks/TaskPage.js";
import { NOT_LISTED, PROBLEMS_HOLD } from "../tasks/ContractScreen.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import { handlers } from "../../sample-host/handlers.js";
import { editing as sampleEditing, sampleReadings } from "../../sample-host/records.js";
import { CONFIRM_TO_CHECK, READING_FAILED } from "../planning/ReadingFailed.js";
import { bridge } from "../workspace/index.js";
import { isLive } from "../../shared/jobs.js";
import { setPlatformForTests } from "../../shared/shortcuts.js";

// A CI runner renders this app several times slower than a laptop, and the
// library's default one-second `findBy` timeout reads as a missing button
// there. Five seconds is what the explicit waits in this file already allow.
configure({ asyncUtilTimeout: 5000 });

let client: QueryClient;
let decisionDetail: Detail;
beforeAll(async () => {
  // Planning mode loads its panes lazily, and the first test to open one would
  // otherwise spend its `findBy` budget on the module load, which on a CI
  // runner takes longer than the wait allows.
  await Promise.all([
    import("../planning/SpecPane.js"),
    import("../planning/GraphPane.js"),
    import("../tasks/Composer.js"),
  ]);
  // Keep the recorded review independent of earlier flows that finish this sample run.
  const workspace = await sampleBridge.request({ kind: "snapshot" });
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
  decisionDetail = structuredClone(await sampleBridge.request({
    kind: "detail", repoId: row.repoId, key: row.ticket.key,
  }));
});
beforeEach(() => {
  // jsdom has no <dialog> implementation; the confirmation dialog only needs open/close.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  }
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
  vi.restoreAllMocks();
});
function mount() {
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}
/**
 * A sample host of its own in the adapter slot, with the modules that read the
 * slot loaded afresh after it, for a test that changes the sample the rest of
 * this file reads. The shared host goes back once the test is over.
 */
async function freshHost() {
  vi.resetModules();
  const { sampleBridge: sample } = await import("../../sample-host/bridge.js");
  const shared = window.perbo;
  window.perbo = sample;
  onTestFinished(() => {
    if (shared) window.perbo = shared;
    else delete window.perbo;
  });
  return sample;
}
/** The app over a sample workspace of its own, for a test that deletes the stopped sample the rest of this file reads. */
async function freshApp() {
  await freshHost();
  const { App: Fresh } = await import("./App.js");
  const { bridge: host } = await import("../workspace/index.js");
  return {
    host,
    mount: () =>
      render(
        <QueryClientProvider client={client}>
          <Fresh />
        </QueryClientProvider>,
      ),
  };
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

/** The stopped sample, PRB-415, as Home lists it and as its page reads it. */
async function stoppedSample() {
  const workspace = await sampleBridge.request({ kind: "snapshot" });
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-415")!;
  const detail = structuredClone(
    await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: "PRB-415" }),
  );
  detail.ticket = row.ticket;
  return { workspace, row, detail };
}

/**
 * Holds a run at the boundary, since what is tested is the request the page
 * sends and not the sample loop it would start. The returned wait answers with
 * that request once it has been sent.
 */
function holdRun() {
  const original = bridge.request.bind(bridge);
  const sent = vi
    .spyOn(bridge, "request")
    .mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind === "run" ? Promise.resolve(null as never) : original(request)) as typeof bridge.request);
  return async () => {
    await waitFor(() => expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(true));
    return sent.mock.calls.map(([request]) => request).find((request) => request.kind === "run");
  };
}

/** Waits for a job the host no longer lists as live: a stop is taken at once and settles once the run has gone, as on the host. */
const gone = (id: string) =>
  waitFor(async () =>
    expect((await sampleBridge.request({ kind: "snapshot" })).jobs.some((entry) => entry.id === id && isLive(entry))).toBe(false),
  );

/** Starts the sample loop on a ticket through the preview host, and stops it when the test is done with it. */
async function runInProgress(key: string, approve = true) {
  const workspace = await sampleBridge.request({ kind: "snapshot" });
  const row = workspace.tasks.find((task) => task.ticket.key === key)!;
  const detail = await sampleBridge.request({ kind: "detail", repoId: row.repoId, key });
  const job = await sampleBridge.request({
    kind: "run", repoId: row.repoId, key, digest: detail.digest,
    approve, publish: false, resumeFrom: null,
  });
  return {
    row, job,
    // The sample loop settles itself; a stop after that is refused as it is by the host, so only a live one is stopped.
    stop: async () => {
      const live = (await sampleBridge.request({ kind: "snapshot" })).jobs.find((entry) => entry.id === job.id && isLive(entry));
      if (live) await sampleBridge.request({ kind: "cancel", jobId: job.id });
      await gone(job.id);
    },
  };
}

/** Presses Generate plan once the planning offers it. */
async function generatePlan(): Promise<void> {
  const generate = await screen.findByRole("button", { name: "Generate plan" }, { timeout: 15_000 });
  await waitFor(() => expect((generate as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
  fireEvent.click(generate);
}

describe("interactive desktop flows", () => {
  /**
   * A planning with its spec written, through the host, and the app opened on
   * it. One requirement, so the drafter has nothing to divide.
   */
  async function planningWithSpec(title: string, outcome: string): Promise<string> {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const opened = await sampleBridge.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: workspace.repositories[0]!.id },
    });
    await sampleBridge.request({
      kind: "specSave",
      id: opened.id,
      repoId: opened.repoId,
      title,
      sections: {
        outcome,
        requirements: "- A signup queues exactly one email.",
        no_gos: "",
        rabbit_holes: "",
        notes: "",
      },
      base: {
        title: "",
        sections: { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" },
      },
    });
    location.hash = `planning/${opened.id}/spec`;
    return opened.id;
  }

  /** The planning panes the rail draws, by name. */
  const tabs = (): string[] =>
    within(screen.getByRole("group", { name: "Planning panes" }))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? "");
  /** The sample host's impact check finding these paths outside the scope, as the host records them. */
  function impactFinds(paths: string[]): void {
    const original = handlers.impactRead;
    vi.spyOn(handlers, "impactRead").mockImplementation(async (request, owner) => {
      const view = await original(request, owner);
      sampleEditing.recordImpact(request.id, paths.length);
      return {
        ...view,
        warnings: paths.map((path) => ({ path, package: "packages/app", reasons: [{ kind: "config" as const, detail: "Configuration." }] })),
        truncated: 0,
      };
    });
  }

  it("lands a flat plan on its contract once it is checked, says the task is simple there, and offers no graph (D-NEW-basic-and-epic-flows)", async () => {
    // Work the drafter did not divide has no graph to curate: its plan is its
    // criteria, and the contract is where they are read. The impact check runs
    // first; with nothing from it, the person lands on the contract, with a
    // pop-up saying why there is no graph. Its plan is not read against the
    // spec here: that is its Confirm contract's.
    impactFinds([]);
    const id = await planningWithSpec("Signup confirmation mail", "New users receive a confirmation email within sixty seconds.");
    mount();
    // Before the plan: the Spec and the Explorer and nothing else.
    await waitFor(() => expect(tabs()).toEqual(["Spec", "Explorer"]));
    await generatePlan();
    await screen.findByText("Drafting the plan from your spec");
    await screen.findByText("Checking the impact", {}, { timeout: 5000 });
    const notice = await screen.findByRole("dialog", { name: "A simple task" }, { timeout: 5000 });
    expect(notice.textContent).toContain("The task is simple, so there is no graph.");
    expect(location.hash).toMatch(/^#planning\/[^/]+\/contract$/);
    // The impact check ran, and no reading: the plan just drafted is recorded
    // as read by its drafting, so its first confirm unchanged reads nothing.
    const { key, read } = await sampleBridge.request({ kind: "editingRead", id });
    expect((await sampleBridge.request({ kind: "snapshot" })).jobs.some((job) => job.kind === "drift" && job.key === key)).toBe(false);
    expect(read).not.toBeNull();
    expect(handlers.impactRead).toHaveBeenCalled();
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    expect(tabs()).toEqual(["Spec", "Explorer", "Confirm contract"]);
    // No chat beside the contract: its criteria are the person's to edit.
    expect(screen.queryByRole("complementary", { name: "Chat" })).toBeNull();
    // Next only puts it away.
    fireEvent.click(within(notice).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "A simple task" })).toBeNull());
    expect(location.hash).toMatch(/\/contract$/);
    // Left for the Spec, the contract is still a tab while nothing has changed.
    fireEvent.click(within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name: "Spec" }));
    await waitFor(() => expect(location.hash).toMatch(/\/spec$/));
    await waitFor(() => expect(tabs()).toEqual(["Spec", "Explorer", "Confirm contract"]));
    expect(await screen.findByRole("complementary", { name: "Chat" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "A simple task" })).toBeNull();
  });

  it("lands an epic's fresh plan on its Graph without reading it, and confirms it unchanged with no reading (D-NEW-basic-and-epic-flows)", async () => {
    // A plan the model drafted from its spec counts as satisfying it: nothing
    // reads it at Generate plan, nothing waits, and it never lands on Problems.
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const opened = await sampleBridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId: workspace.repositories[0]!.id } });
    // Two requirements, which the sample drafter divides into a graph.
    await sampleBridge.request({
      kind: "specSave",
      id: opened.id,
      repoId: opened.repoId,
      title: "Signup mail and its retry",
      sections: {
        outcome: "New users receive a confirmation email.",
        requirements: "- A signup queues exactly one email.\n- A failed send is retried once.",
        no_gos: "",
        rabbit_holes: "",
        notes: "",
      },
      base: { title: "", sections: { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" } },
    });
    location.hash = `planning/${opened.id}/spec`;
    mount();
    const sent = vi.spyOn(bridge, "request");
    const waits: string[] = [];
    const watcher = new MutationObserver(() => {
      for (const heading of document.querySelectorAll("h1"))
        if (["Checking the plan", "Checking the impact", "Checking for drift"].includes(heading.textContent ?? ""))
          waits.push(heading.textContent!);
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    try {
      await generatePlan();
      await waitFor(() => expect(location.hash).toBe(`#planning/${opened.id}/graph`), { timeout: 8000 });
      await screen.findByRole("heading", { name: "Execution graph" });
      const session = await sampleBridge.request({ kind: "editingRead", id: opened.id });
      expect(session.nodes).toBeGreaterThan(0);
      const readings = async () =>
        (await sampleBridge.request({ kind: "snapshot" })).jobs.filter((job) => job.kind === "drift" && job.key === session.key);
      // No reading, and the plan recorded as read at the state it was drafted at.
      expect(await readings()).toEqual([]);
      expect(session.read).not.toBeNull();
      expect(tabs()).not.toContain("Problems");
      // An epic is not a simple task.
      expect(screen.queryByRole("dialog", { name: "A simple task" })).toBeNull();
      // Confirmed as drafted: on to the contract, and still nothing read.
      fireEvent.click(await screen.findByRole("button", { name: "Confirm the plan" }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${opened.id}/contract`), { timeout: 8000 });
      expect(await readings()).toEqual([]);
      expect(sent.mock.calls.map(([request]) => request.kind)).not.toContain("driftCheck");
      expect(waits).toEqual([]);
      expect(tabs()).not.toContain("Problems");
    } finally {
      watcher.disconnect();
    }
  });

  it("takes the contract off the tabs once the spec changes, even while the person is on it", async () => {
    // What keeps the contract a tab is the state it was reached at; a change
    // made while the person reads it is still a change nobody has checked.
    impactFinds([]);
    const id = await planningWithSpec("Signup reminder mail", "New users receive a reminder email within a day.");
    mount();
    await generatePlan();
    const notice = await screen.findByRole("dialog", { name: "A simple task" }, { timeout: 8000 });
    fireEvent.click(within(notice).getByRole("button", { name: "Next" }));
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    await waitFor(async () =>
      expect((await sampleBridge.request({ kind: "editingRead", id })).confirmed).not.toBeNull(),
    );
    const spec = await sampleBridge.request({ kind: "specRead", id });
    const listed = () => client.getQueryData<Snapshot>(["workspace"])?.drafts?.find((draft) => draft.id === id)?.spec;
    const before = listed();
    expect(before).toBeTruthy();
    await sampleBridge.request({
      kind: "specSave",
      id,
      repoId: (await sampleBridge.request({ kind: "editingRead", id })).repoId,
      title: spec.title,
      sections: { ...spec.sections, notes: "Reminders go out in the morning." },
      base: { title: spec.title, sections: spec.sections },
    });
    // The drafts list reads the spec again, with the person still on the contract.
    await waitFor(() => expect(listed()).not.toBe(before), { timeout: 5000 });
    expect(location.hash).toBe(`#planning/${id}/contract`);
    expect(tabs()).toContain("Confirm contract");
    await new Promise((resolve) => setTimeout(resolve, 300));
    fireEvent.click(within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name: "Explorer" }));
    await waitFor(() => expect(location.hash).toBe(`#planning/${id}/explorer`));
    await waitFor(() => expect(tabs()).toEqual(["Spec", "Explorer"]));
  });

  it("lands a flat plan on Impact where the check found paths outside its scope, with the pop-up there", async () => {
    impactFinds(["config/app.json"]);
    await planningWithSpec("Signup receipt mail", "New users receive a confirmation email within sixty seconds.");
    mount();
    await generatePlan();
    const notice = await screen.findByRole("dialog", { name: "A simple task" }, { timeout: 8000 });
    expect(location.hash).toMatch(/^#planning\/[^/]+\/impact$/);
    await waitFor(() => expect(tabs()).toEqual(["Spec", "Explorer", "Impact"]));
    fireEvent.click(within(notice).getByRole("button", { name: "Next" }));
    // The pane shows what the check found, and its way on is the contract.
    expect(await screen.findByText("config/app.json")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm contract" }));
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 8000 });
    expect(location.hash).toMatch(/\/contract$/);
  });

  /** A flat plan drafted and landed on its contract, the pop-up put away and the landing's reading recorded. */
  async function landedFlat(title: string): Promise<{ id: string; key: string }> {
    impactFinds([]);
    const id = await planningWithSpec(title, "New users receive a confirmation email within sixty seconds.");
    mount();
    await generatePlan();
    const notice = await screen.findByRole("dialog", { name: "A simple task" }, { timeout: 8000 });
    fireEvent.click(within(notice).getByRole("button", { name: "Next" }));
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    await waitFor(async () => {
      const session = await sampleBridge.request({ kind: "editingRead", id });
      expect(session.confirmed).not.toBeNull();
      expect(session.read).not.toBeNull();
    });
    const { key } = await sampleBridge.request({ kind: "editingRead", id });
    return { id, key: key! };
  }
  const readings = async (key: string) =>
    (await sampleBridge.request({ kind: "snapshot" })).jobs.filter((job) => job.kind === "drift" && job.key === key).length;
  /** Rewords the first criterion on the contract and waits for it to be written in. */
  async function reword(text: string): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "Edit criterion 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 1" }), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(text, { selector: ".criterion-text" }, { timeout: 8000 });
    await waitFor(() => expect(screen.queryByText("Writing the change into the contract…")).toBeNull(), { timeout: 8000 });
  }

  /**
   * What the confirm puts up, in the order it appears, watched as it is
   * drawn: the reading's page, then the page approving goes on to — the
   * loop's, whose "Approving the contract" wait the sample host's instant
   * approval passes before it can be drawn.
   */
  const LOOP = "the loop";
  function loadingPages(): { seen: string[]; stop: () => void } {
    const seen: string[] = [];
    const look = (): void => {
      const drawn = [...document.querySelectorAll("h1")].some((heading) => heading.textContent === "Checking for drift")
        ? "Checking for drift"
        : /^#task\/[^/]+\/[^/]+\/loop$/.test(location.hash)
          ? LOOP
          : null;
      if (drawn !== null && seen.at(-1) !== drawn) seen.push(drawn);
    };
    const watcher = new MutationObserver(look);
    watcher.observe(document.body, { childList: true, subtree: true, characterData: true });
    return { seen, stop: () => watcher.disconnect() };
  }
  /** Stops the loop a confirm started on this ticket, once the test has read what it needed. */
  async function stopRun(key: string): Promise<void> {
    const run = (await sampleBridge.request({ kind: "snapshot" })).jobs.find((job) => job.kind === "run" && job.key === key);
    if (run === undefined) return;
    if (isLive(run)) await sampleBridge.request({ kind: "cancel", jobId: run.id });
    await gone(run.id);
  }

  it("shows Checking for drift while the confirm's reading runs, then goes on to approving where it found nothing (D-NEW-basic-and-epic-flows)", async () => {
    const { id, key } = await landedFlat("Signup ordered mail");
    // The spec moves in a way that promises nothing new: the confirm reads the
    // plan, finds nothing, and goes ahead.
    const spec = await sampleBridge.request({ kind: "specRead", id });
    const listed = () => client.getQueryData<Snapshot>(["workspace"])?.drafts?.find((draft) => draft.id === id)?.spec;
    const before = listed();
    await sampleBridge.request({
      kind: "specSave",
      id,
      repoId: (await sampleBridge.request({ kind: "editingRead", id })).repoId,
      title: spec.title,
      sections: { ...spec.sections, notes: "Sent from the queue." },
      base: { title: spec.title, sections: spec.sections },
    });
    await waitFor(() => expect(listed()).not.toBe(before), { timeout: 5000 });
    const readingsBefore = await readings(key);
    const pages = loadingPages();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
      await waitFor(() => expect(pages.seen).toEqual(["Checking for drift", LOOP]), { timeout: 8000 });
    } finally {
      pages.stop();
      await stopRun(key);
    }
    expect(await readings(key)).toBe(readingsBefore + 1);
  });

  it("puts up no Checking for drift where the confirm reads nothing, and goes straight on to approving (D-NEW-basic-and-epic-flows)", async () => {
    const { key } = await landedFlat("Signup unread mail");
    const before = await readings(key);
    const pages = loadingPages();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
      await waitFor(() => expect(pages.seen.at(-1)).toBe(LOOP), { timeout: 8000 });
    } finally {
      pages.stop();
      await stopRun(key);
    }
    expect(pages.seen).toEqual([LOOP]);
    expect(await readings(key)).toBe(before);
  });

  it("records the reading owed once a problem is answered on the Problems page, so the confirm after it reads nothing again", async () => {
    const { id, key } = await landedFlat("Signup answered mail");
    await reword("Every new signup queues exactly one email.");
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    await screen.findByText(PROBLEMS_HOLD, {}, { timeout: 8000 });
    await waitFor(() => expect(tabs().at(-1)).toBe("Problems"));
    fireEvent.click(within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name: "Problems" }));
    await waitFor(() => expect(location.hash).toBe(`#planning/${id}/drift`));
    // Answered on the page in the person's own words, which the sample chat
    // applies as a spec write: the spec takes the criterion's words.
    const card = (await screen.findAllByRole("group", { name: /^(Criterion \d|R\d)/ }, { timeout: 8000 }))[0]!;
    fireEvent.click(within(card).getByRole("radio", { name: /Something else/ }));
    fireEvent.change(await within(card).findByLabelText("Your own words"), {
      target: { value: "Change R1 in the spec to say: Every new signup queues exactly one email." },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Send" }));
    // The turn ends, the plan is read again, nothing is open, and the person
    // is back on the contract.
    await waitFor(() => expect(location.hash).toBe(`#planning/${id}/contract`), { timeout: 10_000 });
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    await waitFor(async () => expect((await sampleBridge.request({ kind: "editingRead", id })).drift?.open).toEqual([]));
    await waitFor(async () =>
      expect((await sampleBridge.request({ kind: "snapshot" })).jobs.some((job) => job.kind === "drift" && isLive(job))).toBe(false),
    );
    const before = await readings(key);
    const sent = holdRun();
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    expect(await sent()).toMatchObject({ kind: "run", key, approve: true });
    expect(await readings(key)).toBe(before);
  });

  it("confirms a flat plan nobody changed straight away, reading nothing again (D-NEW-basic-and-epic-flows)", async () => {
    const { key } = await landedFlat("Signup thanks mail");
    const before = await readings(key);
    const sent = holdRun();
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    expect(await sent()).toMatchObject({ kind: "run", key, approve: true });
    expect(await readings(key)).toBe(before);
  });

  it("edits a flat plan's criteria on its contract with no reading and the tab kept, and reads the plan at Confirm contract, refused while problems are open", async () => {
    // The contract is where a basic ticket's criteria are changed, by hand. A
    // change is written in at once and read nowhere yet; the plan is read
    // against the spec when the person confirms, and the confirm is refused
    // while the reading has problems open (D-NEW-basic-and-epic-flows).
    const { id, key } = await landedFlat("Signup welcome mail");
    const before = await readings(key);
    await reword("Every new signup queues exactly one email.");
    expect(location.hash).toBe(`#planning/${id}/contract`);
    expect(await readings(key)).toBe(before);
    fireEvent.click(within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name: "Spec" }));
    await waitFor(() => expect(location.hash).toBe(`#planning/${id}/spec`));
    // Left and come back to: the edit was the person's own, made on it.
    expect(tabs()).toContain("Confirm contract");
    fireEvent.click(within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name: "Confirm contract" }));
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    // Confirmed: the criteria moved since the last reading, so the plan is
    // read, and what it finds refuses the confirm and puts Problems in the rail.
    const sent = vi.spyOn(bridge, "request");
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    await screen.findByText(PROBLEMS_HOLD, {}, { timeout: 8000 });
    expect(await readings(key)).toBe(before + 1);
    await waitFor(() => expect(tabs()).toContain("Problems"));
    expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(false);
    // Confirmed again with nothing changed: refused again, and not read again.
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    await screen.findByText(PROBLEMS_HOLD);
    expect(await readings(key)).toBe(before + 1);
    expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(false);
    sent.mockRestore();
    // Resolved by editing the criteria back to what the spec asks: the next
    // confirm reads the plan, finds nothing, takes the tab away and goes on.
    await reword("A signup queues exactly one email.");
    expect(tabs()).toContain("Problems");
    const run = holdRun();
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    expect(await run()).toMatchObject({ kind: "run", key, approve: true });
    expect(await readings(key)).toBe(before + 2);
    // Every problem resolved, so Problems has left the rail.
    await waitFor(async () =>
      expect((await sampleBridge.request({ kind: "snapshot" })).drafts?.find((draft) => draft.id === id)?.drift?.open).toBe(0),
    );
  });

  /**
   * Every try of a reading made to fail, as a reading with no credential
   * fails, and the host's wait between tries made instant: the tries and the
   * waits asked for are what the returned record holds.
   */
  function readingsDoNotRun(times = Infinity) {
    const paused: number[] = [];
    let tries = 0;
    vi.spyOn(sampleReadings, "pause").mockImplementation(async (ms) => {
      paused.push(ms);
    });
    const attempt = vi.spyOn(sampleReadings, "attempt").mockImplementation(() => {
      tries += 1;
      if (tries <= times) throw new Error("No credential for Claude. Run `claude login`, then try again.");
    });
    return { paused, tries: () => tries, restore: () => attempt.mockRestore() };
  }

  it("says in a pop-up that the plan could not be checked where every try of the confirm's reading fails, confirms nothing, and reads again on the next confirm", async () => {
    const { id, key } = await landedFlat("Signup notice mail");
    await reword("Every new signup queues exactly one email.");
    const before = await readings(key);
    const failing = readingsDoNotRun();
    const sent = vi.spyOn(bridge, "request");
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    const popup = await screen.findByRole("dialog", { name: "The plan could not be checked" }, { timeout: 8000 });
    // Tried four times, 2, 4 and 8 seconds apart, before it was said.
    expect(failing.tries()).toBe(4);
    expect(failing.paused).toEqual([2_000, 4_000, 8_000]);
    // Why in one sentence, and the whole error behind the `i`.
    expect(within(popup).getByText(`${READING_FAILED}: No credential for Claude.`)).toBeTruthy();
    expect(within(popup).getByText(CONFIRM_TO_CHECK)).toBeTruthy();
    expect(within(popup).getByRole("button", { name: "The whole error" })).toBeTruthy();
    expect(popup.textContent).toContain("No credential for Claude. Run `claude login`, then try again.");
    expect(within(popup).getAllByRole("button").map((button) => button.textContent)).toEqual(["i", "Got it"]);
    // Nothing is confirmed, and nothing offers a way past the reading.
    expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(false);
    expect(screen.queryByText(/without the reading/)).toBeNull();
    expect(screen.queryByText(PROBLEMS_HOLD)).toBeNull();
    expect(await readings(key)).toBe(before + 1);
    // Acknowledged: back on the contract, where the confirm is offered again.
    fireEvent.click(within(popup).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "The plan could not be checked" })).toBeNull());
    expect(location.hash).toBe(`#planning/${id}/contract`);
    const approve = screen.getByRole("button", { name: "Approve · start the loop" });
    expect(approve.hasAttribute("disabled")).toBe(false);
    // Pressed again, the plan is read again rather than passed over.
    fireEvent.click(approve);
    await screen.findByRole("dialog", { name: "The plan could not be checked" }, { timeout: 8000 });
    expect(await readings(key)).toBe(before + 2);
    expect(failing.tries()).toBe(8);
    expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(false);
  });

  it("refuses the confirm while problems are open where the reading after a change does not run, and never offers to go on without it", async () => {
    const { key } = await landedFlat("Signup notice held mail");
    await reword("Every new signup queues exactly one email.");
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    await screen.findByText(PROBLEMS_HOLD, {}, { timeout: 8000 });
    await waitFor(() => expect(tabs()).toContain("Problems"));
    // Changed again, so the next confirm owes a reading, and that reading fails.
    await reword("Each new signup queues exactly one email.");
    const before = await readings(key);
    readingsDoNotRun();
    const sent = vi.spyOn(bridge, "request");
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    const popup = await screen.findByRole("dialog", { name: "The plan could not be checked" }, { timeout: 8000 });
    expect(screen.queryByText(/without the reading/)).toBeNull();
    fireEvent.click(within(popup).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "The plan could not be checked" })).toBeNull());
    // Pressed again: read again, and still nothing confirmed.
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    await screen.findByRole("dialog", { name: "The plan could not be checked" }, { timeout: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(false);
    expect(await readings(key)).toBe(before + 2);
  });

  it("confirms as it would have where the confirm's reading fails once and then runs", async () => {
    const { key } = await landedFlat("Signup second try mail");
    await reword("Every new signup queues exactly one email.");
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    await screen.findByText(PROBLEMS_HOLD, {}, { timeout: 8000 });
    // Edited back to what the spec asks: the next confirm reads the plan, and
    // its first try does not run.
    await reword("A signup queues exactly one email.");
    const before = await readings(key);
    const failing = readingsDoNotRun(1);
    const run = holdRun();
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    expect(await run()).toMatchObject({ kind: "run", key, approve: true });
    expect(failing.tries()).toBe(2);
    expect(failing.paused).toEqual([2_000]);
    expect(await readings(key)).toBe(before + 1);
    expect(screen.queryByRole("dialog", { name: "The plan could not be checked" })).toBeNull();
  });

  it("holds the confirm, reading nothing and starting nothing, while the drafts list does not carry the planning", async () => {
    const { id, key } = await landedFlat("Signup notice list mail");
    await reword("Every new signup queues exactly one email.");
    const before = await readings(key);
    // The list read without this planning, from the host and in the page's copy alike.
    const original = bridge.request.bind(bridge);
    const sent = vi.spyOn(bridge, "request").mockImplementation((async (request: Parameters<typeof original>[0]) => {
      if (request.kind === "run") return null as never;
      const reply = await original(request);
      if (request.kind === "drafts") return (reply as Snapshot["drafts"] & object).filter((draft) => draft.id !== id);
      if (request.kind === "snapshot") return { ...(reply as Snapshot), drafts: ((reply as Snapshot).drafts ?? []).filter((draft) => draft.id !== id) };
      return reply;
    }) as typeof bridge.request);
    client.setQueryData<Snapshot>(["workspace"], (workspace) =>
      workspace === undefined ? workspace : { ...workspace, drafts: (workspace.drafts ?? []).filter((draft) => draft.id !== id) },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    fireEvent.click(await screen.findByRole("button", { name: "Approve · start the loop" }));
    await screen.findByText(NOT_LISTED);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(false);
    expect(await readings(key)).toBe(before);
  });

  it("reads the plan when the approve binding is pressed after a change, and holds it while problems are open", async () => {
    const { key } = await landedFlat("Signup keyboard mail");
    await reword("Every new signup queues exactly one email.");
    const before = await readings(key);
    const sent = vi.spyOn(bridge, "request");
    // ⇧⌘↩ as a Mac reads it.
    const press = (): void => {
      setPlatformForTests(true);
      try {
        fireEvent.keyDown(window, { key: "Enter", metaKey: true, shiftKey: true });
      } finally {
        setPlatformForTests(null);
      }
    };
    press();
    await screen.findByText(PROBLEMS_HOLD, {}, { timeout: 8000 });
    expect(await readings(key)).toBe(before + 1);
    expect(sent.mock.calls.some(([request]) => request.kind === "driftCheck")).toBe(true);
    await waitFor(() => expect(tabs()).toContain("Problems"));
    // Pressed again with the problems open: refused, and nothing read again.
    press();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByText(PROBLEMS_HOLD)).toBeTruthy();
    expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(false);
    expect(await readings(key)).toBe(before + 1);
  });

  it("marks the chat's change on the contract, and a hand edit after it leaves no marks (D-128)", async () => {
    const { id } = await landedFlat("Signup marks mail");
    const record = await sampleBridge.request({ kind: "editingRead", id });
    const after = record.form.draft.criteria.map((criterion, index) => ({ id: `ac_${index + 1}`, text: criterion.text }));
    const before = [{ id: "ac_1", text: "A sentence the chat took away." }, ...after.slice(1)];
    sampleEditing.recordChange(id, {
      at: new Date().toISOString(),
      by: "chat",
      spec: null,
      plan: { before: { outcome: record.form.draft.outcome, criteria: before }, after: { outcome: record.form.draft.outcome, criteria: after } },
    });
    await sampleBridge.request({ kind: "editingRead", id });
    const marked = () => document.querySelectorAll(".criteria-editor .change--added, .criteria-editor .change--removed").length;
    await waitFor(() => expect(marked()).toBeGreaterThan(0), { timeout: 5000 });
    // The person's own rewording, by hand: the chat's marks go, and none are drawn for it.
    await reword("Every new signup queues exactly one email.");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(marked()).toBe(0);
    expect(document.querySelectorAll(".criteria-editor del, .criteria-editor ins, .criteria-editor mark")).toHaveLength(0);
  });

  it("moves a person on the Problems tab back to the contract once every problem is resolved, and the tab goes", async () => {
    const { id, key } = await landedFlat("Signup digest mail");
    await reword("Every new signup queues exactly one email.");
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    await screen.findByText(PROBLEMS_HOLD, {}, { timeout: 8000 });
    await waitFor(() => expect(tabs()).toContain("Problems"));
    fireEvent.click(within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name: "Problems" }));
    await waitFor(() => expect(location.hash).toBe(`#planning/${id}/drift`));
    await screen.findByText(/^Problem 1 of \d$/, {}, { timeout: 8000 });
    // The problems hold the confirm until they are resolved, so the page
    // offers no way past them, as it does an epic's.
    expect(screen.queryByRole("button", { name: "Go on to the contract anyway" })).toBeNull();
    expect(screen.queryByText("Going on leaves the problems open.")).toBeNull();
    // The spec takes the plan's words, and the plan is read again: nothing
    // differs any more.
    const spec = await sampleBridge.request({ kind: "specRead", id });
    await sampleBridge.request({
      kind: "specSave",
      id,
      repoId: (await sampleBridge.request({ kind: "editingRead", id })).repoId,
      title: spec.title,
      sections: { ...spec.sections, requirements: spec.sections.requirements.replace("A signup queues exactly one email.", "Every new signup queues exactly one email.") },
      base: { title: spec.title, sections: spec.sections },
    });
    await sampleBridge.request({ kind: "driftCheck", id, state: null });
    await waitFor(() => expect(location.hash).toBe(`#planning/${id}/contract`), { timeout: 8000 });
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    await waitFor(() => expect(tabs()).not.toContain("Problems"));
    expect((await sampleBridge.request({ kind: "snapshot" })).drafts?.find((draft) => draft.id === id)?.drift?.open).toBe(0);
    void key;
  });

  it("keeps a decision pending when leaving, lets it be rewritten, and resumes after confirmation", async () => {
    mount();
    // The card waiting on an answer is the one to click.
    const answer = async (): Promise<void> => {
      const card = await screen.findByRole("button", { name: "Activation email never sent on signup" });
      expect(card.className).toContain("task-card--yellow");
      fireEvent.click(card);
    };
    await answer();
    let dialog = await screen.findByRole("dialog", { name: "Decisions required" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save and continue" }),
    );
    expect(
      within(dialog).getByText("Write your approach before continuing."),
    ).toBeTruthy();
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Your approach" }),
      { target: { value: "Use thirty seconds and document it." } },
    );
    // Left and come back: the answer is still here and still unsent.
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await answer();
    dialog = await screen.findByRole("dialog", { name: "Decisions required" });
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: "Your approach",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Use thirty seconds and document it.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Let it decide" }));
    dialog = await screen.findByRole("dialog", { name: "Confirm your decisions" });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "edit" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Your approach" }), {
      target: { value: "Use one minute and document it." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByText(/Use one minute and document it./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and resume" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(async () => {
      const workspace = await sampleBridge.request({ kind: "snapshot" });
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
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const row = workspace.tasks.find((row) => row.ticket.key === "PRB-377")!;
    row.ticket.delivery = {
      ...row.ticket.delivery,
      state: "none",
      pull_request_url: null,
      pull_request_number: null,
    };
    workspace.tasks = [row];
    const detail = await sampleBridge.request({
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
    // Its card is at the journey's end and says what the contract promised,
    // and nothing on it speaks of a pull request or a merge.
    const card = screen.getByRole("button", { name: row.ticket.title });
    expect(card.className).toContain("task-card--green");
    expect(await within(card).findByText(detail.contract.outcome)).toBeTruthy();
    expect(within(card).queryByText(/pull request|merge/i)).toBeNull();
    home.unmount();
    client.setQueryData(["detail", row.repoId, row.ticket.key], detail);
    render(
      <TaskPage
        workspace={workspace}
        navigate={() => undefined}
        repoId={row.repoId}
        taskKey={row.ticket.key}
        view="review"
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

  /**
   * D-NEW-publish-a-retained-branch-later: a run that ended approved with
   * publishing off kept its branch and opened nothing. Next always leads on
   * to the merge screen, and its one press publishes the branch — the host
   * pushes it, opens the pull request and opens it in the browser — and the
   * screen then holds the pull request like any other.
   */
  async function retainedSample(key: string, retained: boolean) {
    const app = await freshApp();
    const records = await import("../../sample-host/records.js");
    const { ticket, repoId } = records.ticketRow(key);
    if (retained)
      ticket.delivery = { ...ticket.delivery, state: "none", pull_request_url: null, pull_request_number: null, opened_by: null };
    location.hash = ["task", repoId, key, "review"].join("/");
    const sent = vi.spyOn(app.host, "request");
    app.mount();
    const next = (await screen.findByRole("button", { name: "Next" })) as HTMLButtonElement;
    return { sent, next };
  }

  it("leads on from Next to a merge whose press opens the retained branch's pull request, then holds it", async () => {
    const { sent, next } = await retainedSample("PRB-377", true);
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(await screen.findByRole("heading", { name: "Merge?" })).toBeTruthy();
    expect(document.querySelector('section[data-screen="s16"]')).toBeTruthy();
    expect(screen.getByText(/The run kept retry-activation-email on this machine and has not pushed it\./)).toBeTruthy();
    // Nothing is open to leave open.
    expect(screen.queryByRole("button", { name: "Don’t merge" })).toBeNull();
    const press = screen.getByRole("button", { name: "Merge on GitHub" }) as HTMLButtonElement;
    expect(press.disabled).toBe(false);
    fireEvent.click(press);
    expect(await screen.findByText(/The pull request is open in your browser/)).toBeTruthy();
    expect(await screen.findByText(/The pull request is open on your branch\./)).toBeTruthy();
    expect(screen.getByText(/#418$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don’t merge" })).toBeTruthy();
    const kinds = sent.mock.calls.map(([request]) => request.kind);
    expect(kinds.filter((kind) => kind === "publish")).toHaveLength(1);
    // The host opens what it published; the page asks for nothing more.
    expect(kinds).not.toContain("openPullRequest");
  });

  it("says why there is nothing to merge where no branch was retained to publish", async () => {
    const { sent, next } = await retainedSample("PRB-415", false);
    fireEvent.click(next);
    expect(await screen.findByRole("heading", { name: "Nothing to merge" })).toBeTruthy();
    expect(
      screen.getByText("PRB-415 is failed: only a run that ended approved or escalated retains a branch to publish."),
    ).toBeTruthy();
    const press = screen.getByRole("button", { name: "Merge on GitHub" }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    fireEvent.click(press);
    expect(sent.mock.calls.some(([request]) => request.kind === "publish")).toBe(false);
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
      const workspace = await sampleBridge.request({ kind: "snapshot" });
      const row = workspace.tasks[0]!;
      const detail = await sampleBridge.request({
        kind: "detail",
        repoId: row.repoId,
        key: row.ticket.key,
      });
        detail.ticket.state = state;
      detail.ticket.approved_at = new Date().toISOString();
      // Drafted from a spec, so that planning it again is a question the page
      // has to answer for a stranded record.
      detail.ticket.admission.spec = {
        path: "specs/stranded-sample/spec.md",
        content_sha256: "sha256:" + "0".repeat(64),
        files: [],
        names_that_resolved: null,
        symbols_judged_at_approval: false,
      };
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
      function ReopenedTask({ start }: { start: TaskView }) {
        const [view, setView] = useState<TaskView>(start);
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
      const opened = render(<QueryClientProvider client={client}><ReopenedTask start="auto" /></QueryClientProvider>);
      if (outcome === "running") {
        expect(screen.queryByRole("button", { name: "See the stopped run" })).toBeNull();
        expect((screen.getByRole("button", { name: "Stop the loop" }) as HTMLButtonElement).disabled).toBe(false);
        return;
      }
      // Opening the task lands on the stopped page, not on the frozen
      // contract: this ticket is stranded at a stage the loop was carrying it
      // through, and the contract's one offer is Start the loop over criteria
      // nobody can change.
      expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Continue the task" })).toBeTruthy();
      // A stranded record still calls the run live, and one spec is one piece
      // of work while its ticket is: planning it again is not yet, and the
      // button says so only when asked, as the page carries no text.
      const again = screen.getByRole("button", { name: "Plan it again" }) as HTMLButtonElement;
      expect(again.disabled).toBe(true);
      expect(again.title).toMatch(/^Not yet: the record still says this run is at/);
      expect(screen.queryByText(/Not yet/)).toBeNull();
      opened.unmount();
      // And the loop screen, asked for by name, still says the task is ready
      // to be picked up and sends the person to the same page.
      render(<QueryClientProvider client={client}><ReopenedTask start="loop" /></QueryClientProvider>);
      expect(screen.getByRole("heading", { name: "Ready to recover this task" })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Stop the loop" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "See the stopped run" }));
      expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
      expect(detail.ticket.state).toBe(state);
      expect(workspace.jobs[0]?.state).toBe(outcome === "unrecorded" ? undefined : outcome);
    },
  );

  it.each(["failed", "unrecorded", "running", "stopping"] as const)(
    "uses the same recovery state on Home and the loop after a %s run",
    async (outcome) => {
      const workspace = await sampleBridge.request({ kind: "snapshot" });
      const row = workspace.tasks.find((task) => task.ticket.key === "PRB-398")!;
      const newer = workspace.tasks.find((task) => task.ticket.key === "PRB-421")!;
      const detail = structuredClone(await sampleBridge.request({
        kind: "detail", repoId: row.repoId, key: row.ticket.key,
      }));
        workspace.titles = {};
      row.ticket.state = "provisioning";
      row.ticket.updated_at = "2026-09-01T00:00:00.000Z";
      newer.ticket.state = "ready";
      newer.ticket.updated_at = "2026-09-09T00:00:00.000Z";
        workspace.tasks = [newer, row];
      // The newer ticket opened last, so where both run it comes first.
      workspace.lastOpened = {
        [row.repoId + ":" + row.ticket.key]: "2026-09-01T00:00:00.000Z",
        [newer.repoId + ":" + newer.ticket.key]: "2026-09-09T00:00:00.000Z",
      };
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
      if (outcome === "running") {
        expect(card.className).not.toContain("task-card--red");
        expect(card.querySelector(".stage-pill")!.textContent).not.toBe("loop stopped");
        expect(screen.queryByText("1 stopped")).toBeNull();
        expect(document.querySelector(".task-card")).not.toBe(card);
        fireEvent.click(card);
        expect(screen.queryByRole("button", { name: "See the stopped run" })).toBeNull();
        expect((screen.getByRole("button", { name: "Stop the loop" }) as HTMLButtonElement).disabled).toBe(false);
        return;
      }
      if (outcome === "stopping") {
        // A stop asked and not yet finished is the stopped run already: the
        // person said it is over, and the record catches up on its own page.
        expect(screen.getByText("1 stopped")).toBeTruthy();
        expect(card.querySelector(".stage-pill")!.textContent).toBe("loop stopped");
        fireEvent.click(card);
        expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
        expect((screen.getByRole("button", { name: "Continue the task" }) as HTMLButtonElement).disabled).toBe(true);
        return;
      }
      expect(screen.getByText("1 stopped")).toBeTruthy();
      expect(document.querySelector(".task-card")).toBe(card);
      expect(within(card).getByText(/The run stopped/)).toBeTruthy();
      expect(card.querySelector(".stage-pill")!.textContent).toBe("loop stopped");
      fireEvent.click(card);
      expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
      expect(detail.ticket.state).toBe("provisioning");
      expect(workspace.jobs[0]?.state).toBe(outcome === "unrecorded" ? undefined : outcome);
    },
  );

  it.each(["changes_requested", "pr_open", "provisioning"] as const)(
    "keeps canonical %s routing when an earlier run job failed",
    async (state) => {
      const workspace = await sampleBridge.request({ kind: "snapshot" });
      const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
      const detail = structuredClone(decisionDetail);
      const attempt = detail.attempts.at(-1)!;
      if (!attempt.review?.findings.some((finding) => finding.closure === "human"))
        throw new Error("The fixture must carry a recorded human decision");
      const question = attempt.review.findings[0]!.statement;
        workspace.titles = {};
      workspace.tasks = [row];
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
        expect(card.className).toContain("task-card--yellow");
        fireEvent.click(card);
        // What ended the run is said first, from the attempt it recorded rather
        // than the job's exit, and the decision follows once it is read.
        const ended = screen.getByRole("dialog", { name: "The run ended" });
        expect(ended.querySelector(".ended-sentence")?.textContent).toMatch(/^The review escalated the change to you\./);
        expect(ended.querySelector(".ended-log")).toBeNull();
        expect(screen.queryByText("CLI exited with code 2.")).toBeNull();
        fireEvent.click(within(ended).getByRole("button", { name: "Got it" }));
        const dialog = screen.getByRole("dialog", { name: "Decisions required" });
        expect(within(dialog).getByText(question)).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Paused for a decision" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "See the stopped run" })).toBeNull();
      } else if (state === "pr_open") {
        expect(card.className).toContain("task-card--green");
        fireEvent.click(card);
        expect(screen.getByRole("heading", { name: "Review the result" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Start the loop" })).toBeNull();
      } else {
        expect(card.querySelector(".stage-pill")!.textContent).toBe("loop stopped");
        fireEvent.click(card);
        expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
        expect(screen.queryByRole("dialog", { name: "Decisions required" })).toBeNull();
      }
      expect(workspace.jobs).toHaveLength(1);
      expect(workspace.jobs[0]?.state).toBe("failed");
      expect(detail.ticket.state).toBe(state);
    },
  );

  /**
   * The page a stopped run opens on.
   *
   * `failed` is where a stop inside the executor's window leaves the ticket,
   * and the ladder's next line sends a failed ticket to the review screen. A
   * run somebody stopped has no result to review: it has a contract that still
   * stands, evidence that was retained, and three things that can be done
   * about it.
   */
  it("lands a stopped run on its own page, filed in the Archive with its run gone from the journal included", async () => {
    const { workspace, row, detail } = await stoppedSample();
    if (row.ticket.state !== "failed")
      throw new Error("the stopped sample must be a ticket the loop left failed");
    client.setQueryData(["detail", row.repoId, "PRB-415"], detail);
    const page = (snapshot: Snapshot) => (
      <QueryClientProvider client={client}>
        <TaskPage
          workspace={snapshot}
          navigate={() => undefined}
          repoId={row.repoId}
          taskKey="PRB-415"
          view="auto"
          edit={false}
        />
      </QueryClientProvider>
    );
    const stopped = render(page(workspace));
    expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Review the result" })).toBeNull();
    stopped.unmount();
    // Filed in the Archive and its run long gone from the journal, the failed
    // ticket is still a stopped run, with Plan it again on its page rather than
    // a result to review.
    render(page({ ...workspace, jobs: [], archived: [`${row.repoId}:PRB-415`] }));
    expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan it again" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Review the result" })).toBeNull();
  });

  /**
   * Continuing a stopped task, with and without something to carry in.
   *
   * A stopped attempt still seals its execution bundle, and that bundle is
   * what `--resume-from` is given. Where there is none the offer is a fresh
   * attempt, and the page says which of the two it is making rather than
   * leaving a person to guess what "continue" means.
   */
  it.each([true, false])(
    "continues a stopped task, carrying on from the retained changes where there are any: %s",
    async (retained) => {
      const { workspace, row, detail } = await stoppedSample();
      const sealed = detail.attempts.at(-1)?.bundles.find((bundle) => bundle.kind === "execution");
      if (!sealed) throw new Error("the stopped sample must retain an execution bundle");
      if (!retained)
        detail.attempts = detail.attempts.map((attempt) => ({ ...attempt, bundles: [] }));
      mountTaskFromHome(workspace, row.repoId, detail);
      const card = screen.getByRole("button", { name: row.ticket.title });
      expect(card.className).toContain("task-card--red");
      fireEvent.click(card);
      expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
      const sent = holdRun();
      fireEvent.click(screen.getByRole("button", { name: "Continue the task" }));
      expect(await sent()).toMatchObject({
        key: "PRB-415",
        // The contract is approved and frozen: this is another attempt
        // against it, never a second approval.
        approve: false,
        resumeFrom: retained ? sealed.bundle_id : null,
      });
    },
  );

  /**
   * The publication choice a continued attempt carries.
   *
   * The page asks nothing beyond its three buttons, so the choice is the one
   * the stopped run was started with, which the contract page asked for and
   * the run's job records: carrying on from a run is not a new question.
   */
  it.each([false, true])(
    "carries the stopped run's publication choice into a continued attempt: %s",
    async (wanted) => {
      const { workspace, row, detail } = await stoppedSample();
      const stoppedRun = workspace.jobs.find((job) => job.key === "PRB-415" && job.kind === "run");
      if (!stoppedRun) throw new Error("the stopped sample must have the run that was stopped on record");
      stoppedRun.publish = wanted;
      mountTaskFromHome(workspace, row.repoId, detail);
      const card = screen.getByRole("button", { name: row.ticket.title });
      expect(card.className).toContain("task-card--red");
      fireEvent.click(card);
      expect(screen.queryByRole("checkbox")).toBeNull();
      const sent = holdRun();
      fireEvent.click(screen.getByRole("button", { name: "Continue the task" }));
      expect(await sent()).toMatchObject({ key: "PRB-415", publish: wanted });
    },
  );

  it("spends no edit reaching the contract of a plan nobody changed", async () => {
    // Reading the plan and agreeing with it is not an edit: a flat plan lands
    // on its contract without one (D-072).
    impactFinds([]);
    const id = await planningWithSpec("Weekly digest", "Subscribers receive a weekly digest.");
    mount();
    await generatePlan();
    await screen.findByRole("dialog", { name: "A simple task" }, { timeout: 8000 });
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    const { key } = await sampleBridge.request({ kind: "editingRead", id });
    const edits = (await sampleBridge.request({ kind: "snapshot" })).jobs.filter(
      (job) => job.kind === "edit" && job.key === key,
    );
    expect(edits).toHaveLength(0);
  });

  describe("a ticket reopens where it was left (D-130)", () => {
    const on = (screenId: string): boolean => document.querySelector(`section[data-screen="${screenId}"]`) !== null;
    const lastPane = async (id: string) => (await sampleBridge.request({ kind: "editingRead", id })).lastPane;
    /** A flat plan drafted by a planning, landed on its contract: the planning's id and its ticket. */
    async function compiled(title: string): Promise<{ id: string; repoId: string; key: string }> {
      impactFinds([]);
      const id = await planningWithSpec(title, "Subscribers receive a weekly digest.");
      mount();
      await generatePlan();
      const notice = await screen.findByRole("dialog", { name: "A simple task" }, { timeout: 8000 });
      fireEvent.click(within(notice).getByRole("button", { name: "Next" }));
      await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
      await waitFor(async () => expect(await lastPane(id)).toBe("contract"));
      const { repoId, key } = await sampleBridge.request({ kind: "editingRead", id });
      return { id, repoId, key: key! };
    }
    async function home(): Promise<void> {
      fireEvent.click(screen.getByRole("button", { name: "Home" }));
      await screen.findByRole("heading", { name: /Hi, / });
    }
    /** The ticket's own page by a link that names no view, once it has settled where it lands. */
    async function openByLink(plan: { repoId: string; key: string }): Promise<void> {
      location.hash = ["task", plan.repoId, plan.key].join("/");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await waitFor(() => expect(on("s11") || on("s12") || on("stopped") || location.hash.startsWith("#planning/")).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const liveRun = async (repoId: string, key: string) =>
      (await sampleBridge.request({ kind: "snapshot" })).jobs.find((job) => job.repoId === repoId && job.key === key && isLive(job));

    it("opens the compiled contract again from the picker, from a link naming no view and after a restart", async () => {
      const plan = await compiled("Reopen on the contract");
      await home();
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
      const { title } = (await sampleBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key })).ticket;
      fireEvent.click(within(picker).getByRole("button", { name: (name) => name.startsWith(title) }));
      await screen.findByRole("button", { name: "Approve · start the loop" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(on("s11")).toBe(true);
      expect(location.hash).toBe(`#planning/${plan.id}/contract`);

      await home();
      await openByLink(plan);
      expect(on("s11")).toBe(true);
      expect(location.hash).toBe(`#planning/${plan.id}/contract`);

      // A restart: a fresh renderer over the same records, opened on the link.
      cleanup();
      client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
      location.hash = ["task", plan.repoId, plan.key].join("/");
      mount();
      await screen.findByRole("button", { name: "Approve · start the loop" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(on("s11")).toBe(true);
      expect(location.hash).toBe(`#planning/${plan.id}/contract`);
    });

    it("opens the planning's pane again once the person went from the contract to another tab", async () => {
      const plan = await compiled("Reopen on the plan");
      fireEvent.click(within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name: "Explorer" }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/explorer`));
      await waitFor(async () => expect(await lastPane(plan.id)).toBe("explorer"));
      await home();
      const sent = vi.spyOn(bridge, "request");
      await openByLink(plan);
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/explorer`));
      expect(on("s11")).toBe(false);
      // The page that only sent the person on is not a contract they reached.
      expect(sent.mock.calls.some(([request]) => request.kind === "editingContractVisited")).toBe(false);
    });

    it("opens the loop once the contract is approved and running, and the stopped page once the run is stopped", async () => {
      const plan = await compiled("Reopen on the loop");
      try {
        fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
        await screen.findByRole("button", { name: "Stop the loop" });
        await home();
        await openByLink(plan);
        expect(on("s12")).toBe(true);
        expect(on("s11")).toBe(false);
        const stop = (await screen.findByRole("button", { name: "Stop the loop" })) as HTMLButtonElement;
        await waitFor(() => expect(stop.disabled).toBe(false));
        fireEvent.click(stop);
        await screen.findByRole("heading", { name: "The run was stopped" });
        await waitFor(async () => expect(await liveRun(plan.repoId, plan.key)).toBeUndefined());
        await home();
        await openByLink(plan);
        expect(on("stopped")).toBe(true);
      } finally {
        const live = await liveRun(plan.repoId, plan.key);
        if (live) {
          await sampleBridge.request({ kind: "cancel", jobId: live.id });
          await gone(live.id);
        }
      }
    });

    /**
     * Approving rewrites the ticket's record twice within the first seconds —
     * `perbo approve`, then the run moving it on — and a read of the store that
     * lands on a record mid-write is answered with the host's sentence for a
     * ticket it cannot find. A read that fails once the page holds the ticket
     * is a refresh that failed, not a page that did: the loop stays, and the
     * read that follows replaces what it shows.
     */
    it("stays on the loop when a read of the ticket fails while approving moves it", async () => {
      const plan = await compiled("Stay on the loop");
      const original = bridge.request.bind(bridge);
      let approved = false,
        failing = true,
        failed = 0;
      vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) => {
        if (request.kind === "run") approved = true;
        if (approved && failing && request.kind === "detail") {
          failed++;
          return Promise.reject(new Error("This task is no longer in the repository's ticket store."));
        }
        return original(request);
      }) as typeof bridge.request);
      try {
        fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
        await waitFor(() => expect(failed).toBeGreaterThan(0), { timeout: 8000 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
        expect(on("s12") || on("s10")).toBe(true);
        expect(screen.getByText(/This task is no longer in the repository's ticket store\./)).toBeTruthy();
        failing = false;
        // The read that follows, whatever asks for it: here, the window taking
        // focus again once the read is stale.
        await new Promise((resolve) => setTimeout(resolve, 2100));
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onTestFinished(() => focusManager.setFocused(undefined));
        await waitFor(() => expect(screen.queryByText(/no longer in the repository's ticket store/)).toBeNull(), { timeout: 8000 });
        expect(on("s12") || on("stopped") || on("s13")).toBe(true);
      } finally {
        const live = await liveRun(plan.repoId, plan.key);
        if (live) {
          await sampleBridge.request({ kind: "cancel", jobId: live.id });
          await gone(live.id);
        }
      }
    });
  });

  describe("the acceptance criteria's footer", () => {
    /** The footer's children after its spacer, which is what sits in the bar's right corner. */
    const corner = (primary: HTMLElement): Element[] => {
      const footer = primary.closest("footer.page-footer")!;
      const children = [...footer.children];
      const spacer = children.findIndex((child) => child.classList.contains("spacer"));
      expect(spacer).toBeGreaterThanOrEqual(0);
      // The words stay on the left: the status, then the note.
      const left = children.slice(0, spacer);
      expect(left[0]?.getAttribute("role")).toBe("status");
      expect(left.slice(1).map((child) => child.textContent)).toEqual([
        "Still free to change. Approving on the contract freezes them.",
      ]);
      return children.slice(spacer + 1);
    };

    it("puts Compile the contract there too, after the ways out", async () => {
      const workspace = await sampleBridge.request({ kind: "snapshot" });
      const row = workspace.tasks.find((task) => task.ticket.key === "PRB-421")!;
      location.hash = `task/${row.repoId}/PRB-421/edit`;
      mount();
      const compile = await screen.findByRole("button", { name: "Compile the contract" });
      expect(corner(compile).map((child) => child.textContent)).toEqual([
        "Discard saved edits",
        "Cancel",
        "Compile the contract",
      ]);
    });
  });

  it("drafts a plan in planning mode while a run is going (SCP-335)", async () => {
    // Planning runs beside a run: drafting is planning-lane work, so a loop
    // going elsewhere is never in its way (D-101).
    const running = await runInProgress("PRB-398");
    await planningWithSpec("Monthly export", "Every export carries the month it covers.");
    mount();
    await generatePlan();
    await screen.findByText("Drafting the plan from your spec");

    // Both are in flight: the run was never in the way of the drafting.
    const live = (await sampleBridge.request({ kind: "snapshot" })).jobs.filter((entry) =>
      ["running", "stopping"].includes(entry.state),
    );
    expect(live.map((entry) => entry.kind).sort()).toEqual(["draft", "run"]);
    expect(live.some((entry) => entry.id === running.job.id)).toBe(true);
    await screen.findByRole("dialog", { name: "A simple task" }, { timeout: 8000 });
    await running.stop();
  });

  it("refuses a second run while one is going, and says which one is in the way (SCP-335)", async () => {
    const running = await runInProgress("PRB-404");
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const row = workspace.tasks.find((task) => task.ticket.key === "PRB-421")!;
    const detail = structuredClone(await sampleBridge.request({
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
    const after = (await sampleBridge.request({ kind: "snapshot" })).tasks
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
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const row = workspace.tasks[0]!;
    const detail = structuredClone(
      await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: row.ticket.key }),
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
  it("deletes the ticket it drafted itself", async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const repoId = workspace.repositories[0]!.id;
    const opened = await sampleBridge.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId },
    });
    // It has to draft one: a planning that never admitted a ticket has none of
    // its own to throw away.
    expect(opened.key).toBeNull();
    await sampleBridge.request({
      kind: "specSave",
      id: opened.id,
      repoId,
      title: "A light colour mode",
      sections: {
        outcome: "The application supports a usable light colour mode.",
        requirements: "- The person can choose Light, Dark or System without a restart.",
        no_gos: "",
        rabbit_holes: "",
        notes: "",
      },
      base: {
        title: "",
        sections: { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" },
      },
    });
    const withSpec = await sampleBridge.request({ kind: "editingRead", id: opened.id });
    await sampleBridge.request({
      kind: "editingSubmit",
      id: opened.id,
      revision: withSpec.revision,
      operationId: crypto.randomUUID(),
      intent: "generate",
    });
    let key: string | null = null;
    await waitFor(
      async () => {
        key = (await sampleBridge.request({ kind: "editingRead", id: opened.id })).key;
        expect(key).not.toBeNull();
      },
      { timeout: 5000 },
    );

    await sampleBridge.request({ kind: "editingDiscard", id: opened.id });
    const after = await sampleBridge.request({ kind: "snapshot" });
    expect(after.tasks.some((each) => each.ticket.key === key)).toBe(false);
    expect(after.drafts?.some((draft) => draft.id === opened.id) ?? false).toBe(false);
  });

  // The other side of the same rule, and the one that costs somebody their
  // work if it is wrong. A planning opened over a ticket the CLI admitted, or
  // over one another session drafted, holds that key from birth and did not
  // make it: throwing the planning away must leave the ticket where it was.
  it("leaves a ticket it was only opened over", async () => {
    const before = await sampleBridge.request({ kind: "snapshot" });
    const row = before.tasks.find((each) => each.ticket.state === "plan_review") ?? before.tasks[0]!;
    const session = await sampleBridge.request({
      kind: "editingOpen",
      target: { kind: "ticket", repoId: row.repoId, key: row.ticket.key },
    });
    expect(session.key).toBe(row.ticket.key);

    await sampleBridge.request({ kind: "editingDiscard", id: session.id });
    const after = await sampleBridge.request({ kind: "snapshot" });
    expect(after.tasks.some((each) => each.ticket.key === row.ticket.key)).toBe(true);
    // The planning is gone; only the ticket it never made stays.
    expect(after.drafts?.some((draft) => draft.id === session.id) ?? false).toBe(false);
  });

  // A ticket that has run is kept because this planning did not admit it:
  // throwing a planning away deletes only the ticket it drafted. The stage is
  // no guard, since `discardTicket` deletes at every stage but `pr_open`.
  it("keeps a ticket whose loop has run", async () => {
    const before = await sampleBridge.request({ kind: "snapshot" });
    const run = before.tasks.find(
      (each) => !["draft", "specifying", "plan_review", "ready", "plan_invalid"].includes(each.ticket.state),
    );
    if (!run) return;
    const session = await sampleBridge.request({
      kind: "editingOpen",
      target: { kind: "ticket", repoId: run.repoId, key: run.ticket.key },
    });
    await sampleBridge.request({ kind: "editingDiscard", id: session.id });
    const after = await sampleBridge.request({ kind: "snapshot" });
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
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const row = workspace.tasks.find((each) => each.ticket.approved_at) ?? workspace.tasks[0]!;
    row.ticket = { ...row.ticket, approved_at: "2026-09-01T00:00:00.000Z" };
    const session = await sampleBridge.request({
      kind: "editingOpen",
      target: { kind: "ticket", repoId: row.repoId, key: row.ticket.key },
    });
    await expect(
      sampleBridge.request({
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
    const marked = await sampleBridge.request({
      kind: "explorerMark",
      id: session.id,
      revision: session.revision,
      path: "packages/",
      mark: "prohibited",
      always: true,
    });
    expect(marked.history.at(-1)?.summary).toBe("Always prohibit packages/** in this repository");
    expect(marked.form.draft.prohibited).toContain("packages/**");
    const listing = await sampleBridge.request({ kind: "explorerList", repoId: row.repoId });
    expect(listing.standing.find((entry) => entry.path === "packages/**")?.draft).toBe(session.id);
  });
});

/**
 * The one stage a delete is not offered at.
 *
 * A piece of work is deleted whole at every stage, the loop included
 * (D-129), and the contract page is one of the
 * two places it is offered from. A ticket whose pull request is open is the
 * exception: that record is on GitHub and this machine does not own it, so the
 * page withholds the offer until it is closed or merged, and the host refuses
 * it there too.
 */
describe("the contract page's delete", () => {
  it.each([
    { state: "pr_open" as const, offered: false },
    { state: "merged" as const, offered: true },
  ])("is offered on a ticket at $state: $offered", async ({ state, offered }) => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const row = workspace.tasks.find((task) => task.ticket.key === "PRB-415")!;
    const detail = structuredClone(
      await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: "PRB-415" }),
    );
    detail.ticket = { ...detail.ticket, state };
    client.setQueryData(["detail", row.repoId, "PRB-415"], detail);
    render(
      <QueryClientProvider client={client}>
        <TaskPage
          workspace={workspace}
          navigate={() => undefined}
          repoId={row.repoId}
          taskKey="PRB-415"
          view="contract"
          edit={false}
        />
      </QueryClientProvider>,
    );
    // The page's own way back, which it carries at every stage: the anchor for
    // reading what sits beside it.
    await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Delete this contract" }) !== null).toBe(offered);
  });

  it("never lists a filed ticket on Home while the delete goes, though the host drops its mark first", async () => {
    const { host, mount: mountFresh } = await freshApp();
    const title = "Retire the legacy CSV importer";
    const specs = localStorage.getItem("perbo:preview-specs");
    onTestFinished(() => {
      if (specs !== null) localStorage.setItem("perbo:preview-specs", specs);
    });
    const original = host.request.bind(host);
    const repoId = (await original({ kind: "snapshot" })).repositories[0]!.id;
    await original({ kind: "archive", repoId, keys: ["PRB-415"], archived: true });
    // The host takes the archive mark before the records that no longer hold
    // the ticket are read, and its answer is held until the test lets it go.
    let answer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (answer = resolve));
    vi.spyOn(host, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind === "discard"
        ? original({ kind: "archive", repoId, keys: ["PRB-415"], archived: false })
            .then(() => held)
            .then(() => original(request))
        : original(request)) as typeof host.request);
    location.hash = ["task", repoId, "PRB-415", "contract"].join("/");
    mountFresh();
    fireEvent.click(await screen.findByRole("button", { name: "Delete this contract" }));
    const asking = await screen.findByRole("dialog", { name: "Delete #415?" });
    fireEvent.click(within(asking).getByRole("button", { name: "Delete permanently" }));
    await waitFor(async () =>
      expect((await original({ kind: "snapshot" })).archived?.includes(repoId + ":PRB-415")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole("button", { name: title })).toBeNull();
    answer();
    await waitFor(async () =>
      expect((await original({ kind: "snapshot" })).tasks.some((task) => task.ticket.key === "PRB-415")).toBe(false),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole("button", { name: title })).toBeNull();
  });
});

/**
 * The page a stopped run lands on: from Stop the loop at once, and from Home
 * and the Archive while the ticket is stopped. It holds the ticket's name, that
 * the run was stopped, and three buttons named and nothing else, in the footer:
 * Delete this work and Plan it again at the bottom left, and Continue the task
 * darkened at the far right.
 */
describe("the stopped page", () => {
  const stoppedPage = () => document.querySelector('section[data-screen="stopped"]');
  const jobState = async (id: string) =>
    (await sampleBridge.request({ kind: "snapshot" })).jobs.find((job) => job.id === id)?.state;

  it("lands on the page the moment Stop the loop is pressed, and stays there as the record settles", async () => {
    const { row, job } = await runInProgress("PRB-398");
    location.hash = ["task", row.repoId, "PRB-398", "loop"].join("/");
    mount();
    const stop = (await screen.findByRole("button", { name: "Stop the loop" })) as HTMLButtonElement;
    await waitFor(() => expect(stop.disabled).toBe(false));
    fireEvent.click(stop);
    // The same press: nothing has settled yet.
    expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
    expect(location.hash).toMatch(/\/stopped$/);
    let left = false;
    const watch = new MutationObserver(() => {
      if (!stoppedPage()) left = true;
    });
    watch.observe(document.body, { childList: true, subtree: true });
    try {
      // The host takes the stop at once and settles it once the run has gone,
      // and the page is there while it is still going.
      await waitFor(async () => expect(await jobState(job.id)).toBe("stopping"));
      expect(stoppedPage()).not.toBeNull();
      await waitFor(async () => expect(await jobState(job.id)).toBe("cancelled"));
      // Continue waits for the record, then is offered, on the same page.
      await waitFor(() =>
        expect((screen.getByRole("button", { name: "Continue the task" }) as HTMLButtonElement).disabled).toBe(false),
      );
    } finally {
      watch.disconnect();
    }
    expect(left, "the record catching up never sent the person elsewhere").toBe(false);
  });

  it("Stop's shortcut lands on the page at once too", async () => {
    // Stopped once already by the case above, so the run starts back through ready, as the CLI starts one.
    const { row, job } = await runInProgress("PRB-398");
    location.hash = ["task", row.repoId, "PRB-398", "loop"].join("/");
    mount();
    const stop = (await screen.findByRole("button", { name: "Stop the loop" })) as HTMLButtonElement;
    await waitFor(() => expect(stop.disabled).toBe(false));
    // ⌘. as a Mac reads it.
    setPlatformForTests(true);
    try {
      fireEvent.keyDown(window, { key: ".", metaKey: true });
    } finally {
      setPlatformForTests(null);
    }
    // The same keystroke: nothing has settled yet.
    expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
    expect(location.hash).toMatch(/\/stopped$/);
    await waitFor(async () => expect(await jobState(job.id)).toBe("cancelled"));
  });

  it("is where the ticket opens from Home, and from the Archive once filed, while it is stopped", async () => {
    const { row: { ticket }, job } = await runInProgress("PRB-404");
    await sampleBridge.request({ kind: "cancel", jobId: job.id });
    await waitFor(async () => expect(await jobState(job.id)).toBe("cancelled"));
    mount();
    const card = await screen.findByRole("button", { name: ticket.title });
    fireEvent.click(card);
    expect(await screen.findByRole("heading", { name: "The run was stopped" })).toBeTruthy();
    // Filed from Home, and opened from the Archive.
    location.hash = "home";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    fireEvent.click(within(await screen.findByRole("button", { name: ticket.title })).getByRole("button", { name: "Archive" }));
    await waitFor(async () =>
      expect((await sampleBridge.request({ kind: "snapshot" })).archived?.some((entry) => entry.endsWith(":PRB-404"))).toBe(true),
    );
    // Opened afresh, so nothing of the visit above is kept for it.
    cleanup();
    location.hash = "archive";
    mount();
    // Many tickets are filed in the sample archive: find this one as a person would.
    fireEvent.change(await screen.findByRole("textbox", { name: "Search archived tasks" }), {
      target: { value: "PRB-404" },
    });
    const row = await waitFor(() => {
      const found = screen.getAllByRole("row").find((each) => each.textContent?.startsWith("#404"));
      if (!found) throw new Error("the stopped ticket must be filed in the Archive");
      return found;
    });
    fireEvent.click(row);
    expect(await screen.findByRole("heading", { name: "The run was stopped" })).toBeTruthy();
  });

  it("holds the name, the state and the three ways out at the foot, Continue darkened at the far right after the contract and the output", async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    location.hash = ["task", workspace.repositories[0]!.id, "PRB-415"].join("/");
    mount();
    await screen.findByRole("heading", { name: "The run was stopped" });
    const page = stoppedPage()!;
    const footer = page.querySelector(".stopped-actions")!;
    // The footer every pane has, as the page's last row.
    expect(footer.classList.contains("pane-confirm")).toBe(true);
    expect(page.lastElementChild).toBe(footer);
    const buttons = [...footer.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Delete this work",
      "Plan it again",
      "Open the contract",
      "Watch what the agents did",
      "Continue the task",
    ]);
    expect(buttons.map((button) => button.className)).toEqual([
      "button button--secondary",
      "button button--secondary",
      "button button--secondary",
      "button button--secondary",
      "button button--primary",
    ]);
    // Delete and Plan again at the start of the row, and the rest at its end,
    // the highlighted one rightmost.
    expect(buttons[1]!.nextElementSibling!.className).toBe("spacer");
    expect(footer.lastElementChild).toBe(buttons[4]);
    // No description anywhere: the body says the run was stopped, and the
    // header names the ticket.
    expect(page.querySelector(".stopped-body")!.textContent).toBe("The run was stopped");
    expect(page.querySelectorAll("p, h2, dl, label, input").length).toBe(0);
    expect(page.querySelectorAll("button").length).toBe(5);
  });

  it("continues where the stopped attempt left off", async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const repoId = workspace.repositories[0]!.id;
    const detail = await sampleBridge.request({ kind: "detail", repoId, key: "PRB-415" });
    const sealed = detail.attempts.at(-1)?.bundles.find((bundle) => bundle.kind === "execution");
    if (!sealed) throw new Error("the stopped sample must retain an execution bundle");
    location.hash = ["task", repoId, "PRB-415"].join("/");
    mount();
    await screen.findByRole("heading", { name: "The run was stopped" });
    const sent = holdRun();
    fireEvent.click(screen.getByRole("button", { name: "Continue the task" }));
    expect(await sent()).toMatchObject({ kind: "run", key: "PRB-415", approve: false, resumeFrom: sealed.bundle_id });
  });

  it("plans it again onto the new plan's graph", async () => {
    const { host, mount: mountFresh } = await freshApp();
    const before = await host.request({ kind: "snapshot" });
    const repoId = before.repositories[0]!.id;
    // The spec's requirements with their ids, as a save writes them, so the
    // drafter divides the plan and it has a graph to land on.
    const held = localStorage.getItem("perbo:preview-specs")!;
    const files = JSON.parse(held) as Record<string, string>;
    let id = 0;
    files["retire-the-legacy-csv-importer"] = files["retire-the-legacy-csv-importer"]!.replace(
      /^- (?!Nothing)/gm,
      () => `- R${++id}: `,
    );
    localStorage.setItem("perbo:preview-specs", JSON.stringify(files));
    try {
      location.hash = ["task", repoId, "PRB-415"].join("/");
      mountFresh();
      await screen.findByRole("heading", { name: "The run was stopped" });
      fireEvent.click(screen.getByRole("button", { name: "Plan it again" }));
      await waitFor(() => expect(location.hash).toMatch(/^#planning\/[^/]+\/[a-z]+$/));
      const [, sessionId, pane] = location.hash.split("/");
      const drafted = (await host.request({ kind: "drafts" })).find((draft) => draft.id === sessionId)!;
      expect(drafted.nodes).toBeGreaterThan(0);
      expect(pane).toBe("graph");
      expect(await screen.findByRole("heading", { name: "Execution graph" })).toBeTruthy();
    } finally {
      localStorage.setItem("perbo:preview-specs", held);
    }
  });
});

describe("continuing a filed stopped run", () => {
  it("returns it to Home as its loop starts, and keeps it there when it stops again", async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    // Filed with its pull request closed unmerged: a run takes it back through ready.
    const key = "PRB-396";
    const repoId = workspace.tasks.find((row) => row.ticket.key === key)!.repoId;
    const entry = repoId + ":" + key;
    const filed = async () => (await sampleBridge.request({ kind: "snapshot" })).archived ?? [];
    const runThenStop = async () => {
      const { job } = await runInProgress(key, false);
      const during = await filed();
      await sampleBridge.request({ kind: "cancel", jobId: job.id });
      await gone(job.id);
      return during;
    };
    // Stopped, then filed by hand.
    await runThenStop();
    await sampleBridge.request({ kind: "archive", repoId, keys: [key], archived: true });
    expect(await filed()).toContain(entry);
    // Continued from the Archive, it is on Home while it runs and stays there once it stops again.
    expect(await runThenStop()).not.toContain(entry);
    expect(await filed()).not.toContain(entry);
  });
});

describe("Plan it again on a stopped run (D-129)", () => {
  /**
   * From the Archive: a stopped ticket filed there opens on its stopped page,
   * and Plan it again goes into the planning over the plan it drafts, with its
   * tabs — the Graph for an epic, the contract for a basic ticket — and never
   * to the loop's pages (D-NEW-basic-and-epic-flows).
   */
  it.each([
    ["an epic on its Graph", false, "graph"],
    ["a basic ticket on its contract", true, "contract"],
  ] as const)("lands %s, planned again from an archived stopped ticket", async (_, flat, pane) => {
    const { host, mount: mountFresh } = await freshApp();
    const held = localStorage.getItem("perbo:preview-specs");
    onTestFinished(() => {
      if (held !== null) localStorage.setItem("perbo:preview-specs", held);
    });
    if (flat) {
      // One requirement, so the drafter has nothing to divide.
      const specs = JSON.parse(held ?? "{}") as Record<string, string>;
      specs["retire-the-legacy-csv-importer"] = specs["retire-the-legacy-csv-importer"]!.replace(
        /## Requirements[\s\S]*?(?=\n## )/,
        "## Requirements\n\n- R1: The legacy importer and its routes are removed.\n",
      );
      localStorage.setItem("perbo:preview-specs", JSON.stringify(specs));
    }
    const repoId = (await host.request({ kind: "snapshot" })).repositories[0]!.id;
    await host.request({ kind: "archive", repoId, keys: ["PRB-415"], archived: true });
    mountFresh();
    await screen.findByRole("heading", { name: /Hi, / });
    fireEvent.click(within(document.querySelector(".rail") as HTMLElement).getByRole("button", { name: "Archive" }));
    const rows = await screen.findAllByRole("row");
    fireEvent.click(rows.find((row) => row.textContent?.includes("#415"))!);
    await screen.findByRole("heading", { name: "The run was stopped" }, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Plan it again" }));
    await waitFor(() => expect(location.hash).toMatch(new RegExp(`^#planning/[^/]+/${pane}$`)), { timeout: 8000 });
    await screen.findByRole(pane === "graph" ? "heading" : "button", {
      name: pane === "graph" ? "Execution graph" : "Approve · start the loop",
    }, { timeout: 8000 });
    // Inside the planning, with its tabs, and no page of the loop.
    const tabs = within(screen.getByRole("group", { name: "Planning panes" }))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(tabs).toContain(pane === "graph" ? "Graph" : "Confirm contract");
    for (const loop of ["s12", "s13", "s15", "s16", "stopped"])
      expect(document.querySelector(`section[data-screen="${loop}"]`), loop).toBeNull();
  });

  /**
   * The stopped sample ticket planned again as a basic ticket, through its
   * page's Plan it again, in a sample workspace of its own, landed on the
   * contract of the plan drafted. `flagged` is what the impact check finds.
   */
  async function plannedAgainFlat(flagged: string[] = []) {
    const { host, mount: mountFresh } = await freshApp();
    const held = localStorage.getItem("perbo:preview-specs");
    onTestFinished(() => {
      if (held !== null) localStorage.setItem("perbo:preview-specs", held);
    });
    // One requirement, so the drafter has nothing to divide.
    const specs = JSON.parse(held ?? "{}") as Record<string, string>;
    specs["retire-the-legacy-csv-importer"] = specs["retire-the-legacy-csv-importer"]!.replace(
      /## Requirements[\s\S]*?(?=\n## )/,
      "## Requirements\n\n- R1: The legacy importer and its routes are removed.\n",
    );
    localStorage.setItem("perbo:preview-specs", JSON.stringify(specs));
    if (flagged.length > 0) {
      // The fresh sample's own impact check, finding these paths outside the scope.
      const { handlers: fresh } = await import("../../sample-host/handlers.js");
      const { editing: freshEditing } = await import("../../sample-host/records.js");
      const original = fresh.impactRead;
      vi.spyOn(fresh, "impactRead").mockImplementation(async (request, owner) => {
        const view = await original(request, owner);
        freshEditing.recordImpact(request.id, flagged.length);
        return {
          ...view,
          warnings: flagged.map((path) => ({ path, package: "packages/app", reasons: [{ kind: "config" as const, detail: "Configuration." }] })),
          truncated: 0,
        };
      });
    }
    mountFresh();
    fireEvent.click(await screen.findByRole("button", { name: "Retire the legacy CSV importer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Plan it again" }));
    await waitFor(() => expect(location.hash).toMatch(/^#planning\/[^/]+\/contract$/), { timeout: 8000 });
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 8000 });
    const id = location.hash.split("/")[1]!;
    const { key } = await host.request({ kind: "editingRead", id });
    const drifts = async () =>
      (await host.request({ kind: "snapshot" })).jobs.filter((job) => job.kind === "drift" && job.key === key);
    return { host, id, key: key!, drifts };
  }
  /** The rail's planning panes, by name. */
  const railTabs = (): string[] =>
    within(screen.getByRole("group", { name: "Planning panes" }))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? "");

  it("confirms a basic plan drafted again unchanged straight away, with no reading", async () => {
    const { host, id, key, drifts } = await plannedAgainFlat();
    // Read by its drafting, as a plan Generate plan drafts is: nothing read as
    // it lands, and no Problems tab (D-NEW-basic-and-epic-flows).
    expect((await host.request({ kind: "editingRead", id })).read).not.toBeNull();
    expect(await drifts()).toEqual([]);
    expect(railTabs()).not.toContain("Problems");
    const original = host.request.bind(host);
    const sent = vi.spyOn(host, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind === "run" ? Promise.resolve(null as never) : original(request)) as typeof host.request);
    const pages: string[] = [];
    const watcher = new MutationObserver(() => {
      if ([...document.querySelectorAll("h1")].some((heading) => heading.textContent === "Checking for drift")) pages.push("drift");
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
      await waitFor(() => expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(true), { timeout: 5000 });
    } finally {
      watcher.disconnect();
    }
    expect(sent.mock.calls.map(([request]) => request.kind)).not.toContain("driftCheck");
    expect(await drifts()).toEqual([]);
    expect(pages).toEqual([]);
    expect(sent.mock.calls.find(([request]) => request.kind === "run")?.[0]).toMatchObject({ kind: "run", key, approve: true });
  });

  it("reads the criteria edited on the contract after Plan it again, and what the reading finds holds the confirm", async () => {
    const { host, id, key, drifts } = await plannedAgainFlat();
    fireEvent.click(screen.getByRole("button", { name: "Edit criterion 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 1" }), {
      target: { value: "The legacy importer stays, behind a flag." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("The legacy importer stays, behind a flag.", { selector: ".criterion-text" }, { timeout: 8000 });
    await waitFor(() => expect(screen.queryByText("Writing the change into the contract…")).toBeNull(), { timeout: 8000 });
    const original = host.request.bind(host);
    const sent = vi.spyOn(host, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind === "run" ? Promise.resolve(null as never) : original(request)) as typeof host.request);
    fireEvent.click(screen.getByRole("button", { name: "Approve · start the loop" }));
    await screen.findByText(PROBLEMS_HOLD, {}, { timeout: 8000 });
    // One reading, asked of the state the edit left, and a model's — not the
    // draft's agreeing verdict printed back — judging the edited words.
    const asked = sent.mock.calls.filter(([request]) => request.kind === "driftCheck").map(([request]) => request);
    expect(asked).toHaveLength(1);
    const read = await drifts();
    expect(read).toHaveLength(1);
    expect(read[0]!.result).toMatchObject({ cached: false });
    expect(JSON.stringify((read[0]!.result as { findings: unknown[] }).findings)).toContain("behind a flag");
    expect((await host.request({ kind: "editingRead", id })).read).toBe((asked[0] as { state: string }).state);
    expect(sent.mock.calls.some(([request]) => request.kind === "run")).toBe(false);
    await waitFor(() => expect(railTabs().at(-1)).toBe("Problems"));
    void key;
  });

  it("lands a basic plan drafted again with Impact in its rail where the impact check flags paths", async () => {
    await plannedAgainFlat(["config/importer.json"]);
    // Checked as the planning opens over it, where it opened.
    await waitFor(() => expect(railTabs()).toEqual(["Spec", "Explorer", "Impact", "Confirm contract"]), { timeout: 8000 });
    expect(location.hash).toMatch(/\/contract$/);
    fireEvent.click(within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name: "Impact" }));
    expect(await screen.findByText("config/importer.json")).toBeTruthy();
  });

  it("takes the stopped ticket off Home at the click and for good, and lists the plan drafted from its spec in the picker", async () => {
    const { host, mount: mountFresh } = await freshApp();
    const title = "Retire the legacy CSV importer";
    const specs = localStorage.getItem("perbo:preview-specs");
    onTestFinished(() => {
      if (specs !== null) localStorage.setItem("perbo:preview-specs", specs);
    });
    // The host's answer held until the test lets it go, so what Home shows
    // before the host has deleted anything is what is read.
    const original = host.request.bind(host);
    let answer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (answer = resolve));
    vi.spyOn(host, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind === "replan" ? held.then(() => original(request)) : original(request)) as typeof host.request);
    mountFresh();
    const card = await screen.findByRole("button", { name: title });
    expect(card.className).toContain("task-card--red");
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole("button", { name: "Plan it again" }));
    // At once: the host still holds the ticket, and Home does not list it.
    expect((await original({ kind: "snapshot" })).tasks.some((task) => task.ticket.key === "PRB-415")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
    expect(screen.queryByRole("button", { name: title })).toBeNull();
    // The plan drafted, and the planning over it opened.
    answer();
    await waitFor(() => expect(location.hash).toMatch(/^#planning\//));
    // After the delete has settled: gone from the host and from Home.
    const after = await original({ kind: "snapshot" });
    expect(after.tasks.some((task) => task.ticket.key === "PRB-415")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
    await waitFor(() => expect(screen.queryByRole("button", { name: title })).toBeNull());
    // And the work is before the loop again, in the picker, as a planning.
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    expect(within(picker).getByRole("button", { name: /^Retire the legacy CSV importer.*drafted, not approved$/ })).toBeTruthy();
    expect(within(picker).getByRole("button", { name: "Delete planning: " + title })).toBeTruthy();
  });

  it("lists the ticket on Home again once the page a refusal was read on is left", async () => {
    const { host, mount: mountFresh } = await freshApp();
    const title = "Retire the legacy CSV importer";
    const original = host.request.bind(host);
    vi.spyOn(host, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind === "replan"
        ? Promise.reject(new Error("PRB-415 was not drafted from a spec"))
        : original(request)) as typeof host.request);
    mountFresh();
    const card = await screen.findByRole("button", { name: title });
    expect(card.className).toContain("task-card--red");
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole("button", { name: "Plan it again" }));
    // The reason stays on the page it was pressed on.
    expect(await screen.findByText(/was not drafted from a spec/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
    expect(await screen.findByRole("button", { name: title })).toBeTruthy();
  });

  it("is not offered where the pull request is open, because that ticket is not deleted", async () => {
    const host = await freshHost();
    const { TaskPage: Fresh } = await import("../tasks/TaskPage.js");
    const workspace = await host.request({ kind: "snapshot" });
    const row = workspace.tasks.find((task) => task.ticket.key === "PRB-415")!;
    const detail = structuredClone(await host.request({ kind: "detail", repoId: row.repoId, key: "PRB-415" }));
    // Asked for by name while the record a stop left is read, which is how
    // the page is reached with a pull request already open.
    detail.ticket = { ...row.ticket, state: "pr_open" };
    client.setQueryData(["detail", row.repoId, "PRB-415"], detail);
    render(
      <QueryClientProvider client={client}>
        <Fresh workspace={{ ...workspace, refreshingRepos: [row.repoId] }} navigate={() => undefined} repoId={row.repoId} taskKey="PRB-415" view="stopped" edit={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan it again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue the task" })).toBeTruthy();
  });

  it("keeps the stopped page while the ticket is deleted from under it and the plan is drafted", async () => {
    await freshHost();
    const { TaskPage: Fresh } = await import("../tasks/TaskPage.js");
    const { CreateContext, deletes } = await import("./create.js");
    const { bridge: host } = await import("../workspace/index.js");
    const workspace = await host.request({ kind: "snapshot" });
    const row = workspace.tasks.find((task) => task.ticket.key === "PRB-415")!;
    const detail = structuredClone(await host.request({ kind: "detail", repoId: row.repoId, key: "PRB-415" }));
    detail.ticket = row.ticket;
    client.setQueryData(["detail", row.repoId, "PRB-415"], detail);
    // The host has deleted the ticket and is still drafting: a read of it fails.
    vi.spyOn(host, "request").mockRejectedValue(new Error("This task is no longer in the repository's ticket store."));
    const open = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <CreateContext.Provider
          value={{ open, openUnselected: open, toggle: open, enter: open, leave: open, isOpen: false, deleting: new Set([deletes.ticket(row.repoId, "PRB-415")]), hide: () => () => undefined }}
        >
          <Fresh workspace={workspace} navigate={() => undefined} repoId={row.repoId} taskKey="PRB-415" view="stopped" edit={false} />
        </CreateContext.Provider>
      </QueryClientProvider>,
    );
    await client.refetchQueries({ queryKey: ["detail", row.repoId, "PRB-415"] }).catch(() => undefined);
    await waitFor(() => expect(client.getQueryState(["detail", row.repoId, "PRB-415"])?.status).toBe("error"));
    expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
    expect(screen.queryByText(/no longer in the repository's ticket store/)).toBeNull();
  });
});

/**
 * Deleting a run somebody stopped.
 *
 * A piece of work is deleted whole at every stage, the loop included, and the
 * evidence goes with it (D-129). Last in this
 * file because it takes the sample stopped run off the board for good, which
 * is the point of it.
 */
describe("deleting a stopped run", () => {
  it("takes the ticket, its records and the spec it was drafted from", async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const repoId = workspace.repositories[0]!.id;
    const slug = "retire-the-legacy-csv-importer";
    // The spec is in the repository while the stopped ticket names it:
    // opening it starts a planning over the writing that is there, and
    // throwing that planning away leaves the spec, because the ticket still
    // names it.
    const opened = await sampleBridge.request({
      kind: "editingOpen",
      target: { kind: "spec", repoId, slug },
    });
    await sampleBridge.request({
      kind: "editingDiscard",
      id: opened.id,
      revision: opened.revision,
    });
    expect(
      (await sampleBridge.request({ kind: "snapshot" })).tasks.some(
        (row) => row.ticket.key === "PRB-415",
      ),
    ).toBe(true);

    const detail = structuredClone(
      await sampleBridge.request({ kind: "detail", repoId, key: "PRB-415" }),
    );
    const after = await sampleBridge.request({ kind: "snapshot" });
    const row = after.tasks.find((task) => task.ticket.key === "PRB-415")!;
    detail.ticket = row.ticket;
    mountTaskFromHome(after, repoId, detail);
    const card = screen.getByRole("button", { name: row.ticket.title });
    expect(card.className).toContain("task-card--red");
    fireEvent.click(card);
    fireEvent.click(screen.getByRole("button", { name: "Delete this work" }));
    const asking = await screen.findByRole("dialog", { name: "Delete #415?" });
    fireEvent.click(within(asking).getByRole("button", { name: "Delete permanently" }));

    await waitFor(async () =>
      expect(
        (await sampleBridge.request({ kind: "snapshot" })).tasks.some(
          (task) => task.ticket.key === "PRB-415",
        ),
      ).toBe(false),
    );
    // Its records go with it: there is nothing left to read about it.
    await expect(sampleBridge.request({ kind: "detail", repoId, key: "PRB-415" })).rejects.toThrow(
      /Sample task not found/,
    );
    // And the spec folder, which nothing names any more.
    await expect(
      sampleBridge.request({ kind: "editingOpen", target: { kind: "spec", repoId, slug } }),
    ).rejects.toThrow(/no longer in the repository/);
  });
});
