// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../src/renderer/shell/App.js";
import { CreateContext } from "../src/renderer/shell/create.js";
import { HomePage } from "../src/renderer/tasks/HomePage.js";
import { previewBridge } from "../src/renderer/preview.js";
import { bridge } from "../src/renderer/data.js";
import { resetRailSize } from "../src/renderer/shell/rail-size.js";
import {
  DEFAULT_DOCK_WIDTH,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
  resetDockWidth,
} from "../src/renderer/shell/dock-size.js";
import { conflictFor, DEFAULT_SHORTCUTS, effectiveShortcuts, setPlatformForTests } from "../src/shared/shortcuts.js";
import { withDraft } from "../src/renderer/shell/create.js";
import { SpecSection } from "../src/renderer/planning/SpecSection.js";
import type { GraphEdit } from "@perbo/contracts/graph-edit";
import type { ExportedName } from "../src/shared/protocol.js";
import * as specText from "@perbo/planning/spec-text";

let client: QueryClient;
beforeEach(() => {
  // jsdom has no <dialog> implementation; the confirmation dialog only needs open/close.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  }
  setPlatformForTests(true);
  sessionStorage.clear();
  localStorage.removeItem("perbo:preview-editing");
  localStorage.removeItem("perbo:preview-standing");
  localStorage.removeItem("perbo:preview-specs");
  location.hash = "home";
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  setPlatformForTests(null);
});
function mount() {
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}
/**
 * A save against nothing: what the first save of a spec says it read (SCP-321).
 * The tests below that drive the host directly are creating a spec, so this is
 * the truth for each of them.
 */
const NOTHING_YET = {
  title: "",
  sections: { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" },
};
const rail = (): HTMLElement => document.querySelector(".rail") as HTMLElement;
const railNames = (): string[] =>
  within(rail()).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? "");

describe("Create in the rail (SCP-334)", () => {
  it("reads Create, Home, Archive, Settings, bound to ⌘1 to ⌘4 in that order, with ⌘N still creating", async () => {
    resetRailSize();
    resetDockWidth();
    mount();
    await screen.findByRole("heading", { name: /Hi, / });
    const names = railNames();
    expect(names.slice(0, 3)).toEqual(["Create", "Home", "Archive"]);
    expect(names.at(-1)).toBe("Settings");
    const bindings = effectiveShortcuts({});
    expect(bindings.plan).toBe("Meta+1");
    expect(bindings.home).toBe("Meta+2");
    expect(bindings.archive).toBe("Meta+3");
    expect(bindings.settings).toBe("Meta+4");
    expect(bindings.create).toBe("Meta+N");
    // Rebinding still refuses a conflict, by name.
    expect(conflictFor({}, "plan", "Meta+2")?.label).toBe("Home");
    expect(DEFAULT_SHORTCUTS.findIndex((entry) => entry.action === "plan")).toBeLessThan(
      DEFAULT_SHORTCUTS.findIndex((entry) => entry.action === "home"),
    );
    fireEvent.keyDown(window, { key: "1", code: "Digit1", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Plan a piece of work" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Plan a piece of work" })).toBeNull());
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Plan a piece of work" })).toBeTruthy();
  });

  it("opens a picker from Create, starts planning in the chosen repository, and shows the pane icons only while planning", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    // The sample workspace's ticket in plan_review is planning too (D-101), listed before the repositories.
    const rows = within(picker).getAllByRole("button");
    expect(rows[0]!.textContent).toContain("Split the settings page into tabs");
    expect(within(picker).getByText("Continue planning")).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: /example\/webstore/ }));
    await screen.findByLabelText("Outcome");
    expect(location.hash).toMatch(/^#planning\//);
    const panes = screen.getByRole("group", { name: "Planning panes" });
    expect(within(panes).getByRole("button", { name: "Spec" }).getAttribute("aria-current")).toBe("page");
    expect(railNames().slice(0, 7)).toEqual([
      "Create",
      "Spec",
      "Explorer",
      "Graph",
      "Impact",
      "Home",
      "Archive",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
    expect(screen.queryByRole("group", { name: "Planning panes" })).toBeNull();
    expect(railNames().slice(0, 3)).toEqual(["Create", "Home", "Archive"]);
  });

  it("lists open drafts first in the picker, Enter resumes the top one, and the draft survives a restart", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Plan a piece of work" })).getByRole("button", { name: /example\/webstore/ }));
    const outcome = await screen.findByLabelText("Outcome");
    fireEvent.change(outcome, { target: { value: "Every export carries the month it covers." } });
    await waitFor(async () => {
      const drafts = (await previewBridge.request({ kind: "snapshot" })).drafts ?? [];
      expect(drafts.map((draft) => draft.outcome)).toContain("Every export carries the month it covers.");
    });
    // A restart: a fresh renderer over the same persisted sessions.
    cleanup();
    client.clear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    location.hash = "home";
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    expect(within(picker).getByText("Continue planning")).toBeTruthy();
    const rows = within(picker).getAllByRole("button");
    expect(rows[0]!.textContent).toContain("Every export carries the month it covers.");
    fireEvent.keyDown(picker, { key: "Enter" });
    expect(((await screen.findByLabelText("Outcome")) as HTMLTextAreaElement).value).toBe("Every export carries the month it covers.");
    expect(screen.getByRole("group", { name: "Planning panes" })).toBeTruthy();
  });

  it("leads a stale planning link to Create or Home instead of a retry that cannot succeed", async () => {
    location.hash = "planning/00000000-0000-4000-8000-000000000000/spec";
    mount();
    await screen.findByText("This planning could not be opened");
    expect(screen.queryByLabelText("Outcome")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create a task" }));
    expect(await screen.findByRole("dialog", { name: "Plan a piece of work" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
  });

  it("shows a discarded session's link as discarded, with nothing to edit", async () => {
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const session = await previewBridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId: workspace.repositories[0]!.id } });
    await previewBridge.request({ kind: "editingDiscard", id: session.id, revision: session.revision });
    location.hash = `planning/${session.id}/spec`;
    mount();
    await screen.findByText("This planning was discarded");
    expect(screen.queryByLabelText("Outcome")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
  });

  it("lists a session the picker just opened first, before the host's refresh lands", async () => {
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const session = await previewBridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId: workspace.repositories[0]!.id } });
    const stale = { ...workspace, drafts: [{ id: "older", repoId: session.repoId, key: null, outcome: "An older draft", phase: "editing" as const }] };
    const seeded = withDraft(stale, session);
    expect(seeded.drafts!.map((draft) => draft.id)).toEqual([session.id, "older"]);
    expect(withDraft(seeded, session).drafts!.map((draft) => draft.id)).toEqual([session.id, "older"]);
    // The native host answers a drafts refresh, and a snapshot, one round trip later; here neither answers at all.
    const original = bridge.request.bind(bridge);
    let hold = false;
    const spy = vi.spyOn(bridge, "request").mockImplementation((request) =>
      hold && (request.kind === "drafts" || request.kind === "snapshot") ? new Promise(() => undefined) : original(request));
    try {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "Create" }));
      const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
      hold = true;
      fireEvent.click(within(picker).getByRole("button", { name: /example\/landing/ }));
      await screen.findByLabelText("Outcome");
      fireEvent.keyDown(window, { key: "1", code: "Digit1", metaKey: true });
      const again = await screen.findByRole("dialog", { name: "Plan a piece of work" });
      const first = within(again).getAllByRole("button")[0]!;
      expect(first.textContent).toContain("Untitled work");
      expect(first.textContent).toContain("example/landing");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps Create out of Home's header and in its empty state", async () => {
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const open = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <CreateContext.Provider value={{ open, toggle: open, enter: open, leave: () => undefined, isOpen: false }}>
          <HomePage workspace={{ ...workspace, tasks: [] }} navigate={() => undefined} archive={false} />
        </CreateContext.Provider>
      </QueryClientProvider>,
    );
    expect(document.querySelector(".home-heading button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create a task" }));
    expect(open).toHaveBeenCalledTimes(1);
    cleanup();
    render(
      <QueryClientProvider client={client}>
        <CreateContext.Provider value={{ open, toggle: open, enter: open, leave: () => undefined, isOpen: false }}>
          <HomePage workspace={workspace} navigate={() => undefined} archive={false} />
        </CreateContext.Provider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: "Create a task" })).toBeNull();
  });
});

/**
 * The Explorer pane (SCP-318, D-101): the repository's tracked files, one of
 * them read-only, and the marks that change the draft's own scope. Driven here
 * through the real renderer against the browser preview host, which answers
 * the same requests the native host does.
 */
const sessionId = (): string => location.hash.split("/")[1] ?? "";
const session = () => previewBridge.request({ kind: "editingRead", id: sessionId() });
const treeRow = (name: RegExp | string) => screen.getByRole("treeitem", { name });
const filter = () => screen.getByLabelText("Filter files");
const markAs = (label: string) => fireEvent.click(screen.getByRole("tab", { name: label }));

async function openExplorer(repository = /example\/webstore/): Promise<void> {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
  fireEvent.click(within(picker).getByRole("button", { name: repository }));
  await screen.findByLabelText("Outcome");
  fireEvent.click(
    within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", {
      name: "Explorer",
    }),
  );
  await screen.findByRole("tree", { name: "Tracked files" });
}
/** Narrow the tree to one file and select it, the way a person reaches a nested path. */
async function select(query: string, name: RegExp | string): Promise<void> {
  fireEvent.change(filter(), { target: { value: query } });
  const row = await screen.findByRole("treeitem", { name });
  fireEvent.keyDown(row, { key: "Enter" });
  await waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));
}

describe("the Explorer pane (SCP-318)", () => {
  it("names the repository, lists its tracked files, and says which never appear", async () => {
    await openExplorer();
    expect(screen.getByRole("button", { name: "Explorer" }).getAttribute("aria-current")).toBe("page");
    const head = document.querySelector(".pane-head .sub")!;
    expect(head.textContent).toContain("example/webstore");
    expect(head.textContent).toContain("main");
    expect(head.textContent).toMatch(/11 tracked files/);
    expect(treeRow(/README\.md/)).toBeTruthy();
    // Present in the sample repository, and never listed: a secret and a key.
    expect(screen.queryByRole("treeitem", { name: /\.env\.local/ })).toBeNull();
    expect(screen.queryByRole("treeitem", { name: /deploy\.pem/ })).toBeNull();
    expect(document.querySelector(".hidden-note")!.textContent).toMatch(
      /2 paths never appear here: secrets, \.git and agent configuration\./,
    );
  });

  it("allows a folder as a glob and prohibits a file, both on the draft's own scope", async () => {
    await openExplorer();
    const folder = treeRow(/^packages\/$/);
    fireEvent.keyDown(folder, { key: "Enter" });
    await screen.findByRole("tab", { name: "Allowed" });
    markAs("Allowed");
    await waitFor(async () =>
      expect((await session()).form.draft.paths).toContain("packages/**"),
    );
    // The mark is read back off the draft's own scope, on the row and on the control.
    await waitFor(() => expect(treeRow(/^packages\/\s*allowed$/)).toBeTruthy());
    expect(
      screen.getByRole("tab", { name: "Allowed" }).getAttribute("aria-selected"),
    ).toBe("true");
    await select("retry", /retry\.ts/);
    markAs("Prohibited");
    await waitFor(async () => {
      const form = (await session()).form;
      expect(form.draft.prohibited).toContain("packages/queue/src/retry.ts");
      expect(form.draft.paths).not.toContain("packages/queue/src/retry.ts");
    });
    await waitFor(() => expect(treeRow(/^retry\.ts\s*prohibited$/)).toBeTruthy());
  });

  it("shows a file prohibited through the folder above it, and does not mark the file", async () => {
    await openExplorer();
    await select("queue/src", /^src\/$/);
    markAs("Prohibited");
    await waitFor(async () =>
      expect((await session()).form.draft.prohibited).toContain("packages/queue/src/**"),
    );
    await waitFor(() => expect(treeRow(/^retry\.ts\s*via src\/$/)).toBeTruthy());
    expect((await session()).form.draft.prohibited).not.toContain(
      "packages/queue/src/retry.ts",
    );
  });

  it("clears a mark, and undoes one mark back to the one before it", async () => {
    await openExplorer();
    await select("retry", /retry\.ts/);
    markAs("Allowed");
    await waitFor(async () =>
      expect((await session()).form.draft.paths).toContain("packages/queue/src/retry.ts"),
    );
    markAs("Prohibited");
    await waitFor(async () =>
      expect((await session()).form.draft.prohibited).toContain("packages/queue/src/retry.ts"),
    );
    const edits = screen.getByRole("region", { name: "Marks in this draft" });
    expect(within(edits).getAllByText(/Allow|Prohibit/).map((node) => node.textContent)).toEqual([
      "Allow packages/queue/src/retry.ts",
      "Prohibit packages/queue/src/retry.ts",
    ]);
    fireEvent.click(
      within(edits).getByRole("button", { name: "Undo: Prohibit packages/queue/src/retry.ts" }),
    );
    await waitFor(async () => {
      const form = (await session()).form;
      expect(form.draft.paths).toContain("packages/queue/src/retry.ts");
      expect(form.draft.prohibited).not.toContain("packages/queue/src/retry.ts");
    });
    markAs("Unmarked");
    await waitFor(async () =>
      expect((await session()).form.draft.paths).not.toContain("packages/queue/src/retry.ts"),
    );
  });

  it("carries the draft's author on every mark it records", async () => {
    await openExplorer();
    await select("retry", /retry\.ts/);
    markAs("Allowed");
    await waitFor(async () => expect((await session()).history).toHaveLength(1));
    expect((await session()).history[0]?.author).toBe("you");
  });
});

describe("always prohibiting a path from the Explorer pane (SCP-318)", () => {
  it("writes the repository's standing list from a checkbox, with no confirmation, and undo removes it", async () => {
    await openExplorer();
    await select("generated", /generated\/$/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Always prohibit in this repository/ }));
    // No confirmation stands between the checkbox and the list (D-105).
    expect(screen.queryByRole("dialog")).toBeNull();
    const standing = await screen.findByRole("region", { name: /Standing list/ });
    await waitFor(() =>
      expect(within(standing).getByText("packages/queue/src/generated/**")).toBeTruthy(),
    );
    expect(within(standing).getByText("this draft")).toBeTruthy();
    const added = async () =>
      (
        await previewBridge.request({ kind: "explorerList", repoId: (await session()).repoId })
      ).standing.find((entry) => entry.path === "packages/queue/src/generated/**");
    expect((await added())?.draft).toBe(sessionId());
    const edits = screen.getByRole("region", { name: "Marks in this draft" });
    fireEvent.click(
      within(edits).getByRole("button", {
        name: "Undo: Always prohibit packages/queue/src/generated/** in this repository",
      }),
    );
    await waitFor(async () => expect(await added()).toBeUndefined());
  });

  it("shows an entry this draft did not add as locked, with its source and no controls", async () => {
    await openExplorer();
    await select("spec.md", /specs\//);
    expect(screen.queryByRole("tab", { name: "Allowed" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Always prohibit/ })).toBeNull();
    const locked = document.querySelector(".mark-controls")!;
    expect(locked.textContent).toContain("specs/**");
    expect(locked.textContent).toContain("written in .perbo/config.json");
    const standing = screen.getByRole("region", { name: /Standing list/ });
    expect(within(standing).getByText("specs/**")).toBeTruthy();
  });
});

describe("the Explorer pane's preview (SCP-318)", () => {
  it("shows a tracked file read-only, with line numbers and nothing to type into", async () => {
    await openExplorer();
    await select("retry", /retry\.ts/);
    const code = await screen.findByLabelText("Contents of packages/queue/src/retry.ts");
    expect(code.textContent).toContain("MAX_ATTEMPTS");
    // One number per line of the sample file, which is sixteen lines long.
    expect(code.querySelectorAll(".ln")).toHaveLength(16);
    expect(code.querySelectorAll(".ln")[15]?.textContent).toBe("16");
    const preview = document.querySelector(".preview")!;
    expect(preview.querySelectorAll("input, textarea, [contenteditable]")).toHaveLength(0);
    expect(preview.textContent).toContain("read-only");
  });

  it("refuses a file over the preview cap with a sentence instead of part of it", async () => {
    await openExplorer();
    await select("orders", /orders\.json/);
    const refusal = await screen.findByText(/larger than the 256 KiB the preview reads/);
    expect(refusal.textContent).toContain("Open it in your editor");
    expect(document.querySelector(".preview .code")).toBeNull();
  });

  it("summarises a folder rather than reading it", async () => {
    await openExplorer();
    const folder = treeRow(/^packages\/$/);
    fireEvent.keyDown(folder, { key: "Enter" });
    const summary = await screen.findByText(/9 tracked files/);
    expect(summary).toBeTruthy();
    expect(document.querySelector(".preview .code")).toBeNull();
  });
});

/**
 * SCP-336: the Spec pane holds the spec, in the repository (D-103).
 *
 * Everything here runs against the browser preview host, which keeps the
 * sample repository's `specs/` folder where it keeps its editing sessions, and
 * assigns requirement ids with `@perbo/planning`'s own code.
 */
describe("the Spec pane (SCP-336)", () => {
  const startPlanning = async (repo = /example\/webstore/): Promise<void> => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    fireEvent.click(within(picker).getByRole("button", { name: repo }));
    await screen.findByLabelText("Spec title");
  };

  const write = async (sections: Record<string, string> & { title: string }): Promise<void> => {
    const title = await screen.findByLabelText("Spec title");
    fireEvent.change(title, { target: { value: sections.title } });
    fireEvent.blur(title);
    for (const [label, value] of Object.entries(sections)) {
      if (label === "title") continue;
      const field = screen.getByLabelText(label);
      fireEvent.change(field, { target: { value } });
      fireEvent.blur(field);
      await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(value));
    }
  };

  const SPEC = {
    title: "A light colour mode",
    "Spec Outcome": "The application supports a usable light colour mode.",
    "Spec Requirements":
      "- The person can choose Light, Dark or System without a restart.\n" +
      "- Text meets WCAG AA contrast against its background.\n" +
      "- The terminal view has a light palette of its own.",
    "Spec No-Gos": "- Changing the brand colours.",
  };

  it("saves the spec into the repository and gives each requirement an id", async () => {
    await startPlanning();
    // Before anything is written the pane says where the spec will go.
    expect(screen.getByText("specs/…/spec.md")).toBeTruthy();
    await write(SPEC);

    await screen.findByText("specs/a-light-colour-mode/spec.md");
    const listed = await screen.findByRole("list", { name: "Requirements" });
    const rows = within(listed).getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("R1");
    expect(rows[2]).toContain("R3");
    // Nothing has been drafted, so no requirement has landed in a node.
    expect(rows.every((row) => row.includes("none yet"))).toBe(true);
  });

  it("keeps a requirement's id when its text is edited, and gives the next one to a new one", async () => {
    await startPlanning();
    await write(SPEC);
    const requirements = screen.getByLabelText("Spec Requirements") as HTMLTextAreaElement;
    await waitFor(() => expect(requirements.value).toContain("R1:"));
    // R2 and R3 both go — the highest id with them — and one is written.
    fireEvent.change(requirements, {
      target: {
        value:
          requirements.value
            .split("\n")
            .filter((line) => !line.includes("R2:") && !line.includes("R3:"))
            .join("\n")
            .replace("R1: The person can choose", "R1: A person can choose") +
          "\n- The rail follows the mode.",
      },
    });
    fireEvent.blur(requirements);
    const rows = async (): Promise<string[]> =>
      within(await screen.findByRole("list", { name: "Requirements" }))
        .getAllByRole("listitem")
        .map((row) => row.textContent ?? "");
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    const after = await rows();
    expect(after[0]).toContain("R1");
    // Its text changed and its id did not.
    expect(after[0]).toContain("A person can choose");
    // R2 and R3 were each used once, so the new requirement is R4.
    expect(after[1]).toContain("R4");
    expect(after.join(" ")).not.toContain("R2");
    expect(after.join(" ")).not.toContain("R3");
  });

  it("offers Generate plan once the spec has a title and an outcome, not before", async () => {
    await startPlanning();
    const title = await screen.findByLabelText("Spec title");
    fireEvent.change(title, { target: { value: SPEC.title } });
    fireEvent.blur(title);
    await screen.findByText("specs/a-light-colour-mode/spec.md");
    const generate = (): HTMLButtonElement =>
      screen.getByRole("button", { name: "Generate plan" }) as HTMLButtonElement;
    expect(generate().disabled).toBe(true);
    const outcome = screen.getByLabelText("Spec Outcome");
    fireEvent.change(outcome, { target: { value: SPEC["Spec Outcome"] } });
    fireEvent.blur(outcome);
    await waitFor(() => expect(generate().disabled).toBe(false));
  });

  /**
   * SCP-321: the pane completes `@Symbol` from the repository's exported names
   * and marks the ones the index does not hold (D-015). The names come from the
   * host; the browser preview answers the same request from the sample
   * repositories' own stand-in index.
   */
  describe("naming code in the spec", () => {
    /** The pane, with the index read and the spec written. */
    const ready = async (): Promise<void> => {
      await startPlanning();
      await write(SPEC);
      await screen.findByText(/exported TS symbols/);
    };
    const notes = (): HTMLTextAreaElement =>
      screen.getByLabelText("Spec Notes") as HTMLTextAreaElement;
    const type = (value: string): void => {
      fireEvent.change(notes(), { target: { value } });
    };

    it("offers the exported names matching what is typed, and writes the one chosen", async () => {
      await ready();
      type("The sender is @sig");
      const popup = await screen.findByRole("listbox", { name: "Exported symbols" });
      expect(within(popup).getByText("@signup")).toBeTruthy();
      // The file it is in is offered beside it: two names alike are told apart
      // by where they live.
      expect(within(popup).getByText("packages/auth/src/signup.ts")).toBeTruthy();

      fireEvent.keyDown(notes(), { key: "Enter" });
      await waitFor(() => expect(notes().value).toBe("The sender is @signup "));
      expect(screen.queryByRole("listbox", { name: "Exported symbols" })).toBeNull();
    });

    it("puts the caret just past the inserted name and its trailing space, not at the end of the text", async () => {
      await ready();
      // Text follows the reference, so a caret at the end of the text and a
      // caret just past the inserted name are two different places — the
      // point of this case.
      type("@ret and more text after it.");
      const field = notes();
      // `type` sets the whole value at once and leaves the caret at its end;
      // put it back where a person completing "@ret" would have left it
      // before asking what is being typed there.
      field.selectionStart = 4;
      field.selectionEnd = 4;
      fireEvent.click(field);
      await screen.findByRole("listbox", { name: "Exported symbols" });
      fireEvent.keyDown(field, { key: "Enter" });
      await waitFor(() => expect(field.value).toBe("@retryQueue and more text after it."));
      const end = "@retryQueue ".length;
      expect(field.selectionStart).toBe(end);
      expect(field.selectionEnd).toBe(end);
    });

    it("moves through the names with the arrow keys, and gives up on Escape", async () => {
      await ready();
      type("@retry");
      const options = async (): Promise<HTMLElement[]> =>
        within(await screen.findByRole("listbox", { name: "Exported symbols" })).getAllByRole("option");
      // What each name is, and the file it is in, so two alike are told apart.
      expect((await options()).map((each) => each.textContent)).toEqual([
        "@retryQueuefunctionpackages/queue/src/retry.ts",
        "@RetryPolicyinterfacepackages/queue/src/retry.ts",
      ]);
      expect((await options())[0]?.getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(notes(), { key: "ArrowDown" });
      // The key up follows in a browser, and must not answer the same reference
      // again and put the selection back on the first name.
      fireEvent.keyUp(notes(), { key: "ArrowDown" });
      await waitFor(async () =>
        expect((await options())[1]?.getAttribute("aria-selected")).toBe("true"),
      );
      fireEvent.keyDown(notes(), { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("listbox", { name: "Exported symbols" })).toBeNull(),
      );
      // Escape dismissed it and wrote nothing.
      expect(notes().value).toBe("@retry");
    });

    it("says so when nothing matches, rather than offering nothing", async () => {
      await ready();
      type("@nosuchthing");
      const popup = await screen.findByRole("listbox", { name: "Exported symbols" });
      expect(popup.textContent).toContain("No exported symbol matches");
      expect(popup.textContent).toContain("marked until it resolves");
      // Enter is the textarea's own while there is nothing to choose.
      fireEvent.keyDown(notes(), { key: "Enter" });
      expect(notes().value).toBe("@nosuchthing");
    });

    it("marks a name the index does not hold, and replaces every use of it at once", async () => {
      await ready();
      type("@signUp queues it, and @signUp retries. @retryQueue holds it.");
      fireEvent.blur(notes());
      await waitFor(() => expect(document.querySelectorAll(".sym--unknown")).toHaveLength(2));
      // The name the index does hold is marked as a reference and not as wrong.
      expect(document.querySelectorAll(".sym")).toHaveLength(3);

      fireEvent.click(await screen.findByRole("button", { name: "Use @signup" }));
      await waitFor(() =>
        expect(notes().value).toBe("@signup queues it, and @signup retries. @retryQueue holds it."),
      );
      expect(document.querySelectorAll(".sym--unknown")).toHaveLength(0);
      // It reached the file, not only the screen.
      const stored = JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>;
      expect(stored["a-light-colour-mode"]).toContain("@signup queues it");
    });

    it("counts the names not in the index, beside the index's size and its commit", async () => {
      await ready();
      await screen.findByText("every @name resolves");
      expect(screen.getByText("index · 7 exported TS symbols · 9f2c1ab")).toBeTruthy();

      type("@signUp and @retryQueue.");
      fireEvent.blur(notes());
      await screen.findByText("1 name is not in the index");
      type("@signUp and @retryQ.");
      fireEvent.blur(notes());
      await screen.findByText("2 names are not in the index");
    });

    it("measures the nearest names once per distinct unknown name, not once per keystroke", async () => {
      await ready();
      const spy = vi.spyOn(specText, "nearestSymbolNames");
      try {
        // Four edits that leave the same one name unresolved throughout:
        // one measurement per distinct name, where a memo keyed on the array
        // `unknown` would measure on every one of these, since `unknown` is
        // built anew from the section's own text on each.
        type("@signUp is");
        type("@signUp is not");
        type("@signUp is not resolved");
        type("@signUp is not resolved here.");
        fireEvent.blur(notes());
        await screen.findByText("1 name is not in the index");
        expect(spy.mock.calls.filter((call) => call[0] === "signUp")).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("checks no name in a repository the index cannot describe, and says why", async () => {
      await startPlanning(/example\/landing/);
      await write({ title: "A landing page", "Spec Notes": "@signUp is not checked here." });
      await screen.findByText("no TypeScript or JavaScript here, so no @name is checked");
      expect(screen.getByText(/index · not built: no tracked TypeScript or JavaScript/)).toBeTruthy();
      // Nothing is marked wrong: there is no list to be missing from.
      expect(document.querySelectorAll(".sym--unknown")).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /^Use @/ })).toBeNull();
    });

    it("says the index could not be read, rather than reading the index forever, once the request fails", async () => {
      const original = bridge.request.bind(bridge);
      const asked = vi.spyOn(bridge, "request").mockImplementation((request) =>
        request.kind === "symbolIndex"
          ? Promise.reject(new Error("could not run perbo index"))
          : original(request),
      );
      try {
        await startPlanning();
        await write(SPEC);
        await screen.findByText("the index could not be read");
        expect(screen.queryByText("reading the index…")).toBeNull();
        // Not checked reads the same as not built: nothing is marked wrong and
        // no completion is offered for a name typed after the read failed.
        type("@signUp is mentioned here.");
        fireEvent.blur(notes());
        expect(screen.queryByRole("listbox", { name: "Exported symbols" })).toBeNull();
        expect(document.querySelectorAll(".sym--unknown")).toHaveLength(0);
      } finally {
        asked.mockRestore();
      }
    });
  });

  describe("the nearest-name offer on an unknown reference", () => {
    it("offers a name once even where the index exports it from two files", () => {
      const symbols: ExportedName[] = [
        { name: "signUp", kind: "function", path: "packages/auth/src/one.ts" },
        { name: "signUp", kind: "function", path: "packages/auth/src/two.ts" },
      ];
      render(
        <SpecSection
          field="notes"
          name="Notes"
          hint=""
          value="@Signup queues it."
          symbols={symbols}
          onChange={() => undefined}
          onCommit={() => undefined}
        />,
      );
      expect(screen.getAllByRole("button", { name: "Use @signUp" })).toHaveLength(1);
    });
  });

  /**
   * SCP-321: the person and the interview both write this file, and neither
   * overwrites the other. A section both changed comes back with the file's own
   * text beside what was typed, and nothing is written until it is settled.
   */
  describe("when the spec moves under the pane", () => {
    /** The session the pane is open on, for a second writer to write through. */
    const openSession = async (): Promise<string> => {
      const drafts = (await previewBridge.request({ kind: "drafts" })) ?? [];
      return drafts[0]!.id;
    };
    /** Another writer — the interview — reading the file and writing one section. */
    const elsewhere = async (over: { outcome?: string; notes?: string }): Promise<void> => {
      const id = await openSession();
      const session = await previewBridge.request({ kind: "editingRead", id });
      const read = await previewBridge.request({ kind: "specRead", id });
      const reply = await previewBridge.request({
        kind: "specSave",
        id,
        repoId: session.repoId,
        title: read.title,
        sections: { ...read.sections, ...over },
        base: { title: read.title, sections: read.sections },
      });
      expect(reply.conflicting).toEqual([]);
    };

    it("shows both texts, writes neither, and saves the one chosen", async () => {
      await startPlanning();
      await write(SPEC);
      await elsewhere({ outcome: "The interview's sentence." });

      const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);

      const notice = (await screen.findByText(/Nothing was saved/)).closest(
        ".notice",
      ) as HTMLElement;
      expect(notice.textContent).toContain("Outcome");
      // Both halves are on screen: the one that was typed, and the one in the file.
      expect(within(notice).getByText("The interview's sentence.")).toBeTruthy();
      expect(within(notice).getByText("The person's sentence.")).toBeTruthy();
      // And the file still says what the other writer left there.
      const written = (): string =>
        (JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>)[
          "a-light-colour-mode"
        ] ?? "";
      expect(written()).toContain("The interview's sentence.");
      expect(written()).not.toContain("The person's sentence.");

      fireEvent.click(within(notice).getByRole("button", { name: "Keep both" }));
      await waitFor(() => expect(written()).toContain("The person's sentence."));
      expect(written()).toContain("The interview's sentence.");
    });

    it("keeps the file's text where that is what is chosen, and stops asking", async () => {
      await startPlanning();
      await write(SPEC);
      await elsewhere({ outcome: "The interview's sentence." });
      const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      const notice = (await screen.findByText(/Nothing was saved/)).closest(
        ".notice",
      ) as HTMLElement;

      fireEvent.click(within(notice).getByRole("button", { name: "Use the file's" }));
      await waitFor(() => expect(outcome.value).toBe("The interview's sentence."));
      expect(screen.queryByText(/Nothing was saved/)).toBeNull();
      const written =
        (JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>)[
          "a-light-colour-mode"
        ] ?? "";
      expect(written).toContain("The interview's sentence.");
      expect(written).not.toContain("The person's sentence.");
    });

    it("writes nothing else while a refusal is open, so the refused section is never carried in", async () => {
      await startPlanning();
      await write(SPEC);
      await elsewhere({ outcome: "The interview's sentence." });
      const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      await screen.findByText(/Nothing was saved/);

      // Another section left while the refusal stands. Writing it would write
      // the whole spec, and carry the refused Outcome over the interview's.
      const notes = screen.getByLabelText("Spec Notes");
      fireEvent.change(notes, { target: { value: "A note typed meanwhile." } });
      fireEvent.blur(notes);
      const written = (): string =>
        (JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>)[
          "a-light-colour-mode"
        ] ?? "";
      await waitFor(() => expect(screen.getByText(/Nothing was saved/)).toBeTruthy());
      expect(written()).not.toContain("A note typed meanwhile.");
      expect(written()).toContain("The interview's sentence.");
      expect(written()).not.toContain("The person's sentence.");

      // Settled, and both the section that was refused and the one that waited
      // go together.
      const notice = (await screen.findByText(/Nothing was saved/)).closest(".notice") as HTMLElement;
      fireEvent.click(within(notice).getByRole("button", { name: "Keep yours" }));
      await waitFor(() => expect(written()).toContain("A note typed meanwhile."));
      expect(written()).toContain("The person's sentence.");
    });

    it("keeps the card and the person's text through a refetch, and still saves once it is settled", async () => {
      await startPlanning();
      await write(SPEC);
      await elsewhere({ outcome: "The interview's sentence." });

      const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      await screen.findByText(/Nothing was saved/);

      // The file moves again while the card is open: a window focus refetches
      // it for real, since `main.tsx` turns `refetchOnWindowFocus` on
      // everywhere and the spec query has no staleTime of its own.
      await elsewhere({ notes: "Written while the card was open." });
      await client.invalidateQueries({ queryKey: ["spec", sessionId()] });

      // Notes is not part of the conflict, so it follows the refetch either
      // way — waiting for it is waiting for the new view to have actually
      // landed, rather than finding the notice still up from before it did.
      const notes = screen.getByLabelText("Spec Notes") as HTMLTextAreaElement;
      await waitFor(() => expect(notes.value).toBe("Written while the card was open."));

      // The card survived that refetch, with the person's text still in it —
      // not replaced by the further change underneath.
      expect(outcome.value).toBe("The person's sentence.");
      const notice = screen.getByText(/Nothing was saved/).closest(".notice") as HTMLElement;
      expect(within(notice).getByText("The interview's sentence.")).toBeTruthy();
      expect(within(notice).getByText("The person's sentence.")).toBeTruthy();

      const written = (): string =>
        (JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>)[
          "a-light-colour-mode"
        ] ?? "";
      fireEvent.click(within(notice).getByRole("button", { name: "Keep yours" }));
      await waitFor(() => expect(written()).toContain("The person's sentence."));
      expect(written()).toContain("Written while the card was open.");
      expect(screen.queryByText(/Nothing was saved/)).toBeNull();
    });

    it("resends against what the open card showed, not a refetch that landed under it", async () => {
      await startPlanning();
      await write(SPEC);
      await elsewhere({ outcome: "The interview's sentence." });

      const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      await screen.findByText(/Nothing was saved/);

      // Typed while the card is open, and never committed — `commit` bails
      // while `conflict` is set, so nothing has gone out for it yet.
      const notes = screen.getByLabelText("Spec Notes") as HTMLTextAreaElement;
      fireEvent.change(notes, { target: { value: "Typed while the card was open." } });
      fireEvent.blur(notes);

      // The file moves again underneath, in a section the card never named.
      await elsewhere({ outcome: "The interview's sentence.", notes: "The interview's note." });
      await client.invalidateQueries({ queryKey: ["spec", sessionId()] });
      const cached = (): { sections: { notes: string } } | undefined =>
        client.getQueryData(["spec", sessionId()]) as { sections: { notes: string } } | undefined;
      await waitFor(() => expect(cached()?.sections.notes).toBe("The interview's note."));

      const written = (): string =>
        (JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>)[
          "a-light-colour-mode"
        ] ?? "";

      const firstNotice = (await screen.findByText(/Nothing was saved/)).closest(
        ".notice",
      ) as HTMLElement;
      fireEvent.click(within(firstNotice).getByRole("button", { name: "Keep yours" }));

      // The resend settles one way or the other: refused again on Notes, or
      // — the bug this guards — written straight over it. Waiting for
      // either lets the assertion below say which one happened, rather than
      // a bare timeout that says nothing.
      await waitFor(() =>
        expect(
          written().includes("Typed while the card was open.") ||
            screen.queryByText(/Nothing was saved/) !== null,
        ).toBe(true),
      );
      // Not written over: the typed Notes is not in the file yet.
      expect(written()).not.toContain("Typed while the card was open.");

      // Refused again, this time on Notes — a section the card never showed
      // as conflicting — rather than writing the typed text over the
      // interview's because the resend read as if this writer had already
      // seen it.
      const secondNotice = (await screen.findByText(/Nothing was saved/)).closest(
        ".notice",
      ) as HTMLElement;
      expect(secondNotice.textContent).toContain("Notes");
      expect(within(secondNotice).getByText("The interview's note.")).toBeTruthy();
      expect(within(secondNotice).getByText("Typed while the card was open.")).toBeTruthy();
      expect(written()).toContain("The interview's note.");
      expect(written()).not.toContain("The person's sentence.");

      fireEvent.click(within(secondNotice).getByRole("button", { name: "Use the file's" }));
      await waitFor(() => expect(screen.queryByText(/Nothing was saved/)).toBeNull());
      expect(written()).toContain("The person's sentence.");
      expect(written()).toContain("The interview's note.");
    });

    it("does not refuse a later save spuriously once a refusal settles with nothing left to send", async () => {
      await startPlanning();
      await write(SPEC);
      await elsewhere({ outcome: "The interview's sentence." });

      const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      const notice = (await screen.findByText(/Nothing was saved/)).closest(".notice") as HTMLElement;

      // Settled with nothing else typed: `pending()` finds nothing left to
      // send, so this resolves without a further refusal — the held ref must
      // not survive past this, or it becomes what the next save is read
      // against instead of the file this pane has since followed.
      fireEvent.click(within(notice).getByRole("button", { name: "Use the file's" }));
      await waitFor(() => expect(outcome.value).toBe("The interview's sentence."));
      expect(screen.queryByText(/Nothing was saved/)).toBeNull();

      // The file moves again, in a section the settled refusal never named.
      await elsewhere({ notes: "Written while the card was open." });
      await client.invalidateQueries({ queryKey: ["spec", sessionId()] });
      const notes = screen.getByLabelText("Spec Notes") as HTMLTextAreaElement;
      await waitFor(() => expect(notes.value).toBe("Written while the card was open."));

      // Built on what is now shown, which already is the file's own text.
      fireEvent.change(notes, {
        target: { value: "Written while the card was open.\nThe person's line." },
      });
      fireEvent.blur(notes);

      const written = (): string =>
        (JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>)[
          "a-light-colour-mode"
        ] ?? "";
      await waitFor(() => expect(written()).toContain("The person's line."));
      // A real save this time, not the settle's own no-op above — confirms
      // the earlier refusal left nothing behind to catch it.
      expect(screen.queryByText(/Nothing was saved/)).toBeNull();
    });

    it("keeps the card showing what the refusal read, not a second move of the same section underneath", async () => {
      await startPlanning();
      await write(SPEC);
      await elsewhere({ outcome: "The interview's first sentence." });

      const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      const notice = (await screen.findByText(/Nothing was saved/)).closest(".notice") as HTMLElement;
      expect(within(notice).getByText("The interview's first sentence.")).toBeTruthy();

      // The section the card is about moves again while it is open.
      await elsewhere({ outcome: "The interview's second sentence." });
      await client.invalidateQueries({ queryKey: ["spec", sessionId()] });
      await waitFor(() =>
        expect(
          (client.getQueryData(["spec", sessionId()]) as { sections: { outcome: string } } | undefined)
            ?.sections.outcome,
        ).toBe("The interview's second sentence."),
      );

      // The open card still shows what the refusal read, not the live
      // refetch — `theirs` reads the held ref, not `view`, while open.
      expect(within(notice).getByText("The interview's first sentence.")).toBeTruthy();
      expect(within(notice).queryByText("The interview's second sentence.")).toBeNull();

      // Taking the file's side takes what the card showed.
      fireEvent.click(within(notice).getByRole("button", { name: "Use the file's" }));
      await waitFor(() => expect(outcome.value).toBe("The interview's first sentence."));
    });

    it("keeps the held refusal through a save that errors while its card is still open", async () => {
      const original = bridge.request.bind(bridge);
      // Armed only for the one call this test means to fail — the setup
      // above (write, elsewhere) makes specSave calls of its own, so
      // counting them would fail this test for the wrong reason.
      let rejectNextSave = false;
      const asked = vi.spyOn(bridge, "request").mockImplementation((request) => {
        if (request.kind === "specSave" && rejectNextSave) {
          rejectNextSave = false;
          return Promise.reject(new Error("network blip"));
        }
        return original(request);
      });
      try {
        await startPlanning();
        await write(SPEC);
        await elsewhere({ outcome: "The interview's first sentence." });

        const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
        fireEvent.change(outcome, { target: { value: "The person's sentence." } });
        fireEvent.blur(outcome);
        const notice = (await screen.findByText(/Nothing was saved/)).closest(
          ".notice",
        ) as HTMLElement;
        expect(within(notice).getByText("The interview's first sentence.")).toBeTruthy();

        // The same section the card is about moves again while the card is
        // open — a fallback to the live file rather than what the card
        // read would show a text the person was never shown.
        await elsewhere({ outcome: "The interview's second sentence." });
        await client.invalidateQueries({ queryKey: ["spec", sessionId()] });
        await waitFor(() =>
          expect(
            (client.getQueryData(["spec", sessionId()]) as { sections: { outcome: string } } | undefined)
              ?.sections.outcome,
          ).toBe("The interview's second sentence."),
        );

        // Generate reaches the mutation directly while the card is still
        // open, and this resend errors.
        rejectNextSave = true;
        fireEvent.click(screen.getByRole("button", { name: "Generate plan" }));
        await waitFor(() => expect(rejectNextSave).toBe(false));

        // The card is untouched by the error: still open, still showing
        // what the refusal read, not the file's later move.
        expect(within(notice).getByText("The interview's first sentence.")).toBeTruthy();
        expect(screen.getByText(/Nothing was saved/)).toBeTruthy();

        // Taking the file's side takes what the card showed, not the
        // file's later move.
        fireEvent.click(within(notice).getByRole("button", { name: "Use the file's" }));
        await waitFor(() => expect(outcome.value).toBe("The interview's first sentence."));
      } finally {
        asked.mockRestore();
      }
    });

    it("does not refuse a later save spuriously once a settled refusal's own resend errors with no card open", async () => {
      const original = bridge.request.bind(bridge);
      let rejectNextSave = false;
      const asked = vi.spyOn(bridge, "request").mockImplementation((request) => {
        if (request.kind === "specSave" && rejectNextSave) {
          rejectNextSave = false;
          return Promise.reject(new Error("network blip"));
        }
        return original(request);
      });
      try {
        await startPlanning();
        await write(SPEC);
        await elsewhere({ outcome: "The interview's first sentence." });

        const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
        fireEvent.change(outcome, { target: { value: "The person's sentence." } });
        fireEvent.blur(outcome);
        const notice = (await screen.findByText(/Nothing was saved/)).closest(
          ".notice",
        ) as HTMLElement;

        // The refused section moves again while the card is open, so
        // settling it queues a resend with something to send — the held
        // text against a base the file has since moved past — rather than
        // settling finding nothing left to send, as it does when nothing
        // else has moved meanwhile.
        await elsewhere({ outcome: "The interview's second sentence." });
        await client.invalidateQueries({ queryKey: ["spec", sessionId()] });
        await waitFor(() =>
          expect(
            (client.getQueryData(["spec", sessionId()]) as { sections: { outcome: string } } | undefined)
              ?.sections.outcome,
          ).toBe("The interview's second sentence."),
        );

        // Settling closes the card — no refusal is what ends this attempt —
        // and the resend that follows errors.
        rejectNextSave = true;
        fireEvent.click(within(notice).getByRole("button", { name: "Use the file's" }));
        await waitFor(() => expect(rejectNextSave).toBe(false));
        expect(screen.queryByText(/Nothing was saved/)).toBeNull();

        // The file moves again, in a section the settled refusal never named.
        await elsewhere({ notes: "Written after the errored resend." });
        await client.invalidateQueries({ queryKey: ["spec", sessionId()] });
        const notes = screen.getByLabelText("Spec Notes") as HTMLTextAreaElement;
        await waitFor(() => expect(notes.value).toBe("Written after the errored resend."));

        // Built on what is now shown, which already is the file's own text —
        // refused only if the held view outlived the card that showed it.
        fireEvent.change(notes, {
          target: { value: "Written after the errored resend.\nThe person's line." },
        });
        fireEvent.blur(notes);

        const written = (): string =>
          (JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>)[
            "a-light-colour-mode"
          ] ?? "";
        await waitFor(() => expect(written()).toContain("The person's line."));
        expect(screen.queryByText(/Nothing was saved/)).toBeNull();
      } finally {
        asked.mockRestore();
      }
    });

    it("leaves a section nobody else touched alone, and refuses only the one that moved", async () => {
      await startPlanning();
      await write(SPEC);
      await elsewhere({ notes: "The interview's note." });

      const outcome = screen.getByLabelText("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      await waitFor(() => {
        const stored = JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>;
        expect(stored["a-light-colour-mode"]).toContain("The person's sentence.");
      });
      const stored = JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>;
      expect(stored["a-light-colour-mode"]).toContain("The interview's note.");
      expect(screen.queryByText(/Nothing was saved/)).toBeNull();
    });

    it("gives Keep both's two new requirements distinct ids, and does not repeat the shared one", async () => {
      await startPlanning();
      await write(SPEC);
      const id = sessionId();

      // The interview reads the file — with the three requirements' own ids
      // already in it — and appends one more of its own.
      const beforeInterview = await previewBridge.request({ kind: "specRead", id });
      const interviewReply = await previewBridge.request({
        kind: "specSave",
        id,
        repoId: (await session()).repoId,
        title: beforeInterview.title,
        sections: {
          ...beforeInterview.sections,
          requirements: `${beforeInterview.sections.requirements}\n- The interview's own requirement.`,
        },
        base: { title: beforeInterview.title, sections: beforeInterview.sections },
      });
      expect(interviewReply.conflicting).toEqual([]);

      // The person, still on the read from before the interview wrote, adds a
      // different one of their own — typed into the textarea as it already
      // shows the three original lines, ids included.
      const requirements = screen.getByLabelText("Spec Requirements") as HTMLTextAreaElement;
      fireEvent.change(requirements, {
        target: { value: `${requirements.value}\n- The person's own requirement.` },
      });
      fireEvent.blur(requirements);
      const notice = (await screen.findByText(/Nothing was saved/)).closest(".notice") as HTMLElement;
      expect(notice.textContent).toContain("Requirements");

      // Keep both joins the file's text and the person's: the three original
      // lines, each already carrying an id, are whole in both halves and so
      // land in the joined text twice.
      fireEvent.click(within(notice).getByRole("button", { name: "Keep both" }));
      await waitFor(() => expect(screen.queryByText(/Nothing was saved/)).toBeNull());
      // Rendering that joined text must not refuse the save over an id it
      // only sees twice because the join repeated the line, not because two
      // requirements now disagree about what one id means.
      expect(screen.queryByRole("alert")).toBeNull();

      const after = await previewBridge.request({ kind: "specRead", id });
      const ids = after.requirements.map((each) => each.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(after.requirements.map((each) => each.text)).toEqual(
        expect.arrayContaining([
          "The interview's own requirement.",
          "The person's own requirement.",
        ]),
      );
    });
  });

  /**
   * The bridge, watched: every request's kind as it is called and as it
   * settles, with `specSave` held back while `holding` is set so a save can be
   * kept in flight on purpose.
   */
  const watchBridge = () => {
    const events: string[] = [];
    const original = bridge.request.bind(bridge);
    let holding = false;
    let release: (() => void) | null = null;
    const spy = vi.spyOn(bridge, "request").mockImplementation((request) => {
      events.push(`${request.kind}:called`);
      const gate =
        request.kind === "specSave" && holding
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve();
      return gate.then(() => original(request)).then((reply) => {
        events.push(`${request.kind}:settled`);
        return reply;
      });
    });
    return {
      events,
      hold: () => {
        holding = true;
      },
      let: () => {
        holding = false;
        release?.();
        release = null;
      },
      restore: () => spy.mockRestore(),
    };
  };

  it("drafts only once the save it sends has landed, with anything left meanwhile", async () => {
    await startPlanning();
    await write(SPEC);
    const watched = watchBridge();
    try {
      // An outcome typed and not yet left: Generate plan must save it first.
      const outcome = screen.getByLabelText("Spec Outcome");
      fireEvent.change(outcome, { target: { value: "A changed outcome." } });
      watched.hold();
      fireEvent.click(screen.getByRole("button", { name: "Generate plan" }));
      await waitFor(() => expect(watched.events).toContain("specSave:called"));
      // Left while that save is out: it goes before the drafter reads the file.
      const noGos = screen.getByLabelText("Spec No-Gos");
      fireEvent.change(noGos, { target: { value: "- Left while the save was out." } });
      fireEvent.blur(noGos);
      watched.let();
      await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
      const submitted = watched.events.indexOf("editingSubmit:called");
      const saved = watched.events.filter((event, index) => event === "specSave:settled" && index < submitted);
      expect(submitted).toBeGreaterThan(-1);
      expect(saved).toHaveLength(2);
      const stored = JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>;
      expect(stored["a-light-colour-mode"]).toContain("A changed outcome.");
      expect(stored["a-light-colour-mode"]).toContain("Left while the save was out.");
    } finally {
      watched.restore();
    }
  });

  it("holds Start over while a save is out", async () => {
    await startPlanning();
    await write(SPEC);
    fireEvent.click(await screen.findByRole("button", { name: "Generate plan" }));
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    const drafts = (await previewBridge.request({ kind: "drafts" })) ?? [];
    location.hash = `planning/${drafts[0]!.id}/spec`;
    fireEvent.click(await screen.findByRole("button", { name: "Start over from the spec…" }));
    const dialog = await screen.findByRole("dialog", { name: "Start over from the spec?" });
    const startOver = (): HTMLButtonElement => within(dialog).getByRole("button", { name: "Start over" }) as HTMLButtonElement;
    expect(startOver().disabled).toBe(false);
    const watched = watchBridge();
    try {
      watched.hold();
      const notes = screen.getByLabelText("Spec Notes");
      fireEvent.change(notes, { target: { value: "Written with the dialog open." } });
      fireEvent.blur(notes);
      await waitFor(() => expect(startOver().disabled).toBe(true));
      watched.let();
      await waitFor(() => expect(startOver().disabled).toBe(false));
    } finally {
      watched.restore();
    }
  });

  it("keeps R1 and R2 when three sections are left in quick succession", async () => {
    await startPlanning();
    // Title, Outcome and Requirements are each left before the previous save
    // has come back, so every save is sent while the file still lacks ids.
    const title = await screen.findByLabelText("Spec title");
    fireEvent.change(title, { target: { value: SPEC.title } });
    fireEvent.blur(title);
    const outcome = screen.getByLabelText("Spec Outcome");
    fireEvent.change(outcome, { target: { value: SPEC["Spec Outcome"] } });
    fireEvent.blur(outcome);
    const requirements = screen.getByLabelText("Spec Requirements") as HTMLTextAreaElement;
    fireEvent.change(requirements, {
      target: { value: "- The person can choose Light, Dark or System.\n- Text meets WCAG AA contrast." },
    });
    fireEvent.blur(requirements);

    await screen.findByText("specs/a-light-colour-mode/spec.md");
    await waitFor(() => expect(requirements.value).toContain("R2:"));
    await screen.findByText("Saved in the repository — the file is the spec");
    expect(requirements.value).toContain("- R1: The person can choose Light, Dark or System.");
    expect(requirements.value).toContain("- R2: Text meets WCAG AA contrast.");
    expect(requirements.value).not.toContain("R3:");
    const stored = JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>;
    expect(stored["a-light-colour-mode"]).toContain("perbo:requirement-ids through R2");
    expect(stored["a-light-colour-mode"]).toContain(SPEC["Spec Outcome"]);
  });

  it("reads the file again when it was written outside the app", async () => {
    await startPlanning();
    await write(SPEC);
    const stored = JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>;
    localStorage.setItem(
      "perbo:preview-specs",
      JSON.stringify({
        ...stored,
        "a-light-colour-mode": stored["a-light-colour-mode"]!.replace(
          "R3: The terminal view has a light palette of its own.",
          "R3: The terminal view has a light palette written elsewhere.",
        ),
      }),
    );
    // Leaving and coming back reads the repository, which is what the spec is.
    const planning = location.hash;
    cleanup();
    client.clear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    location.hash = planning;
    mount();
    await screen.findByLabelText("Spec title");
    await waitFor(() =>
      expect((screen.getByLabelText("Spec Requirements") as HTMLTextAreaElement).value).toContain(
        "written elsewhere",
      ),
    );
  });

  it("generates a plan from the spec, lands on the contract, and names each requirement's node", async () => {
    await startPlanning();
    await write(SPEC);
    fireEvent.click(await screen.findByRole("button", { name: "Generate plan" }));
    await screen.findByText("Drafting the plan from your spec");
    // It lands on the drafted contract, as compiling one does.
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    expect(location.hash).toMatch(/^#task\//);

    // Back in planning, each requirement names the node its criteria sit in.
    const drafts = (await previewBridge.request({ kind: "drafts" })) ?? [];
    const planning = drafts[0]!;
    location.hash = `planning/${planning.id}/spec`;
    const rows = within(await screen.findByRole("list", { name: "Requirements" }))
      .getAllByRole("listitem")
      .map((row) => row.textContent ?? "");
    expect(rows.some((row) => row.includes("node_1"))).toBe(true);
    expect(rows.some((row) => row.includes("node_2"))).toBe(true);
    expect(rows.every((row) => row.includes("none yet"))).toBe(false);
  });

  it("asks before starting over from the spec, and re-drafts the same ticket when it is confirmed", async () => {
    await startPlanning();
    await write(SPEC);
    fireEvent.click(await screen.findByRole("button", { name: "Generate plan" }));
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    const drafts = (await previewBridge.request({ kind: "drafts" })) ?? [];
    const planning = drafts[0]!;
    const key = planning.key!;
    // The number, not the record: the sample host hands back its live ticket.
    const version = (await previewBridge.request({ kind: "detail", repoId: planning.repoId, key }))
      .ticket.plan_version;
    location.hash = `planning/${planning.id}/spec`;

    fireEvent.click(await screen.findByRole("button", { name: "Start over from the spec…" }));
    const dialog = await screen.findByRole("dialog", { name: /Start over from the spec/ });
    // Keeping the plan runs nothing at all.
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Start over/ })).toBeNull());
    expect(
      (await previewBridge.request({ kind: "detail", repoId: planning.repoId, key })).ticket
        .plan_version,
    ).toBe(version);

    fireEvent.click(screen.getByRole("button", { name: "Start over from the spec…" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: /Start over from the spec/ })).getByRole(
        "button",
        { name: "Start over" },
      ),
    );
    await waitFor(
      async () =>
        expect(
          (await previewBridge.request({ kind: "detail", repoId: planning.repoId, key })).ticket
            .plan_version,
        ).toBe(version + 1),
      { timeout: 5000 },
    );
    // The same ticket, never a second one.
    const after = await previewBridge.request({ kind: "snapshot" });
    expect(after.tasks.filter((row) => row.ticket.key === key)).toHaveLength(1);
  });
});

/**
 * SCP-316: the Graph pane curates the plan and approves it once (D-100,
 * D-101, D-104). Driven through the real renderer against the browser preview
 * host, which applies the same `GraphEditSchema` operations the CLI applies.
 */
describe("the Graph pane (SCP-316)", () => {
  const pane = (name: string) =>
    within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name });
  const canvas = (): HTMLElement => document.querySelector(".canvas") as HTMLElement;
  const layer = (): HTMLElement => document.querySelector(".canvas-inner") as HTMLElement;
  const counts = (): string => document.querySelector(".size-counts")?.textContent ?? "";
  const nodeAt = (label: RegExp) => screen.getByRole("button", { name: label });

  const SECTIONS = {
    outcome: "The application supports a usable light colour mode.",
    requirements:
      "- The person can choose Light, Dark or System without a restart.\n" +
      "- Text meets WCAG AA contrast against its background.\n" +
      "- The terminal view has a light palette of its own.\n" +
      "- The rail follows the mode.",
    no_gos: "- Changing the brand colours.",
    rabbit_holes: "",
    notes: "",
  };

  /**
   * One piece of planning with a spec and a plan drafted from it, through the
   * host rather than the Spec pane: what is being driven here is the Graph
   * pane, and each test needs a ticket of its own to curate.
   */
  async function planned(): Promise<{ id: string; repoId: string; key: string }> {
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const repoId = workspace.repositories[0]!.id;
    const opened = await previewBridge.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId },
    });
    await previewBridge.request({
      kind: "specSave",
      id: opened.id,
      repoId,
      title: "A light colour mode",
      sections: SECTIONS,
      base: NOTHING_YET,
    });
    const current = await previewBridge.request({ kind: "editingRead", id: opened.id });
    await previewBridge.request({
      kind: "editingSubmit",
      id: opened.id,
      revision: current.revision,
      operationId: crypto.randomUUID(),
      intent: "generate",
    });
    let key: string | null = null;
    await waitFor(
      async () => {
        key = (await previewBridge.request({ kind: "editingRead", id: opened.id })).key;
        expect(key).not.toBeNull();
      },
      { timeout: 5000 },
    );
    return { id: opened.id, repoId, key: key! };
  }

  /** That planning, open on the Graph pane, with its graph drawn. */
  async function openGraph(): Promise<{ id: string; repoId: string; key: string }> {
    const plan = await planned();
    location.hash = `planning/${plan.id}/graph`;
    mount();
    await screen.findByRole("heading", { name: "Execution graph" });
    await screen.findByRole("button", { name: /^Node node_1/ });
    return plan;
  }
  const graphOf = (plan: { repoId: string; key: string }) =>
    previewBridge.request({ kind: "graphRead", repoId: plan.repoId, key: plan.key });

  it("approves the plan on the fixed binding, producing the contract the runner reads", async () => {
    const plan = await openGraph();
    const detail = () => previewBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key });
    expect((await detail()).ticket.approved_at).toBeNull();
    expect(screen.getByRole("button", { name: "Approve · start the loop" })).toBeTruthy();
    // ⇧⌘↵, which is fixed and cannot be rebound.
    expect(effectiveShortcuts({}).approve).toBe("Shift+Meta+Enter");
    fireEvent.keyDown(window, { key: "Enter", metaKey: true, shiftKey: true });
    await waitFor(async () => expect((await detail()).ticket.approved_at).not.toBeNull());
    // The same request the contract screen sends: approve, then the loop.
    await waitFor(async () =>
      expect((await previewBridge.request({ kind: "snapshot" })).jobs.some((job) => job.kind === "run")).toBe(true),
    );
  });

  it("moves the size estimate as the graph changes", async () => {
    await openGraph();
    const before = counts();
    expect(before).toContain("2 nodes");
    expect(before).toContain("4 criteria");
    fireEvent.click(nodeAt(/^Node node_1/));
    fireEvent.click(
      within(await screen.findByRole("region", { name: "Node node_1" })).getByRole("button", {
        name: "Split…",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Split node node_1/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Split" }));
    await waitFor(() => expect(counts()).toContain("3 nodes"));
    expect(counts()).not.toBe(before);
  });

  it("pans by dragging the empty canvas and by scrolling, and not by dragging a node", async () => {
    await openGraph();
    expect(layer().style.transform).toBe("translate(0px, 0px)");
    fireEvent.mouseDown(canvas(), { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(window, { clientX: 260, clientY: 190 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(layer().style.transform).toBe("translate(60px, 40px)"));

    fireEvent.wheel(canvas(), { deltaX: 10, deltaY: 20 });
    await waitFor(() => expect(layer().style.transform).toBe("translate(50px, 20px)"));

    const held = layer().style.transform;
    fireEvent.mouseDown(nodeAt(/^Node node_1/), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(window);
    expect(layer().style.transform).toBe(held);
  });

  it("shows a node's generated page read-only beside its criteria and paths", async () => {
    await openGraph();
    fireEvent.click(nodeAt(/^Node node_1/));
    const inspector = await screen.findByRole("region", { name: "Node node_1" });
    expect(within(inspector).getByLabelText("Criterion ac_1")).toBeTruthy();
    expect(within(inspector).getByText("packages/auth/**")).toBeTruthy();
    const page = within(inspector).getByLabelText("specs/a-light-colour-mode/nodes/node_1.md");
    expect(page.tagName).toBe("PRE");
    expect(page.textContent).toContain("# First part");
    expect(page.textContent).toContain("Changing the brand colours.");
    expect(page.textContent).toContain("R1:");
    expect(page.querySelectorAll("input, textarea, [contenteditable]")).toHaveLength(0);
  });

  it("edits a criterion through the one edit path, and undoes the latest edit", async () => {
    const plan = await openGraph();
    const before = (await graphOf(plan)).criteria[0]!.text;
    fireEvent.click(nodeAt(/^Node node_1/));
    const criterion = await screen.findByLabelText("Criterion ac_1");
    fireEvent.change(criterion, { target: { value: "A person can choose the colour mode." } });
    fireEvent.blur(criterion);
    await waitFor(async () =>
      expect((await graphOf(plan)).criteria[0]?.text).toBe("A person can choose the colour mode."),
    );
    const history = await screen.findByRole("region", { name: "Edits to this plan" });
    expect(within(history).getAllByRole("listitem")).toHaveLength(1);
    // The edit is the person's own, and admission counts it (D-072).
    expect((await graphOf(plan)).editCount).toBeGreaterThan(0);
    expect((await graphOf(plan)).history[0]?.author).toBe("you");
    fireEvent.click(within(history).getByRole("button", { name: /^Undo/ }));
    await waitFor(async () => expect((await graphOf(plan)).criteria[0]?.text).toBe(before));
  });

  it("edits the text of a criterion proven by hand, keeping who proves it and why", async () => {
    const plan = await planned();
    await previewBridge.request({
      kind: "graphEdit",
      repoId: plan.repoId,
      key: plan.key,
      edit: {
        op: "set_criterion",
        id: "ac_1",
        text: "A person can choose the colour mode.",
        expected_verification: {
          kind: "manual",
          assertion: "Open Settings and switch modes",
          manual_reviewer: "the designer",
          manual_reason: "a colour is judged by eye",
        },
      },
    });
    await waitFor(async () => expect((await graphOf(plan)).criteria[0]?.kind).toBe("manual"));
    location.hash = `planning/${plan.id}/graph`;
    mount();
    await screen.findByRole("heading", { name: "Execution graph" });
    fireEvent.click(await screen.findByRole("button", { name: /^Node node_1/ }));
    const criterion = await screen.findByLabelText("Criterion ac_1");
    fireEvent.change(criterion, { target: { value: "The colour mode is chosen by eye." } });
    fireEvent.blur(criterion);
    await waitFor(async () =>
      expect((await graphOf(plan)).criteria[0]).toMatchObject({
        text: "The colour mode is chosen by eye.",
        kind: "manual",
        assertion: "Open Settings and switch modes",
      }),
    );
  });

  it("draws and removes an edge, which is approach and not contract", async () => {
    const plan = await openGraph();
    expect((await graphOf(plan)).edges).toEqual([{ from: "node_1", to: "node_2" }]);
    fireEvent.click(nodeAt(/^Node node_2/));
    const inspector = await screen.findByRole("region", { name: "Node node_2" });
    fireEvent.click(
      within(inspector).getByRole("button", { name: "Remove the edge node_1 to node_2" }),
    );
    await waitFor(async () => expect((await graphOf(plan)).edges).toEqual([]));
    fireEvent.change(within(inspector).getByLabelText("Add a node this one comes after"), {
      target: { value: "node_1" },
    });
    await waitFor(async () =>
      expect((await graphOf(plan)).edges).toEqual([{ from: "node_1", to: "node_2" }]),
    );
  });

  it("replaces the plan from the spec only after the same confirmation the Spec pane asks for", async () => {
    const plan = await openGraph();
    const version = async (): Promise<number> =>
      (await previewBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key })).ticket
        .plan_version;
    const before = await version();
    fireEvent.click(screen.getByRole("button", { name: "Start over from the spec…" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: /Start over from the spec/ })).getByRole(
        "button",
        { name: "Keep editing" },
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Start over/ })).toBeNull());
    expect(await version()).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Start over from the spec…" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: /Start over from the spec/ })).getByRole(
        "button",
        { name: "Start over" },
      ),
    );
    await waitFor(async () => expect(await version()).toBe(before + 1), { timeout: 5000 });
  });

  it("opens planning mode for a ticket already in plan_review, on the graph", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    fireEvent.click(
      within(picker).getByRole("button", { name: /Split the settings page into tabs/ }),
    );
    await screen.findByRole("heading", { name: "Execution graph" });
    expect(location.hash).toMatch(/^#planning\/.*\/graph$/);
    expect(await screen.findByRole("button", { name: /^Node node_1/ })).toBeTruthy();
    expect(pane("Graph").getAttribute("aria-current")).toBe("page");
  });

  it("approves a flat plan, which has criteria and no graph to curate", async () => {
    const plan = await planned();
    const edit = async (edit: GraphEdit) =>
      previewBridge.request({ kind: "graphEdit", repoId: plan.repoId, key: plan.key, edit });
    await edit({ op: "delete_node", id: "node_2", move_criteria_to: "node_1", delete_criteria: [] });
    await waitFor(async () => expect((await graphOf(plan)).nodes).toHaveLength(1));
    await edit({ op: "delete_node", id: "node_1", move_criteria_to: null, delete_criteria: [] });
    await waitFor(async () => expect((await graphOf(plan)).nodes).toHaveLength(0));
    expect((await graphOf(plan)).criteria.length).toBeGreaterThan(0);
    location.hash = `planning/${plan.id}/graph`;
    mount();
    await screen.findByText(/This plan is flat/);
    const detail = () => previewBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key });
    expect((await detail()).ticket.approved_at).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Approve · start the loop" }));
    await waitFor(async () => expect((await detail()).ticket.approved_at).not.toBeNull());
  });

  /**
   * SCP-317: the same pane, after the loop has started, reading the run's own
   * records — and a plan that has never run, where every node is untouched.
   */
  it("shows every node untouched and nothing outside before the plan has run", async () => {
    await openGraph();
    for (const id of ["node_1", "node_2"])
      expect(
        within(screen.getByRole("button", { name: new RegExp(`^Node ${id}`) })).getByText(
          "untouched",
        ),
      ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Changed outside every node" })).toBeNull();
  });

  it("shows each node's state and the changed paths outside every node while the work runs", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Plan a piece of work" })).getByRole(
        "button",
        { name: /Split the settings page into tabs/ },
      ),
    );
    await screen.findByRole("button", { name: /^Node node_1/ });
    const planning = location.hash;
    // Runs go one at a time, and the sample keeps one live for a while.
    const settled = async () =>
      expect(
        (await previewBridge.request({ kind: "snapshot" })).jobs.some(
          (job) => job.kind === "run" && ["running", "stopping"].includes(job.state),
        ),
      ).toBe(false);
    await waitFor(settled, { timeout: 6000 });
    fireEvent.click(await screen.findByRole("button", { name: "Approve · start the loop" }));
    // The loop is running; the person comes back to the graph to watch it.
    await waitFor(
      async () =>
        expect(
          (await previewBridge.request({ kind: "snapshot" })).tasks.some(
            (task) => task.ticket.key === "PRB-421" && task.ticket.state !== "plan_review",
          ),
        ).toBe(true),
      { timeout: 6000 },
    );
    cleanup();
    client.clear();
    location.hash = planning;
    mount();
    await screen.findByRole("button", { name: /^Node node_1/ });

    // node_1 names packages/auth/**, node_2 packages/queue/**, and the sample
    // change set touches both and one path neither of them names.
    const first = await screen.findByRole("button", { name: /^Node node_1/ });
    expect(within(first).getByText("packages/auth/signup.ts")).toBeTruthy();
    const second = screen.getByRole("button", { name: /^Node node_2/ });
    expect(within(second).getByText("packages/queue/retry.ts")).toBeTruthy();
    expect(within(second).getByText("a finding open")).toBeTruthy();
    const outside = await screen.findByRole("region", { name: "Changed outside every node" });
    expect(within(outside).getByText("docs/activation-email.md")).toBeTruthy();
    expect(within(first).queryByText("docs/activation-email.md")).toBeNull();

    // The node panel carries each criterion's state and where its evidence is.
    fireEvent.click(second);
    const inspector = await screen.findByRole("region", { name: "Node node_2" });
    expect(within(inspector).getByText(/queue\/retry\.test\.ts:88/)).toBeTruthy();
    expect(within(inspector).getByText(/permanently failed email/)).toBeTruthy();
  });

  /**
   * The records this pane reads are written by the loop and by the interview
   * as well as by the pane, so it follows them rather than only its own edits
   * (D-100): an edit made anywhere else appears without the person asking.
   */
  it("follows a change to the plan that the pane did not make", async () => {
    const plan = await openGraph();
    const first = (await graphOf(plan)).criteria[0]!;
    expect(await screen.findByText(first.text)).toBeTruthy();
    // Somebody else's edit, straight through the host, as the interview makes one.
    await previewBridge.request({
      kind: "graphEdit",
      repoId: plan.repoId,
      key: plan.key,
      edit: {
        op: "set_criterion",
        id: first.id,
        text: "Somebody else changed this criterion.",
        expected_verification: { kind: first.kind, assertion: first.assertion },
      },
    });
    await screen.findByText("Somebody else changed this criterion.", undefined, { timeout: 5000 });
  });

  it("shows the paths outside every node beside a note, not instead of them", async () => {
    // The two are not alternatives: a note says why part of the reading is
    // missing, and the outside paths are a reading that was not.
    const { OutsidePathsForTests } = await import("../src/renderer/planning/GraphPane.js");
    render(<OutsidePathsForTests outside={["docs/activation.md"]} note="Something could not be read." />);
    expect(screen.getByText("Something could not be read.")).toBeTruthy();
    expect(screen.getByText("docs/activation.md")).toBeTruthy();
  });

  it("says there is nothing to curate before a plan is drafted", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Plan a piece of work" })).getByRole("button", {
        name: /example\/webstore/,
      }),
    );
    await screen.findByLabelText("Spec title");
    fireEvent.click(pane("Graph"));
    await screen.findByText("No graph yet");
    expect(screen.queryByRole("button", { name: "Node" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });
});

/**
 * SCP-313: the interview docked beside every pane (D-102). The session here is
 * the browser preview's stand-in: no process, no provider and no repository
 * behind it, answering the same three requests the native host answers.
 */
describe("the interview docked in planning mode (SCP-313)", () => {
  const pane = (name: string) =>
    within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name });
  const dock = (): HTMLElement => screen.getByRole("complementary", { name: "Interview" });
  /** Everything the dock's own hints hold, which is where an asking is kept. */
  const askedInTranscript = (): string =>
    within(dock())
      .queryAllByRole("tooltip", { hidden: true })
      .map((hint) => hint.textContent ?? "")
      .join("\n");
  const composer = (): HTMLTextAreaElement =>
    screen.getByLabelText("Message the interview") as HTMLTextAreaElement;

  const SECTIONS = {
    outcome: "The application supports a usable light colour mode.",
    requirements:
      "- The person can choose Light, Dark or System without a restart.\n" +
      "- Text meets WCAG AA contrast against its background.",
    no_gos: "- Changing the brand colours.",
    rabbit_holes: "",
    notes: "",
  };

  /** One piece of planning with a spec, through the host rather than the Spec pane. */
  async function planning(): Promise<{ id: string; repoId: string }> {
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const repoId = workspace.repositories[0]!.id;
    const opened = await previewBridge.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId },
    });
    await previewBridge.request({
      kind: "specSave",
      id: opened.id,
      repoId,
      title: "A light colour mode",
      sections: SECTIONS,
      base: NOTHING_YET,
    });
    return { id: opened.id, repoId };
  }

  /** That planning, and one turn already sent, so the chat has something in it. */
  async function spoken(): Promise<{ id: string; repoId: string }> {
    const plan = await planning();
    await previewBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
    await previewBridge.request({ kind: "interviewTurn", id: plan.id, text: "why two nodes?" });
    await waitFor(async () =>
      expect(
        (await previewBridge.request({ kind: "editingRead", id: plan.id })).conversation.some(
          (line) => line.line.kind === "refused",
        ),
      ).toBe(true),
    );
    return plan;
  }

  it("stays visible and usable on the Spec, Explorer and Graph panes", async () => {
    const plan = await spoken();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    for (const name of ["Spec", "Explorer", "Graph"]) {
      fireEvent.click(pane(name));
      // The dock is beside the pane, not inside it, so it survives the switch.
      await waitFor(() => expect(dock()).toBeTruthy());
      expect(within(dock()).getByText("why two nodes?")).toBeTruthy();
      expect(composer().disabled).toBe(false);
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Stop the interview" })).toBeTruthy();
    }
  });

  it("shows a refusal as a refusal, with nothing to allow or deny", async () => {
    const plan = await spoken();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    const card = await screen.findByRole("note", { name: "Refused" });
    expect(card.textContent).toContain("Bash");
    expect(card.textContent).toContain("pnpm test");
    expect(card.textContent).toContain("read-only shapes");
    // A refusal is reported, never put to the person as a question (D-102).
    expect(within(card).queryAllByRole("button")).toEqual([]);
    for (const label of [/allow/i, /deny/i, /always/i, /approve/i])
      expect(within(dock()).queryByRole("button", { name: label })).toBeNull();
  });

  it("sends the person's turn and shows what the session answered", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "split the queue node" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(dock()).getByText("split the queue node")).toBeTruthy());
    expect(await within(dock()).findByText(/Noted: “split the queue node”/)).toBeTruthy();
    // The composer empties, ready for the next turn.
    await waitFor(() => expect(composer().value).toBe(""));
  });

  it("keeps what a box wrote behind a dot, and opens it on hover and on focus", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "ask me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await within(dock()).findByRole("group", { name: "How the queue is split" });

    // The line in the chat says only that an asking happened; the questions
    // themselves are behind its dot.
    const said = await within(dock()).findByText(/Asked 3 questions/);
    // The questions are in the document — a screen reader reaches them through
    // `aria-describedby` whether or not they are on screen — but the line the
    // chat shows is the summary, and the rest stays shut until it is asked for.
    const shown = [...said.childNodes]
      .filter((node) => !(node instanceof HTMLElement && node.className.includes("info-hint")))
      .map((node) => node.textContent ?? "")
      .join("");
    expect(shown).toContain("Asked 3 questions");
    expect(shown).not.toContain("Where does the split go?");
    const dot = within(said).getByRole("button", { name: "The questions that were asked" });
    const hint = within(said).getByRole("tooltip", { hidden: true });
    expect(hint.textContent).toContain("Where does the split go?");
    expect(dot.getAttribute("aria-describedby")).toBe(hint.id);
    expect(dot.getAttribute("aria-expanded")).toBe("false");
    expect(hint.className).not.toContain("info-hint-body--open");

    fireEvent.pointerEnter(dot);
    await waitFor(() => expect(dot.getAttribute("aria-expanded")).toBe("true"));
    expect(within(said).getByRole("tooltip").className).toContain("info-hint-body--open");
    // Crossing the gap to the panel keeps it open: the panel hangs against the
    // window, so the space between the two is neither of them, and shutting at
    // once would close the thing the pointer is travelling to.
    fireEvent.pointerLeave(dot);
    fireEvent.pointerEnter(within(said).getByRole("tooltip"));
    await new Promise((settle) => setTimeout(settle, 220));
    expect(dot.getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerLeave(within(said).getByRole("tooltip"));
    await waitFor(() => expect(dot.getAttribute("aria-expanded")).toBe("false"));

    // A keyboard reaches it too: it is not a hover-only affordance.
    fireEvent.focus(dot);
    await waitFor(() => expect(dot.getAttribute("aria-expanded")).toBe("true"));
    fireEvent.keyDown(dot, { key: "Escape" });
    await waitFor(() => expect(dot.getAttribute("aria-expanded")).toBe("false"));

    await waitFor(() => expect(within(dock()).queryAllByText(/Noted:/)).toHaveLength(0));
  });


  it("resizes the interview by dragging the bar on its edge, and remembers it", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    const bar = screen.getByRole("separator", { name: "Resize the interview" });
    expect(dock().style.width).toBe(`${DEFAULT_DOCK_WIDTH}px`);
    expect(bar.getAttribute("aria-valuenow")).toBe(String(DEFAULT_DOCK_WIDTH));

    // The dock is on the right, so the width is the distance from the pointer
    // to the window's right edge.
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 700 });
    await waitFor(() => expect(dock().style.width).toBe("500px"));
    fireEvent.pointerUp(bar, { pointerId: 1 });

    // A move after the drag has ended does not keep dragging it.
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 900 });
    expect(dock().style.width).toBe("500px");
    expect(
      screen.getByRole("separator", { name: "Resize the interview" }).getAttribute("aria-valuenow"),
    ).toBe("500");
    expect(localStorage.getItem("perbo:dock")).toBe("500");
  });

  it("holds the interview's width inside its bounds, and the keyboard moves it", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    const bar = () => screen.getByRole("separator", { name: "Resize the interview" });
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });

    // Dragged past either end, it stops at the end rather than going past it.
    fireEvent.pointerDown(bar(), { button: 0, pointerId: 1 });
    fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 1190 });
    await waitFor(() => expect(dock().style.width).toBe(`${MIN_DOCK_WIDTH}px`));
    fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 10 });
    await waitFor(() => expect(dock().style.width).toBe(`${MAX_DOCK_WIDTH}px`));
    fireEvent.pointerUp(bar(), { pointerId: 1 });

    // Left widens, because the edge moving left is the dock growing.
    fireEvent.keyDown(bar(), { key: "ArrowRight" });
    await waitFor(() => expect(dock().style.width).toBe(`${MAX_DOCK_WIDTH - 16}px`));
    fireEvent.keyDown(bar(), { key: "ArrowLeft" });
    await waitFor(() => expect(dock().style.width).toBe(`${MAX_DOCK_WIDTH}px`));
    // Home puts it back where it opens, as double-clicking does.
    fireEvent.keyDown(bar(), { key: "Home" });
    await waitFor(() => expect(dock().style.width).toBe(`${DEFAULT_DOCK_WIDTH}px`));
    fireEvent.doubleClick(bar());
    expect(dock().style.width).toBe(`${DEFAULT_DOCK_WIDTH}px`);
  });

  it("puts one group of questions at a time, and sends the options' own words", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "ask me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // The session closes the turn it asked in with a line of its own, as both
    // transports do, and the card stands through it.
    expect(await within(dock()).findByText(/Questions are with you/)).toBeTruthy();
    const card = async (name: string) => within(await within(dock()).findByRole("group", { name }));
    const first = await card("How the queue is split");
    // The first group only: its two parts are read together.
    expect(first.getByText("Where does the split go?")).toBeTruthy();
    expect(first.getByText("What proves it?")).toBeTruthy();
    expect(first.queryByText("What happens to the old node?")).toBeNull();
    expect(within(dock()).getByText("1 of 2")).toBeTruthy();

    // Send waits for every part to have an answer.
    const sendAnswer = () =>
      within(within(dock()).getByRole("group", { name: "How the queue is split" })).getByRole(
        "button",
        { name: "Send" },
      );
    expect((sendAnswer() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dock()).getByRole("radio", { name: /Split at the read/ }));
    expect((sendAnswer() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dock()).getByRole("radio", { name: /A unit test per node/ }));
    expect((sendAnswer() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendAnswer());

    // It went as the person's own turn, lettered as the parts were read.
    expect(await within(dock()).findByText(/a\) Split at the read/)).toBeTruthy();

    // Answering the first group brings the second.
    const second = await card("Question 2");
    expect(second.getByText("What happens to the old node?")).toBeTruthy();
    // The first is off the card, though the transcript still holds it behind
    // the dot on the line that says the asking happened.
    expect(second.queryByText("Where does the split go?")).toBeNull();
    expect(askedInTranscript()).toContain("Where does the split go?");
    // Every part carries a way out of choosing, and the composer stays live.
    expect(second.getAllByRole("radio")).toHaveLength(3);
    expect(second.getByText("Let the interview decide")).toBeTruthy();
    expect((composer() as HTMLTextAreaElement).disabled).toBe(false);

    await waitFor(() => expect(within(dock()).getAllByText(/Noted:/)).toHaveLength(1));
  });

  it("takes the questions away once the person says something of their own", async () => {
    // A turn that is not the group's answer ends the asking: the session
    // answers what was said instead, and a card left standing would answer a
    // question nobody is asking any more.
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "ask me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await within(dock()).findByRole("group", { name: "How the queue is split" });

    fireEvent.change(composer(), { target: { value: "what do you mean by split?" } });
    fireEvent.click(within(dock()).getAllByRole("button", { name: "Send" }).at(-1)!);

    await waitFor(() =>
      expect(within(dock()).queryByRole("group", { name: "How the queue is split" })).toBeNull(),
    );
    // Nothing asked is lost: the transcript still holds every question.
    expect(askedInTranscript()).toContain("Where does the split go?");
    expect(askedInTranscript()).toContain("What happens to the old node?");
    expect(await within(dock()).findByText(/Noted:/)).toBeTruthy();
  });

  it("keeps saying it is working through a pause it takes mid-turn", async () => {
    // The pause that reads as something having gone wrong: the session says a
    // line, then goes quiet to read the repository before it says the next.
    // The lines alone cannot tell that from a session that has finished.
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");

    await previewBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
    await previewBridge.request({
      kind: "interviewTurn",
      id: plan.id,
      text: "what is this piece of work for?",
    });
    expect((await within(dock()).findAllByText("Thinking…")).length).toBeGreaterThan(0);

    // It speaks, and then says nothing for a while. The turn is not over, so
    // the dock is still saying so — which is the whole point: the lines alone
    // would read as a session that had finished.
    await within(dock()).findByText(/I'll look at what's already here/);
    expect((await within(dock()).findAllByText("Thinking…")).length).toBeGreaterThan(0);

    // The rest of the turn lands, and only then does it stop saying it.
    await within(dock()).findByText(/Noted:/);
    await waitFor(() => expect(within(dock()).queryAllByText("Thinking…")).toHaveLength(0));
  });

  it("stops saying it is working when the interview is stopped mid-turn", async () => {
    // Something going wrong, or the person deciding not to wait, is the one
    // case the indicator must not sit through: nothing is coming.
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    await previewBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
    await previewBridge.request({ kind: "interviewTurn", id: plan.id, text: "why two nodes?" });
    expect((await within(dock()).findAllByText("Thinking…")).length).toBeGreaterThan(0);

    await previewBridge.request({ kind: "interviewStop", id: plan.id });
    await waitFor(() => expect(within(dock()).queryAllByText("Thinking…")).toHaveLength(0));
    // And the turn it was in the middle of still lands without bringing it back.
    await within(dock()).findByText(/Noted:/);
    expect(within(dock()).queryAllByText("Thinking…")).toHaveLength(0);
  });

  it("says the interview is working until its answer lands", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    // Nothing is waited for before a turn is sent.
    expect(within(dock()).queryAllByText("Thinking…")).toHaveLength(0);

    fireEvent.change(composer(), { target: { value: "split the queue node" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await within(dock()).findAllByText("Thinking…")).length).toBeGreaterThan(0);

    // The answer takes it away and leaves the turn with the person again.
    expect(await within(dock()).findByText(/Noted: “split the queue node”/)).toBeTruthy();
    await waitFor(() => expect(within(dock()).queryAllByText("Thinking…")).toHaveLength(0));
  });

  it("names the spec from the person's first turn when the planning has none", async () => {
    // The interview writes specs/<slug>/spec.md, so a planning with no slug
    // has nowhere to write. The person's own first message names it rather
    // than the turn being refused.
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const opened = await previewBridge.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: workspace.repositories[0]!.id },
    });
    location.hash = `planning/${opened.id}/graph`;
    mount();
    await screen.findByLabelText("Message the interview");
    fireEvent.change(composer(), { target: { value: "Can you add a dark mode toggle" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await within(dock()).findByText(/Named from your first message: specs\/add-a-dark-mode-toggle/),
    ).toBeTruthy();
    // The turn was heard: the session answers it, and the composer is ready
    // for the next one.
    expect(await within(dock()).findByText(/Noted:/)).toBeTruthy();
    await waitFor(() => expect(composer().value).toBe(""));
    const after = await previewBridge.request({ kind: "editingRead", id: opened.id });
    expect(after.specSlug).toBe("add-a-dark-mode-toggle");
  });

  it("keeps the turn in the composer when no folder name can come from it", async () => {
    // A message with no letters or digits names nothing, so the refusal still
    // stands and retyping it is not the person's job.
    const workspace = await previewBridge.request({ kind: "snapshot" });
    const opened = await previewBridge.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId: workspace.repositories[0]!.id },
    });
    location.hash = `planning/${opened.id}/graph`;
    mount();
    await screen.findByLabelText("Message the interview");
    fireEvent.change(composer(), { target: { value: "?!?!" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await within(dock()).findByText(/spec title first/)).toBeTruthy();
    await waitFor(() => expect(composer().value).toBe("?!?!"));
  });

  it("takes the Undo off a card once a later edit is in the way", async () => {
    const session = await planning();
    const current = await previewBridge.request({ kind: "editingRead", id: session.id });
    await previewBridge.request({
      kind: "editingSubmit",
      id: session.id,
      revision: current.revision,
      operationId: crypto.randomUUID(),
      intent: "generate",
    });
    let key: string | null = null;
    await waitFor(
      async () => {
        key = (await previewBridge.request({ kind: "editingRead", id: session.id })).key;
        expect(key).not.toBeNull();
      },
      { timeout: 5000 },
    );

    // Over the Spec pane, where neither the Graph pane nor the drawer is there
    // to follow the records for it.
    location.hash = `planning/${session.id}/spec`;
    mount();
    await screen.findByLabelText("Message the interview");
    // Two turns: the interview answers the first and edits the plan on the
    // second, which is the edit the card offers to undo.
    for (const text of ["what is this for?", "tighten the first criterion"]) {
      fireEvent.change(composer(), { target: { value: text } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(composer().value).toBe(""));
    }
    expect(await within(dock()).findByRole("button", { name: /^Undo/ })).toBeTruthy();

    // A hand edit lands after it, which D-100 says an undo may not reach past.
    const plan = { repoId: session.repoId, key: key! };
    const graph = await previewBridge.request({ kind: "graphRead", ...plan });
    const second = graph.criteria[1]!;
    await previewBridge.request({
      kind: "graphEdit",
      ...plan,
      edit: {
        op: "set_criterion",
        id: second.id,
        text: `${second.text} — by hand`,
        expected_verification: { kind: second.kind, assertion: second.assertion },
      },
    });
    // The card asks the plan rather than the snapshot it was drawn from, so it
    // stops offering an undo the host would refuse.
    await waitFor(() =>
      expect(within(dock()).queryByRole("button", { name: /^Undo/ })).toBeNull(),
    );
  });

  it("opens the plan's history over the pane, with the chat still beside it", async () => {
    // A plan with an edit of each author, both through the one edit path.
    const session = await planning();
    const current = await previewBridge.request({ kind: "editingRead", id: session.id });
    await previewBridge.request({
      kind: "editingSubmit",
      id: session.id,
      revision: current.revision,
      operationId: crypto.randomUUID(),
      intent: "generate",
    });
    let key: string | null = null;
    await waitFor(
      async () => {
        key = (await previewBridge.request({ kind: "editingRead", id: session.id })).key;
        expect(key).not.toBeNull();
      },
      { timeout: 5000 },
    );
    const plan = { repoId: session.repoId, key: key! };
    const drafted = await previewBridge.request({ kind: "graphRead", ...plan });
    const second = drafted.criteria[1]!;
    await previewBridge.request({
      kind: "graphEdit",
      ...plan,
      edit: {
        op: "set_criterion",
        id: second.id,
        text: `${second.text} — said again`,
        expected_verification: { kind: second.kind, assertion: second.assertion },
      },
    });
    // The preview answers an edit as a job, so the hand edit is first in the
    // log only once it has settled.
    await waitFor(async () =>
      expect(
        (await previewBridge.request({ kind: "graphRead", ...plan })).history,
      ).toHaveLength(1),
    );
    await previewBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: session.id });
    await previewBridge.request({ kind: "interviewTurn", id: session.id, text: "one" });
    await previewBridge.request({ kind: "interviewTurn", id: session.id, text: "and make it 60 seconds" });
    await waitFor(async () =>
      expect(
        (await previewBridge.request({ kind: "graphRead", ...plan })).history.map(
          (edit) => edit.author,
        ),
      ).toEqual(["you", "interview"]),
    );

    location.hash = `planning/${session.id}/graph`;
    mount();
    await screen.findByRole("heading", { name: "Execution graph" });
    fireEvent.click(screen.getByRole("button", { name: /^History/ }));
    const drawer = await screen.findByRole("dialog", { name: "The plan’s history" });
    // Both authors are named, and the chat is still there beside the drawer.
    expect(within(drawer).getAllByText("you").length).toBeGreaterThan(0);
    expect(within(drawer).getAllByText("the interview").length).toBeGreaterThan(0);
    expect(within(drawer).getByRole("button", { name: /^Undo/ })).toBeTruthy();
    expect(composer()).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "The plan’s history" })).toBeNull(),
    );
  });

  it("comes back to the conversation after leaving planning mode and after a restart", async () => {
    const plan = await spoken();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    expect(await within(dock()).findByText("why two nodes?")).toBeTruthy();
    // Leave for Home and come back: the same session, the same conversation.
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
    location.hash = `planning/${plan.id}/spec`;
    await screen.findByLabelText("Spec title");
    expect(await within(dock()).findByText("why two nodes?")).toBeTruthy();

    // A restart: a fresh renderer over the same persisted sessions.
    cleanup();
    client.clear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    expect(await within(dock()).findByText("why two nodes?")).toBeTruthy();
    expect(await within(dock()).findByRole("note", { name: "Refused" })).toBeTruthy();
  });
});

/**
 * The Impact pane (SCP-320, D-015): what this draft is likely to touch that its
 * scope does not cover, listed when a person asks for it, with each warning
 * turnable into the draft's own scope mark or the spec's own No-Go.
 *
 * Driven here through the real renderer against the browser preview host, which
 * computes the same report from the same `@perbo/planning` code the native
 * host runs.
 */
describe("the Impact pane (SCP-320)", () => {
  const openPane = async (pane: string): Promise<void> => {
    fireEvent.click(
      within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name: pane }),
    );
  };
  /** Planning in one repository, with `paths` as the draft's declared scope. */
  const planningOver = async (repository: RegExp, paths: string[]): Promise<void> => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    fireEvent.click(within(picker).getByRole("button", { name: repository }));
    await screen.findByLabelText("Outcome");
    const opened = await session();
    await previewBridge.request({
      kind: "editingSave",
      id: opened.id,
      revision: opened.revision,
      repoId: opened.repoId,
      form: { ...opened.form, draft: { ...opened.form.draft, paths } },
    });
    await openPane("Impact");
    await screen.findByRole("heading", { name: "Impact" });
  };
  const check = async (): Promise<void> => {
    fireEvent.click(screen.getAllByRole("button", { name: /^Check (impact|again)$/ }).at(-1)!);
    await waitFor(() => expect(document.querySelector(".impact-row")).toBeTruthy());
  };
  const row = (path: string) => screen.getByLabelText(path);

  it("sits last in the rail's planning panes, and asks for nothing until it is asked", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    expect(railNames().slice(0, 7)).toEqual([
      "Create",
      "Spec",
      "Explorer",
      "Graph",
      "Impact",
      "Home",
      "Archive",
    ]);
    expect(screen.getByRole("button", { name: "Impact" }).getAttribute("aria-current")).toBe("page");
    // Opening the pane reads nothing: the answer is a parse of the whole tree.
    expect(document.querySelector(".pane-head .sub")!.textContent).toContain("not checked yet");
    expect(document.querySelector(".impact-row")).toBeNull();
    await check();
    expect(document.querySelector(".pane-head .sub")!.textContent).toContain(
      "outside this draft's scope",
    );
    // What it was checked against, so a report read later is not taken for a fresh one.
    expect(document.querySelector(".pane-head")!.textContent).toContain("checked ");
    // The fixture's commit is 40 characters, like a real one `perbo index`
    // writes; the pane shows the first 7 and no more.
    expect(document.querySelector(".pane-head")!.textContent).toContain("against 9f2c1ab");
    expect(document.querySelector(".pane-head")!.textContent).not.toContain(
      "9f2c1abccccccccccccccccccccccccccccccccc",
    );
  });

  it("names the importers outside the scope and the path classes the change reaches", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    await check();
    // The test imports the file the draft changes; the theme imports it from another package.
    expect(within(row("packages/auth/test/signup.test.ts")).getByText(
      "imports packages/auth/src/signup.ts, which this draft changes",
    )).toBeTruthy();
    expect(within(row("packages/ui/src/theme.ts")).getByText(
      "imports packages/auth/src/signup.ts, which this draft changes",
    )).toBeTruthy();
    // The manifest of the package the scope names, which the scope does not cover.
    expect(within(row("packages/auth/package.json")).getByText(
      "a dependency manifest, which changes what every other package resolves",
    )).toBeTruthy();
    // Grouped by package, and the file the draft changes is not one of them.
    expect(screen.getByRole("region", { name: "packages/auth" })).toBeTruthy();
    expect(screen.queryByLabelText("packages/auth/src/signup.ts")).toBeNull();
  });

  it("turns a warning into the draft's own scope mark, listed in the draft's history with an undo", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    await check();
    fireEvent.click(within(row("packages/ui/src/theme.ts")).getByRole("button", { name: "Add to scope" }));
    await waitFor(async () =>
      expect((await session()).form.draft.paths).toContain("packages/ui/src/theme.ts"),
    );
    // The same edit the Explorer records, so the Explorer shows it with an Undo.
    await openPane("Explorer");
    const edits = await screen.findByRole("region", { name: "Marks in this draft" });
    expect(within(edits).getByText("Allow packages/ui/src/theme.ts")).toBeTruthy();
    expect(within(edits).getByRole("button", { name: "Undo: Allow packages/ui/src/theme.ts" })).toBeTruthy();
  });

  it("turns a warning into a No-Go in the spec's own file, once however often it is asked", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    // A spec to append to: the No-Gos are a section of the file.
    await openPane("Spec");
    const title = await screen.findByLabelText("Spec title");
    fireEvent.change(title, { target: { value: "Signup retries" } });
    fireEvent.blur(title);
    await screen.findByText("specs/signup-retries/spec.md");
    await openPane("Impact");
    await check();
    const noGos = async (): Promise<string> =>
      (await previewBridge.request({ kind: "specRead", id: sessionId() })).sections.no_gos;
    // Every action on this pane is disabled while a save is out, so a click
    // fired straight after another would land on a disabled button and never
    // reach the append. Each one waits for the buttons to come back first.
    const addNoGo = async (path: string): Promise<void> => {
      const button = (): HTMLButtonElement =>
        within(row(path)).getByRole("button", { name: "Add as a No-Go" }) as HTMLButtonElement;
      await waitFor(() => expect(button().disabled).toBe(false));
      fireEvent.click(button());
      await waitFor(() => expect(button().disabled).toBe(false));
    };
    await addNoGo("packages/auth/package.json");
    expect(await noGos()).toBe("- Changing packages/auth/package.json.");
    await addNoGo("packages/auth/package.json");
    await addNoGo("packages/ui/src/theme.ts");
    // Asked three times over two paths: two lines, in the order they were asked.
    expect(await noGos()).toBe(
      "- Changing packages/auth/package.json.\n- Changing packages/ui/src/theme.ts.",
    );
  });

  it("refuses a No-Go where the No-Gos moved since this action read the file, and keeps the other writer's line", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    await openPane("Spec");
    const title = await screen.findByLabelText("Spec title");
    fireEvent.change(title, { target: { value: "Signup retries" } });
    fireEvent.blur(title);
    await screen.findByText("specs/signup-retries/spec.md");
    await openPane("Impact");
    await check();
    const noGos = async (): Promise<string> =>
      (await previewBridge.request({ kind: "specRead", id: sessionId() })).sections.no_gos;
    const button = (): HTMLButtonElement =>
      within(row("packages/auth/package.json")).getByRole("button", {
        name: "Add as a No-Go",
      }) as HTMLButtonElement;

    // Held so a second writer can land in between this action's own read and
    // its save — the window `base` exists to cover. `bridge` and `previewBridge`
    // are the same object in this browser preview, so the interview's own write
    // goes through `original` directly rather than through the spy — otherwise
    // it would be held behind its own call and never land.
    let holding = true;
    let release: (() => void) | null = null;
    const original = bridge.request.bind(bridge);
    const spy = vi.spyOn(bridge, "request").mockImplementation((request) =>
      request.kind === "specSave" && holding
        ? new Promise((resolve) => {
            release = () => resolve(original(request));
          })
        : original(request),
    );
    try {
      fireEvent.click(button());
      await waitFor(() => expect(release).not.toBeNull());
      // The interview writes the No-Gos itself while this action's save is out.
      const read = await original({ kind: "specRead", id: sessionId() });
      await original({
        kind: "specSave",
        id: sessionId(),
        repoId: (await session()).repoId,
        title: read.title,
        sections: { ...read.sections, no_gos: "- The interview's No-Go." },
        base: { title: read.title, sections: read.sections },
      });
      holding = false;
      release!();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Nothing was saved");
      expect(alert.textContent).toContain("No-Gos");
      // Refused: the file still holds only what the interview wrote.
      expect(await noGos()).toBe("- The interview's No-Go.");
      // Asked again, this read is fresh, so it lands beside the interview's line.
      await waitFor(() => expect(button().disabled).toBe(false));
      fireEvent.click(button());
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(await noGos()).toBe(
        "- The interview's No-Go.\n- Changing packages/auth/package.json.",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("says a No-Go needs a spec before there is one, and writes nothing", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    await check();
    fireEvent.click(
      within(row("packages/auth/package.json")).getByRole("button", { name: "Add as a No-Go" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("This planning has no spec yet") as unknown as string,
    );
    expect((await previewBridge.request({ kind: "specRead", id: sessionId() })).slug).toBeNull();
  });

  it("re-derives on each ask, so Check again answers the draft as it stands now", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    await check();
    expect(row("packages/auth/package.json")).toBeTruthy();
    // The draft's scope moves under the pane. The report is held until it is
    // asked for again — it is a parse of the whole tree, not a subscription —
    // so nothing here has changed yet.
    const opened = await session();
    await previewBridge.request({
      kind: "editingSave",
      id: opened.id,
      revision: opened.revision,
      repoId: opened.repoId,
      form: { ...opened.form, draft: { ...opened.form.draft, paths: ["packages/auth/**"] } },
    });
    expect(row("packages/auth/package.json")).toBeTruthy();
    // Asked again: the manifest is inside the scope now, so it is no longer
    // something the draft is likely to touch that its scope does not cover.
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByLabelText("packages/auth/package.json")).toBeNull());
    // Still an answer, so the silence above is a fresh derivation and not an empty one.
    expect(row("packages/ui/src/theme.ts")).toBeTruthy();
  });

  it("asks for nothing when the window comes back, however long the pane is left open", async () => {
    // The other half of "on demand means a button". `main.tsx` turns
    // `refetchOnWindowFocus` on for every query in the app, so without a
    // staleness rule of its own this pane would run a whole `perbo index` over
    // the tracked tree each time the window regained focus while it was open.
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, refetchOnWindowFocus: true },
        mutations: { retry: false },
      },
    });
    const asked = vi.spyOn(previewBridge, "request");
    const runs = (): number =>
      asked.mock.calls.filter(([request]) => request.kind === "impactRead").length;
    try {
      await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
      await check();
      expect(runs()).toBe(1);
      // The window goes away and comes back, twice.
      const awayAndBack = (): void => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      };
      awayAndBack();
      awayAndBack();
      await waitFor(() => expect(row("packages/auth/package.json")).toBeTruthy());
      expect(runs()).toBe(1);
      // The button still asks, so the silence above is the staleness rule and
      // not a pane that has stopped reading.
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(runs()).toBe(2));
    } finally {
      asked.mockRestore();
      focusManager.setFocused(undefined);
    }
  });

  it("asks for nothing when the window comes back after a failed ask, either", async () => {
    // The failed half of the same rule. A rejected query's `data` stays
    // undefined, and `isStaleByTime` treats undefined data as stale regardless
    // of `staleTime`, so without `refetchOnWindowFocus: false` on the pane's
    // own query a failed ask would run `git ls-files` and a full `perbo
    // index` again on every focus.
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, refetchOnWindowFocus: true },
        mutations: { retry: false },
      },
    });
    const original = bridge.request.bind(bridge);
    const asked = vi
      .spyOn(bridge, "request")
      .mockImplementation((request) =>
        request.kind === "impactRead"
          ? Promise.reject(new Error("this checkout has no HEAD to read"))
          : original(request),
      );
    const runs = (): number =>
      asked.mock.calls.filter(([request]) => request.kind === "impactRead").length;
    try {
      await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
      fireEvent.click(screen.getAllByRole("button", { name: /^Check (impact|again)$/ }).at(-1)!);
      await screen.findByRole("alert");
      expect(runs()).toBe(1);
      const awayAndBack = (): void => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      };
      awayAndBack();
      awayAndBack();
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(runs()).toBe(1);
    } finally {
      asked.mockRestore();
      focusManager.setFocused(undefined);
    }
  });

  it("is advice: checking changes neither the draft's scope nor its history", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    const before = await session();
    await check();
    await check();
    const after = await session();
    expect(after.form.draft).toEqual(before.form.draft);
    expect(after.history).toEqual(before.history);
    expect(after.revision).toBe(before.revision);
  });

  it("lists only the path classes for a repository outside TypeScript, and says why", async () => {
    await planningOver(/example\/landing/, ["src/index.html", "src/styles.css"]);
    await check();
    expect(document.querySelector(".impact-note")!.textContent).toContain(
      "Nothing here reads imports",
    );
    expect(document.querySelector(".impact-note")!.textContent).toContain(
      "Only the path classes are listed",
    );
    expect(document.querySelector(".impact-note")!.textContent).toContain(
      "Tracked extensions here: .css .html .md .sql",
    );
    expect(within(row("src/migrations/0001-signups.sql")).getByText(
      "a schema or data migration, whose effect outlives the pull request",
    )).toBeTruthy();
    // Nothing on this screen claims to have read an import.
    expect(screen.queryByText(/which this draft changes/)).toBeNull();
    expect(screen.queryByText(/which the spec names/)).toBeNull();
  });
});
