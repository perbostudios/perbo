// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TicketState } from "@perbo/contracts";
import { App } from "./App.js";
import { Rail } from "./Rail.js";
import { CreateProvider } from "./create.js";
import { HomePage } from "../tasks/HomePage.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import { bridge } from "../workspace/index.js";
import { setPlatformForTests } from "../../shared/shortcuts.js";
import { resetRailSize } from "./rail-size.js";
import { resetLabel } from "../settings/UsagePage.js";
import type { Change, ReplyMap, Request, Snapshot, TaskRow } from "../../shared/protocol.js";

let client: QueryClient;
beforeEach(() => {
  // jsdom has no <dialog> implementation; the confirmation dialog only needs open/close.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  }
  sessionStorage.clear();
  localStorage.removeItem("perbo:preview-editing");
  location.hash = "home";
  setPlatformForTests(true);
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
  setPlatformForTests(null);
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.textSize;
  delete document.documentElement.dataset.motion;
});
function mount() {
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}
/**
 * The app over a sample workspace of its own, for a test that deletes the
 * stopped sample the other tests in this file read. The fresh sample host goes
 * in the adapter slot before the app's modules load, since the slot is read
 * as they do, and the shared one goes back once the test is over.
 */
async function freshSample() {
  vi.resetModules();
  const { sampleBridge: sample } = await import("../../sample-host/bridge.js");
  const shared = window.perbo;
  window.perbo = sample;
  onTestFinished(() => {
    if (shared) window.perbo = shared;
    else delete window.perbo;
  });
  const { App: Fresh } = await import("./App.js");
  const { bridge: host } = await import("../workspace/index.js");
  return {
    host,
    sample,
    mount: () =>
      render(
        <QueryClientProvider client={client}>
          <Fresh />
        </QueryClientProvider>,
      ),
  };
}
/** Opens the sample's unapproved plan from the Create picker and goes on to its contract. */
async function openTheContract(): Promise<void> {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
  fireEvent.click(within(picker).getByRole("button", { name: /^Split the settings page into tabs/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Confirm the plan|Open the contract/ }, { timeout: 5000 }),
  );
}
/**
 * What a ticket's page says while it reads, recorded as each is put up, and a
 * way to wait for one plain read of the ticket to come and go.
 */
function watchTheWait(): { said: string[]; read: () => Promise<void> } {
  const said: string[] = [];
  let up: string | null = null;
  const watch = new MutationObserver(() => {
    const now =
      ["Compiling the contract", "Reading the task and its evidence…"].find(
        (text) => screen.queryByText(text) !== null,
      ) ?? null;
    if (now !== null && now !== up) said.push(now);
    up = now;
  });
  watch.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => watch.disconnect());
  const read = async (): Promise<void> => {
    const before = said.length;
    await waitFor(() => expect(said.slice(before)).toContain("Reading the task and its evidence…"));
    await waitFor(() => expect(screen.queryByText("Reading the task and its evidence…")).toBeNull(), {
      timeout: 5000,
    });
  };
  return { said, read };
}
async function resetPreviewSettings(): Promise<void> {
  const snapshot = await sampleBridge.request({ kind: "snapshot" });
  await sampleBridge.request({
    kind: "saveSettings",
    settings: { ...snapshot.settings, theme: "system", textSize: "default", reduceMotion: false, shortcuts: {} },
  });
}

describe("UI v2", () => {
  it("opens settings on General, moves through the pill, and keeps breadcrumbs one level deep", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    await screen.findByText("General", { selector: ".header-section" }, { timeout: 5000 });
    expect(document.querySelector('[data-screen="s6f"]')).toBeTruthy();
    const pill = screen.getByRole("group", { name: "Settings sections" });
    expect(pill.getAttribute("aria-hidden")).toBe("false");
    fireEvent.click(within(pill).getByRole("button", { name: "Usage" }));
    await screen.findByText("Plans in use");
    expect(document.querySelector('[data-screen="s6e"]')).toBeTruthy();
    fireEvent.click(within(pill).getByRole("button", { name: "Connections" }));
    await screen.findByText("Connections", { selector: ".header-section" });
    expect(screen.getByRole("button", { name: "Change executor model" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "change in General" }));
    fireEvent.click(await screen.findByRole("button", { name: /About/ }));
    await screen.findByText("About", { selector: ".header-section" });
    expect(screen.getByText("Spent in", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText("General", { selector: ".header-section" });
  });

  it("saves appearance from General and reflects it on the document", async () => {
    await resetPreviewSettings();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const theme = await screen.findByRole("tablist", { name: "Theme" });
    fireEvent.click(within(theme).getByRole("tab", { name: "Dark" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    await waitFor(() => expect(document.documentElement.dataset.motion).toBe("reduced"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Any stage changes/ }));
    await waitFor(async () => {
      const saved = (await sampleBridge.request({ kind: "snapshot" })).settings;
      expect(saved.theme).toBe("dark");
      expect(saved.reduceMotion).toBe(true);
      expect(saved.notifyOn.stage).toBe(true);
    });
    expect(screen.queryByText(/phone/i)).toBeNull();
    fireEvent.click(within(theme).getByRole("tab", { name: "System" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
    await resetPreviewSettings();
  });

  it("records a shortcut, refuses one already in use by name, and dispatches the new binding", async () => {
    await resetPreviewSettings();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: /Shortcuts/ }));
    await screen.findByText("Shortcuts", { selector: ".header-section" });
    const createRow = screen.getByRole("button", { name: /Create a task: ⌘ N/ });
    fireEvent.click(createRow);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect((await screen.findByRole("alert")).textContent).toMatch(/already Search running tickets/);
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    await screen.findByRole("button", { name: /Create a task: ⌘ J/ });
    expect((screen.getByRole("button", { name: /Approve the contract: ⇧ ⌘ ↵ \(fixed\)/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByText("General", { selector: ".header-section" });
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Plan a piece of work" })).toBeNull();
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    await screen.findByRole("dialog", { name: "Plan a piece of work" });
    await resetPreviewSettings();
  });

  it("keeps a completed ticket on Home until it is archived by hand, then files it", async () => {
    mount();
    const card = await screen.findByRole("button", { name: "Retry the webhook dispatcher three times" });
    expect(card.className).toContain("task-card--complete");
    expect(screen.getByText("2 completed")).toBeTruthy();
    await within(card).findByText("perbo/409-webhook-retry");
    await within(card).findByText("+72");
    fireEvent.click(within(card).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry the webhook dispatcher three times" })).toBeNull(),
    );
    fireEvent.click(within(screen.getByRole("complementary", { name: "Main navigation" })).getByRole("button", { name: "Archive" }));
    await screen.findByRole("table", { name: "Archived tickets" });
    const row = (await screen.findAllByRole("row")).find((entry) => within(entry).queryByText("#409"))!;
    await within(row).findByText("+72");
    fireEvent.click(within(row).getByRole("button", { name: "Return this ticket to Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("button", { name: "Retry the webhook dispatcher three times" });
  });

  it("searches and filters the running list and focuses search from the shortcut", async () => {
    mount();
    const search = await screen.findByLabelText("Search running tickets");
    fireEvent.change(search, { target: { value: "invite" } });
    expect(screen.getByRole("button", { name: "Rate-limit the invite endpoint" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Backfill the audit table" })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Filter tickets"));
    fireEvent.click(screen.getByRole("option", { name: "Show · needs you" }));
    // A finding to answer needs you; an open pull request is the journey's end.
    expect(screen.getAllByRole("button", { name: /Answer|Merge/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Backfill the audit table" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rate-limit the invite endpoint" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Split the settings page into tabs" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Filter tickets"));
    fireEvent.click(screen.getByRole("option", { name: "Show · all" }));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(search);
  });

  it("shows the usage page honestly: provider windows only where reported, the ledger from records", async () => {
    const original = bridge.request.bind(bridge);
    const weekly = new Date(Date.now() + 3 * 86_400_000);
    vi.spyOn(bridge, "request").mockImplementation(async <T extends Request>(request: T): Promise<ReplyMap[T["kind"]]> => {
      if (request.kind === "usage")
        return {
          readAt: new Date().toISOString(),
          ledger: { month: "2026-09", spentMicros: 2_140_000, pricedAttempts: 3, unpricedAttempts: 1, ticketsRun: 2, ticketsMerged: 1, stoppedShort: 1, averageMergedMicros: null },
          providers: [
            { id: "claude", name: "Claude Code", role: "default executor", connected: true, plan: "Max", detail: "Read from Claude Code.", windows: [
              { label: "5-hour limit", usedPercent: 9, resetsAt: new Date(Date.now() + 225 * 60_000).toISOString() },
              { label: "Weekly · all models", usedPercent: 37, resetsAt: weekly.toISOString() },
              { label: "Weekly · Fable", usedPercent: 36, resetsAt: weekly.toISOString() },
            ] },
            { id: "codex", name: "Codex", role: "default reviewer", connected: true, plan: "Pro", windows: [{ label: "5-hour limit", usedPercent: 82, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }], detail: "Read from the Codex app-server." },
            { id: "anthropic", name: "Anthropic API", role: null, connected: false, plan: null, windows: null, detail: "No API key in the app environment." },
          ],
          notes: ["webstore · PRB-2: The attempts record could not be read."],
        } as ReplyMap[T["kind"]];
      return original(request);
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Usage" }));
    await screen.findByText("Codex · Pro");
    const claude = screen.getByText("Claude Code · Max").closest("section")!;
    expect(within(claude).getAllByRole("meter").map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuenow")])).toEqual([
      ["5-hour limit", "9"],
      ["Weekly · all models", "37"],
      ["Weekly · Fable", "36"],
    ]);
    const meter = within(claude).getAllByRole("meter")[0]!;
    expect(meter.querySelector("span")!.style.width).toBe("9%");
    const rows = [...claude.querySelectorAll(".usage-window .row")].map((row) => row.textContent);
    const weeklyReset = `Resets ${weekly.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
    expect(rows).toEqual([
      "5-hour limitResets in 3 hr 45 min9% used",
      `Weekly · all models${weeklyReset}37% used`,
      `Weekly · Fable${weeklyReset}36% used`,
    ]);
    expect(claude.querySelector(".connection-dot")?.classList.contains("disconnected")).toBe(false);
    expect(screen.getByText("Anthropic API").closest("section")!.querySelector(".connection-dot")?.classList.contains("disconnected")).toBe(true);
    expect(document.querySelector(".usage-facts")?.textContent).toContain("$2.14");
    expect(screen.getByText(/1 unpriced attempt/)).toBeTruthy();
    // D-096: a ticket counted here stopped short of finishing, which is a
    // stall as often as a ceiling the repository set.
    expect(screen.getByText(/1 stopped short/)).toBeTruthy();
    expect(screen.getByText(/not every attempt was priced/)).toBeTruthy();
    expect(screen.getByText(/Codex’s 5-hour limit is at 82%/)).toBeTruthy();
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByText(/held/)).toBeNull();
  });

  it("opens the rail by default, collapses it away from the toggle, and remembers the choice", async () => {
    resetRailSize();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Reduce the sidebar" }));
    expect(document.querySelector(".settings-pill")).toBeNull();
    expect(document.querySelector(".rail")).toBeNull();
    expect(document.querySelector(".titlebar .rail-toggle")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("perbo:rail")!)).toMatchObject({ collapsed: true });
    fireEvent.click(screen.getByRole("button", { name: "Expand the sidebar" }));
    expect((document.querySelector(".rail") as HTMLElement).style.width).toBe("66px");
    expect(document.querySelector(".settings-pill")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".rail-resize")).toBeNull();
    resetRailSize();
  });

  it("asks in the picker's own dialog, keeps the picker up behind it, and deletes nothing when declined", async () => {
    // Answered in the app and not by the browser: a native modal takes the
    // pointer out of the panel, and a panel opened by hover closes when the
    // pointer leaves it — so answering would shut the list being answered about
    // (D-129).
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    fireEvent.click(
      within(picker).getByRole("button", {
        name: /^Delete plan: Split the settings page into tabs/,
      }),
    );

    const asking = await screen.findByRole("dialog", { name: "Delete plan" });
    // Where they are, and that all of it goes. A piece of work is one thing:
    // leaving the spec behind would put a row back under the same title the
    // moment the delete finished, which reads as a copy of what was removed.
    expect(asking.textContent).toContain("A plan is drafted and not approved");
    expect(asking.textContent).toContain("the spec folder they came from all go");
    expect(asking.textContent).not.toContain("stays");

    // Declining keeps both the ticket and the picker.
    fireEvent.click(within(asking).getByRole("button", { name: "Keep it" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete plan" })).toBeNull(),
    );
    expect(screen.queryByRole("dialog", { name: "Plan a piece of work" })).toBeTruthy();
    const held = await sampleBridge.request({ kind: "snapshot" });
    expect(held.tasks.some((row) => row.ticket.key === "PRB-421")).toBe(true);

    // And accepting asks the host to delete that ticket and no other.
    const original = bridge.request.bind(bridge);
    const sent = vi
      .spyOn(bridge, "request")
      .mockImplementation(((request: Parameters<typeof original>[0]) =>
        request.kind === "discard"
          ? Promise.resolve(null)
          : original(request)) as typeof bridge.request);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Plan a piece of work" })).getByRole(
        "button",
        { name: /^Delete plan: Split the settings page into tabs/ },
      ),
    );
    const again = await screen.findByRole("dialog", { name: "Delete plan" });
    fireEvent.click(within(again).getAllByRole("button", { name: "Delete plan" })[0]!);
    await waitFor(() =>
      expect(
        sent.mock.calls.some(
          ([request]) => request.kind === "discard" && request.key === "PRB-421",
        ),
      ).toBe(true),
    );
  });

  it("goes back from the contract to the plan it was confirmed from", async () => {
    // Confirming a plan leads here from the Graph, and the contract is where a
    // person reads what approving would freeze. Not being ready to approve
    // means going back to the plan to change it, so Back is the way to the
    // graph rather than to the task's own editor, which is a different page
    // for a different job.
    await openTheContract();
    const back = await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 });
    expect(back.hasAttribute("disabled"), "there is a plan to go back to").toBe(false);
    fireEvent.click(back);
    await waitFor(() => expect(location.hash).toMatch(/^#planning\/.*\/graph$/), { timeout: 5000 });
  });

  it("chooses the models on the contract, which is the page before the loop", async () => {
    // The models are not among the four fields approving freezes (ADR-0016),
    // so they stay a choice right up to the moment the loop starts — and this
    // is the last page before it.
    await openTheContract();
    await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 });

    // Each role opens its own picker, from the block that states it.
    const change = await screen.findByRole("button", { name: "Change executor model" });
    expect(screen.getByRole("button", { name: "Change reviewer model" })).toBeTruthy();
    fireEvent.click(change);
    const popup = await screen.findByRole("group", { name: "executor model selection" });

    // Both roles are choosable, and the skills the executor may use are in the
    // same place rather than on a screen of their own.
    expect(within(popup).getByRole("combobox", { name: "Model" })).toBeTruthy();
    expect(within(popup).getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("says the contract is being compiled on the way to it", async () => {
    // Confirming a plan runs a command that reads the ticket, and the page it
    // leads to cannot draw until that answers. A sentence with no sign of work
    // behind it reads as a page that failed to load.
    await openTheContract();
    expect(await screen.findByText("Compiling the contract")).toBeTruthy();
    // And it gives way to the page itself.
    await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 });
    expect(screen.queryByText("Compiling the contract")).toBeNull();
  });

  it("only reads the ticket, and compiles nothing, when a ticket is opened from Home", async () => {
    // Opening a ticket reads it; the contract is compiled on the way from a
    // confirmed plan and on no other way onto a ticket's page.
    mount();
    await screen.findByRole("heading", { name: /Hi, / });
    const { said, read } = watchTheWait();
    for (const title of ["Activation email never sent on signup", "Rate-limit the invite endpoint"]) {
      location.hash = "home";
      fireEvent.click(await screen.findByRole("button", { name: title }, { timeout: 5000 }));
      await read();
    }
    // And a link to the plan waiting for approval while it is in planning,
    // which is the ticket a confirm compiles.
    location.hash = "home";
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    fireEvent.click(within(picker).getByRole("button", { name: /^Split the settings page into tabs/ }));
    await screen.findByRole("heading", { name: "Execution graph" }, { timeout: 5000 });
    const planning = location.hash.split("/")[1];
    const waiting = (await sampleBridge.request({ kind: "snapshot" })).drafts!.find(
      (draft) => draft.id === planning,
    )!;
    location.hash = "home";
    await screen.findByRole("heading", { name: /Hi, / });
    location.hash = `task/${waiting.repoId}/${waiting.key}`;
    await read();
    expect(said).not.toContain("Compiling the contract");
  });

  it("only reads the ticket, and compiles nothing, coming back to a contract the planning was left at", async () => {
    // The contract was compiled on the way from the confirm; a person who
    // left the planning there and comes back to it is reading the ticket
    // again (D-130), whether the picker takes them or the contract's own
    // address does, as Back does.
    await openTheContract();
    await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 });
    const contract = location.hash;
    const [, repoId, key] = contract.slice(1).split("/");
    const planning = (await sampleBridge.request({ kind: "snapshot" })).drafts!.find(
      (draft) => draft.repoId === repoId && draft.key === key,
    )!;
    await waitFor(async () =>
      expect((await sampleBridge.request({ kind: "editingRead", id: planning.id })).lastView).toBe("contract"),
    );
    const { said, read } = watchTheWait();

    location.hash = "home";
    await screen.findByRole("heading", { name: /Hi, / });
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    fireEvent.click(within(picker).getByRole("button", { name: /^Split the settings page into tabs/ }));
    await read();

    location.hash = "home";
    await screen.findByRole("heading", { name: /Hi, / });
    location.hash = contract;
    await read();
    expect(said).not.toContain("Compiling the contract");
  });

  it("offers no way to the spec from the contract", async () => {
    // The contract states what approving freezes; the spec is the other half of
    // the same work and is read and written in planning, where the plan it
    // drafted is beside it, not from the page a person is deciding on.
    await openTheContract();
    await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Open the spec…" })).toBeNull();
  });

  it("takes the row off the list before the host has answered, and puts it back if it refuses", async () => {
    // The answer was given in the dialog. A row that sits there for a round
    // trip afterwards reads as a click that missed, so it goes at once and the
    // deletion runs behind it.
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    const original = bridge.request.bind(bridge);
    // Held open: the host has not answered, and will not until this resolves.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent = vi
      .spyOn(bridge, "request")
      .mockImplementation(((request: Parameters<typeof original>[0]) =>
        request.kind === "discard"
          ? held.then(() => Promise.reject(new Error("the repository is busy")))
          : original(request)) as typeof bridge.request);

    fireEvent.click(
      within(picker).getByRole("button", {
        name: /^Delete plan: Split the settings page into tabs/,
      }),
    );
    const asking = await screen.findByRole("dialog", { name: "Delete plan" });
    fireEvent.click(within(asking).getAllByRole("button", { name: "Delete plan" })[0]!);

    // Gone already, with the request still in flight.
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: "Plan a piece of work" })).queryByRole("button", {
          name: /^Split the settings page into tabs/,
        }),
      ).toBeNull(),
    );
    expect(sent.mock.calls.some(([request]) => request.kind === "discard")).toBe(true);

    // And a refusal puts it back rather than leaving a row deleted only on screen.
    release!();
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: "Plan a piece of work" })).queryByRole("button", {
          name: /^Split the settings page into tabs/,
        }),
      ).toBeTruthy(),
    );
  });

  it("deletes a never-run contract for good, behind a confirmation", async () => {
    // Reached through the Create picker and not through Home. A plan nobody has
    // approved is pre-loop work, which the picker holds and Home does not
    // (D-129), so the contract page it is deleted
    // from is opened from there.
    await openTheContract();
    fireEvent.click(await screen.findByRole("button", { name: "Delete this contract" }, { timeout: 5000 }));
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(async () => {
      const workspace = await sampleBridge.request({ kind: "snapshot" });
      expect(workspace.tasks.some((row) => row.ticket.key === "PRB-421")).toBe(false);
    });
  });

  it("plans a stopped run again from its spec, in place of the record it deletes", async () => {
    // The approved contract is frozen (ADR-0016), so there is no editing a
    // stopped plan back into shape. What there is, is the spec it was drafted
    // from: the stopped ticket goes with everything recorded after its
    // contract, and the spec is admitted again and opened as a planning.
    const { sample, mount: mountFresh } = await freshSample();
    const specs = localStorage.getItem("perbo:preview-specs");
    onTestFinished(() => {
      if (specs !== null) localStorage.setItem("perbo:preview-specs", specs);
    });
    const before = await sample.request({ kind: "snapshot" });
    const repoId = before.repositories[0]!.id;
    const known = before.tasks.map((row) => row.ticket.key);
    location.hash = ["task", repoId, "PRB-415"].join("/");
    mountFresh();
    await screen.findByRole("heading", { name: "The run was stopped" }, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Plan it again" }));
    // Planning mode over the new plan, on the pane that holds it.
    await waitFor(() => expect(location.hash).toMatch(/^#planning\/[^/]+\/(graph|criteria)$/), {
      timeout: 5000,
    });
    const after = await sample.request({ kind: "snapshot" });
    // The stopped ticket is gone, and the new plan is the one row the spec has.
    expect(after.tasks.some((row) => row.ticket.key === "PRB-415")).toBe(false);
    const minted = after.tasks.filter((row) => !known.includes(row.ticket.key));
    expect(minted).toHaveLength(1);
    expect(minted[0]!.ticket.state).toBe("plan_review");
    expect(minted[0]!.ticket.admission.spec?.path).toBe(
      "specs/retire-the-legacy-csv-importer/spec.md",
    );
    // And the work is before the loop again, in the picker, as a planning.
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    expect(
      within(picker).getByRole("button", { name: /^Retire the legacy CSV importer.*drafted, not approved$/ }),
    ).toBeTruthy();
  });

  it("refuses to plan again from a spec that is no longer there, in the command's own words", async () => {
    // A spec deleted in the person's own editor is the way here: the app
    // refuses to remove one while a ticket still names it. The host asks
    // before it spends an admission and answers in `admit`'s own sentence, and
    // the preview answers the same press the same way.
    const before = await sampleBridge.request({ kind: "snapshot" });
    const repoId = before.repositories[0]!.id;
    const known = before.tasks.map((row) => row.ticket.key);
    const held = localStorage.getItem("perbo:preview-specs");
    const files = JSON.parse(held ?? "{}") as Record<string, string>;
    delete files["retire-the-legacy-csv-importer"];
    localStorage.setItem("perbo:preview-specs", JSON.stringify(files));
    try {
      location.hash = ["task", repoId, "PRB-415"].join("/");
      mount();
      await screen.findByRole("heading", { name: "The run was stopped" }, { timeout: 5000 });
      fireEvent.click(screen.getByRole("button", { name: "Plan it again" }));
      expect(
        await screen.findByText("no spec at specs/retire-the-legacy-csv-importer/spec.md", {}, {
          timeout: 5000,
        }),
      ).toBeTruthy();
      // Nothing was drafted, and the page the press was made on is still there.
      const after = await sampleBridge.request({ kind: "snapshot" });
      expect(after.tasks.map((row) => row.ticket.key)).toEqual(known);
      expect(screen.getByRole("heading", { name: "The run was stopped" })).toBeTruthy();
    } finally {
      if (held === null) localStorage.removeItem("perbo:preview-specs");
      else localStorage.setItem("perbo:preview-specs", held);
    }
  });

  it("lets every subscription account be refreshed or signed in again from Connections", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
    await screen.findByText("Connections", { selector: ".header-section" }, { timeout: 5000 });
    expect(await screen.findAllByRole("button", { name: "Sign in again" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Sign in again" })[0]!);
    const notices = await screen.findAllByRole("alert");
    expect(notices.some((notice) => /sample workspace/.test(notice.textContent ?? "") && notice.textContent?.includes("claude auth login"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Refresh connections/ }));
    await screen.findByText("Connections refreshed");
    expect(screen.queryByRole("button", { name: "Perbo home" })).toBeNull();
  });
});

/**
 * The ceiling on a guarded read governs the whole workspace as well, and every
 * repository's invalidation dirties it, so records moving across repositories
 * faster than the workspace can be read refuse the read rather than taking it
 * again. What the person is left with then is the refusal and a way to ask
 * again, never an empty window.
 */
describe("a workspace read nothing lets settle", () => {
  it("shows the refusal and a way to read again", async () => {
    const snapshot = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
    let listener: ((change: Change) => void) | undefined;
    vi.spyOn(bridge, "subscribe").mockImplementation((next) => { listener = next; return () => (listener = undefined); });
    let sequence = 0;
    vi.spyOn(bridge, "request").mockImplementation(async (input) => {
      if (input.kind === "snapshot") {
        const repository = snapshot.repositories[sequence % snapshot.repositories.length]!;
        listener?.({ kind: "records", sequence: ++sequence, repoId: repository.id, key: null });
        return structuredClone(snapshot) as never;
      }
      if (input.kind === "repositorySnapshot")
        return { repository: snapshot.repositories.find((entry) => entry.id === input.repoId)!, tasks: [], errors: [] } as never;
      throw new Error("Unexpected request " + input.kind);
    });
    mount();
    expect(await screen.findByText(/changed while every attempt to read them/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("Home row colours and what may be archived", () => {
  const card = (name: string): Promise<HTMLElement> => screen.findByRole("button", { name });

  it("colours a row green at the journey's end, yellow for a decision, and red for a stopped loop", async () => {
    mount();
    const tones = async (name: string): Promise<string[]> =>
      [...(await card(name)).classList].filter((entry) => /^task-card--(green|yellow|red)$/.test(entry));
    expect(await tones("Retry the webhook dispatcher three times")).toEqual(["task-card--green"]);
    expect(await tones("Backfill the audit table")).toEqual(["task-card--green"]);
    expect(await tones("Activation email never sent on signup")).toEqual(["task-card--yellow"]);
    expect(await tones("Retire the legacy CSV importer")).toEqual(["task-card--red"]);
    // Mid-run with nothing running them: runs that stopped short.
    expect(await tones("Rate-limit the invite endpoint")).toEqual(["task-card--red"]);
    expect(await tones("Cache the pricing table response")).toEqual(["task-card--red"]);
    // The note and the primary button stay what they were.
    const stopped = await card("Retire the legacy CSV importer");
    expect(within(stopped).getByText(/The run stopped\. Its work and evidence have been retained/)).toBeTruthy();
    expect(within(stopped).getByRole("button", { name: "See the stopped run" })).toBeTruthy();
  });

  it("archives a stopped ticket from Home, opens its stopped page from the Archive, and refuses a running one", async () => {
    mount();
    const stopped = await card("Retire the legacy CSV importer");
    expect(within(await card("Backfill the audit table")).queryByRole("button", { name: "Archive" })).toBeNull();
    fireEvent.click(within(stopped).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retire the legacy CSV importer" })).toBeNull());
    fireEvent.click(within(screen.getByRole("complementary", { name: "Main navigation" })).getByRole("button", { name: "Archive" }));
    await screen.findByRole("table", { name: "Archived tickets" });
    fireEvent.change(screen.getByLabelText("Search archived tasks"), { target: { value: "legacy CSV" } });
    const row = (await screen.findAllByRole("row")).find((entry) => within(entry).queryByText("#415"))!;
    fireEvent.click(row);
    await waitFor(() => expect(document.querySelector('[data-screen="stopped"]')).toBeTruthy());
    const repoId = (await sampleBridge.request({ kind: "snapshot" })).repositories[0]!.id;
    // A ticket with its run under way is one the loop still carries.
    const detail = await sampleBridge.request({ kind: "detail", repoId, key: "PRB-398" });
    const running = await sampleBridge.request({
      kind: "run", repoId, key: "PRB-398", digest: detail.digest, approve: true, publish: false, resumeFrom: null,
    });
    try {
      await expect(
        sampleBridge.request({ kind: "archive", repoId, keys: ["PRB-398"], archived: true }),
      ).rejects.toThrow("PRB-398 is still in its loop. Archive it once it has finished or its run has stopped.");
    } finally {
      await sampleBridge.request({ kind: "cancel", jobId: running.id }).catch(() => undefined);
    }
    await sampleBridge.request({ kind: "archive", repoId, keys: ["PRB-415"], archived: false });
  });

  it("shows the Archive's table and footer with no empty state when nothing matches", async () => {
    mount();
    await card("Retire the legacy CSV importer");
    fireEvent.click(within(screen.getByRole("complementary", { name: "Main navigation" })).getByRole("button", { name: "Archive" }));
    const table = await screen.findByRole("table", { name: "Archived tickets" });
    fireEvent.change(screen.getByLabelText("Search archived tasks"), { target: { value: "nothing is called this" } });
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(1));
    expect(screen.queryByText("No completed tickets here yet")).toBeNull();
    expect(screen.queryByText(/Change the filters, or return after a ticket has finished/)).toBeNull();
    expect(document.querySelector('[data-screen="s5"] .empty-state')).toBeNull();
    expect(screen.getByText(/Showing 0 of/)).toBeTruthy();
  });
});

describe("usage: a window's reset label", () => {
  const now = Date.parse("2026-09-23T12:00:00.000Z");
  const label = (offsetMs: number) =>
    resetLabel({ label: "5-hour limit", usedPercent: 9, resetsAt: new Date(now + offsetMs).toISOString() });
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
  });

  it("shows nothing for a reset already past", () => {
    expect(label(-60_000)).toBe("");
    expect(label(0)).toBe("");
  });

  it("counts minutes under an hour, and names the weekday from a day on", () => {
    expect(label(45 * 60_000)).toBe("Resets in 45 min");
    const day = new Date(now + 86_400_000);
    expect(label(86_400_000)).toBe(`Resets ${day.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
  });
});

describe("usage: a signed-in provider that reports no window", () => {
  it("draws it connected with the provider's own sentence and no meter", async () => {
    const original = bridge.request.bind(bridge);
    vi.spyOn(bridge, "request").mockImplementation(async <T extends Request>(request: T): Promise<ReplyMap[T["kind"]]> => {
      if (request.kind === "usage")
        return {
          readAt: new Date().toISOString(),
          ledger: { month: "2026-09", spentMicros: 0, pricedAttempts: 0, unpricedAttempts: 0, ticketsRun: 0, ticketsMerged: 0, stoppedShort: 0, averageMergedMicros: null },
          providers: [
            { id: "claude", name: "Claude Code", role: null, connected: true, plan: null, windows: null, detail: "This Claude Code does not report its limits without an inference turn. Update it to see them." },
          ],
          notes: [] as string[],
        } as ReplyMap[T["kind"]];
      return original(request);
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Usage" }));
    const sentence = await screen.findByText(/does not report its limits without an inference turn/);
    const card = sentence.closest("section")!;
    expect(card.querySelector(".connection-dot")?.classList.contains("disconnected")).toBe(false);
    expect(within(card).queryAllByRole("meter")).toEqual([]);
  });
});

describe("Home's badge, its header counts and its cards' buttons", () => {
  /**
   * A board of the sample's shape with the states given, nothing filed, and a
   * run under way for each ticket mid-loop: one with nothing running it is a
   * stopped run.
   */
  async function board(states: [TicketState, string | null][]): Promise<Snapshot> {
    const workspace = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
    const template = workspace.tasks.find((row) => row.repoId === workspace.repositories[0]!.id)!;
    workspace.jobs = [];
    workspace.archived = [];
    workspace.refreshingRepos = [];
    workspace.titles = {};
    workspace.tasks = states.map(([state, url], index) => {
      const row = structuredClone(template);
      row.ticket.key = "PRB-" + (900 + index);
      row.ticket.ticket_id = "t-" + index;
      row.ticket.title = `Ticket ${index} ${state}`;
      row.ticket.state = state;
      row.ticket.delivery.pull_request_url = url;
      return row;
    });
    workspace.jobs = workspace.tasks
      .filter((row) => ["provisioning", "executing", "verifying", "independent_review"].includes(row.ticket.state))
      .map((row) => run(row, "running-" + row.ticket.key, "running"));
    return workspace;
  }
  const pr = "https://github.com/example/webstore/pull/9";
  const dot = (): HTMLElement => document.querySelector<HTMLElement>(".rail-badge .t-badge-dot")!;
  const shows = (): [string | null, string] => [
    [...dot().classList].find((entry) => /^rail-badge--(yellow|red|green)$/.test(entry)) ?? null,
    dot().textContent ?? "",
  ];
  const railOver = (workspace: Snapshot) => <Rail route={{ page: "home" }} navigate={() => undefined} workspace={workspace} />;
  const rail = (workspace: Snapshot) => render(railOver(workspace));
  const home = (workspace: Snapshot) =>
    render(
      <QueryClientProvider client={client}>
        <HomePage workspace={workspace} navigate={() => undefined} archive={false} />
      </QueryClientProvider>,
    );
  /** A run of the sample loop on this row: under way, or stopped a minute after it started. */
  const run = (row: TaskRow, id: string, state: "running" | "cancelled") => ({
    id, repoId: row.repoId, key: row.ticket.key, resultKey: null, kind: "run" as const,
    label: "Run engineering loop", state, startedAt: "2026-09-09T09:00:00.000Z",
    endedAt: state === "running" ? null : "2026-09-09T09:01:00.000Z", log: "", error: null, result: null, publish: false,
  });
  /** Fake time moved on ten milliseconds at a time, so each timer the badge sets after a render is on time. */
  const at = (ms: number): void => {
    for (let step = 0; step < ms; step += 10) act(() => void vi.advanceTimersByTime(10));
  };
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cycles the Home badge yellow, red, green, a decision held seven seconds and the others four", async () => {
    const workspace = await board([
      ["changes_requested", null], ["pr_open", pr], ["failed", null], ["merged", pr], ["closed", pr], ["executing", null],
    ]);
    vi.useFakeTimers();
    rail(workspace);
    expect(shows()).toEqual(["rail-badge--yellow", "1"]);
    expect(dot().getAttribute("aria-label")).toBe("1 ticket needs action");
    at(6_700);
    expect(shows()).toEqual(["rail-badge--yellow", "1"]);
    expect(dot().className).not.toContain("rail-badge--leaving");
    // It shrinks away just before the next colour, and grows back in as it.
    at(200);
    expect(dot().className).toContain("rail-badge--leaving");
    at(150);
    expect(shows()).toEqual(["rail-badge--red", "1"]);
    expect(dot().className).toContain("rail-badge--swapped");
    expect(dot().getAttribute("aria-label")).toBe("1 stopped");
    at(3_850);
    expect(shows()).toEqual(["rail-badge--red", "1"]);
    at(150);
    expect(shows()).toEqual(["rail-badge--green", "3"]);
    expect(dot().getAttribute("aria-label")).toBe("3 completed");
    at(3_850);
    expect(shows()).toEqual(["rail-badge--green", "3"]);
    at(150);
    expect(shows()).toEqual(["rail-badge--yellow", "1"]);
  });

  it("skips a colour with no tickets, holds one colour steady, and shows no badge while everything runs", async () => {
    const two = await board([["failed", null], ["merged", pr]]);
    const one = await board([["cancelled", null], ["executing", null]]);
    const running = await board([["executing", null], ["verifying", null], ["provisioning", null]]);
    vi.useFakeTimers();
    rail(two);
    expect(shows()).toEqual(["rail-badge--red", "1"]);
    at(4_050);
    expect(shows()).toEqual(["rail-badge--green", "1"]);
    at(4_050);
    expect(shows()).toEqual(["rail-badge--red", "1"]);
    cleanup();
    rail(one);
    for (let tick = 0; tick < 12; tick++) {
      at(5_000);
      expect(shows()).toEqual(["rail-badge--red", "1"]);
      expect(dot().className).not.toMatch(/leaving|swapped/);
    }
    cleanup();
    rail(running);
    expect(document.querySelector(".rail-badge")!.getAttribute("data-open")).toBe("false");
    expect(shows()).toEqual([null, ""]);
    expect(dot().getAttribute("aria-label")).toBeNull();
  });

  it("keeps the badge while a repository's records are read again, so it does not flash", async () => {
    const workspace = await board([["changes_requested", null], ["executing", null]]);
    const stopped = workspace.tasks[1]!;
    workspace.jobs = [run(stopped, "stopped", "cancelled")];
    const { rerender } = rail(workspace);
    expect(document.querySelector(".rail-badge")!.getAttribute("data-open")).toBe("true");
    expect(shows()).toEqual(["rail-badge--yellow", "1"]);
    rerender(railOver({ ...workspace, refreshingRepos: [stopped.repoId] }));
    expect(document.querySelector(".rail-badge")!.getAttribute("data-open")).toBe("true");
    expect(shows()).toEqual(["rail-badge--yellow", "1"]);
  });

  it("counts a decision, a stop and a completion in the header, left to right, and only where there are any", async () => {
    const workspace = await board([
      ["changes_requested", null], ["pr_open", pr], ["failed", null], ["merged", pr], ["executing", null],
    ]);
    home(workspace);
    const pills = [...document.querySelectorAll(".page-header .attention-count, .page-header .stopped-count, .page-header .completed-count")];
    expect(pills.map((pill) => pill.textContent?.trim())).toEqual(["1 ticket needs action", "1 stopped", "2 completed"]);
    expect(screen.queryByText(/runner · this machine/)).toBeNull();
    expect(document.querySelector(".live-dot")).toBeNull();
    cleanup();
    home({ ...workspace, tasks: workspace.tasks.filter((row) => row.ticket.state !== "failed") });
    expect(screen.queryByText(/stopped$/)).toBeNull();
    expect(screen.getByText("1 ticket needs action")).toBeTruthy();
    expect(screen.getByText("2 completed")).toBeTruthy();
  });

  it("greets, filters, sorts and archives Home by the same three colours", async () => {
    const workspace = await board([
      ["changes_requested", null], ["failed", null], ["cancelled", null], ["pr_open", pr], ["merged", pr], ["merged", pr], ["executing", null],
    ]);
    // Each ticket newer than the one before it, so the colour, not the age, puts the answer first.
    workspace.tasks.forEach((row, index) => (row.ticket.updated_at = `2026-09-0${index + 1}T09:00:00.000Z`));
    home(workspace);
    const greeting = document.querySelector(".home-heading p")!.textContent ?? "";
    expect(greeting).toContain("one waiting on you");
    expect(greeting).toContain("three completed");
    const cards = (): string[] =>
      [...document.querySelectorAll(".task-list .task-card")].map((card) => card.getAttribute("aria-label") ?? "");
    expect(cards()).toEqual([
      "Ticket 0 changes_requested",
      "Ticket 2 cancelled", "Ticket 1 failed",
      "Ticket 6 executing", "Ticket 5 merged", "Ticket 4 merged", "Ticket 3 pr_open",
    ]);
    const show = (option: string): string[] => {
      fireEvent.click(screen.getByLabelText("Filter tickets"));
      fireEvent.click(screen.getByRole("option", { name: "Show · " + option }));
      return cards();
    };
    expect(show("needs you")).toEqual(["Ticket 0 changes_requested"]);
    expect(show("stopped")).toEqual(["Ticket 2 cancelled", "Ticket 1 failed"]);
    expect(show("completed")).toEqual(["Ticket 5 merged", "Ticket 4 merged", "Ticket 3 pr_open"]);
    expect(show("running")).toEqual(["Ticket 6 executing"]);
    // The loop has let go of a merged or stopped ticket; an open pull request still waits on its merge.
    expect(screen.getByRole("button", { name: "Archive all 4" })).toBeTruthy();
  });

  it("sets each card's buttons together at its end, Archive last and an icon alone", async () => {
    const workspace = await board([["failed", null], ["merged", pr], ["changes_requested", null]]);
    workspace.jobs = [run(workspace.tasks[0]!, "stopped", "cancelled")];
    home(workspace);
    const buttons = (name: string): HTMLElement[] => {
      const card = screen.getByRole("button", { name });
      const actions = card.querySelector<HTMLElement>(".task-card-actions")!;
      return [...actions.children] as HTMLElement[];
    };
    const stopped = buttons("Ticket 0 failed");
    expect(stopped.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["See the stopped run", "Archive"]);
    const merged = buttons("Ticket 1 merged");
    expect(merged.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Report", "Archive"]);
    for (const archive of [stopped.at(-1)!, merged.at(-1)!]) {
      expect(archive.textContent).toBe("");
      expect(archive.getAttribute("title")).toBe("Archive");
      expect(archive.querySelector("img")).toBeTruthy();
    }
    // A ticket the loop still carries has no Archive, and its one button is still in the row.
    expect(buttons("Ticket 2 changes_requested").map((button) => button.textContent)).toEqual(["Answer"]);
  });

  it("opens the Create picker from Home's empty state with nothing selected", async () => {
    const workspace = await board([]);
    render(
      <QueryClientProvider client={client}>
        <CreateProvider workspace={workspace} navigate={() => undefined} route={{ page: "home" }}>
          <Rail route={{ page: "home" }} navigate={() => undefined} workspace={workspace} />
          <HomePage workspace={workspace} navigate={() => undefined} archive={false} />
        </CreateProvider>
      </QueryClientProvider>,
    );
    // The empty Home is one plain row, not a page footer: its heading at the start and a primary button at the end.
    const row = screen.getByRole("heading", { name: "Nothing admitted yet" }).closest(".home-empty");
    expect(row).toBeTruthy();
    expect(row!.closest(".page-footer, footer")).toBeNull();
    expect(document.querySelector(".page-footer")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(screen.queryByText(/Set up and waiting/)).toBeNull();
    const create = screen.getByRole("button", { name: "Create a task" });
    expect(create.className).toContain("button--primary");
    expect(create.closest(".home-empty")).toBe(row);
    expect(row!.lastElementChild).toBe(create);
    fireEvent.click(create);
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    expect(picker.querySelector(".picker-row.active")).toBeNull();
    expect(document.activeElement).toBe(picker);
    // Enter with nothing selected starts nothing; the arrow keys select from the top.
    fireEvent.keyDown(picker, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Plan a piece of work" })).toBe(picker);
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(picker.querySelector(".picker-row.active")).toBe(picker.querySelector(".picker-row"));
    // The rail's Create still opens on its top row, the first repository, which Enter starts in.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Plan a piece of work" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const again = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    expect(again.querySelector(".picker-row.active")).toBe(again.querySelector(".picker-row"));
  });

  it("never lists on Home a filed stopped ticket the Archive is deleting, whatever reads land meanwhile", async () => {
    const { host, sample, mount: mountFresh } = await freshSample();
    const title = "Retire the legacy CSV importer";
    const repoId = (await sample.request({ kind: "snapshot" })).repositories[0]!.id;
    await sample.request({ kind: "archive", repoId, keys: ["PRB-415"], archived: true });
    const original = host.request.bind(host);
    let answer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (answer = resolve));
    vi.spyOn(host, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
      request.kind === "discard" ? held.then(() => original(request)) : original(request)) as typeof host.request);
    let listed = false;
    const watch = new MutationObserver(() => {
      if (document.querySelector(`[data-screen="s4"] article[aria-label="${title}"]`)) listed = true;
    });
    watch.observe(document.body, { childList: true, subtree: true, attributes: true });
    try {
      mountFresh();
      await screen.findByRole("heading", { name: /Hi, / });
      fireEvent.click(within(screen.getByRole("complementary", { name: "Main navigation" })).getByRole("button", { name: "Archive" }));
      fireEvent.change(await screen.findByLabelText("Search archived tasks"), { target: { value: "legacy CSV" } });
      const row = (await screen.findAllByRole("row")).find((entry) => within(entry).queryByText("#415"))!;
      fireEvent.click(row);
      fireEvent.click(await screen.findByRole("button", { name: "Delete this work" }));
      const asking = await screen.findByRole("dialog", { name: "Delete #415?" });
      fireEvent.click(within(asking).getByRole("button", { name: "Delete permanently" }));
      // While the host deletes it: Home is open, and a read lands that says
      // the ticket is back on Home — its archive mark gone, its record still there.
      fireEvent.click(screen.getByRole("button", { name: "Home" }));
      await screen.findByRole("heading", { name: /Hi, / });
      await original({ kind: "archive", repoId, keys: ["PRB-415"], archived: false });
      await act(() => client.invalidateQueries({ queryKey: ["workspace"] }));
      expect((await original({ kind: "snapshot" })).tasks.some((task) => task.ticket.key === "PRB-415")).toBe(true);
      expect(screen.queryByRole("button", { name: title })).toBeNull();
      // The delete finishes, and the reads after it settle.
      answer();
      await waitFor(async () =>
        expect((await original({ kind: "snapshot" })).tasks.some((task) => task.ticket.key === "PRB-415")).toBe(false),
      );
      await waitFor(() => expect(client.isFetching()).toBe(0));
      await act(() => client.invalidateQueries({ queryKey: ["workspace"] }));
      expect(screen.queryByRole("button", { name: title })).toBeNull();
      expect(listed).toBe(false);
    } finally {
      watch.disconnect();
    }
  });
});
