// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import { bridge } from "../workspace/index.js";
import { setPlatformForTests } from "../../shared/shortcuts.js";
import { resetRailSize } from "./rail-size.js";
import type { Change, ReplyMap, Request } from "../../shared/protocol.js";

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
    expect(screen.getByText("1 completed")).toBeTruthy();
    await within(card).findByText("perbo/409-webhook-retry");
    await within(card).findByText("+72");
    fireEvent.click(within(card).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry the webhook dispatcher three times" })).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("table", { name: "Completed tickets" });
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
    // A decision to answer, a pull request to merge, and two tickets mid-run
    // with nothing running them, which is what recovery looks like.
    expect(
      screen.getAllByRole("button", { name: /Answer|Merge|Review and recover/ }),
    ).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Split the settings page into tabs" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Filter tickets"));
    fireEvent.click(screen.getByRole("option", { name: "Show · all" }));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(search);
  });

  it("shows the usage page honestly: provider windows only where reported, the ledger from records", async () => {
    const original = bridge.request.bind(bridge);
    vi.spyOn(bridge, "request").mockImplementation(async <T extends Request>(request: T): Promise<ReplyMap[T["kind"]]> => {
      if (request.kind === "usage")
        return {
          readAt: new Date().toISOString(),
          ledger: { month: "2026-09", spentMicros: 2_140_000, pricedAttempts: 3, unpricedAttempts: 1, ticketsRun: 2, ticketsMerged: 1, stoppedShort: 1, averageMergedMicros: null },
          providers: [
            { id: "claude", name: "Claude Code", role: "default executor", plan: null, windows: null, detail: "Claude Code reports a limit only when a run meets one; there is no window to read without spending a turn." },
            { id: "codex", name: "Codex", role: "default reviewer", plan: "Pro", windows: [{ label: "Session · 5-hour window", usedPercent: 82, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }], detail: "Read from the Codex app-server." },
            { id: "anthropic", name: "Anthropic API", role: null, plan: null, windows: null, detail: "No API key in the app environment." },
          ],
          notes: ["webstore · PRB-2: The attempts record could not be read."],
        } as ReplyMap[T["kind"]];
      return original(request);
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Usage" }));
    await screen.findByText("Codex · Pro");
    expect(screen.getByRole("meter", { name: "Session · 5-hour window" }).getAttribute("aria-valuenow")).toBe("82");
    expect(screen.getByText(/no window to read without spending a turn/)).toBeTruthy();
    expect(document.querySelector(".usage-facts")?.textContent).toContain("$2.14");
    expect(screen.getByText(/1 unpriced attempt/)).toBeTruthy();
    // D-096: a ticket counted here stopped short of finishing, which is a
    // stall as often as a ceiling the repository set.
    expect(screen.getByText(/1 stopped short/)).toBeTruthy();
    expect(screen.getByText(/not every attempt was priced/)).toBeTruthy();
    expect(screen.getByText(/Codex’s session · 5-hour window is at 82%/)).toBeTruthy();
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

  it("deletes a never-run contract for good, behind a confirmation", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Review contract" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete this contract" }, { timeout: 5000 }));
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(async () => {
      const workspace = await sampleBridge.request({ kind: "snapshot" });
      expect(workspace.tasks.some((row) => row.ticket.key === "PRB-421")).toBe(false);
    });
    await screen.findByRole("heading", { name: /Hi, / });
    expect(screen.queryByRole("button", { name: "Split the settings page into tabs" })).toBeNull();
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
