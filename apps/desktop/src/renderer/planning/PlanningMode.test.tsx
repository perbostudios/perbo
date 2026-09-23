// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../shell/App.js";
import { CreateContext } from "../shell/create.js";
import { HomePage } from "../tasks/HomePage.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import { bridge } from "../workspace/index.js";
import { resetRailSize } from "../shell/rail-size.js";
import { DEFAULT_ASKED_HEIGHT, resetAskedHeight } from "../shell/asked-size.js";
import {
  DEFAULT_DOCK_WIDTH,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
  resetDockWidth,
} from "../shell/dock-size.js";
import { conflictFor, DEFAULT_SHORTCUTS, effectiveShortcuts, setPlatformForTests } from "../../shared/shortcuts.js";
import {
  ticketsNoDraftStandsFor,
  titleOfDraft,
  unclaimedSpecs,
  withDraft,
} from "../shell/create.js";
import { isPreLoop } from "../../shared/archive.js";
import { untouchedPlanning } from "../../shared/contract-editing.js";
import { isLive } from "../../shared/jobs.js";
import { TICKET_STATES } from "@perbo/contracts";
import { SpecSection } from "./SpecSection.js";
import {
  firstSentence,
  foldAllowList,
  handedOver,
  sayWorking,
  waitsOnWords,
} from "./InterviewDock.js";
import { GraphInspector } from "./GraphInspector.js";
import type { GraphEdit } from "@perbo/contracts/browser";
import { INTERVIEW_WROTE_THE_SPEC } from "../../shared/protocol.js";
import type { ExportedName, OpenDraft, Snapshot } from "../../shared/protocol.js";
import * as planningBrowser from "@perbo/planning/browser";

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
  client = newClient();
});
afterEach(() => {
  cleanup();
  client.clear();
  setPlatformForTests(null);
});
const newClient = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
function mount() {
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}
/** A restart: a fresh renderer over the same persisted sessions, opened on `hash`. */
function restart(hash: string): void {
  cleanup();
  client.clear();
  client = newClient();
  location.hash = hash;
  mount();
}
/** The planning the route is on. */
const sessionId = (): string => location.hash.split("/")[1] ?? "";
const session = () => sampleBridge.request({ kind: "editingRead", id: sessionId() });
const editingRead = (id: string) => sampleBridge.request({ kind: "editingRead", id });
/** The pane a planning was last left at, as the host recorded it. */
const lastPane = async (id: string): Promise<string | null> => (await editingRead(id)).lastPane;
const pane = (name: string): HTMLElement =>
  within(screen.getByRole("group", { name: "Planning panes" })).getByRole("button", { name });
/** Create's picker, opened the way a person opens it. */
async function openPicker(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  return await screen.findByRole("dialog", { name: "Plan a piece of work" });
}
/** The question a repository row in the picker lands on (D-131). */
const ASK = "What do you want to build?";
/**
 * A fresh planning in one repository, open on its Spec pane with nothing put
 * into it, and its id. Opened through the host as Send opens one: the
 * question page creates nothing until its answer is sent, and these cases are
 * about the planning, not about that answer.
 */
async function startPlanning(repository: RegExp = /example\/webstore/): Promise<string> {
  const workspace = await sampleBridge.request({ kind: "snapshot" });
  const repoId = workspace.repositories.find((repo) => repository.test(repo.name))!.id;
  const opened = await bridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
  location.hash = `planning/${opened.id}/spec`;
  mount();
  await screen.findByLabelText("Spec title");
  return opened.id;
}
/**
 * Three round trips over the bridge. A leave reads the session and then
 * discards it: two round trips over the same bridge, so a third settles after
 * both.
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await sampleBridge.request({ kind: "snapshot" });
}
/** The bar at the foot of a card of questions, which sends the whole group as one turn (D-117). */
function sendGroup(card: HTMLElement): void {
  fireEvent.click(within(card).getByRole("button", { name: "Send" }));
}
/** A fresh planning in the sample workspace's first repository, opened through the host. */
async function openFresh() {
  const workspace = await sampleBridge.request({ kind: "snapshot" });
  return sampleBridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId: workspace.repositories[0]!.id } });
}
async function goHome(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Home" }));
  await screen.findByRole("heading", { name: /Hi, / });
  await settle();
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
/**
 * The dock's working line, whatever it says.
 *
 * These cases are about whether the session is reported as working, not about
 * which words it uses: the line names the work in hand — "Reading what you
 * said…", "Changing the plan…" — and pinning one wording would make every
 * later improvement to it look like a regression here.
 *
 * Still a sentence about work, though. A bare trailing ellipsis is also how
 * the dock clips a long question, so matching on that alone would call the
 * indicator up over text that has nothing to do with it.
 */
const WORKING =
  /^(?:Reading|Thinking|Working|Trying|Drafting|Changing|Taking|Questions|Writing)\b[^…]*…$/;
const rail = (): HTMLElement => document.querySelector(".rail") as HTMLElement;
const railNames = (): string[] =>
  within(rail()).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? "");
/** The renderer's own stylesheet, as written. */
const stylesheet = (): string => readFileSync(`${import.meta.dirname}/../styles.css`, "utf8");
/** The first rule in the renderer's stylesheet with exactly this selector, up to its closing brace. */
function cssRule(selector: string): string {
  const css = stylesheet();
  const at = css.indexOf(`\n${selector} {`);
  expect(at).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("Create in the rail (SCP-334)", () => {
  it("reads Create, Home, Archive, Settings, bound to ⌘1 to ⌘4 in that order, with ⌘N still creating", async () => {
    resetRailSize();
    resetDockWidth();
    resetAskedHeight();
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
    // The repositories to start in come first; the sample workspace's ticket
    // in plan_review is planning too (D-101), listed under them.
    expect([...picker.querySelectorAll(".section-label")].map((label) => label.textContent)).toEqual([
      "Start in",
      "Continue planning",
    ]);
    const rows = within(picker).getAllByRole("button");
    expect(rows[0]!.textContent).toContain("example/webstore");
    expect(rows.indexOf(within(picker).getByRole("button", { name: /^Split the settings page into tabs/ }))).toBeGreaterThan(
      rows.indexOf(within(picker).getByRole("button", { name: /example\/landing/ })),
    );
    fireEvent.click(within(picker).getByRole("button", { name: /example\/webstore/ }));
    const question = await screen.findByRole("textbox", { name: ASK });
    expect(question.getAttribute("placeholder")).toBe("Start planning");
    fireEvent.change(question, { target: { value: "Can you add a dark mode toggle" } });
    fireEvent.keyDown(question, { key: "Enter" });
    await screen.findByLabelText("Spec title");
    expect(location.hash).toMatch(/^#planning\//);
    const started = sessionId();
    const panes = screen.getByRole("group", { name: "Planning panes" });
    expect(within(panes).getByRole("button", { name: "Spec" }).getAttribute("aria-current")).toBe("page");
    // No plan yet, so no graph to offer: Spec, the files it is written
    // against, and what it is likely to touch.
    expect(railNames().slice(0, 6)).toEqual([
      "Create",
      "Spec",
      "Explorer",
      "Impact",
      "Home",
      "Archive",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
    expect(screen.queryByRole("group", { name: "Planning panes" })).toBeNull();
    expect(railNames().slice(0, 3)).toEqual(["Create", "Home", "Archive"]);
    // What was sent is in it, so leaving kept it.
    await settle();
    expect((await editingRead(started)).phase).toBe("editing");
  });

  it("lists an open draft under the repositories, Enter resumes the top planning still open, and the draft survives a restart", async () => {
    const repositories = (await sampleBridge.request({ kind: "snapshot" })).repositories.length;
    await startPlanning();
    const title = screen.getByLabelText("Spec title");
    fireEvent.change(title, { target: { value: "Every export carries its month" } });
    fireEvent.blur(title);
    await waitFor(async () => {
      const specs = (await sampleBridge.request({ kind: "snapshot" })).specs ?? [];
      expect(specs.map((spec) => spec.title)).toContain("Every export carries its month");
    }, { timeout: 5000 });
    restart("home");
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    expect(within(picker).getByText("Continue planning")).toBeTruthy();
    const rows = [...picker.querySelectorAll<HTMLElement>(".picker-row")];
    // The repositories first; the draft is the first row under the last of
    // them, and the one Enter takes.
    expect(rows[0]!.textContent).toContain("example/webstore");
    expect(rows[repositories]!.textContent).toContain("Every export carries its month");
    fireEvent.keyDown(picker, { key: "Enter" });
    expect(((await screen.findByLabelText("Spec title")) as HTMLInputElement).value).toBe(
      "Every export carries its month",
    );
    expect(screen.getByRole("group", { name: "Planning panes" })).toBeTruthy();
  });

  it("leads a stale planning link to Create or Home instead of a retry that cannot succeed", async () => {
    location.hash = "planning/00000000-0000-4000-8000-000000000000/spec";
    mount();
    await screen.findByText("This planning could not be opened");
    expect(screen.queryByLabelText("Spec title"), "nothing to edit").toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create a task" }));
    expect(await screen.findByRole("dialog", { name: "Plan a piece of work" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
  });

  it("shows a discarded session's link as discarded, with nothing to edit", async () => {
    const session = await openFresh();
    await sampleBridge.request({ kind: "editingDiscard", id: session.id, revision: session.revision });
    location.hash = `planning/${session.id}/spec`;
    mount();
    await screen.findByText("This planning was discarded");
    expect(screen.queryByLabelText("Spec title"), "nothing to edit").toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
  });

  it("offers a spec nothing points at, and not one a planning is already writing", async () => {
    // A spec whose planning was discarded: the folder stays, and the picker is
    // what leads back to it, where otherwise it would go on holding its own
    // title against a new one (D-129).
    const markdown = planningBrowser.renderSpec(
      { ...planningBrowser.EMPTY_SPEC_TEXT, title: "Play tic tac toe" },
      { highWater: 0, existing: [] },
    ).markdown;
    localStorage.setItem(
      "perbo:preview-specs",
      JSON.stringify({ "play-tic-tac-toe": markdown }),
    );
    mount();
    const picker = await openPicker();
    const row = within(picker).getByRole("button", { name: /^Play tic tac toe/ });
    expect(row.textContent).toContain("spec written, no plan yet");

    // Opening it lands on the spec, and on that spec: the session is named from
    // the slug at birth, so its first save writes the folder already there
    // rather than minting a second from the same title.
    fireEvent.click(row);
    await screen.findByLabelText("Spec title");
    const opened = await sampleBridge.request({ kind: "snapshot" });
    const writing = (opened.drafts ?? []).find((draft) => draft.specSlug === "play-tic-tac-toe");
    expect(writing, "the session the picker opened writes that spec").toBeTruthy();

    // And now that a planning names it, it is no longer offered: the row is the
    // way back in, not a second copy of a spec already open. Without the
    // subtraction this assertion fails while the one above still passes.
    cleanup();
    mount();
    const again = await openPicker();
    await waitFor(() =>
      expect(
        within(again)
          .getAllByRole("button")
          .filter((each) => each.textContent?.includes("spec written, no plan yet")),
      ).toHaveLength(0),
    );
  });

  it("offers a spec that has only a name, which is a piece of work with its plan still to come", async () => {
    // Named by the interview from a first turn, or by the person in the Spec
    // pane, and nothing written yet. Home is for tickets; until a plan makes
    // one, the picker is the only place this lives
    // (D-129).
    const named = planningBrowser.renderSpec(
      { ...planningBrowser.EMPTY_SPEC_TEXT, title: "Have a dark mode" },
      { highWater: 0, existing: [] },
    ).markdown;
    expect(planningBrowser.readSpecSections(named).text.outcome.trim(), "nothing but a name").toBe("");
    localStorage.setItem("perbo:preview-specs", JSON.stringify({ "have-a-dark-mode": named }));
    mount();
    const picker = await openPicker();
    expect(
      within(picker).getByRole("button", { name: /^Have a dark mode/ }).textContent,
    ).toContain("spec written, no plan yet");
  });

  describe("what the dock says the session is doing", () => {
    it("names the work in hand rather than calling every pause thinking", () => {
      // "Thinking…" is true of every pause and says nothing about any of them.
      expect(sayWorking({ kind: "tool", tool: "read_plan", ok: true, detail: "", edit: null } as never)).toBe(
        "Reading the plan…",
      );
      expect(sayWorking({ kind: "tool", tool: "edit_plan", ok: true, detail: "", edit: null } as never)).toBe(
        "Changing the plan…",
      );
      expect(sayWorking({ kind: "turn", text: "do it" } as never)).toBe("Reading what you said…");
      expect(sayWorking({ kind: "refused", tool: "Bash", rule: "r", target: null, reason: "x" } as never)).toBe(
        "Trying another way…",
      );
      expect(sayWorking(undefined)).toBe("Reading the repository…");
    });

    it("says nothing under the note that is already the whole status", () => {
      // The spec is written, the note says so and names the three ways on. A
      // line under it saying the session is working reads as more being owed
      // before the person may act, and nothing is: the spec is readable now
      // (D-102).
      expect(
        sayWorking({ kind: "note", text: INTERVIEW_WROTE_THE_SPEC, notable: true } as never),
      ).toBeNull();
      // Any other note is not that note, and the pause under it is still a
      // pause.
      expect(
        sayWorking({ kind: "note", text: "Writing the spec…" } as never),
      ).toBe("Thinking…");
    });

    it("says something for a tool it does not know, rather than its argument name", () => {
      // A tool added later reads as work rather than as nothing.
      expect(sayWorking({ kind: "tool", tool: "some_new_tool", ok: true, detail: "", edit: null } as never)).toBe(
        "Working…",
      );
      // And one that failed is being answered, not repeated.
      expect(sayWorking({ kind: "tool", tool: "edit_plan", ok: false, detail: "", edit: null } as never)).toBe(
        "Reading what came back…",
      );
    });
  });

  describe("a command the session may not run", () => {
    const refused = (n: number, rule: string) =>
      ({ n, at: "2026-01-01T00:00:00.000Z", line: { kind: "refused", tool: "Bash", rule, target: null, reason: "r" } }) as never;
    const said = (n: number) =>
      ({ n, at: "2026-01-01T00:00:00.000Z", line: { kind: "said", text: "hello" } }) as never;

    it("folds a run of them into one, because it is one thing that happened", () => {
      const folded = foldAllowList([
        refused(1, "command_allow_list"),
        refused(2, "command_allow_list"),
        refused(3, "command_allow_list"),
      ]);
      expect(folded).toHaveLength(1);
      expect(folded[0]!.tried).toBe(3);
    });

    it("folds every rule where nothing shows a write, not only the allow list", () => {
      // The runner's own rules split this way: a shape the guard cannot vouch
      // for is recorded and the attempt runs on, where a write rule ends it.
      for (const rule of ["command_allow_list", "unreadable_program", "unreadable_inline_program"])
        expect(foldAllowList([refused(1, rule)])[0]!.tried, rule).toBe(1);
    });

    it("keeps the card for every rule that does show a write", () => {
      // These are the ones a person should act on, and the red belongs to them.
      for (const rule of [
        "write_outside_worktree",
        "write_outside_scope",
        "write_prohibited_path",
        "command_deny_list",
        "git_credential_config",
      ])
        expect(foldAllowList([refused(1, rule)])[0]!.tried, rule).toBeUndefined();
    });

    it("keeps a refusal that matters as its own line, whatever it sits beside", () => {
      // A write it may not make is not the session finding the edge of what it
      // can read: it is the thing to act on, and it keeps its own card.
      const folded = foldAllowList([
        refused(1, "command_allow_list"),
        refused(2, "write_outside_scope"),
        refused(3, "command_allow_list"),
      ]);
      expect(folded.map((each) => each.tried)).toEqual([1, undefined, 1]);
    });

    it("does not fold across anything else, since those are separate events", () => {
      const folded = foldAllowList([
        refused(1, "command_allow_list"),
        said(2),
        refused(3, "command_allow_list"),
      ]);
      expect(folded).toHaveLength(3);
      expect(folded.map((each) => each.tried)).toEqual([1, undefined, 1]);
    });

    it("leaves a conversation with none of them alone", () => {
      expect(foldAllowList([said(1), said(2)]).map((each) => each.tried)).toEqual([
        undefined,
        undefined,
      ]);
    });
  });

  describe("what Home shows and what the picker shows", () => {
    const row = (state: string) =>
      ({ repoId: "repo-1", repository: "test", ticket: { key: "PRB-1", state } }) as unknown as Parameters<
        typeof isPreLoop
      >[0];

    it("keeps a plan nobody has approved off Home, because it is still being planned", () => {
      expect(isPreLoop(row("plan_review"))).toBe(true);
      expect(isPreLoop(row("draft"))).toBe(true);
      expect(isPreLoop(row("specifying"))).toBe(true);
    });

    it("keeps the loop's own work on Home, from the moment approval starts it", () => {
      // `ready` is approved and queued, which is the loop carrying it. If this
      // ever reads true, Home has hidden work that is actually running.
      for (const state of ["ready", "provisioning", "executing", "verifying", "pr_open", "merged", "done"])
        expect(isPreLoop(row(state)), state).toBe(false);
    });

    it("puts every state Home refuses into the picker, so no ticket is nowhere", () => {
      // Home and the picker are one split, not two filters: a state absent from
      // both is a ticket a person cannot reach at all. The picker lists what
      // isPreLoop says Home does not.
      const refused = TICKET_STATES.filter((state) => isPreLoop(row(state)));
      // Exactly the states the picker restores. Widen PRE_LOOP_STATES without
      // widening what the picker lists and this fails, which is the only way a
      // ticket ends up on neither surface.
      expect([...refused]).toEqual(["draft", "specifying", "plan_review"]);
      expect(refused.length).toBeLessThan(TICKET_STATES.length);
    });

    it("leaves a ticket that died before it ran on Home, which is the only place it is visible", () => {
      // `plan_invalid` is terminal and was approved, so it is not planning to
      // resume; hiding it would leave a dead ticket nowhere (D-103).
      expect(isPreLoop(row("plan_invalid"))).toBe(false);
    });
  });

  it("names a planning by its spec, then by the plan's own shorter name", () => {
    const spec = { repoId: "repo-1", slug: "a-clock-app", title: "A clock app" };
    const writing = { repoId: "repo-1", specSlug: "a-clock-app", key: null, outcome: "" } as OpenDraft;
    const held = { specs: [spec], tasks: [], titles: {} } as unknown as Parameters<typeof titleOfDraft>[0];

    // During the interview there is no outcome and no ticket, and "Untitled
    // work" would stand beside a spec the person has already titled.
    expect(titleOfDraft(held, writing)).toBe("A clock app");

    // Once a plan is drafted, its ticket's title — not the outcome, which is a
    // sentence stating what will be true and reads as a paragraph in a list.
    const planned = {
      specs: [spec],
      titles: {},
      tasks: [{ repoId: "repo-1", ticket: { key: "PRB-2", title: "Clock app" } }],
    } as unknown as Parameters<typeof titleOfDraft>[0];
    expect(
      titleOfDraft(planned, {
        ...writing,
        key: "PRB-2",
        outcome: "A person can read the time on a clock that updates every second without a reload.",
      }),
    ).toBe("Clock app");

    // And with none of them, the row still says something.
    expect(titleOfDraft({ specs: [], tasks: [], titles: {} } as unknown as Parameters<typeof titleOfDraft>[0], writing)).toBe(
      "Untitled work",
    );
  });

  it("lists a drafted plan once, under the planning that is writing its spec", () => {
    // A plan the interview drafted leaves the session holding the spec, so
    // listing the planning and the ticket would be two rows for one piece of
    // work: deleting either would leave the other standing under the same
    // title, and opening the ticket would start a second planning beside the
    // first (D-101, D-103).
    const ticket = (key: string, slug: string | null) => ({
      repoId: "repo-1",
      ticket: {
        key,
        admission: slug === null ? null : { spec: { path: `specs/${slug}/spec.md` } },
      },
    });
    const writing = { id: "a", repoId: "repo-1", specSlug: "a-clock-app", key: null } as OpenDraft;
    expect(ticketsNoDraftStandsFor([ticket("PRB-2", "a-clock-app")], [writing])).toEqual([]);
    // Still covered once the session does hold the ticket, by the key.
    const holding = { ...writing, key: "PRB-2" } as OpenDraft;
    expect(ticketsNoDraftStandsFor([ticket("PRB-2", "a-clock-app")], [holding])).toEqual([]);

    // And a ticket no planning is writing keeps its own row, which is the way
    // into a plan the command line admitted.
    expect(
      ticketsNoDraftStandsFor([ticket("PRB-3", "another-spec")], [writing]).map(
        (row) => row.ticket.key,
      ),
    ).toEqual(["PRB-3"]);
    expect(
      ticketsNoDraftStandsFor([ticket("PRB-4", null)], [writing]).map((row) => row.ticket.key),
    ).toEqual(["PRB-4"]);
    // A planning with no spec stands for nothing: matching on the missing slug
    // would hide every ticket the command line admitted with no spec at all.
    const nameless = { id: "c", repoId: "repo-1", specSlug: null, key: null } as OpenDraft;
    expect(
      ticketsNoDraftStandsFor([ticket("PRB-4", null)], [nameless]).map((row) => row.ticket.key),
    ).toEqual(["PRB-4"]);
    // And a spec of the same name in another repository is another spec.
    const elsewhere = { ...writing, repoId: "repo-2" } as OpenDraft;
    expect(
      ticketsNoDraftStandsFor([ticket("PRB-2", "a-clock-app")], [elsewhere]).map(
        (row) => row.ticket.key,
      ),
    ).toEqual(["PRB-2"]);
  });

  describe("which specs the picker offers", () => {
    const spec = { repoId: "repo-1", slug: "have-a-dark-mode", title: "Have a dark mode" };
    const ticketFor = (path: string | null) =>
      ({
        repoId: "repo-1",
        repository: "test",
        ticket: { key: "PRB-1", admission: { spec: path === null ? null : { path } } },
      }) as unknown as Snapshot["tasks"][number];

    it("offers one no planning and no ticket names", () => {
      expect(unclaimedSpecs({ specs: [spec], tasks: [] }, [])).toEqual([spec]);
    });

    it("does not offer one a planning is writing", () => {
      const draft = { repoId: "repo-1", specSlug: "have-a-dark-mode" } as OpenDraft;
      expect(unclaimedSpecs({ specs: [spec], tasks: [] }, [draft])).toEqual([]);
    });

    it("does not offer one a ticket was drafted from, which is the only claim a CLI admission leaves", () => {
      // No session at all: this arm is what a ticket the command line admitted
      // is read through, and reading only the sessions would offer a spec whose
      // plan is already on the board.
      const tasks = [ticketFor("specs/have-a-dark-mode/spec.md")];
      expect(unclaimedSpecs({ specs: [spec], tasks }, [])).toEqual([]);
    });

    it("reads the slug from the folder, whatever folder the repository keeps specs in", () => {
      const tasks = [ticketFor("docs/specs/have-a-dark-mode/spec.md")];
      expect(unclaimedSpecs({ specs: [spec], tasks }, [])).toEqual([]);
    });

    it("keeps a spec apart from one of the same name in another repository", () => {
      const draft = { repoId: "repo-2", specSlug: "have-a-dark-mode" } as OpenDraft;
      expect(unclaimedSpecs({ specs: [spec], tasks: [] }, [draft])).toEqual([spec]);
    });

    it("is unbothered by a ticket that was never drafted from a spec", () => {
      expect(unclaimedSpecs({ specs: [spec], tasks: [ticketFor(null)] }, [])).toEqual([spec]);
    });
  });

  it("lists a session Send just opened, before the host's refresh lands", async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const session = await sampleBridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId: workspace.repositories[0]!.id } });
    const stale = { ...workspace, drafts: [{ id: "older", repoId: session.repoId, key: null, admitted: false, outcome: "An older draft", phase: "editing" as const, nodes: 0, drift: null, scope: { paths: [], prohibited: [] }, specSlug: null, lastPane: null, lastView: null }] };
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
      fireEvent.click(within(picker).getByRole("button", { name: /example\/landing/ }));
      const question = await screen.findByRole("textbox", { name: ASK });
      hold = true;
      fireEvent.change(question, { target: { value: "Can you add a dark mode toggle" } });
      fireEvent.keyDown(question, { key: "Enter" });
      await screen.findByLabelText("Spec title");
      fireEvent.keyDown(window, { key: "1", code: "Digit1", metaKey: true });
      const again = await screen.findByRole("dialog", { name: "Plan a piece of work" });
      const opened = [...again.querySelectorAll<HTMLElement>(".picker-row")].filter((row) =>
        (row.textContent ?? "").includes("example/landing · draft in progress"),
      );
      expect(opened).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps Create out of Home's header and in its empty state", async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const open = vi.fn();
    const openUnselected = vi.fn();
    const create = { open, openUnselected, toggle: open, enter: open, leave: () => undefined, isOpen: false, deleting: new Set<string>(), hide: () => () => undefined };
    render(
      <QueryClientProvider client={client}>
        <CreateContext.Provider value={create}>
          <HomePage workspace={{ ...workspace, tasks: [] }} navigate={() => undefined} archive={false} />
        </CreateContext.Provider>
      </QueryClientProvider>,
    );
    expect(document.querySelector(".home-heading button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create a task" }));
    // Home's empty state opens the picker with nothing in it selected.
    expect(openUnselected).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    cleanup();
    render(
      <QueryClientProvider client={client}>
        <CreateContext.Provider value={create}>
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
 * through the real renderer against the sample host, which answers the same
 * requests the native host does.
 */
const treeRow = (name: RegExp | string) => screen.getByRole("treeitem", { name });
const filter = () => screen.getByLabelText("Filter files");
const markAs = (label: string) => fireEvent.click(screen.getByRole("tab", { name: label }));

async function openExplorer(repository = /example\/webstore/): Promise<void> {
  await startPlanning(repository);
  fireEvent.click(pane("Explorer"));
  await screen.findByRole("tree", { name: "Tracked files" });
}
/** Narrow the tree to one file and select it, the way a person reaches a nested path. */
async function select(query: string, name: RegExp | string): Promise<void> {
  fireEvent.change(filter(), { target: { value: query } });
  const row = await screen.findByRole("treeitem", { name });
  fireEvent.keyDown(row, { key: "Enter" });
  await waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));
}

describe("clicking away from a planning nothing was put into (D-129)", () => {
  const phaseOf = async (id: string): Promise<string> => (await editingRead(id)).phase;
  /** What Create offers, which is where a planning kept is offered back. */
  async function pickerRows(): Promise<HTMLElement> {
    fireEvent.keyDown(window, { key: "1", code: "Digit1", metaKey: true });
    return await screen.findByRole("dialog", { name: "Plan a piece of work" });
  }
  const offers = (picker: HTMLElement, text: string): boolean =>
    within(picker).getAllByRole("button").some((row) => (row.textContent ?? "").includes(text));

  it("throws it away, so the picker has nothing to offer back", async () => {
    const id = await startPlanning();
    expect(await phaseOf(id)).toBe("editing");
    await goHome();
    await waitFor(async () => expect(await phaseOf(id)).toBe("discarded"));
    expect(offers(await pickerRows(), "Untitled work")).toBe(false);
  });

  it("keeps one that has a title", async () => {
    const id = await startPlanning();
    const title = await screen.findByLabelText("Spec title");
    fireEvent.change(title, { target: { value: "Every export carries its month" } });
    fireEvent.blur(title);
    await waitFor(async () => {
      const specs = (await sampleBridge.request({ kind: "snapshot" })).specs ?? [];
      expect(specs.map((spec) => spec.title)).toContain("Every export carries its month");
    }, { timeout: 5000 });
    await goHome();
    expect(await phaseOf(id)).toBe("editing");
    // Still there to go back to: the row Create offers for a keyless draft.
    expect(offers(await pickerRows(), "draft in progress")).toBe(true);
  });

  it("keeps one whose title is typed and left by a shortcut, unsaved", async () => {
    const id = await startPlanning();
    const title = await screen.findByLabelText("Spec title");
    fireEvent.change(title, { target: { value: "Every refund names its order" } });
    // From inside the field, which never blurs it: the pane's own unmount is
    // what saves the title.
    fireEvent.keyDown(title, { key: "2", code: "Digit2", metaKey: true });
    await screen.findByRole("heading", { name: /Hi, / });
    await settle();
    expect(await phaseOf(id)).toBe("editing");
    const specs = (await sampleBridge.request({ kind: "snapshot" })).specs ?? [];
    expect(specs.map((spec) => spec.title)).toContain("Every refund names its order");
  });

  it("keeps one the person has said something to", async () => {
    // A turn is not an edit — `converse` leaves the revision alone — so this
    // is the case the conversation clause is in the predicate for.
    const opened = await openFresh();
    location.hash = `planning/${opened.id}/graph`;
    mount();
    await screen.findByLabelText("Message the chat");
    fireEvent.change(screen.getByLabelText("Message the chat"), { target: { value: "Can you add a dark mode toggle" } });
    fireEvent.keyDown(screen.getByLabelText("Message the chat"), { key: "Enter" });
    await screen.findByText(/Noted:/);
    await goHome();
    expect(await phaseOf(opened.id)).toBe("editing");
  });

  it("keeps one opened over a ticket that already had a plan", async () => {
    mount();
    const picker = await openPicker();
    // The sample workspace's ticket in plan_review, which the picker lists
    // under Continue planning; its own row rather than the bin on it.
    fireEvent.click(within(picker).getByRole("button", { name: /^Split the settings page into tabs/ }));
    await screen.findByRole("group", { name: "Planning panes" });
    const id = sessionId();
    expect((await editingRead(id)).key).not.toBeNull();
    await goHome();
    expect(await phaseOf(id)).toBe("editing");
  });

  it("is not a move between its own panes", async () => {
    const id = await startPlanning();
    fireEvent.click(pane("Explorer"));
    await screen.findByRole("tree", { name: "Tracked files" });
    fireEvent.click(pane("Impact"));
    fireEvent.click(pane("Spec"));
    await screen.findByLabelText("Spec title");
    await settle();
    expect(await phaseOf(id)).toBe("editing");
    expect(screen.getByRole("group", { name: "Planning panes" })).toBeTruthy();
  });

  it("is not the picker opening over it", async () => {
    const id = await startPlanning();
    expect(offers(await pickerRows(), "Untitled work")).toBe(true);
    await settle();
    expect(await phaseOf(id)).toBe("editing");
  });

  it("is not closing Perbo", async () => {
    const id = await startPlanning();
    restart(`planning/${id}/spec`);
    await screen.findByLabelText("Spec title");
    await settle();
    expect(await phaseOf(id)).toBe("editing");
    expect(screen.queryByText("This planning was discarded")).toBeNull();
    expect(screen.getByLabelText("Spec title")).toBeTruthy();
  });
});

describe("a planning reopens where it was left (D-130)", () => {
  const panes = (): HTMLElement => screen.getByRole("group", { name: "Planning panes" });
  /** The pane the rail marks as the one open. */
  const current = (): string | null =>
    within(panes())
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-current") === "page")
      ?.getAttribute("aria-label") ?? null;
  /**
   * Start one from the picker and title its spec, so leaving it keeps it. The
   * title is saved through the host rather than typed: what these cases are
   * about is the pane, and the Spec pane's own saving has cases of its own.
   */
  async function startTitled(title: string): Promise<string> {
    const id = await startPlanning();
    const { repoId } = await editingRead(id);
    const read = await sampleBridge.request({ kind: "specRead", id });
    await sampleBridge.request({
      kind: "specSave",
      id,
      repoId,
      title,
      sections: read.sections,
      base: { title: read.title, sections: read.sections },
    });
    expect((await editingRead(id)).specSlug).not.toBeNull();
    return id;
  }
  async function toExplorer(id: string): Promise<void> {
    fireEvent.click(pane("Explorer"));
    await screen.findByRole("tree", { name: "Tracked files" });
    await waitFor(async () => expect(await lastPane(id)).toBe("explorer"));
  }
  /** Click the picker's row for a piece of work, by the words on it. */
  async function reopenFromPicker(text: string): Promise<void> {
    fireEvent.keyDown(window, { key: "1", code: "Digit1", metaKey: true });
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    fireEvent.click(
      within(picker).getAllByRole("button").find((row) => (row.textContent ?? "").includes(text))!,
    );
  }

  it("reopens from the picker on the pane it was left at", async () => {
    const id = await startTitled("Every export carries its month");
    await toExplorer(id);
    await goHome();
    // The row Create offers for a keyless draft, which this is the only one of.
    await reopenFromPicker("draft in progress");
    await screen.findByRole("tree", { name: "Tracked files" });
    expect(location.hash).toBe(`#planning/${id}/explorer`);
    expect(current()).toBe("Explorer");
  });

  it("reopens on it after Perbo is closed, from a link that names no pane", async () => {
    const id = await startTitled("Every refund names its order");
    await toExplorer(id);
    restart(`planning/${id}`);
    const entries = history.length;
    await screen.findByRole("tree", { name: "Tracked files" });
    expect(location.hash).toBe(`#planning/${id}/explorer`);
    expect(current()).toBe("Explorer");
    // In place of the link, so Back does not return to it and be sent on again.
    expect(history.length).toBe(entries);
  });

  it("reopens a ticket's planning on it, from the ticket's own link and from the picker", async () => {
    mount();
    const picker = await openPicker();
    fireEvent.click(within(picker).getByRole("button", { name: /^Split the settings page into tabs/ }));
    await screen.findByRole("heading", { name: "Execution graph" });
    const id = sessionId();
    await toExplorer(id);
    await goHome();
    // The ticket's own address would land on its graph, which is where a
    // divided plan belongs; the pane it was left at comes first.
    const session = await editingRead(id);
    location.hash = `task/${session.repoId}/${session.key!}`;
    await waitFor(() => expect(location.hash).toBe(`#planning/${id}/explorer`), { timeout: 5000 });
    await screen.findByRole("tree", { name: "Tracked files" });
    await goHome();
    await reopenFromPicker("Split the settings page into tabs");
    await screen.findByRole("tree", { name: "Tracked files" });
    expect(location.hash).toBe(`#planning/${id}/explorer`);
    // And the contract's way back, which would otherwise be the graph.
    location.hash = `task/${session.repoId}/${session.key!}/contract`;
    fireEvent.click(await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 }));
    await waitFor(() => expect(location.hash).toBe(`#planning/${id}/explorer`));
  });

  it("is not taken for a ticket with no spec and no division, whose own editor goes on to its contract", async () => {
    // A flat plan admitted from a typed draft: its planning has no graph to
    // curate and no spec to read the criteria on, so it is not the planning
    // curating the ticket, and the pane it was left at does not hold the
    // ticket's own page.
    const repoId = (await sampleBridge.request({ kind: "snapshot" })).repositories[0]!.id;
    const outcome = "Every archived order keeps its receipt.";
    const admitted = await sampleBridge.request({
      kind: "admit",
      repoId,
      draft: {
        outcome,
        criteria: [{ text: "Kept", assertion: "An archived order's receipt can be read", kind: "test" }],
        paths: ["src/**"],
        prohibited: [],
      },
    });
    await waitFor(async () =>
      expect(
        (await sampleBridge.request({ kind: "snapshot" })).jobs.find((job) => job.id === admitted.id)?.state,
      ).toBe("completed"),
    );
    const key = (await sampleBridge.request({ kind: "snapshot" })).jobs.find((job) => job.id === admitted.id)!
      .resultKey!;
    mount();
    await screen.findByRole("heading", { name: /Hi, / });
    await reopenFromPicker(outcome);
    await screen.findByRole("heading", { name: "Acceptance criteria" }, { timeout: 5000 });
    const id = sessionId();
    await waitFor(async () => expect(await lastPane(id)).toBe("criteria"));
    const session = await editingRead(id);
    expect([session.key, session.nodes, session.specSlug]).toEqual([key, 0, null]);
    location.hash = `task/${repoId}/${key}/contract`;
    fireEvent.click(await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 }));
    await waitFor(() => expect(location.hash).toBe(`#task/${repoId}/${key}/edit`));
    fireEvent.click(await screen.findByRole("button", { name: "Compile the contract" }, { timeout: 5000 }));
    await waitFor(() => expect(location.hash).toBe(`#task/${repoId}/${key}/auto`), { timeout: 5000 });
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    await settle();
    await new Promise((done) => setTimeout(done, 100));
    expect(location.hash).toBe(`#task/${repoId}/${key}/auto`);
    expect(screen.getByRole("button", { name: "Approve · start the loop" })).toBeTruthy();
  });

  it("is not something put into a planning, so one only looked around in is still thrown away", async () => {
    const id = await startPlanning();
    await toExplorer(id);
    const looked = await editingRead(id);
    expect(looked.revision).toBe(0);
    expect(untouchedPlanning(looked)).toBe(true);
    await goHome();
    await waitFor(async () =>
      expect((await editingRead(id)).phase).toBe("discarded"),
    );
  });

  it("does not take a pane the planning does not offer, reached by an address typed by hand, for where it was left", async () => {
    const id = await startTitled("Every coupon names its expiry");
    await toExplorer(id);
    // A Graph, for a planning with no plan to draw one of.
    location.hash = `planning/${id}/graph`;
    await waitFor(() => expect(screen.queryByRole("tree", { name: "Tracked files" })).toBeNull());
    await settle();
    await new Promise((done) => setTimeout(done, 100));
    expect(await lastPane(id)).toBe("explorer");
  });

  it("opens by the usual rule where the pane it was left at is no longer offered", async () => {
    const id = await startTitled("Every invoice carries its currency");
    // A Graph is offered only for a plan the drafter divided, and this
    // planning has no plan at all.
    await sampleBridge.request({ kind: "editingVisited", id, pane: "graph" });
    await goHome();
    await reopenFromPicker("draft in progress");
    await screen.findByLabelText("Spec title");
    expect(location.hash).toBe(`#planning/${id}/spec`);
    expect(current()).toBe("Spec");
    await sampleBridge.request({ kind: "editingVisited", id, pane: "graph" });
    restart(`planning/${id}`);
    await screen.findByLabelText("Spec title");
    expect(location.hash).toBe(`#planning/${id}/spec`);
  });
});

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
        await sampleBridge.request({ kind: "explorerList", repoId: (await session()).repoId })
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
 * Everything here runs against the sample host, which keeps the sample
 * repository's `specs/` folder where it keeps its editing sessions, and
 * assigns requirement ids with `@perbo/planning`'s own code.
 */
describe("the Spec pane (SCP-336)", () => {
  /**
   * A section's editor, opened first.
   *
   * The pane shows a section as it reads until somebody asks to type in it, so
   * the textarea a test writes into is not on the page until something opens
   * it — which is what a person does by clicking, and what this does too.
   * Re-asked every time rather than held, because leaving a section closes its
   * editor and the next write needs the one that is open now.
   */
  const specField = (label: string): HTMLTextAreaElement => {
    const shown = screen.getByLabelText(label);
    if (shown instanceof HTMLTextAreaElement) return shown;
    fireEvent.mouseDown(shown);
    return screen.getByLabelText(label) as HTMLTextAreaElement;
  };

  const write = async (sections: Record<string, string> & { title: string }): Promise<void> => {
    const title = await screen.findByLabelText("Spec title");
    fireEvent.change(title, { target: { value: sections.title } });
    fireEvent.blur(title);
    for (const [label, value] of Object.entries(sections)) {
      if (label === "title") continue;
      const field = specField(label);
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

  /**
   * The pane's reads of the spec, held until `release`, so what a test types
   * comes first however fast the sample host answers; `direct` is the host
   * itself, past the hold.
   */
  const holdSpecRead = () => {
    const request = sampleBridge.request;
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => (release = done));
    const spy = vi.spyOn(sampleBridge, "request").mockImplementation((async (input: Parameters<typeof request>[0]) => {
      if (input.kind === "specRead") await held;
      return request.call(sampleBridge, input);
    }) as typeof request);
    return { spy, release: () => release(), direct: request.bind(sampleBridge) };
  };

  it("keeps a title typed before the spec's first read lands, and saves it on leaving the field", async () => {
    const { spy, release } = holdSpecRead();
    try {
      const id = await startPlanning();
      const title = screen.getByLabelText("Spec title");
      fireEvent.change(title, { target: { value: "Every receipt names its shop" } });
      release();
      await waitFor(() => expect(spy.mock.calls.some(([input]) => input.kind === "specRead")).toBe(true));
      // The read has landed once the pane's working copy of the file has it;
      // the typed title is still what the field says.
      await waitFor(() => expect(client.getQueryData(["spec", id])).toBeDefined());
      expect((screen.getByLabelText("Spec title") as HTMLInputElement).value).toBe("Every receipt names its shop");
      fireEvent.blur(screen.getByLabelText("Spec title"));
      await waitFor(async () =>
        expect((await sampleBridge.request({ kind: "specRead", id })).title).toBe("Every receipt names its shop"),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps nothing typed over a section before the first read that the file fills, and keeps a title typed where the file has none", async () => {
    const { spy, release, direct } = holdSpecRead();
    try {
      const id = await startPlanning();
      // The file, written before the pane has read it: an Outcome of its own
      // and, its heading taken out by hand outside the app, no title.
      const { repoId } = await direct({ kind: "editingRead", id });
      const outcome = "Every receipt the shop prints names the shop.";
      await direct({
        kind: "specSave",
        id,
        repoId,
        title: "Receipts",
        sections: { ...NOTHING_YET.sections, outcome },
        base: NOTHING_YET,
      });
      const { specSlug } = await direct({ kind: "editingRead", id });
      const files = JSON.parse(localStorage.getItem("perbo:preview-specs")!) as Record<string, string>;
      files[specSlug!] = files[specSlug!]!.replace(/^# Receipts\r?\n/m, "");
      localStorage.setItem("perbo:preview-specs", JSON.stringify(files));
      const file = await direct({ kind: "specRead", id });
      expect(file.title).toBe("");
      expect(file.sections.outcome).toBe(outcome);
      // Typed while the pane's first read is still out.
      fireEvent.change(screen.getByLabelText("Spec title"), { target: { value: "Every receipt names its shop" } });
      fireEvent.change(specField("Spec Outcome"), { target: { value: "Receipts are nicer." } });
      release();
      await waitFor(() => expect(client.getQueryData(["spec", id])).toBeDefined());
      await waitFor(() => expect(specField("Spec Outcome").value).toBe(outcome));
      expect((screen.getByLabelText("Spec title") as HTMLInputElement).value).toBe("Every receipt names its shop");
      fireEvent.blur(screen.getByLabelText("Spec title"));
      await waitFor(async () =>
        expect((await direct({ kind: "specRead", id })).title).toBe("Every receipt names its shop"),
      );
      expect((await direct({ kind: "specRead", id })).sections.outcome).toBe(outcome);
    } finally {
      spy.mockRestore();
    }
  });

  it("saves the spec into the repository and gives each requirement an id", async () => {
    await startPlanning();
    // Before anything is written the pane says where the spec will go.
    expect(screen.getByText("specs/…/spec.md")).toBeTruthy();
    await write(SPEC);

    await screen.findByText("specs/a-light-colour-mode/spec.md");
    // The ids are written into the section they were typed in.
    await waitFor(() => expect(specField("Spec Requirements").value).toContain("R1:"));
    expect(specField("Spec Requirements").value).toContain("R3:");
    // Nothing has been drafted, so no requirement has landed in a node, and the
    // list of where they landed is a column of "none yet" — so it is not there.
    expect(screen.queryByRole("list", { name: "Requirements" })).toBeNull();
  });

  it("keeps a requirement's id when its text is edited, and gives the next one to a new one", async () => {
    await startPlanning();
    await write(SPEC);
    const requirements = specField("Spec Requirements") as HTMLTextAreaElement;
    await waitFor(() => expect(specField("Spec Requirements").value).toContain("R1:"));
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
    // The ids are read where they are written, the list of nodes being absent
    // until there is a plan for a requirement to have landed in.
    await waitFor(() => expect(specField("Spec Requirements").value).toContain("R4:"));
    const after = specField("Spec Requirements")
      .value.split("\n")
      .filter((line) => /R\d+:/.test(line));
    expect(after).toHaveLength(2);
    expect(after[0]).toContain("R1");
    // Its text changed and its id did not. The text is read in the box it is
    // edited in; the list beside it says where each id landed, and saying the
    // sentence twice is what made the pane twice as long as the spec.
    expect(specField("Spec Requirements").value).toContain("R1: A person can choose");
    // R2 and R3 were each used once, so the new requirement is R4.
    expect(after[1]).toContain("R4");
    expect(after.join(" ")).not.toContain("R2:");
    expect(after.join(" ")).not.toContain("R3:");
  });

  it("shows a section as it reads, and opens the editor where it is clicked", async () => {
    await startPlanning();
    await write({
      title: SPEC.title,
      "Spec Requirements": "### The page\n\n- The rail follows the mode.",
    });
    await screen.findByText("specs/a-light-colour-mode/spec.md");

    // The section is not an editor until somebody asks for one.
    const reading = screen.getByLabelText("Spec Requirements");
    expect(reading.tagName).toBe("DIV");
    // The marks the file uses to say a thing are not the thing: the heading is
    // a heading, the requirement's id is beside its line, and neither `###` nor
    // `R1:` is in the words.
    const heading = within(reading).getByText("The page");
    expect(heading.textContent).not.toContain("#");
    await waitFor(() => expect(within(reading).getByText("R1").className).toBe("spec-req-id"));
    const item = within(reading).getByText("The rail follows the mode.");
    expect(item.textContent).not.toContain("R1:");

    // Clicking gives back the editor, with the file's own characters in it.
    fireEvent.mouseDown(reading);
    const editor = screen.getByLabelText("Spec Requirements") as HTMLTextAreaElement;
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toContain("### The page");
    expect(editor.value).toContain("R1:");
    expect(document.activeElement).toBe(editor);

    // And leaving it goes back to reading, without asking for a second save.
    fireEvent.blur(editor);
    await waitFor(() => expect(screen.getByLabelText("Spec Requirements").tagName).toBe("DIV"));
  });

  it("offers Generate plan once the spec has a title and an outcome, not before", async () => {
    await startPlanning();
    const title = await screen.findByLabelText("Spec title");
    fireEvent.change(title, { target: { value: SPEC.title } });
    fireEvent.blur(title);
    await screen.findByText("specs/a-light-colour-mode/spec.md");
    // No foot at all until there is something to draft from: no button, and
    // no sentence standing in for one.
    expect(document.querySelector(".spec-generate")).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate plan" })).toBeNull();
    const outcome = specField("Spec Outcome");
    fireEvent.change(outcome, { target: { value: SPEC["Spec Outcome"] } });
    fireEvent.blur(outcome);
    const generate = (await screen.findByRole("button", { name: "Generate plan" })) as HTMLButtonElement;
    expect(generate.closest(".spec-generate")).not.toBeNull();
    await waitFor(() => expect(generate.disabled).toBe(false));
    expect(within(document.querySelector(".spec-generate") as HTMLElement).getByText(/^Press once/)).toBeTruthy();
  });

  /**
   * SCP-321: the pane completes `@Symbol` from the repository's exported names
   * and marks the ones the index does not hold (D-015). The names come from the
   * host; the sample host answers the same request from the sample
   * repositories' own stand-in index.
   */
  describe("naming code in the spec", () => {
    /** The pane, with the index read and the spec written. */
    const ready = async (): Promise<void> => {
      await startPlanning();
      await write(SPEC);
      // The index reports behind the dot in the pane head.
      await screen.findAllByRole("button", { name: "About the symbol index" });
    };
    const notes = (): HTMLTextAreaElement =>
      specField("Spec Notes") as HTMLTextAreaElement;
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
      // Nothing is said when every name resolves: the absence of the warning
      // below is the answer, and the index's own size is behind the dot.
      expect(screen.queryByText(/name is not|names are not/)).toBeNull();
      expect(screen.getAllByText(/7 exported TypeScript symbols, read at 9f2c1ab/).length)
        .toBeGreaterThan(0);

      type("@signUp and @retryQueue.");
      fireEvent.blur(notes());
      await screen.findByText("1 name is not in the index");
      type("@signUp and @retryQ.");
      fireEvent.blur(notes());
      await screen.findByText("2 names are not in the index");
    });

    it("measures the nearest names once per distinct unknown name, not once per keystroke", async () => {
      await ready();
      const spy = vi.spyOn(planningBrowser, "nearestSymbolNames");
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
      // A repository with nothing to check says so once, behind the dot, and
      // not a second time in the line beside it.
      await screen.findAllByRole("button", { name: "About the symbol index" });
      expect(screen.queryByText(/so no @name is checked/)).toBeNull();
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
      const drafts = (await sampleBridge.request({ kind: "drafts" })) ?? [];
      return drafts[0]!.id;
    };
    /** Another writer — the interview — reading the file and writing one section. */
    const elsewhere = async (over: { outcome?: string; notes?: string }): Promise<void> => {
      const id = await openSession();
      const session = await sampleBridge.request({ kind: "editingRead", id });
      const read = await sampleBridge.request({ kind: "specRead", id });
      const reply = await sampleBridge.request({
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

      const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
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
      const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      const notice = (await screen.findByText(/Nothing was saved/)).closest(
        ".notice",
      ) as HTMLElement;

      fireEvent.click(within(notice).getByRole("button", { name: "Use the file's" }));
      await waitFor(() => expect(specField("Spec Outcome").value).toBe("The interview's sentence."));
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
      const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      await screen.findByText(/Nothing was saved/);

      // Another section left while the refusal stands. Writing it would write
      // the whole spec, and carry the refused Outcome over the interview's.
      const notes = specField("Spec Notes");
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

      const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
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
      await waitFor(() =>
        expect(specField("Spec Notes").value).toBe("Written while the card was open."),
      );

      // The card survived that refetch, with the person's text still in it —
      // not replaced by the further change underneath.
      expect(specField("Spec Outcome").value).toBe("The person's sentence.");
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

      const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      await screen.findByText(/Nothing was saved/);

      // Typed while the card is open, and never committed — `commit` bails
      // while `conflict` is set, so nothing has gone out for it yet.
      const notes = specField("Spec Notes") as HTMLTextAreaElement;
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

      const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
      fireEvent.change(outcome, { target: { value: "The person's sentence." } });
      fireEvent.blur(outcome);
      const notice = (await screen.findByText(/Nothing was saved/)).closest(".notice") as HTMLElement;

      // Settled with nothing else typed: `pending()` finds nothing left to
      // send, so this resolves without a further refusal — the held ref must
      // not survive past this, or it becomes what the next save is read
      // against instead of the file this pane has since followed.
      fireEvent.click(within(notice).getByRole("button", { name: "Use the file's" }));
      await waitFor(() => expect(specField("Spec Outcome").value).toBe("The interview's sentence."));
      expect(screen.queryByText(/Nothing was saved/)).toBeNull();

      // The file moves again, in a section the settled refusal never named.
      await elsewhere({ notes: "Written while the card was open." });
      await client.invalidateQueries({ queryKey: ["spec", sessionId()] });
      const notes = specField("Spec Notes") as HTMLTextAreaElement;
      await waitFor(() => expect(specField("Spec Notes").value).toBe("Written while the card was open."));

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

      const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
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
      await waitFor(() => expect(specField("Spec Outcome").value).toBe("The interview's first sentence."));
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

        const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
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
        await waitFor(() => expect(specField("Spec Outcome").value).toBe("The interview's first sentence."));
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

        const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
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
        const notes = specField("Spec Notes") as HTMLTextAreaElement;
        await waitFor(() => expect(specField("Spec Notes").value).toBe("Written after the errored resend."));

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

      const outcome = specField("Spec Outcome") as HTMLTextAreaElement;
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
      const beforeInterview = await sampleBridge.request({ kind: "specRead", id });
      const interviewReply = await sampleBridge.request({
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
      const requirements = specField("Spec Requirements") as HTMLTextAreaElement;
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

      const after = await sampleBridge.request({ kind: "specRead", id });
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
      const outcome = specField("Spec Outcome");
      fireEvent.change(outcome, { target: { value: "A changed outcome." } });
      watched.hold();
      fireEvent.click(screen.getByRole("button", { name: "Generate plan" }));
      await waitFor(() => expect(watched.events).toContain("specSave:called"));
      // Left while that save is out: it goes before the drafter reads the file.
      const noGos = specField("Spec No-Gos");
      fireEvent.change(noGos, { target: { value: "- Left while the save was out." } });
      fireEvent.blur(noGos);
      watched.let();
      // The drafter divides this spec, so the plan lands on its graph.
      await waitFor(() => expect(location.hash).toMatch(/\/graph$/), { timeout: 5000 });
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

  it("says it is drafting the plan from the press, before the host has answered", async () => {
    await startPlanning();
    await write(SPEC);
    const original = bridge.request.bind(bridge);
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(bridge, "request").mockImplementation((request) =>
      request.kind === "editingSubmit" ? held.then(() => original(request)) : original(request),
    );
    try {
      fireEvent.click(await screen.findByRole("button", { name: "Generate plan" }));
      await waitFor(() => expect(spy.mock.calls.some(([request]) => request.kind === "editingSubmit")).toBe(true));
      // The submission is out and unanswered: the session is not working yet,
      // so the heading comes from what was pressed.
      expect(screen.getByRole("heading", { name: "Drafting the plan from your spec" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Compiling your contract" })).toBeNull();
      release!();
      // The drafter divides this spec, so the plan lands on its graph.
      await waitFor(() => expect(location.hash).toMatch(/\/graph$/), { timeout: 5000 });
    } finally {
      release!();
      spy.mockRestore();
    }
  });

  it("holds Start over while a save is out", async () => {
    await startPlanning();
    await write(SPEC);
    fireEvent.click(await screen.findByRole("button", { name: "Generate plan" }));
    // The drafter divides this spec, so the plan lands on its graph.
    await waitFor(() => expect(location.hash).toMatch(/\/graph$/), { timeout: 5000 });
    const drafts = (await sampleBridge.request({ kind: "drafts" })) ?? [];
    location.hash = `planning/${drafts[0]!.id}/spec`;
    await screen.findByLabelText("Spec title");
    fireEvent.click(await screen.findByRole("button", { name: "Start over from the spec…" }));
    const dialog = await screen.findByRole("dialog", { name: "Start over from the spec?" });
    const startOver = (): HTMLButtonElement => within(dialog).getByRole("button", { name: "Start over" }) as HTMLButtonElement;
    expect(startOver().disabled).toBe(false);
    const watched = watchBridge();
    try {
      watched.hold();
      const notes = specField("Spec Notes");
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
    const outcome = specField("Spec Outcome");
    fireEvent.change(outcome, { target: { value: SPEC["Spec Outcome"] } });
    fireEvent.blur(outcome);
    const requirements = specField("Spec Requirements") as HTMLTextAreaElement;
    fireEvent.change(requirements, {
      target: { value: "- The person can choose Light, Dark or System.\n- Text meets WCAG AA contrast." },
    });
    fireEvent.blur(requirements);

    await screen.findByText("specs/a-light-colour-mode/spec.md");
    await waitFor(() => expect(specField("Spec Requirements").value).toContain("R2:"));
    await screen.findByText("Saved");
    expect(specField("Spec Requirements").value).toContain("- R1: The person can choose Light, Dark or System.");
    expect(specField("Spec Requirements").value).toContain("- R2: Text meets WCAG AA contrast.");
    expect(specField("Spec Requirements").value).not.toContain("R3:");
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
    restart(planning);
    await screen.findByLabelText("Spec title");
    await waitFor(() =>
      expect((specField("Spec Requirements") as HTMLTextAreaElement).value).toContain(
        "written elsewhere",
      ),
    );
  });

  it("generates a plan from the spec, lands on it, and names each requirement's node", async () => {
    await startPlanning();
    await write(SPEC);
    fireEvent.click(await screen.findByRole("button", { name: "Generate plan" }));
    await screen.findByText("Drafting the plan from your spec");
    // It lands on the plan, which is the point of having drafted one: the
    // drafter divides this spec into two nodes, so the plan has a graph and
    // the graph is where the person goes. Work it does not divide lands on the
    // criteria instead, which is that plan's own pane.
    await waitFor(() => expect(location.hash).toMatch(/^#planning\/[^/]+\/graph$/), {
      timeout: 5000,
    });
    await screen.findByRole("button", { name: "Confirm the plan" }, { timeout: 5000 });

    // Back in planning, each requirement carries the node its criteria sit in,
    // beside its own id rather than in a table under the section: the id is the
    // spec's word and the node is the plan's answer to it, read together.
    const drafts = (await sampleBridge.request({ kind: "drafts" })) ?? [];
    const planning = drafts[0]!;
    location.hash = `planning/${planning.id}/spec`;
    await screen.findByLabelText("Spec Requirements", {}, { timeout: 5000 });
    const landed = await waitFor(() => {
      const marks = [...document.querySelectorAll(".spec-req-node")].map(
        (each) => each.textContent ?? "",
      );
      expect(marks.length, "every requirement with a node says which").toBeGreaterThan(0);
      return marks;
    });
    // The node's number alone, beside the requirement's own id: `node_` on
    // every line is a word repeated as often as there are requirements.
    expect(landed).toContain("1");
    expect(landed).toContain("2");
    expect(landed.every((each) => !each.includes("node_"))).toBe(true);
    for (const mark of document.querySelectorAll(".spec-req-node"))
      expect(mark.closest(".spec-req-id"), "inside the requirement's own id chip").toBeTruthy();
  });

  it("asks before starting over from the spec, and re-drafts the same ticket when it is confirmed", async () => {
    await startPlanning();
    await write(SPEC);
    fireEvent.click(await screen.findByRole("button", { name: "Generate plan" }));
    // The drafter divides this spec, so the plan lands on its graph.
    await waitFor(() => expect(location.hash).toMatch(/\/graph$/), { timeout: 5000 });
    const drafts = (await sampleBridge.request({ kind: "drafts" })) ?? [];
    const planning = drafts[0]!;
    const key = planning.key!;
    // The number, not the record: the sample host hands back its live ticket.
    const version = (await sampleBridge.request({ kind: "detail", repoId: planning.repoId, key }))
      .ticket.plan_version;
    location.hash = `planning/${planning.id}/spec`;
    await screen.findByLabelText("Spec title");

    fireEvent.click(await screen.findByRole("button", { name: "Start over from the spec…" }));
    const dialog = await screen.findByRole("dialog", { name: /Start over from the spec/ });
    // Keeping the plan runs nothing at all.
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Start over/ })).toBeNull());
    expect(
      (await sampleBridge.request({ kind: "detail", repoId: planning.repoId, key })).ticket
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
          (await sampleBridge.request({ kind: "detail", repoId: planning.repoId, key })).ticket
            .plan_version,
        ).toBe(version + 1),
      { timeout: 5000 },
    );
    // The same ticket, never a second one.
    const after = await sampleBridge.request({ kind: "snapshot" });
    expect(after.tasks.filter((row) => row.ticket.key === key)).toHaveLength(1);
  });
});

/**
 * SCP-316: the Graph pane curates the plan and approves it once (D-100,
 * D-101, D-104). Driven through the real renderer against the sample host,
 * which applies the same `GraphEditSchema` operations the CLI applies.
 */
describe("the Graph pane (SCP-316)", () => {
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
  async function planned(title = "A light colour mode"): Promise<{ id: string; repoId: string; key: string }> {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const repoId = workspace.repositories[0]!.id;
    const opened = await sampleBridge.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId },
    });
    await sampleBridge.request({
      kind: "specSave",
      id: opened.id,
      repoId,
      title,
      sections: SECTIONS,
      base: NOTHING_YET,
    });
    const current = await sampleBridge.request({ kind: "editingRead", id: opened.id });
    await sampleBridge.request({
      kind: "editingSubmit",
      id: opened.id,
      revision: current.revision,
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
    sampleBridge.request({ kind: "graphRead", repoId: plan.repoId, key: plan.key });

  it("confirms the plan on the fixed binding, and approval waits for the contract", async () => {
    const plan = await openGraph();
    const detail = () => sampleBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key });
    expect((await detail()).ticket.approved_at).toBeNull();
    // The graph says the division is right; what freezes is stated on the
    // contract, so that is where approving happens and nowhere else.
    expect(screen.getByRole("button", { name: "Confirm the plan" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
    // ⇧⌘↵, which is fixed and cannot be rebound.
    expect(effectiveShortcuts({}).approve).toBe("Shift+Meta+Enter");
    fireEvent.keyDown(window, { key: "Enter", metaKey: true, shiftKey: true });
    // By way of the plan read against its spec, which the shortcut cannot
    // skip; a plan just drafted agrees with its spec, so the reading lands on
    // the contract by itself.
    await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
    await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/), { timeout: 5000 });
    // Nothing is approved and nothing runs until it is approved there.
    expect((await detail()).ticket.approved_at).toBeNull();
    // Scoped to this plan: the sample workspace carries a stopped run of its
    // own, and a check that reads every row in the journal reports on somebody
    // else's work rather than on the plan under test.
    expect(
      (await sampleBridge.request({ kind: "snapshot" })).jobs.some(
        (job) => job.kind === "run" && (job.key === plan.key || job.resultKey === plan.key),
      ),
    ).toBe(false);
  });

  it("confirms the plan with the button by the same way", async () => {
    const plan = await openGraph();
    fireEvent.click(screen.getByRole("button", { name: "Confirm the plan" }));
    await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
  });

  it("makes its footer as tall as the chat's box and the space beneath it, so their tops are level", async () => {
    await openGraph();
    const footer = screen.getByRole("button", { name: "Confirm the plan" }).closest(".approve-bar");
    expect(footer).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Message the chat" }).closest(".composer-box")).not.toBeNull();
    const css = stylesheet();
    /** Every rule with exactly this selector, together: `textarea` has two. */
    const rule = (selector: string): string => {
      const blocks = css.split(`\n${selector} {`).slice(1);
      expect(blocks.length, selector).toBeGreaterThan(0);
      return blocks.map((block) => block.slice(0, block.indexOf("}"))).join("\n");
    };
    const px = (declarations: string, property: string): number[] => {
      const found = new RegExp(`\\n\\s*${property}: ([^;]+);`).exec(declarations);
      expect(found, property).not.toBeNull();
      return found![1]!.split(" ").map((part) => Number.parseFloat(part));
    };
    // The box the textarea sits in: its textarea's floor, its own padding
    // above and below, and its rim on both edges; then the composer's padding
    // beneath the box, down to the dock's bottom, which is the pane's.
    const box = rule(".composer-box");
    const [padTop, , padBottom] = px(box, "padding");
    const [rim] = px(box, "border");
    const [textarea] = px(rule("textarea"), "min-height");
    const [, , beneath] = px(rule(".composer"), "padding");
    const bar = rule(".approve-bar");
    expect(px(bar, "min-height")).toEqual([textarea! + padTop! + padBottom! + 2 * rim! + beneath!]);
    expect(bar).toContain("align-items: center;");
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

  it("closes the size popover by its Close at the right edge or by a press outside it, not inside it", async () => {
    await openGraph();
    const trigger = screen.getByRole("button", { name: /^Size \w+: how it is worked out$/ });
    const popover = () => screen.queryByRole("dialog", { name: "How the size is worked out" });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    const pop = popover()!;
    expect(pop).not.toBeNull();
    // Close is the last thing in the panel, alone in a row pushed to its right edge.
    const close = within(pop).getByRole("button", { name: "Close" });
    const foot = close.parentElement!;
    expect(foot.className).toBe("graph-pop-foot");
    expect(foot.lastElementChild).toBe(close);
    expect(pop.lastElementChild).toBe(foot);
    const rule = cssRule(".graph-pop-foot");
    expect(rule).toContain("display: flex;");
    expect(rule).toContain("justify-content: flex-end;");
    // The button's own press is inside, so its click shuts it.
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(popover()).toBeNull();
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    // A press inside the panel leaves it open.
    fireEvent.mouseDown(popover()!.querySelector("table")!);
    expect(popover()).not.toBeNull();
    // A press outside it shuts it.
    fireEvent.mouseDown(canvas());
    await waitFor(() => expect(popover()).toBeNull());
    // Close still shuts it.
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(within(popover()!).getByRole("button", { name: "Close" }));
    expect(popover()).toBeNull();
  });

  it("holds how to work the canvas behind an i in the header, which a press outside or Close shuts", async () => {
    await openGraph();
    const hint = "shift-click two to merge · drag from ○ for an edge · drag the canvas to pan";
    const tools = document.querySelector(".graph-tools")!.parentElement!;
    expect(tools.textContent).not.toContain(hint);
    const dot = screen.getByRole("button", { name: "How to work the canvas" });
    expect(dot.className).toBe("info-hint-dot");
    const popover = () => screen.queryByRole("dialog", { name: "How to work the canvas" });
    expect(popover()).toBeNull();
    fireEvent.mouseDown(dot);
    fireEvent.click(dot);
    const pop = popover()!;
    expect(pop.textContent).toContain(hint);
    const close = within(pop).getByRole("button", { name: "Close" });
    expect(close.parentElement!.className).toBe("graph-pop-foot");
    expect(pop.lastElementChild).toBe(close.parentElement);
    fireEvent.mouseDown(pop);
    expect(popover()).not.toBeNull();
    fireEvent.mouseDown(canvas());
    await waitFor(() => expect(popover()).toBeNull());
    fireEvent.mouseDown(dot);
    fireEvent.click(dot);
    fireEvent.click(within(popover()!).getByRole("button", { name: "Close" }));
    expect(popover()).toBeNull();
  });

  it("says how many nodes are selected in place of the canvas's i", async () => {
    await openGraph();
    fireEvent.click(nodeAt(/^Node node_1/), { shiftKey: true });
    fireEvent.click(nodeAt(/^Node node_2/), { shiftKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "How to work the canvas" })).toBeNull();
  });

  it("keeps an i's panel inside the window when a transformed page frame holds it", async () => {
    await openGraph();
    const dot = screen.getByRole("button", { name: "What this session may do" });
    const body = document.getElementById(dot.getAttribute("aria-describedby")!)!;
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
    // The page frame's entrance animation leaves it a containing block, so a
    // fixed panel's `left` and `top` count from the frame's corner.
    const frame = { left: 66, top: 48 };
    const window1024 = { innerWidth: 1024, innerHeight: 768 };
    const kept = Object.fromEntries(
      Object.keys(window1024).map((key) => [key, Object.getOwnPropertyDescriptor(window, key)]),
    );
    for (const [key, value] of Object.entries(window1024))
      Object.defineProperty(window, key, { value, configurable: true });
    const measured = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        // Past the window's right margin and too low for the panel below it.
        if (this === dot) return rect(1005, 740, 15, 15);
        if (this === body)
          return rect(
            frame.left + (parseFloat(this.style.left) || 0),
            frame.top + (parseFloat(this.style.top) || 0),
            parseFloat(this.style.width) || 360,
            77,
          );
        return rect(0, 0, 0, 0);
      });
    try {
      fireEvent.click(dot);
      await waitFor(() => expect(body.className).toContain("info-hint-body--open"));
      const drawn = body.getBoundingClientRect();
      // Held at the window's 8px margin, not the dot's right edge past it, and
      // opened upwards: 740 - 6 - 77.
      expect(drawn.right).toBe(1024 - 8);
      expect(drawn.left).toBe(1024 - 8 - 360);
      expect(drawn.top).toBe(657);
    } finally {
      measured.mockRestore();
      for (const [key, descriptor] of Object.entries(kept))
        if (descriptor) Object.defineProperty(window, key, descriptor);
    }
  });

  it("pans by dragging the empty canvas and by scrolling, and not by dragging a node", async () => {
    await openGraph();
    expect(layer().style.transform).toBe("translate(0px, 0px) scale(1)");
    fireEvent.mouseDown(canvas(), { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(window, { clientX: 260, clientY: 190 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(layer().style.transform).toBe("translate(60px, 40px) scale(1)"));

    fireEvent.wheel(canvas(), { deltaX: 10, deltaY: 20 });
    await waitFor(() => expect(layer().style.transform).toBe("translate(50px, 20px) scale(1)"));

    const held = layer().style.transform;
    fireEvent.mouseDown(nodeAt(/^Node node_1/), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(window);
    expect(layer().style.transform).toBe(held);
  });

  describe("the inspector beside the node card", () => {
    it("holds the controls, and no read-only column repeating what the card reads out", async () => {
      const plan = await openGraph();
      const card = nodeAt(/^Node node_1/);
      fireEvent.click(card);
      const inspector = await screen.findByRole("region", { name: "Node node_1" });
      const node = (await graphOf(plan)).nodes.find((each) => each.id === "node_1")!;
      // The card reads out the title and each criterion and how it is proven;
      // the paths are the inspector's alone.
      expect(card.textContent).toContain(node.title);
      for (const criterion of node.criteria) {
        expect(card.textContent).toContain(criterion.text);
        expect(card.textContent).toContain(criterion.kind);
      }
      expect(node.paths.length).toBeGreaterThan(0);
      for (const path of node.paths) {
        expect(card.textContent).not.toContain(path);
        expect(inspector.textContent).toContain(path);
      }
      // The inspector keeps what changes them.
      expect(within(inspector).getByLabelText("Criterion ac_1")).toBeTruthy();
      expect(within(inspector).getByLabelText("Add a path or glob")).toBeTruthy();
      expect(within(inspector).getByLabelText("Add a node this one comes after")).toBeTruthy();
      expect(within(inspector).getByLabelText("Add a node this one comes before")).toBeTruthy();
      // And nothing that only reads them out again: of the node's page, the Notes alone.
      expect(inspector.textContent).not.toContain("## Requirements");
      expect(inspector.textContent).not.toContain("## Criteria");
    });
  });

  describe("the inspector's Notes (D-103)", () => {
    const NOTES = "Ask Dana which tokens the terminal palette may reuse.\n\nKeep the contrast script.";

    it("shows the Notes a person wrote on the node's page, and none of the page's generated part", async () => {
      const plan = await planned();
      const view = await graphOf(plan);
      const sample = view.nodes.find((each) => each.id === "node_1")!;
      // The page as the host reads it back once a person has written under Notes.
      const node = { ...sample, page: { path: sample.page!.path, text: `${sample.page!.text}${NOTES}\n` } };
      expect(node.page.text).toContain("## Requirements");
      render(
        <GraphInspector
          view={view}
          node={node}
          changes={null}
          live={undefined}
          busy={false}
          apply={() => undefined}
          onSplit={() => undefined}
          onClose={() => undefined}
        />,
      );
      const inspector = screen.getByRole("region", { name: "Node node_1" });
      const notes = within(inspector).getByLabelText(`Notes in ${node.page.path}`);
      expect(notes.textContent).toBe(NOTES);
      expect(inspector.textContent).toMatch(/Notes\s*read-only/);
      for (const heading of ["## Requirements", "## Criteria", "## Paths", "## No-Gos", "Generated from"])
        expect(inspector.textContent).not.toContain(heading);
    });

    it("says a page with no notes has none yet, and where the file is", async () => {
      const plan = await openGraph();
      fireEvent.click(nodeAt(/^Node node_1/));
      const inspector = await screen.findByRole("region", { name: "Node node_1" });
      const path = (await graphOf(plan)).nodes.find((each) => each.id === "node_1")!.page!.path;
      expect(path).toMatch(/^specs\/.+\/nodes\/node_1\.md$/);
      expect(inspector.textContent).toContain(`No notes yet. Write them under Notes in ${path}.`);
      expect(inspector.querySelector("pre")).toBeNull();
    });
  });

  describe("the inspector's two halves, its add chips and its dismissable errors", () => {
    const labels = (element: Element): string[] =>
      [...element.querySelectorAll(".section-label")].map((label) =>
        (label.firstChild?.textContent ?? "").trim(),
      );

    it("puts the criteria in one half, scrolling, and the order, the paths and the Notes in one block in the other", async () => {
      await openGraph();
      fireEvent.click(nodeAt(/^Node node_1/));
      const inspector = await screen.findByRole("region", { name: "Node node_1" });
      const body = inspector.querySelector(".insp-body")!;
      expect([...body.children].map((child) => child.className)).toEqual(["insp-main", "insp-block"]);
      const [criteria, block] = [...body.children] as [HTMLElement, HTMLElement];
      expect(within(criteria).getByLabelText("Criterion ac_1")).toBeTruthy();
      expect(within(criteria).queryByLabelText("Add a path or glob")).toBeNull();
      // Top to bottom: after and before side by side, then the paths, then the Notes.
      expect([...block.children].slice(0, 3).map((child) => child.className)).toEqual([
        "insp-order",
        "insp-paths",
        "insp-notes",
      ]);
      expect(labels(block.querySelector(".insp-order")!)).toEqual(["Comes after", "Comes before"]);
      expect(labels(block)).toEqual([
        "Comes after",
        "Comes before",
        "Paths expected to satisfy them",
        "Notes",
      ]);
      // Five and five; the criteria scroll and the block does not go with them.
      expect(cssRule(".insp-body")).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);");
      expect(cssRule(".insp-body")).not.toMatch(/overflow/);
      expect(cssRule(".insp-main,\n.insp-block")).toContain("overflow-y: auto;");
      expect(cssRule(".insp-order")).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);");
    });

    it("adds a path from its chip, and the new bubble lands before the chip", async () => {
      const plan = await openGraph();
      fireEvent.click(nodeAt(/^Node node_1/));
      const inspector = await screen.findByRole("region", { name: "Node node_1" });
      const row = () => inspector.querySelector(".insp-paths .path-chips")!;
      const chip = within(inspector).getByRole("button", { name: "Add a path or glob" });
      expect(chip.textContent).toBe("+ path");
      expect(row().lastElementChild).toBe(chip);
      expect(inspector.querySelector("input")).toBeNull();
      fireEvent.click(chip);
      const entry = within(inspector).getByRole("combobox", { name: "Add a path or glob" });
      expect(document.activeElement).toBe(entry);
      fireEvent.change(entry, { target: { value: "packages/auth/test/**" } });
      fireEvent.keyDown(entry, { key: "Enter" });
      await waitFor(async () =>
        expect((await graphOf(plan)).nodes.find((each) => each.id === "node_1")!.paths).toContain(
          "packages/auth/test/**",
        ),
      );
      await waitFor(() => expect(row().textContent).toContain("packages/auth/test/**"));
      const bubbles = [...row().children];
      expect(bubbles.at(-1)!.textContent).toBe("+ path");
      expect(bubbles.at(-2)!.textContent).toContain("packages/auth/test/**");
    });

    it("puts the path chip back on Escape, and on leaving its box empty", async () => {
      await openGraph();
      fireEvent.click(nodeAt(/^Node node_1/));
      const inspector = await screen.findByRole("region", { name: "Node node_1" });
      const open = (): HTMLElement => {
        fireEvent.click(within(inspector).getByRole("button", { name: "Add a path or glob" }));
        return within(inspector).getByRole("combobox", { name: "Add a path or glob" });
      };
      // Escape drops the box whatever is typed in it.
      const typed = open();
      fireEvent.change(typed, { target: { value: "packages/auth/test/**" } });
      fireEvent.keyDown(typed, { key: "Escape" });
      expect(within(inspector).getByRole("button", { name: "Add a path or glob" }).textContent).toBe("+ path");
      expect(within(inspector).queryByRole("combobox", { name: "Add a path or glob" })).toBeNull();
      // Leaving it with nothing in it drops it too.
      fireEvent.blur(open());
      expect(within(inspector).getByRole("button", { name: "Add a path or glob" }).textContent).toBe("+ path");
      expect(within(inspector).queryByRole("combobox", { name: "Add a path or glob" })).toBeNull();
    });

    it("adds an edge from its chip, the dropdown of nodes, and the new bubble lands before it", async () => {
      const plan = await openGraph();
      fireEvent.click(nodeAt(/^Node node_1/));
      const inspector = await screen.findByRole("region", { name: "Node node_1" });
      const [afterRow, beforeRow] = [...inspector.querySelectorAll(".insp-order .path-chips")] as [
        HTMLElement,
        HTMLElement,
      ];
      const chip = within(inspector).getByLabelText("Add a node this one comes before");
      expect(beforeRow.lastElementChild).toBe(chip);
      expect(afterRow.lastElementChild).toBe(within(inspector).getByLabelText("Add a node this one comes after"));
      expect((chip as HTMLSelectElement).options[0]!.textContent).toBe("+ before");
      expect((afterRow.lastElementChild as HTMLSelectElement).options[0]!.textContent).toBe("+ after");
      fireEvent.click(within(inspector).getByRole("button", { name: "Remove the edge node_1 to node_2" }));
      await waitFor(() => expect(beforeRow.children).toHaveLength(1));
      fireEvent.change(chip, { target: { value: "node_2" } });
      await waitFor(async () =>
        expect((await graphOf(plan)).edges).toEqual([{ from: "node_1", to: "node_2" }]),
      );
      await waitFor(() => expect(beforeRow.children).toHaveLength(2));
      expect(beforeRow.firstElementChild!.textContent).toContain("node_2");
      expect(beforeRow.lastElementChild).toBe(chip);
    });

    it("takes a red error off the screen with its ×, and shows the next one", async () => {
      await openGraph();
      fireEvent.click(nodeAt(/^Node node_2/));
      const inspector = await screen.findByRole("region", { name: "Node node_2" });
      // node_1 already comes before node_2, so a second edge is refused.
      const duplicate = (): void => {
        fireEvent.change(within(inspector).getByLabelText("Add a node this one comes after"), {
          target: { value: "node_1" },
        });
      };
      duplicate();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("duplicate edge");
      fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      duplicate();
      expect((await screen.findByRole("alert")).textContent).toContain("duplicate edge");
    });

    it("gives only a red notice a ×", async () => {
      const { Notice } = await import("../ui/index.js");
      render(
        <>
          <Notice>A warning.</Notice>
          <Notice tone="success">Done.</Notice>
          <Notice tone="danger">It failed.</Notice>
        </>,
      );
      expect(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss" })).toBeTruthy();
      for (const status of screen.getAllByRole("status"))
        expect(within(status).queryByRole("button", { name: "Dismiss" })).toBeNull();
    });

    it("brings a dismissed error back when the page shows a different one", async () => {
      const { Notice } = await import("../ui/index.js");
      const { rerender } = render(<Notice tone="danger">The first refusal.</Notice>);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("alert")).toBeNull();
      rerender(<Notice tone="danger">The first refusal.</Notice>);
      expect(screen.queryByRole("alert")).toBeNull();
      rerender(<Notice tone="danger">The second refusal.</Notice>);
      expect(screen.getByRole("alert").textContent).toContain("The second refusal.");
    });

    it("keeps a criterion's first letter inside its box, lined up with the kind buttons", () => {
      // A textarea clips at its padding edge, so with no inline padding the
      // first letter loses its left edge; the padding is given back as a
      // negative margin so the words do not move. The chat's box is the same
      // cause, and takes the same rule.
      const textarea = cssRule(".crit-edit textarea,\n.composer-box textarea");
      expect(textarea).toContain("padding-inline: 4px;");
      expect(textarea).toContain("margin-inline: -4px;");
      expect(textarea).toContain("width: calc(100% + 8px);");
      expect(cssRule(".crit-edit textarea")).not.toMatch(/padding: |margin|width/);
    });
  });

  describe("zooming the canvas", () => {
    /** The layer's pan offset and scale, as its transform states them. */
    const placed = (): { x: number; y: number; scale: number } => {
      const match = /^translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\) scale\(([\d.e+-]+)\)$/.exec(
        layer().style.transform,
      );
      expect(match).not.toBeNull();
      return { x: Number(match![1]), y: Number(match![2]), scale: Number(match![3]) };
    };
    /** A trackpad pinch at the frame's corner, as that many wheel events with `ctrlKey` set. */
    const pinch = (deltaY: number, times = 1): void => {
      for (let i = 0; i < times; i += 1) fireEvent.wheel(canvas(), { ctrlKey: true, deltaY, clientX: 0, clientY: 0 });
    };

    it("zooms in on a pinch outward and out on a pinch inward, and stops at 0.5× and 2.5×", async () => {
      await openGraph();
      expect(placed().scale).toBe(1);
      pinch(-10);
      await waitFor(() => expect(placed().scale).toBeGreaterThan(1));
      const first = placed().scale;
      pinch(10);
      await waitFor(() => expect(placed().scale).toBeLessThan(first));
      pinch(-100, 40);
      await waitFor(() => expect(placed().scale).toBe(2.5));
      pinch(100, 80);
      await waitFor(() => expect(placed().scale).toBe(0.5));
    });

    it("zooms by the scroll wheel with ⌘ held, keeps plain scrolling a pan, and holds the point under the pointer", async () => {
      await openGraph();
      const wheel = new WheelEvent("wheel", { deltaY: -100, clientX: 120, clientY: 80, metaKey: true, cancelable: true });
      canvas().dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
      await waitFor(() => expect(placed().scale).toBeGreaterThan(1));
      const zoomed = placed();
      // The layer point that was under the pointer at 1× is under it still.
      expect((120 - zoomed.x) / zoomed.scale).toBeCloseTo(120, 6);
      expect((80 - zoomed.y) / zoomed.scale).toBeCloseTo(80, 6);

      fireEvent.wheel(canvas(), { deltaX: 10, deltaY: 20 });
      await waitFor(() => expect(placed().y).toBeCloseTo(zoomed.y - 20, 6));
      expect(placed().x).toBeCloseTo(zoomed.x - 10, 6);
      expect(placed().scale).toBe(zoomed.scale);

      // From a pan and a zoom already off 1×, a second zoom holds its own point too.
      const before = placed();
      fireEvent.wheel(canvas(), { metaKey: true, deltaY: -100, clientX: 300, clientY: 200 });
      await waitFor(() => expect(placed().scale).toBeGreaterThan(before.scale));
      const after = placed();
      expect((300 - after.x) / after.scale).toBeCloseTo((300 - before.x) / before.scale, 6);
      expect((200 - after.y) / after.scale).toBeCloseTo((200 - before.y) / before.scale, 6);
    });

    it("draws an edge to the pointer in the layer's own coordinates while zoomed", async () => {
      await openGraph();
      pinch(-100, 40);
      await waitFor(() => expect(placed().scale).toBe(2.5));
      const handle = nodeAt(/^Node node_1/).querySelector(".handle") as HTMLElement;
      fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(window, { clientX: 250, clientY: 125 });
      await waitFor(() =>
        expect(document.querySelector("path.edge.temp")?.getAttribute("d")).toMatch(/ L100,50$/),
      );
      // jsdom does no hit-testing; dropping over nothing draws no edge.
      Object.defineProperty(document, "elementFromPoint", { value: () => null, configurable: true });
      try {
        fireEvent.mouseUp(window);
      } finally {
        delete (document as { elementFromPoint?: unknown }).elementFromPoint;
      }
      await waitFor(() => expect(document.querySelector("path.edge.temp")).toBeNull());
    });
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
    await sampleBridge.request({
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
      (await sampleBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key })).ticket
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
      within(picker).getByRole("button", { name: /^Split the settings page into tabs/ }),
    );
    await screen.findByRole("heading", { name: "Execution graph" });
    expect(location.hash).toMatch(/^#planning\/.*\/graph$/);
    expect(await screen.findByRole("button", { name: /^Node node_1/ })).toBeTruthy();
    expect(pane("Graph").getAttribute("aria-current")).toBe("page");
  });

  it("holds the way onward while the interview is still taking a turn", async () => {
    // What approving freezes is what the contract holds when it is read
    // (ADR-0016), and a turn in flight may still be moving the plan — a
    // criterion, a node, the outcome. Settling it now settles the half of it
    // that has landed, so the way onward waits, and says it is waiting rather
    // than going quiet.
    const plan = await planned();
    location.hash = `planning/${plan.id}/graph`;
    mount();
    const onward = await screen.findByRole("button", { name: "Confirm the plan" });
    expect(onward.hasAttribute("disabled"), "nothing in flight, nothing to wait for").toBe(false);

    await sampleBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
    await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: "what is this for?" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Confirm the plan" }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(screen.getByText("Waiting for the chat to finish this turn…")).toBeTruthy();

    // And it comes back once the turn is over, rather than staying shut.
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: "Confirm the plan" }).hasAttribute("disabled"),
        ).toBe(false),
      { timeout: 5000 },
    );
  });

  it("calls a drafted sample ticket by its spec's title, and an edit to its graph does not rename it", async () => {
    // The sample has no drafter, so its ticket takes what `admit` falls back
    // to, and keeps it through every edit (D-127).
    // A title no other ticket carries, since the plans above are called theirs.
    const plan = await planned("A high-contrast colour mode");
    const title = async () =>
      (await sampleBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key })).ticket.title;
    expect(await title()).toBe("A high-contrast colour mode");
    await sampleBridge.request({
      kind: "graphEdit",
      repoId: plan.repoId,
      key: plan.key,
      edit: { op: "delete_node", id: "node_2", move_criteria_to: "node_1", delete_criteria: [] },
    });
    await waitFor(async () => expect((await graphOf(plan)).nodes).toHaveLength(1));
    expect(await title()).toBe("A high-contrast colour mode");
  });

  it("confirms a flat plan, which has criteria and no graph to curate", async () => {
    const plan = await planned();
    const edit = async (edit: GraphEdit) =>
      sampleBridge.request({ kind: "graphEdit", repoId: plan.repoId, key: plan.key, edit });
    await edit({ op: "delete_node", id: "node_2", move_criteria_to: "node_1", delete_criteria: [] });
    await waitFor(async () => expect((await graphOf(plan)).nodes).toHaveLength(1));
    await edit({ op: "delete_node", id: "node_1", move_criteria_to: null, delete_criteria: [] });
    await waitFor(async () => expect((await graphOf(plan)).nodes).toHaveLength(0));
    expect((await graphOf(plan)).criteria.length).toBeGreaterThan(0);
    location.hash = `planning/${plan.id}/criteria`;
    mount();
    // Work with nothing to divide has no graph to curate, so its plan is the
    // criteria it will be judged against, and that is the pane the rail
    // offers. The Graph is not among them.
    await screen.findByRole("heading", { name: "Acceptance criteria" }, { timeout: 5000 });
    const panes = screen.getByRole("group", { name: "Planning panes" });
    await waitFor(() => expect(within(panes).getByRole("button", { name: "Plan" })).toBeTruthy());
    expect(within(panes).queryByRole("button", { name: "Graph" })).toBeNull();

    const detail = () => sampleBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key });
    expect((await detail()).ticket.approved_at).toBeNull();
    // And the way onward is the same: the contract is where what freezes is
    // stated, whether or not the work was divided, and approving happens
    // there and nowhere else.
    const next = await screen.findByRole("button", { name: "Next" });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);
    // By way of the plan read against its spec: nothing here moved a
    // promise, so the reading it was drafted with holds and lands on the
    // contract by itself.
    await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
    await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/), { timeout: 5000 });
    expect((await detail()).ticket.approved_at).toBeNull();
  });

  it("reopens from the picker on the contract it was left at, whose way back is the Graph it was confirmed from, not the reading on the way (D-130)", async () => {
    const plan = await openGraph();
    await waitFor(async () => expect(await lastPane(plan.id)).toBe("graph"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm the plan" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm the plan" }));
    await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
    await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/), { timeout: 5000 });
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    await waitFor(async () => expect((await editingRead(plan.id)).lastView).toBe("contract"));
    expect(await lastPane(plan.id)).toBe("graph");
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByRole("heading", { name: /Hi, / });
    const picker = await openPicker();
    const { title } = (await sampleBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key })).ticket;
    fireEvent.click(within(picker).getByRole("button", { name: (name) => name.startsWith(title) }));
    await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
    expect(location.hash).toMatch(/^#task\//);
    fireEvent.click(screen.getByRole("button", { name: "Back to planning" }));
    await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/graph`), { timeout: 5000 });
    await screen.findByRole("heading", { name: "Execution graph" });
    // Back on the Graph, that is where it was left: the ticket's own page
    // sends the person there again, not to the contract.
    await waitFor(async () => expect((await editingRead(plan.id)).lastView).toBeNull());
    location.hash = ["task", plan.repoId, plan.key].join("/");
    await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/graph`), { timeout: 5000 });
    await screen.findByRole("heading", { name: "Execution graph" });
  });

  describe("the plan read against the spec (D-128)", () => {
    /**
     * That planning, with two criteria reworded by hand, which is the one way
     * the plan and the spec can part: the chat's edits are held to the spec.
     */
    async function parted(): Promise<{ id: string; repoId: string; key: string }> {
      const plan = await planned();
      for (const [id, text] of [
        ["ac_1", "The person can choose Light or Dark, after a restart."],
        ["ac_2", "Text meets WCAG AAA contrast against its background."],
      ] as const)
        await sampleBridge.request({
          kind: "graphEdit",
          repoId: plan.repoId,
          key: plan.key,
          edit: { op: "set_criterion", id, text, expected_verification: { kind: "test", assertion: text } },
        });
      await waitFor(async () =>
        expect((await graphOf(plan)).criteria.find((each) => each.id === "ac_2")?.text).toMatch(/AAA/),
      );
      return plan;
    }
    /** That planning open on the Problems pane, with the first problem in front of the person. */
    async function problems(): Promise<{ id: string; repoId: string; key: string }> {
      const plan = await parted();
      location.hash = `planning/${plan.id}/drift`;
      mount();
      await screen.findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
      return plan;
    }
    const cards = () => screen.queryAllByRole("group", { name: /Criterion \d and R\d/ });
    const railPanes = (): string[] =>
      within(screen.getByRole("group", { name: "Planning panes" }))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
    /** The option's own sentence, which is what answering with it sends. */
    const REWORD_1 =
      "Reword criterion 1 to say: The person can choose Light, Dark or System without a restart.";
    /** The first answer on a card, which is the reading's recommendation, sent. */
    const answerFirst = (card: HTMLElement) => {
      fireEvent.click(within(card).getAllByRole("radio")[0]!);
      sendGroup(card);
    };

    /** That planning, confirmed from its Graph and held on the Problems page with the first problem up. */
    async function confirmedIntoProblems(): Promise<{ id: string; repoId: string; key: string }> {
      const plan = await parted();
      location.hash = `planning/${plan.id}/graph`;
      mount();
      await screen.findByRole("heading", { name: "Execution graph" });
      await waitFor(async () => expect(await lastPane(plan.id)).toBe("graph"));
      fireEvent.click(screen.getByRole("button", { name: "Confirm the plan" }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
      await screen.findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
      return plan;
    }

    it("goes Back to planning from the contract to the plan, not to the reading, after a resolved round (D-130)", async () => {
      const plan = await confirmedIntoProblems();
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      answerFirst(await screen.findByRole("group", { name: "Criterion 2 and R2" }, { timeout: 5000 }));
      await screen.findByRole("heading", { name: "Every problem is resolved" }, { timeout: 5000 });
      fireEvent.click(screen.getByRole("button", { name: "Confirm the plan" }));
      await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/), { timeout: 5000 });
      expect(await lastPane(plan.id)).toBe("graph");
      fireEvent.click(await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/graph`));
      await screen.findByRole("heading", { name: "Execution graph" });
    });

    it("goes Back to planning from the contract to the pane the plan was confirmed from, where that is not the plan's own (D-130)", async () => {
      const plan = await problems();
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      answerFirst(await screen.findByRole("group", { name: "Criterion 2 and R2" }, { timeout: 5000 }));
      await screen.findByRole("heading", { name: "Every problem is resolved" }, { timeout: 5000 });
      location.hash = `planning/${plan.id}/explorer`;
      await screen.findByRole("tree", { name: "Tracked files" });
      await waitFor(async () => expect(await lastPane(plan.id)).toBe("explorer"));
      const dock = screen.getByRole("complementary", { name: "Chat" });
      const note = await within(dock).findByText(/^Every problem is resolved/);
      fireEvent.click(within(note).getByRole("button", { name: "Confirm the plan" }));
      await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/), { timeout: 5000 });
      // The plan's own pane is the Graph, so landing there would be the
      // fallback and not where the planning was left.
      fireEvent.click(await screen.findByRole("button", { name: "Back to planning" }, { timeout: 5000 }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/explorer`));
      await screen.findByRole("tree", { name: "Tracked files" });
    });

    it("reopens on the Problems page while problems are open, by that rule and not by a record of the page (D-130)", async () => {
      const plan = await confirmedIntoProblems();
      fireEvent.click(screen.getByRole("button", { name: "Home" }));
      await screen.findByRole("heading", { name: /Hi, / });
      expect(await lastPane(plan.id)).toBe("graph");
      const picker = await openPicker();
      const { title } = (await sampleBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key })).ticket;
      fireEvent.click(within(picker).getByRole("button", { name: (name) => name.startsWith(title) }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`), { timeout: 5000 });
      await screen.findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
      expect(await lastPane(plan.id)).not.toBe("drift");
      // The ticket's own page lands by the same rule.
      location.hash = "home";
      await screen.findByRole("heading", { name: /Hi, / });
      location.hash = `task/${plan.repoId}/${plan.key}`;
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`), { timeout: 5000 });
      await screen.findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
    });

    it("lands on the Problems pane from Confirm, which joins the rail after Impact, and puts one problem at a time", async () => {
      const plan = await parted();
      location.hash = `planning/${plan.id}/graph`;
      mount();
      await screen.findByRole("heading", { name: "Execution graph" });
      // Not in the rail before the reading has found anything: it is on the
      // way to the contract and nowhere to go to.
      await waitFor(() => expect(railPanes()).toContain("Impact"));
      expect(railPanes()).not.toContain("Problems");
      fireEvent.click(screen.getByRole("button", { name: "Confirm the plan" }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
      // The reading is said to be under way while it is.
      await screen.findByRole("heading", { name: "Checking the plan against the spec" });
      await screen.findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
      // One problem, and only one, however many the reading found: the second
      // appears when the first is resolved.
      expect(cards()).toHaveLength(1);
      expect(screen.queryByRole("group", { name: "Criterion 2 and R2" })).toBeNull();
      expect(screen.getByText("Problem 1 of 2")).toBeTruthy();
      expect(screen.getByText("1 more after this")).toBeTruthy();
      // Now in the rail, after Impact, and current.
      await waitFor(() => expect(railPanes()).toContain("Problems"));
      expect(railPanes().indexOf("Problems")).toBe(railPanes().indexOf("Impact") + 1);
      expect(pane("Problems").getAttribute("aria-current")).toBe("page");
      // And no chat beside it: the card is the chat's own card.
      expect(screen.queryByRole("complementary", { name: /^(Interview|Chat)$/ })).toBeNull();
      expect(screen.queryByLabelText("Message the chat")).toBeNull();
    });

    it("puts the recommendation first and the person's own words last, in a box inside that answer", async () => {
      await problems();
      const card = screen.getByRole("group", { name: "Criterion 1 and R1" });
      const first = within(card);
      const radios = first.getAllByRole("radio");
      // The reading's two answers, then the person's own words — and not the
      // answer that hands the choice to the interview, which has no judgement
      // of its own here: it is the one being asked to move the plan or the
      // spec.
      expect(radios).toHaveLength(3);
      expect(radios[0]).toBe(first.getByRole("radio", { name: /^Reword criterion 1 .*recommended/ }));
      expect(radios[2]).toBe(first.getByRole("radio", { name: /Something else/ }));
      expect(first.queryByText("Architect's call")).toBeNull();
      // The person's own words open a box inside that answer, on the card
      // itself, which is the one way to answer here and in the chat alike.
      expect(screen.queryByLabelText("Your own words")).toBeNull();
      fireEvent.click(radios[2]!);
      const box = (await first.findByLabelText("Your own words")) as HTMLTextAreaElement;
      expect(box.closest(".choice")?.contains(radios[2]!)).toBe(true);
      expect(card.contains(box)).toBe(true);
      // Nothing goes while nothing is said in it.
      fireEvent.change(box, { target: { value: "   " } });
      expect((within(card).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      sendGroup(card);
      await settle();
      expect(screen.getByRole("group", { name: "Criterion 1 and R1" })).toBe(card);
      // And the answers above it are still there to pick instead.
      expect((radios[0] as HTMLInputElement).disabled).toBe(false);
    });

    it("gives the person's own words the box's own look only once it is picked", async () => {
      await problems();
      const card = within(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      const own = card.getByRole("radio", { name: /Something else/ }).closest("label")!;
      // Unpicked it is one of the pair under the answers: the look that goes
      // with the box is worn while the box is there and not before.
      expect(own.classList.contains("choice--paired")).toBe(true);
      expect(own.classList.contains("choice--custom")).toBe(false);
      fireEvent.click(card.getByRole("radio", { name: /Something else/ }));
      await card.findByLabelText("Your own words");
      expect(own.classList.contains("choice--custom")).toBe(true);
      // And it comes off again with the pick, as the box does.
      fireEvent.click(card.getByRole("radio", { name: /Something else/ }));
      expect(own.classList.contains("choice--custom")).toBe(false);
    });

    it("sends a lone part in the paragraphs the person wrote it in", async () => {
      // A problem is one part, so its answer is the turn whole and carries no
      // letter: nothing reads its lines as parts, and an answer written as two
      // paragraphs is the person's sentence and goes down as they wrote it.
      const plan = await problems();
      const card = within(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      fireEvent.click(card.getByRole("radio", { name: /Something else/ }));
      fireEvent.change(await card.findByLabelText("Your own words"), {
        target: { value: "  Leave criterion 1 as it is.\n\nMove R1 to say the same.  " },
      });
      sendGroup(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      await waitFor(async () => {
        const session = await editingRead(plan.id);
        expect(
          session.conversation.some(
            (line) =>
              line.line.kind === "turn" &&
              line.line.text === "Leave criterion 1 as it is.\n\nMove R1 to say the same.",
          ),
        ).toBe(true);
      });
    });

    it("sends the answer as the person's turn, says it is being resolved, puts the next, and offers the contract after the last", async () => {
      const plan = await problems();
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      // While the interview applies it and the plan is read again, the pane
      // says so rather than leaving the answered card up.
      await screen.findByRole("heading", { name: "Resolving the problem" });
      // Down as a turn, in the option's own words and nothing more.
      await waitFor(async () => {
        const session = await editingRead(plan.id);
        expect(
          session.conversation.some((line) => line.line.kind === "turn" && line.line.text === REWORD_1),
        ).toBe(true);
      });
      // The next problem, once the reading records that the first is closed.
      await screen.findByRole("group", { name: "Criterion 2 and R2" }, { timeout: 5000 });
      expect(cards()).toHaveLength(1);
      expect(screen.queryByRole("group", { name: "Criterion 1 and R1" })).toBeNull();
      expect(screen.getByText("Problem 1 of 1")).toBeTruthy();
      expect(screen.getByText("the last one")).toBeTruthy();
      expect((await editingRead(plan.id)).drift).toMatchObject({
        open: [{ heading: "Criterion 2 and R2" }],
        resolved: false,
      });
      answerFirst(screen.getByRole("group", { name: "Criterion 2 and R2" }));
      await screen.findByRole("heading", { name: "Every problem is resolved" }, { timeout: 5000 });
      expect(cards()).toHaveLength(0);
      expect((await editingRead(plan.id)).drift).toEqual({
        open: [],
        resolved: true,
      });
      // Out of the rail with none open, though the record stands, and the way on is offered.
      expect(railPanes()).not.toContain("Problems");
      // "The plan", since this is still planning: the contract is where it leads.
      expect(screen.queryByRole("button", { name: "Confirm the contract" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Confirm the plan" }));
      await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/));
    });

    it("puts the same problem in the chat on the Graph pane, and answering it there advances it", async () => {
      const plan = await problems();
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      const dock = screen.getByRole("complementary", { name: "Chat" });
      const card = await within(dock).findByRole("group", { name: "Criterion 1 and R1" });
      expect(within(card).getByText("Problem 1 of 2")).toBeTruthy();
      expect(within(card).getByRole("radio", { name: /^Reword criterion 1 .*recommended/ })).toBeTruthy();
      // The same card as the pane's: nothing hands the choice to the interview.
      expect(within(card).getAllByRole("radio")).toHaveLength(3);
      expect(within(card).queryByText("Architect's call")).toBeNull();
      // The chat's line says the problem was put, and the card is the answer to it.
      expect(within(dock).getByText(/^Problem 1 of 2: Criterion 1 and R1\./)).toBeTruthy();
      answerFirst(card);
      await waitFor(async () => {
        const session = await editingRead(plan.id);
        expect(
          session.conversation.some((line) => line.line.kind === "turn" && line.line.text === REWORD_1),
        ).toBe(true);
      });
      const next = await within(dock).findByRole(
        "group",
        { name: "Criterion 2 and R2" },
        { timeout: 5000 },
      );
      expect(within(next).getByText("Problem 1 of 1")).toBeTruthy();
      expect(within(dock).queryByRole("group", { name: "Criterion 1 and R1" })).toBeNull();
      // And the pane shows the same one, after the reading it asks for on
      // arrival — the dock's card is gone with the dock by then.
      location.hash = `planning/${plan.id}/drift`;
      await screen.findByRole("heading", { name: "Checking the plan against the spec" });
      expect(screen.queryByRole("complementary", { name: /^(Interview|Chat)$/ })).toBeNull();
      await screen.findByRole("group", { name: "Criterion 2 and R2" }, { timeout: 5000 });
      expect(cards()).toHaveLength(1);
    });

    it("offers the contract in the chat once every problem is resolved", async () => {
      const plan = await problems();
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      answerFirst(await screen.findByRole("group", { name: "Criterion 2 and R2" }, { timeout: 5000 }));
      await screen.findByRole("heading", { name: "Every problem is resolved" }, { timeout: 5000 });
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      const dock = screen.getByRole("complementary", { name: "Chat" });
      const note = await within(dock).findByText(/^Every problem is resolved/);
      expect(within(note).queryByRole("button", { name: "Confirm the contract" })).toBeNull();
      fireEvent.click(within(note).getByRole("button", { name: "Confirm the plan" }));
      await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/));
    });

    it("withholds the chat's way on while a question from the interview stands, and offers it again once answered", async () => {
      const plan = await problems();
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      answerFirst(await screen.findByRole("group", { name: "Criterion 2 and R2" }, { timeout: 5000 }));
      await screen.findByRole("heading", { name: "Every problem is resolved" }, { timeout: 5000 });
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      const dock = screen.getByRole("complementary", { name: "Chat" });
      const note = await within(dock).findByText(/^Every problem is resolved/);
      expect(within(note).getByRole("button", { name: "Confirm the plan" })).toBeTruthy();
      // The interview asks a question of its own: it stands between the
      // person and confirming, so the note reads without its button.
      await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: "ask me" });
      await within(dock).findByRole("group", { name: "How the queue is split" }, { timeout: 5000 });
      expect(within(note).queryByRole("button", { name: "Confirm the plan" })).toBeNull();
      // Answered in the person's own words, which takes the question away —
      // but not the button back: the interview is applying the answer, and
      // then the plan is read against the spec again, and until that reading
      // has landed what the answer did to the record is not known. The page
      // waits through the same two, and the note reads without its button.
      await sampleBridge.request({
        kind: "interviewTurn",
        id: plan.id,
        text: "Change R1 in the spec to say: The person can choose Light, Dark or System without a restart.",
      });
      await waitFor(() =>
        expect(within(dock).queryByRole("group", { name: "How the queue is split" })).toBeNull(),
      );
      expect((await sampleBridge.request({ kind: "snapshot" })).working).toContain(plan.id);
      expect(within(note).queryByRole("button", { name: "Confirm the plan" })).toBeNull();
      // From here until the reading the turn owes has landed, the button is
      // never there — not while the interview applies the answer, not in the
      // round trip between the turn ending and the reading's job appearing,
      // and not while it runs. Watched rather than sampled: a flash between
      // two polls is exactly what would let the person confirm a plan the
      // reading was about to find wanting. The landing is taken from the
      // change that carries the job, which reaches the dock before it draws.
      const before = (await sampleBridge.request({ kind: "snapshot" })).jobs
        .filter((job) => job.kind === "drift" && job.key === plan.key)
        .map((job) => job.startedAt)
        .sort()
        .at(-1) ?? "";
      let shownAt: number | null = null;
      let landedAt: number | null = null;
      const watcher = new MutationObserver(() => {
        if (shownAt === null && within(note).queryByRole("button", { name: "Confirm the plan" }))
          shownAt = performance.now();
      });
      watcher.observe(note, { childList: true, subtree: true, attributes: true });
      const unsubscribe = sampleBridge.subscribe((change) => {
        const job = "job" in change ? change.job : undefined;
        if (
          landedAt === null &&
          job !== undefined &&
          job.kind === "drift" &&
          job.key === plan.key &&
          job.startedAt > before &&
          !isLive(job)
        )
          landedAt = performance.now();
      });
      await waitFor(() => expect(landedAt).not.toBeNull(), { timeout: 5000 });
      await waitFor(
        () => expect(within(note).getByRole("button", { name: "Confirm the plan" })).toBeTruthy(),
        { timeout: 5000 },
      );
      watcher.disconnect();
      unsubscribe();
      expect(shownAt, "the button was there before the reading landed").not.toBeNull();
      expect(shownAt! >= landedAt!, "the button came back before the reading landed").toBe(true);
    });

    it("lands on the problems from the picker and from the ticket's own link while they are open", async () => {
      const plan = await problems();
      // The picker's row for this planning, which would otherwise open the spec.
      location.hash = "home";
      const picker = await openPicker();
      // Named by its ticket's name (D-127).
      const { title } = (await sampleBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key })).ticket;
      fireEvent.click(within(picker).getByRole("button", { name: (name) => name.startsWith(title) }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
      await screen.findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
      // The ticket's own address, which lands where the ticket belongs.
      location.hash = `task/${plan.repoId}/${plan.key}`;
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`), { timeout: 5000 });
      await screen.findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
    });

    it("goes on to the contract anyway with the problems open, and is not asked again at the same state", async () => {
      const plan = await problems();
      expect(railPanes()).toContain("Problems");
      fireEvent.click(screen.getByRole("button", { name: "Go on to the contract anyway" }));
      await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/));
      // On the contract page itself — not only its address — before turning
      // back, as a person is: the way back through the reading starts there.
      await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
      // The problems are forgotten with it, and the ticket's own page opens
      // on the contract it was left at rather than on them.
      expect((await editingRead(plan.id)).drift).toBeNull();
      await waitFor(async () => expect((await editingRead(plan.id)).lastView).toBe("contract"));
      location.hash = `task/${plan.repoId}/${plan.key}`;
      await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 });
      expect(location.hash).toBe(`#task/${plan.repoId}/${plan.key}`);
      // And the pane comes out of the rail.
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      expect(railPanes()).not.toContain("Problems");
      // A pane recorded is the last place again: the ticket's page sends the
      // person into the planning, on that pane.
      await waitFor(async () => expect((await editingRead(plan.id)).lastView).toBeNull());
      location.hash = `task/${plan.repoId}/${plan.key}`;
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/graph`), { timeout: 5000 });
      // Back through the reading lands on the contract without a card.
      location.hash = `planning/${plan.id}/drift`;
      await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/), { timeout: 5000 });
      expect(screen.queryByRole("group", { name: "Criterion 1 and R1" })).toBeNull();
    });

    it("passes straight through for a plan that was not drafted from its spec", async () => {
      // A plan admitted from a typed draft, with a spec written beside it
      // afterwards: the planning has a spec, the ticket's admission does not,
      // and the CLI would refuse to read one against the other. The page is
      // not a place to stand while that is said; it goes on to the contract.
      const workspace = await sampleBridge.request({ kind: "snapshot" });
      const repoId = workspace.repositories[0]!.id;
      const admitted = await sampleBridge.request({
        kind: "admit",
        repoId,
        draft: {
          outcome: "The result is saved.",
          criteria: [{ text: "Saved", assertion: "The saved text can be read", kind: "test" }],
          paths: ["src/**"],
          prohibited: [],
        },
      });
      await waitFor(async () =>
        expect(
          (await sampleBridge.request({ kind: "snapshot" })).jobs.find((job) => job.id === admitted.id)
            ?.state,
        ).toBe("completed"),
      );
      const key = (await sampleBridge.request({ kind: "snapshot" })).jobs.find(
        (job) => job.id === admitted.id,
      )!.resultKey!;
      const opened = await sampleBridge.request({
        kind: "editingOpen",
        target: { kind: "planning", repoId, key },
      });
      await sampleBridge.request({
        kind: "specSave",
        id: opened.id,
        repoId,
        title: "Saving the result",
        sections: { ...SECTIONS, outcome: "The result is saved." },
        base: NOTHING_YET,
      });
      const session = await editingRead(opened.id);
      expect(session.specSlug).not.toBeNull();
      const before = (await sampleBridge.request({ kind: "snapshot" })).jobs.length;
      location.hash = `planning/${opened.id}/drift`;
      mount();
      await waitFor(() => expect(location.hash).toBe(`#task/${repoId}/${key}/contract`), {
        timeout: 5000,
      });
      // Nothing was asked of the reading on the way.
      expect((await sampleBridge.request({ kind: "snapshot" })).jobs).toHaveLength(before);
    });

    it("waits for a turn in flight before the Spec pane's way to the plan, as the Graph's does", async () => {
      const plan = await planned();
      location.hash = `planning/${plan.id}/spec`;
      mount();
      const onward = await screen.findByRole("button", { name: "Open the plan" });
      expect(onward.hasAttribute("disabled")).toBe(false);
      await sampleBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
      await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: "what is this for?" });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Open the plan" }).hasAttribute("disabled")).toBe(
          true,
        ),
      );
      await waitFor(
        () =>
          expect(
            screen.getByRole("button", { name: "Open the plan" }).hasAttribute("disabled"),
          ).toBe(false),
        { timeout: 5000 },
      );
      // And the way it opens is the reading, as every way from the plan to the contract is.
      fireEvent.click(screen.getByRole("button", { name: "Open the plan" }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
    });

    it("reads again on every arrival, and a hand rewording after a resolved round re-opens the problems", async () => {
      const plan = await problems();
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      answerFirst(await screen.findByRole("group", { name: "Criterion 2 and R2" }, { timeout: 5000 }));
      await screen.findByRole("heading", { name: "Every problem is resolved" }, { timeout: 5000 });
      // With the round resolved the ticket belongs to its plan again: Home
      // lands it on the graph, and though the record stands the rail no
      // longer offers the Problems pane. The resolved page is not where the
      // planning was left, since the reading is never remembered
      // (D-130).
      expect(await lastPane(plan.id)).toBeNull();
      location.hash = `task/${plan.repoId}/${plan.key}`;
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/graph`), { timeout: 5000 });
      await screen.findByRole("heading", { name: "Execution graph" });
      expect(railPanes()).not.toContain("Problems");
      // And the picker's row lands where it was left, now the Graph.
      await waitFor(async () => expect(await lastPane(plan.id)).toBe("graph"));
      location.hash = "home";
      const picker = await openPicker();
      const { title } = (await sampleBridge.request({ kind: "detail", repoId: plan.repoId, key: plan.key })).ticket;
      fireEvent.click(within(picker).getByRole("button", { name: (name) => name.startsWith(title) }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/graph`), { timeout: 5000 });
      await screen.findByRole("heading", { name: "Execution graph" });
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      // A rewording by hand, which no record can know about.
      await sampleBridge.request({
        kind: "graphEdit",
        repoId: plan.repoId,
        key: plan.key,
        edit: {
          op: "set_criterion",
          id: "ac_1",
          text: "The person can choose Light or Dark, after a restart.",
          expected_verification: { kind: "test", assertion: "after a restart" },
        },
      });
      await waitFor(async () =>
        expect((await graphOf(plan)).criteria.find((each) => each.id === "ac_1")?.text).toMatch(/after a restart/),
      );
      // The pane's own button, not the chat's resolved note beside it, which
      // offers the same words.
      fireEvent.click(
        screen
          .getAllByRole("button", { name: "Confirm the plan" })
          .find((button) => button.closest('[role="complementary"]') === null)!,
      );
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
      // Read again rather than shown as resolved: the wait, then the problem.
      await screen.findByRole("heading", { name: "Checking the plan against the spec" });
      expect(screen.queryByRole("heading", { name: "Every problem is resolved" })).toBeNull();
      await screen.findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
      expect(screen.getByText("Problem 1 of 1")).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Every problem is resolved" })).toBeNull();
      expect((await editingRead(plan.id)).drift).toMatchObject({
        open: [{ heading: "Criterion 1 and R1" }],
        resolved: false,
      });
      // Open again, the pane is back in the rail.
      await waitFor(() => expect(railPanes()).toContain("Problems"));
    });

    it("puts the problem again in the chat when the answer did not close it, and not over the interview's own card", async () => {
      const plan = await problems();
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      const dock = () => screen.getByRole("complementary", { name: "Chat" });
      const card = await within(dock()).findByRole("group", { name: "Criterion 1 and R1" });
      const problemLines = () => within(dock()).queryAllByText(/^Problem 1 of 2: Criterion 1 and R1\./);
      expect(problemLines()).toHaveLength(1);
      // Words of the person's own that are not one of the ways to close it,
      // said in the box inside that answer: a problem is one part, so what
      // goes down is the sentence bare. The card comes down, the interview
      // answers what was said, and the reading after finds the problem still
      // there — so it is put again, since nothing stands to answer it.
      fireEvent.click(within(card).getByRole("radio", { name: /Something else/ }));
      fireEvent.change(await within(card).findByLabelText("Your own words"), {
        target: { value: "Leave criterion 1 as it is for now." },
      });
      sendGroup(card);
      await waitFor(() =>
        expect(within(dock()).queryByRole("group", { name: "Criterion 1 and R1" })).toBeNull(),
      );
      const again = await within(dock()).findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
      expect(problemLines()).toHaveLength(2);
      expect(within(again).getByText("Problem 1 of 2")).toBeTruthy();
      // A question the interview asks of its own stands instead, and the
      // reading after it puts nothing over it.
      fireEvent.click(within(again).getByRole("radio", { name: /Something else/ }));
      fireEvent.change(await within(again).findByLabelText("Your own words"), {
        target: { value: "ask me" },
      });
      sendGroup(again);
      await within(dock()).findByRole("group", { name: "How the queue is split" }, { timeout: 5000 });
      const readings = () =>
        sampleBridge
          .request({ kind: "snapshot" })
          .then((snapshot) => snapshot.jobs.filter((job) => job.kind === "drift" && job.key === plan.key));
      const before = (await readings()).length;
      await waitFor(
        async () => {
          const jobs = await readings();
          expect(jobs.length).toBeGreaterThan(before - 1);
          expect(jobs.every((job) => job.state === "completed")).toBe(true);
        },
        { timeout: 5000 },
      );
      expect(within(dock()).getByRole("group", { name: "How the queue is split" })).toBeTruthy();
      expect(within(dock()).queryByRole("group", { name: "Criterion 1 and R1" })).toBeNull();
      expect(problemLines()).toHaveLength(2);
    });

    it("stays on the wait from Send until the next problem is shown", async () => {
      const plan = await problems();
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      await screen.findByRole("heading", { name: "Resolving the problem" });
      // Between the interview's turn ending and the reading starting, and
      // between the reading landing and the record reaching the page, the
      // answered card is not put back up to be answered again: no answer can
      // be picked, and nothing can be sent, until the next problem is there.
      let sendable = false;
      await waitFor(
        () => {
          const next = screen.queryByRole("group", { name: "Criterion 2 and R2" });
          if (next !== null) return;
          if (
            screen.queryAllByRole("radio").length > 0 ||
            screen
              .queryAllByRole("button", { name: "Send" })
              .some((button) => !(button as HTMLButtonElement).disabled)
          )
            sendable = true;
          throw new Error("the next problem is not shown yet");
        },
        { timeout: 5000, interval: 5 },
      );
      expect(sendable).toBe(false);
      void plan;
    });

    it("holds the wait until the record shows what the reading decided, where the record arrives after the reading's job", async () => {
      await problems();
      // The record reaches this page a round trip after the reading's job has
      // settled. Here that round trip is made long, so a page that stood on
      // the job alone would put the answered card back up meanwhile, to be
      // answered a second time.
      const request = sampleBridge.request;
      const spy = vi.spyOn(sampleBridge, "request").mockImplementation((async (input: Parameters<typeof request>[0]) => {
        const reply = await request.call(sampleBridge, input);
        if (input.kind === "editingRead") await new Promise((done) => setTimeout(done, 250));
        return reply;
      }) as typeof request);
      try {
        answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
        await screen.findByRole("heading", { name: "Resolving the problem" });
        let sendable = false;
        await waitFor(
          () => {
            if (screen.queryByRole("group", { name: "Criterion 2 and R2" }) !== null) return;
            if (
              screen.queryAllByRole("radio").length > 0 ||
              screen
                .queryAllByRole("button", { name: "Send" })
                .some((button) => !(button as HTMLButtonElement).disabled)
            )
              sendable = true;
            throw new Error("the next problem is not shown yet");
          },
          { timeout: 8000, interval: 5 },
        );
        expect(sendable).toBe(false);
        // And the same from the last problem to the resolved state.
        answerFirst(screen.getByRole("group", { name: "Criterion 2 and R2" }));
        await screen.findByRole("heading", { name: "Resolving the problem" });
        await waitFor(
          () => {
            if (screen.queryByRole("heading", { name: "Every problem is resolved" }) !== null) return;
            if (screen.queryAllByRole("radio").length > 0) sendable = true;
            throw new Error("the resolved state is not shown yet");
          },
          { timeout: 8000, interval: 5 },
        );
        expect(sendable).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("marks what an answer sent from the Problems page changed of the plan (D-128)", async () => {
      const plan = await problems();
      // The reading's recommendation, which rewords criterion 1 to the
      // spec's words through the interview's edit path.
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      await screen.findByRole("group", { name: "Criterion 2 and R2" }, { timeout: 5000 });
      await waitFor(async () =>
        expect((await editingRead(plan.id)).change?.plan ?? null).not.toBeNull(),
      );
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      const card = await screen.findByRole("button", { name: /^Node node_1/ });
      const marks = (className: string): string[] =>
        [...card.querySelectorAll(className)].map((mark) => mark.textContent ?? "");
      await waitFor(() => expect(marks(".change--added").join("|")).toContain("System"));
      expect(marks(".change--removed").join("|")).toContain("after");
    });

    it("takes a problem's card down in the chat when a clean reading finds it closed by hand", async () => {
      const plan = await problems();
      // Both problems fixed on the Graph pane rather than answered: the
      // criteria reworded to the spec's own words, while the first's card
      // still stands.
      for (const [id, text] of [
        ["ac_1", "The person can choose Light, Dark or System without a restart."],
        ["ac_2", "Text meets WCAG AA contrast against its background."],
      ] as const)
        await sampleBridge.request({
          kind: "graphEdit",
          repoId: plan.repoId,
          key: plan.key,
          edit: { op: "set_criterion", id, text, expected_verification: { kind: "test", assertion: text } },
        });
      await waitFor(async () =>
        expect((await graphOf(plan)).criteria.find((each) => each.id === "ac_2")?.text).toMatch(/WCAG AA /),
      );
      expect((await editingRead(plan.id)).asking).not.toBeNull();
      // Arriving again reads the plan against the spec, and the reading
      // finds nothing: the card comes down with the problems, so the chat
      // offers the way on rather than a card over a problem that is gone —
      // and the arrival goes on to the contract, since nothing was resolved
      // in front of the person to stop for.
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      location.hash = `planning/${plan.id}/drift`;
      await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/), { timeout: 5000 });
      await waitFor(async () =>
        expect((await editingRead(plan.id)).asking).toBeNull(),
      );
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      const dock = screen.getByRole("complementary", { name: "Chat" });
      const note = await within(dock).findByText(/^Every problem is resolved/);
      expect(within(dock).queryByRole("group", { name: "Criterion 1 and R1" })).toBeNull();
      await waitFor(() => expect(within(note).getByRole("button", { name: "Confirm the plan" })).toBeTruthy());
    });

    it("keeps the way back and the quiet way on while it waits", async () => {
      const plan = await problems();
      // Arriving again with a problem open: the reading first, and the
      // footer with it.
      location.hash = `planning/${plan.id}/graph`;
      await screen.findByRole("heading", { name: "Execution graph" });
      location.hash = `planning/${plan.id}/drift`;
      await screen.findByRole("heading", { name: "Checking the plan against the spec" });
      expect(screen.getByRole("button", { name: "Back to the plan" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Go on to the contract anyway" })).toBeTruthy();
      await screen.findByRole("group", { name: "Criterion 1 and R1" }, { timeout: 5000 });
      // And while the answer is being resolved.
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      await screen.findByRole("heading", { name: "Resolving the problem" });
      expect(screen.getByRole("button", { name: "Go on to the contract anyway" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Back to the plan" }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/graph`));
    });

    it("shows a question the interview asks of its own, and answers it from the same page", async () => {
      const plan = await problems();
      const first = within(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      fireEvent.click(first.getByRole("radio", { name: /Something else/ }));
      fireEvent.change(await screen.findByLabelText("Your own words"), { target: { value: "ask me" } });
      sendGroup(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      // The interview's question, in the interview's own shape: the chat is
      // not beside this pane, so it is put here, with the answer that hands
      // the choice back, since it is the interview's to decide.
      const asked = await screen.findByRole("group", { name: "How the queue is split" }, { timeout: 5000 });
      // Two parts, each with its two answers and the two every question of
      // the interview's carries.
      expect(within(asked).getAllByRole("radio")).toHaveLength(8);
      expect(within(asked).getAllByText("Architect's call")).toHaveLength(2);
      expect(screen.queryByRole("group", { name: "Criterion 1 and R1" })).toBeNull();
      expect(screen.getByRole("button", { name: "Back to the plan" })).toBeTruthy();
      fireEvent.click(within(asked).getByRole("radio", { name: /Split at the read/ }));
      fireEvent.click(within(asked).getByRole("radio", { name: /A unit test per node/ }));
      sendGroup(asked);
      // Down as the person's turn, lettered as the parts were read, and the
      // next group follows it here.
      await waitFor(async () => {
        const session = await editingRead(plan.id);
        expect(
          session.conversation.some(
            (line) => line.line.kind === "turn" && /^a\) Split at the read/.test(line.line.text),
          ),
        ).toBe(true);
      });
      await screen.findByRole("group", { name: "Question 2" }, { timeout: 5000 });
    });

    it("shows a reading the host started that failed, with the way on and the way back", async () => {
      const plan = await problems();
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      // The spec goes unreadable under the reading the host starts once the
      // interview has applied the answer: the reading fails, and the page
      // says so rather than waiting on it.
      const slug = (await editingRead(plan.id)).specSlug!;
      const specs = JSON.parse(localStorage.getItem("perbo:preview-specs") ?? "{}") as Record<string, string>;
      delete specs[slug];
      localStorage.setItem("perbo:preview-specs", JSON.stringify(specs));
      await screen.findByText(`specs/${slug}/spec.md could not be read.`, {}, { timeout: 5000 });
      expect(screen.getByRole("button", { name: "Go on to the contract anyway" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Back to the plan" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Resolving the problem" })).toBeNull();
      expect(screen.queryByRole("group", { name: /Criterion \d and R\d/ })).toBeNull();
    });

    it("goes back to the plan's own pane", async () => {
      const plan = await problems();
      // The rail stays beside it, with the plan's pane and the problems both in it.
      expect(railPanes()).toContain("Graph");
      expect(railPanes()).toContain("Problems");
      fireEvent.click(screen.getByRole("button", { name: "Back to the plan" }));
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/graph`));
    });

    it("puts a question from the interview ahead of the resolved state, and offers Confirm the plan only once it is answered and the plan re-read", async () => {
      const plan = await problems();
      answerFirst(screen.getByRole("group", { name: "Criterion 1 and R1" }));
      answerFirst(await screen.findByRole("group", { name: "Criterion 2 and R2" }, { timeout: 5000 }));
      await screen.findByRole("heading", { name: "Every problem is resolved" }, { timeout: 5000 });
      expect(screen.getByRole("button", { name: "Confirm the plan" })).toBeTruthy();
      // The interview asks a question of its own. It is the thing to answer:
      // the resolved state and the way on go behind it, and no count stands
      // in the corner, since it is not a problem.
      const landed = async (): Promise<number> =>
        (await sampleBridge.request({ kind: "snapshot" })).jobs.filter(
          (job) => job.kind === "drift" && job.key === plan.key && !isLive(job),
        ).length;
      const readings = await landed();
      await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: "ask me" });
      await screen.findByRole("heading", { name: "A question from the Architect" }, { timeout: 5000 });
      expect(screen.getByRole("group", { name: "How the queue is split" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Every problem is resolved" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Confirm the plan" })).toBeNull();
      expect(screen.queryByText(/^Problem \d of \d$/)).toBeNull();
      // The turn ends with the question standing, and the plan is read again
      // once it does — a wait the pane shows over everything — and the
      // question is the thing to answer again once that reading has landed,
      // with the way on still withheld.
      await waitFor(async () => expect(await landed()).toBeGreaterThan(readings), { timeout: 5000 });
      const asked = await screen.findByRole("group", { name: "How the queue is split" }, { timeout: 5000 });
      expect(screen.queryByRole("button", { name: "Confirm the plan" })).toBeNull();
      // Answered here, which is a turn: the plan is read again once it is
      // over, and only then is the resolved state back with its way on.
      // The question has two parts, and each is answered on the card — this
      // one in the person's own words, in the box inside that answer, and the
      // other by picking. A part said in their own words answers it as much
      // as a picked one does, so the group's answer is complete and the
      // interview's second group follows it here.
      fireEvent.click(within(asked).getAllByRole("radio", { name: /Something else/ })[0]!);
      fireEvent.change(await within(asked).findByLabelText("Your own words for 1a"), {
        target: {
          value:
            "Change R1 in the spec to say: The person can choose Light, Dark or System without a restart.",
        },
      });
      fireEvent.click(within(asked).getByRole("radio", { name: /A unit test per node/ }));
      sendGroup(asked);
      await screen.findByRole("heading", { name: "Resolving the problem" });
      expect(screen.queryByRole("button", { name: "Confirm the plan" })).toBeNull();
      // Down as the person's turn, lettered as the parts were read, with the
      // part they said themselves under its own letter.
      const session = await editingRead(plan.id);
      expect(
        session.conversation.some(
          (line) =>
            line.line.kind === "turn" &&
            line.line.text ===
              "a) Change R1 in the spec to say: The person can choose Light, Dark or System without a restart.\n" +
                "b) A unit test per node",
        ),
      ).toBe(true);
      const second = await screen.findByRole("group", { name: "Question 2" }, { timeout: 5000 });
      expect(screen.queryByRole("button", { name: "Confirm the plan" })).toBeNull();
      fireEvent.click(within(second).getByRole("radio", { name: /Delete it/ }));
      sendGroup(second);
      await screen.findByRole("heading", { name: "Resolving the problem" });
      expect(screen.queryByRole("button", { name: "Confirm the plan" })).toBeNull();
      // The interview moved the plan while it answered, so the reading after
      // the last group finds a problem — which is the point of reading again
      // after every turn. The way on is still withheld until that is closed.
      const problem = await screen.findByRole(
        "group",
        { name: "Criterion 1 and R1" },
        { timeout: 5000 },
      );
      expect(screen.queryByRole("group", { name: "Question 2" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Confirm the plan" })).toBeNull();
      answerFirst(problem);
      await screen.findByRole("heading", { name: "Every problem is resolved" }, { timeout: 5000 });
      expect(screen.getByRole("button", { name: "Confirm the plan" })).toBeTruthy();
      expect(screen.queryByRole("group", { name: "How the queue is split" })).toBeNull();
    });

    describe("confirming once the problems are resolved", () => {
      /** Nothing under way for the planning: no turn in flight and no reading live. */
      const quiet = async (plan: { id: string }): Promise<void> => {
        const workspace = await sampleBridge.request({ kind: "snapshot" });
        expect(workspace.working).not.toContain(plan.id);
        expect(workspace.jobs.some((job) => job.kind === "drift" && isLive(job))).toBe(false);
      };
      /** Each problem on the planning answered with its first way to close it, as turns, until none is open. */
      async function resolveAll(plan: { id: string }): Promise<void> {
        for (const heading of ["Criterion 1 and R1", "Criterion 2 and R2"]) {
          await waitFor(
            async () => {
              const session = await editingRead(plan.id);
              expect(session.drift?.open[0]?.heading).toBe(heading);
              expect(session.asking).not.toBeNull();
            },
            { timeout: 5000 },
          );
          const label = (await editingRead(plan.id)).drift!.open[0]!.options[0]!.label;
          await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: label });
        }
        await waitFor(
          async () => expect((await editingRead(plan.id)).drift).toEqual({ open: [], resolved: true }),
          { timeout: 5000 },
        );
        await waitFor(() => quiet(plan));
      }

      it("goes from the Graph's Confirm the plan straight to the contract once the problems were resolved in the chat", async () => {
        const plan = await problems();
        location.hash = `planning/${plan.id}/graph`;
        await screen.findByRole("heading", { name: "Execution graph" });
        await resolveAll(plan);
        // Whatever the page puts up on the way, recorded as it is put up: the
        // resolved page is a stop, and the way through never makes it.
        const stops: string[] = [];
        const watch = new MutationObserver(() => {
          if (screen.queryByRole("heading", { name: "Every problem is resolved" }) !== null)
            stops.push(location.hash);
        });
        watch.observe(document.body, { childList: true, subtree: true });
        fireEvent.click(
          screen
            .getAllByRole("button", { name: "Confirm the plan" })
            .find((button) => button.closest('[role="complementary"]') === null)!,
        );
        await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/), { timeout: 5000 });
        watch.disconnect();
        expect(stops).toEqual([]);
      });

      it("puts Confirm the plan in the Problems page's footer, to the right of Back to the plan", async () => {
        const plan = await problems();
        await resolveAll(plan);
        await screen.findByRole("heading", { name: "Every problem is resolved" }, { timeout: 5000 });
        const footer = document.querySelector('[data-screen="drift"] .pane-confirm') as HTMLElement;
        expect(within(footer).getAllByRole("button").map((button) => button.textContent)).toEqual([
          "Back to the plan",
          "Confirm the plan",
        ]);
        // One way on, and it is the footer's.
        expect(screen.getAllByRole("button", { name: "Confirm the plan" })).toHaveLength(1);
        fireEvent.click(within(footer).getByRole("button", { name: "Confirm the plan" }));
        await waitFor(() => expect(location.hash).toMatch(/^#task\/.*\/contract$/), { timeout: 5000 });
      });

      it("stops on the Problems page for the Architect's own question though every problem is resolved", async () => {
        const plan = await problems();
        location.hash = `planning/${plan.id}/graph`;
        await screen.findByRole("heading", { name: "Execution graph" });
        await resolveAll(plan);
        // The interview asks a question of its own, and its turn ends, and
        // the reading after it lands, with the question standing.
        await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: "ask me" });
        const dock = screen.getByRole("complementary", { name: "Chat" });
        await within(dock).findByRole("group", { name: "How the queue is split" }, { timeout: 5000 });
        await waitFor(() => quiet(plan), { timeout: 5000 });
        expect((await editingRead(plan.id)).drift).toEqual({ open: [], resolved: true });
        expect((await editingRead(plan.id)).asking).not.toBeNull();
        // Arriving on the Problems page stops there for the question rather
        // than passing through to the contract, once the arrival's reading has
        // landed as much as before.
        location.hash = `planning/${plan.id}/drift`;
        await screen.findByRole("heading", { name: "A question from the Architect" }, { timeout: 5000 });
        await waitFor(() => quiet(plan), { timeout: 5000 });
        await new Promise((done) => setTimeout(done, 200));
        expect(location.hash).toBe(`#planning/${plan.id}/drift`);
        expect(screen.getByRole("heading", { name: "A question from the Architect" })).toBeTruthy();
        expect(screen.getByRole("group", { name: "How the queue is split" })).toBeTruthy();
      });
    });

    describe("a problem answered in the chat stays answered", () => {
      it("keeps the answered card down across a visit to the Problems page while the answer is applied", async () => {
        const plan = await problems();
        location.hash = `planning/${plan.id}/graph`;
        await screen.findByRole("heading", { name: "Execution graph" });
        const dock = () => screen.getByRole("complementary", { name: "Chat" });
        answerFirst(await within(dock()).findByRole("group", { name: "Criterion 1 and R1" }));
        // The reading the Problems page asks for as it opens, asked while the
        // interview is still applying the answer — in the same moment, so it
        // reads the plan the answer has not reached yet — and the page itself,
        // which adopts it and says the problem is being resolved.
        expect((await sampleBridge.request({ kind: "snapshot" })).working).toContain(plan.id);
        const reading = await sampleBridge.request({ kind: "driftCheck", id: plan.id });
        location.hash = `planning/${plan.id}/drift`;
        await screen.findByRole("heading", { name: "Resolving the problem" });
        await waitFor(
          async () =>
            expect(
              (await sampleBridge.request({ kind: "snapshot" })).jobs.find((job) => job.id === reading.id)?.state,
            ).toBe("completed"),
          { timeout: 5000 },
        );
        location.hash = `planning/${plan.id}/graph`;
        await screen.findByRole("heading", { name: "Execution graph" });
        // Watched until the answer's own reading puts the next problem: the
        // answered one is never back in the meantime.
        const seen: string[] = [];
        await waitFor(
          () => {
            for (const card of within(dock()).queryAllByRole("group", { name: /Criterion \d and R\d/ }))
              seen.push(card.getAttribute("aria-label") ?? "");
            expect(within(dock()).queryByRole("group", { name: "Criterion 2 and R2" })).not.toBeNull();
          },
          { timeout: 5000, interval: 10 },
        );
        expect(seen).not.toContain("Criterion 1 and R1");
        const record = await editingRead(plan.id);
        expect(
          record.conversation.filter(
            (entry) => entry.line.kind === "asked" && entry.line.groups[0]?.title === "Criterion 1 and R1",
          ),
        ).toHaveLength(1);
      });
    });
  });

  /**
   * The last change to the spec and the plan, marked where it stands
   * (D-128): green for what came, red
   * and struck through for what went, and only the last change — the next
   * one turns the previous marks back to plain text.
   */
  describe("the marks on the last change", () => {
    const session = (plan: { id: string }) => editingRead(plan.id);
    /** That planning, with the sample interview's second turn having reworded the first criterion. */
    async function reworded(): Promise<{ id: string; repoId: string; key: string }> {
      const plan = await planned();
      await sampleBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
      // Two turns: the sample answers the first and edits the plan on the second.
      for (const text of ["what is this for?", "tighten the first criterion"]) {
        await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text });
        await waitFor(
          async () => expect((await sampleBridge.request({ kind: "snapshot" })).working ?? []).not.toContain(plan.id),
          { timeout: 5000 },
        );
      }
      await waitFor(async () => expect((await session(plan)).change?.plan ?? null).not.toBeNull());
      return plan;
    }
    const added = (root: ParentNode = document): string[] =>
      [...root.querySelectorAll(".change--added")].map((mark) => mark.textContent ?? "");
    const removed = (root: ParentNode = document): string[] =>
      [...root.querySelectorAll(".change--removed")].map((mark) => mark.textContent ?? "");

    it("marks the interview's rewording on the node card and in the inspector, and a later change replaces it", async () => {
      const plan = await reworded();
      location.hash = `planning/${plan.id}/graph`;
      mount();
      await screen.findByRole("heading", { name: "Execution graph" });
      const card = await screen.findByRole("button", { name: /^Node node_1/ });
      // The new words green, the old words red and struck through, on the card.
      await waitFor(() => expect(added(card).join("|")).toContain("within 60 seconds"));
      expect(removed(card)).toEqual(["."]);
      // And in the inspector, under the box that edits the criterion.
      fireEvent.click(card);
      const line = await screen.findByLabelText("Criterion ac_1 as the last change left it");
      expect(added(line).join("|")).toContain("within 60 seconds");
      expect(removed(line)).toEqual(["."]);
      // A change by hand to another criterion is the last change now: the
      // first one's marks are plain text again, and only the new ones show.
      // This one adds words and takes none away, so nothing at all reads
      // struck through once it is the last change.
      const second = (await graphOf(plan)).criteria[1]!;
      await sampleBridge.request({
        kind: "graphEdit",
        repoId: plan.repoId,
        key: plan.key,
        edit: {
          op: "set_criterion",
          id: second.id,
          text: `By hand: ${second.text}`,
          expected_verification: { kind: second.kind, assertion: second.assertion },
        },
      });
      await waitFor(() => expect(added().join("|")).toContain("By hand"), { timeout: 5000 });
      expect(added().join("|")).not.toContain("within 60 seconds");
      expect(removed()).toEqual([]);
      expect((await session(plan)).change?.plan?.after.criteria.find((each) => each.id === second.id)?.text).toContain(
        "By hand",
      );
    });

    it("marks what the interview wrote in the spec as it reads, and not while the section is being edited", async () => {
      const plan = await planned();
      await sampleBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
      await sampleBridge.request({
        kind: "interviewTurn",
        id: plan.id,
        text: "Change R1 in the spec to say: The person can choose Light or Dark.",
      });
      // The turn's own change: the planning opened with a spec written from
      // nothing, which is its first writing and marks nothing.
      await waitFor(
        async () => expect((await session(plan)).change?.spec?.after.requirements).toContain("Light or Dark."),
        { timeout: 5000 },
      );
      location.hash = `planning/${plan.id}/spec`;
      mount();
      const reading = await screen.findByLabelText("Spec Requirements");
      // The words that came are green and the words that went are struck, in
      // the requirement as it now reads: "System" went, and what the diff
      // finds new of "Light or Dark" is marked in it.
      await waitFor(() => expect(added(reading).length).toBeGreaterThan(0));
      // The words as they now read, which is the text without what is struck.
      const shown = reading.cloneNode(true) as HTMLElement;
      for (const struck of shown.querySelectorAll("del")) struck.remove();
      expect(shown.textContent).toContain("Light or Dark.");
      for (const mark of added(reading)) expect("The person can choose Light or Dark.").toContain(mark);
      expect(removed(reading).join("|")).toContain("System");
      // Only the section that moved is marked.
      expect(added(screen.getByLabelText("Spec Outcome"))).toEqual([]);
      // Opening the editor on it shows the text as it is, with no marks.
      const section = reading.closest(".spec-section")!;
      fireEvent.mouseDown(reading, { clientX: 0, clientY: 0 });
      await waitFor(() => expect(section.querySelector("textarea")).not.toBeNull());
      expect(added(section)).toEqual([]);
      expect(removed(section)).toEqual([]);
    });

    it("marks what Next changed on the Plan pane, with a criterion it took away struck through at the end", async () => {
      const plan = await planned();
      const edit = async (edit: GraphEdit) =>
        sampleBridge.request({ kind: "graphEdit", repoId: plan.repoId, key: plan.key, edit });
      await edit({ op: "delete_node", id: "node_2", move_criteria_to: "node_1", delete_criteria: [] });
      await waitFor(async () => expect((await graphOf(plan)).nodes).toHaveLength(1));
      await edit({ op: "delete_node", id: "node_1", move_criteria_to: null, delete_criteria: [] });
      await waitFor(async () => expect((await graphOf(plan)).nodes).toHaveLength(0));
      const count = (await graphOf(plan)).criteria.length;
      expect(count).toBeGreaterThan(1);
      location.hash = `planning/${plan.id}/criteria`;
      mount();
      await screen.findByRole("heading", { name: "Acceptance criteria" }, { timeout: 5000 });
      fireEvent.click(await screen.findByRole("button", { name: "Edit criterion 1" }));
      fireEvent.change(screen.getByLabelText("Criterion 1"), {
        target: { value: "A person can choose the colour mode." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      fireEvent.click(screen.getByRole("button", { name: `Delete criterion ${count}` }));
      const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
      await waitFor(() => expect(next.disabled).toBe(false));
      fireEvent.click(next);
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
      await waitFor(async () => expect((await session(plan)).change?.plan ?? null).not.toBeNull(), {
        timeout: 5000,
      });
      // Back on the plan: the rewording marked on its row, and the criterion
      // that went struck through after the last row.
      location.hash = `planning/${plan.id}/criteria`;
      await screen.findByRole("heading", { name: "Acceptance criteria" }, { timeout: 5000 });
      await waitFor(() => expect(added(document.querySelector(".criteria-editor")!).join("|")).toContain("colour mode"), {
        timeout: 5000,
      });
      const struck = screen.getByLabelText("A criterion removed by the last change");
      expect(removed(struck).join("|")).toContain("The rail follows the mode.");
      // Editing a row takes every mark away while the list is moving.
      fireEvent.click(screen.getByRole("button", { name: "Edit criterion 2" }));
      expect(added()).toEqual([]);
      expect(screen.queryByLabelText("A criterion removed by the last change")).toBeNull();
    });

    it("marks a criterion deleted from the middle of the plan as the one that went, and the ones after it as themselves", async () => {
      // Next numbers the criteria afresh, so the third takes the second's
      // id: by id the survivor would read as a rewording of the one deleted,
      // and the last as gone. By words, the survivors carry no mark and the
      // deleted one is struck through at the end.
      const plan = await planned();
      const edit = async (edit: GraphEdit) =>
        sampleBridge.request({ kind: "graphEdit", repoId: plan.repoId, key: plan.key, edit });
      await edit({ op: "delete_node", id: "node_2", move_criteria_to: "node_1", delete_criteria: [] });
      await waitFor(async () => expect((await graphOf(plan)).nodes).toHaveLength(1));
      await edit({ op: "delete_node", id: "node_1", move_criteria_to: null, delete_criteria: [] });
      await waitFor(async () => expect((await graphOf(plan)).nodes).toHaveLength(0));
      const texts = (await graphOf(plan)).criteria.map((each) => each.text);
      expect(texts.length).toBeGreaterThan(2);
      location.hash = `planning/${plan.id}/criteria`;
      mount();
      await screen.findByRole("heading", { name: "Acceptance criteria" }, { timeout: 5000 });
      fireEvent.click(screen.getByRole("button", { name: "Delete criterion 2" }));
      const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
      await waitFor(() => expect(next.disabled).toBe(false));
      fireEvent.click(next);
      await waitFor(() => expect(location.hash).toBe(`#planning/${plan.id}/drift`));
      await waitFor(async () => expect((await session(plan)).change?.plan ?? null).not.toBeNull(), {
        timeout: 5000,
      });
      location.hash = `planning/${plan.id}/criteria`;
      await screen.findByRole("heading", { name: "Acceptance criteria" }, { timeout: 5000 });
      const struck = await screen.findByLabelText("A criterion removed by the last change", {}, { timeout: 5000 });
      expect(removed(struck)).toEqual([texts[1]]);
      // The struck one is the only mark on the pane: nothing green, and
      // nothing else struck, on any survivor's row.
      expect(added()).toEqual([]);
      expect(removed()).toEqual([texts[1]]);
      expect(screen.getAllByLabelText("A criterion removed by the last change")).toHaveLength(1);
    });

    it("marks the work of a turn queued behind another with it, as one change", async () => {
      const plan = await planned();
      await sampleBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
      const lines = async () => (await session(plan)).conversation.map((entry) => entry.line);
      await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: "what is this for?" });
      // The first turn has said its first line and not yet ended when the
      // second is sent: the second is owed behind it, and it is the second
      // that edits the plan, after the first has ended.
      await waitFor(async () =>
        expect((await lines()).some((line) => line.kind === "said" && /Nothing here sets a colour mode/.test(line.text))).toBe(true),
      );
      expect((await sampleBridge.request({ kind: "snapshot" })).working).toContain(plan.id);
      await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: "tighten the first criterion" });
      await waitFor(
        async () => expect((await sampleBridge.request({ kind: "snapshot" })).working ?? []).not.toContain(plan.id),
        { timeout: 5000 },
      );
      await waitFor(async () =>
        expect((await lines()).filter((line) => line.kind === "tool" && line.tool === "edit_plan")).toHaveLength(1),
      );
      const change = (await session(plan)).change;
      expect(change?.plan?.after.criteria[0]?.text).toContain("within 60 seconds");
      expect(change?.plan?.before.criteria[0]?.text).not.toContain("within 60 seconds");
    });
  });

  /**
   * SCP-317: the same pane, after the loop has started, reading the run's own
   * records — and a plan that has never run, where every node is untouched and
   * so carries no chip: a word on every node that says nothing is noise.
   */
  it("puts no state on a node the change set has not touched, and nothing outside, before the plan has run", async () => {
    await openGraph();
    for (const id of ["node_1", "node_2"]) {
      const node = screen.getByRole("button", { name: new RegExp(`^Node ${id}`) });
      expect(within(node).queryByText(/untouched/i)).toBeNull();
      expect(node.querySelector(".state")).toBeNull();
    }
    expect(screen.queryByRole("region", { name: "Changed outside every node" })).toBeNull();
  });

  it("shows each node's state and the changed paths outside every node while the work runs", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Plan a piece of work" })).getByRole(
        "button",
        { name: /^Split the settings page into tabs/ },
      ),
    );
    await screen.findByRole("button", { name: /^Node node_1/ });
    const planning = location.hash;
    // Runs go one at a time, and the sample keeps one live for a while.
    const settled = async () =>
      expect(
        (await sampleBridge.request({ kind: "snapshot" })).jobs.some(
          (job) => job.kind === "run" && ["running", "stopping"].includes(job.state),
        ),
      ).toBe(false);
    await waitFor(settled, { timeout: 6000 });
    // Confirm on the graph, approve on the contract: one approval, on the
    // page that says what freezes.
    fireEvent.click(await screen.findByRole("button", { name: "Confirm the plan" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve · start the loop" }, { timeout: 5000 }),
    );
    // The loop is running; the person comes back to the graph to watch it.
    await waitFor(
      async () =>
        expect(
          (await sampleBridge.request({ kind: "snapshot" })).tasks.some(
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
    await sampleBridge.request({
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
    // Read off the card's text, since the change is marked on it: the words
    // that came are in a mark of their own.
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /^Node node_1/ }).textContent).toContain(
          "Somebody else changed this criterion.",
        ),
      { timeout: 5000 },
    );
  });

  it("shows the paths outside every node beside a note, not instead of them", async () => {
    // The two are not alternatives: a note says why part of the reading is
    // missing, and the outside paths are a reading that was not.
    const { OutsidePathsForTests } = await import("./GraphPane.js");
    render(<OutsidePathsForTests outside={["docs/activation.md"]} note="Something could not be read." />);
    expect(screen.getByText("Something could not be read.")).toBeTruthy();
    expect(screen.getByText("docs/activation.md")).toBeTruthy();
  });

  it("says there is nothing to curate before a plan is drafted", async () => {
    await startPlanning();
    // The rail does not offer Graph before there is one, so this is the pane
    // a link or a restored route can still land on: it says what it has.
    expect(screen.queryByRole("button", { name: "Graph" })).toBeNull();
    const planning = (await sampleBridge.request({ kind: "drafts" }))![0]!;
    location.hash = `planning/${planning.id}/graph`;
    await screen.findByText("No graph yet");
    expect(screen.queryByRole("button", { name: "Node" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });
});

/**
 * SCP-313: the interview docked beside every pane (D-102). The session here is
 * the sample host's stand-in: no process, no provider and no repository
 * behind it, answering the same three requests the native host answers.
 */
describe("the interview docked in planning mode (SCP-313)", () => {
  const dock = (): HTMLElement => screen.getByRole("complementary", { name: "Chat" });
  /** Everything the dock's own hints hold, which is where an asking is kept. */
  const askedInTranscript = (): string =>
    within(dock())
      .queryAllByRole("tooltip", { hidden: true })
      .map((hint) => hint.textContent ?? "")
      .join("\n");
  const composer = (): HTMLTextAreaElement =>
    screen.getByLabelText("Message the chat") as HTMLTextAreaElement;

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
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const repoId = workspace.repositories[0]!.id;
    const opened = await sampleBridge.request({
      kind: "editingOpen",
      target: { kind: "fresh", repoId },
    });
    await sampleBridge.request({
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
    await sampleBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
    await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: "why two nodes?" });
    await waitFor(async () =>
      expect(
        (await sampleBridge.request({ kind: "editingRead", id: plan.id })).conversation.some(
          (line) => line.line.kind === "refused",
        ),
      ).toBe(true),
    );
    return plan;
  }
  /** A planning, open on its Spec pane beside the dock. */
  const onSpec = async (from: typeof planning = planning): Promise<{ id: string; repoId: string }> => {
    const plan = await from();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    return plan;
  };
  /** Something typed into the composer and sent with Enter. */
  const say = (text: string): void => {
    fireEvent.change(composer(), { target: { value: text } });
    fireEvent.keyDown(composer(), { key: "Enter" });
  };

  describe("the dock's answers, its status line and the interview behind the chat", () => {
    /** Whether the snapshot has the planning's turn in flight. */
    const working = async (id: string): Promise<boolean> =>
      ((await sampleBridge.request({ kind: "snapshot" })).working ?? []).includes(id);
    /** The snapshot, once the planning's turn is over. */
    const turnOver = async (id: string): Promise<void> =>
      waitFor(async () => expect(await working(id)).toBe(false), { timeout: 5000 });
    /** What the dock's one status line says, or null where there is none. */
    const status = (): string | null => {
      const line = dock().querySelector(".chat-working");
      if (line === null) return null;
      return line.querySelector(".t-think-text:not(.is-exit)")?.getAttribute("data-text") ?? "";
    };
    /** Whether the composer's rim pulses. */
    const rim = (): boolean => composer().closest(".composer-box")?.classList.contains("awaiting-words") ?? false;
    /** A line of a conversation, for reading one without a session. */
    const entry = (n: number, line: unknown) => ({ n, at: "2026-09-23T00:00:00.000Z", line }) as never;

    it("takes a pick back when it is clicked again, and sends nothing until every part has one", async () => {
      const plan = await onSpec();
      say("ask me");
      const group = await within(dock()).findByRole("group", { name: "How the queue is split" });
      const card = within(group);
      const read = card.getByRole("radio", { name: /Split at the read/ }) as HTMLInputElement;
      fireEvent.click(read);
      expect(read.checked).toBe(true);
      // Clicked again, the pick is taken back.
      fireEvent.click(read);
      expect(read.checked).toBe(false);
      expect(read.closest("label")?.classList.contains("selected")).toBe(false);
      // So the other part's pick leaves the group unanswered, and nothing goes.
      fireEvent.click(card.getByRole("radio", { name: /A unit test per node/ }));
      sendGroup(group);
      await settle();
      const lettered = async (): Promise<boolean> =>
        (await editingRead(plan.id)).conversation.some(
          (line) => line.line.kind === "turn" && line.line.text.startsWith("a) "),
        );
      expect(await lettered()).toBe(false);
      expect(within(dock()).getByRole("group", { name: "How the queue is split" })).toBeTruthy();
      // Picked again, the group is whole and goes from the bar.
      fireEvent.click(read);
      sendGroup(group);
      await waitFor(async () => expect(await lettered()).toBe(true));
      expect(
        (await editingRead(plan.id)).conversation.some(
          (line) => line.line.kind === "turn" && line.line.text === "a) Split at the read\nb) A unit test per node",
        ),
      ).toBe(true);
    });

    it("moves one status line through the turn, and shows nothing the session says once the spec is handed over", async () => {
      const plan = await onSpec(spoken);
      // The earlier turn over and its last line's words in place of its dots,
      // which stand in the status line's place while they are up.
      await turnOver(plan.id);
      await waitFor(() => expect(dock().querySelector(".msg--speaking")).toBeNull());
      say("please write the spec");
      // Reading the answer, then writing the spec, on the one line.
      await waitFor(() => expect(status()).toBe("Reading what you said…"));
      await waitFor(() => expect(status()).toBe("Writing the spec…"), { timeout: 5000 });
      expect(dock().querySelectorAll(".chat-working")).toHaveLength(1);
      // The writing is the line's to say, not a line left in the log.
      expect(dock().querySelector(".msg--note")?.textContent ?? "").not.toContain("Writing the spec…");
      await within(dock()).findByText(/^The spec is written/, {}, { timeout: 5000 });
      expect(status()).toBeNull();
      // The session goes on working under the note — a quiet read_plan the
      // chat does not draw — and still no line says so, for the rest of the
      // turn: the note is the status until the turn is over (D-102).
      await waitFor(async () =>
        expect(
          (await editingRead(plan.id)).conversation.at(-1)?.line.kind,
          "the tool line is the turn's last so far",
        ).toBe("tool"),
      );
      await settle();
      expect(await working(plan.id)).toBe(true);
      expect(status()).toBeNull();
      await turnOver(plan.id);
      expect(status()).toBeNull();
      // The session's own closing line came after the note, and is not shown:
      // the note is what the turn says (D-102).
      expect(within(dock()).queryByText(/That is the spec as I have it/)).toBeNull();
      expect(
        (await editingRead(plan.id)).conversation.some(
          (line) => line.line.kind === "said" && line.line.text.startsWith("That is the spec"),
        ),
      ).toBe(false);
      expect(within(dock()).queryAllByText(/^Writing the spec…$/)).toHaveLength(0);
    });

    it("folds the interview away behind one line once there is a plan, and opens and closes it there", async () => {
      await onSpec(spoken);
      say("please write the spec");
      await within(dock()).findByText(/^The spec is written/, {}, { timeout: 5000 });
      // Before the plan nothing is folded.
      expect(within(dock()).queryByRole("button", { name: /Show the earlier chat/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Generate plan" }));
      await waitFor(() => expect(location.hash).toMatch(/^#planning\/[^/]+\/(graph|criteria)$/), {
        timeout: 5000,
      });
      // Folded by default: the interview's lines are behind one line at the top.
      const show = await within(dock()).findByRole("button", { name: /^Show the earlier chat \(\d+ lines?\)$/ });
      expect(show.getAttribute("aria-expanded")).toBe("false");
      expect(dock().querySelector(".chat")?.firstElementChild).toBe(show);
      expect(within(dock()).queryByText("why two nodes?")).toBeNull();
      expect(within(dock()).queryByText(/^The spec is written/)).toBeNull();
      // What is said from the plan onward is shown.
      say("what now?");
      expect(await within(dock()).findByText("what now?")).toBeTruthy();
      expect(within(dock()).queryByText("why two nodes?")).toBeNull();
      // Opened on a click, and closed again on the next.
      fireEvent.click(show);
      expect(await within(dock()).findByText("why two nodes?")).toBeTruthy();
      const hide = within(dock()).getByRole("button", { name: "Hide the earlier chat" });
      expect(hide.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(hide);
      await waitFor(() => expect(within(dock()).queryByText("why two nodes?")).toBeNull());
      expect(within(dock()).getByText("what now?")).toBeTruthy();
    });

    it("pulses the composer's rim while it waits on words only the person can type", async () => {
      const plan = await onSpec();
      // The first message: what the work is.
      expect(rim()).toBe(true);
      // Off once they begin, and back if they take it all out.
      fireEvent.change(composer(), { target: { value: "a" } });
      expect(rim()).toBe(false);
      fireEvent.change(composer(), { target: { value: "" } });
      expect(rim()).toBe(true);
      // Off while the turn is in flight.
      say("ask me plainly");
      await waitFor(() => expect(status()).not.toBeNull());
      expect(rim()).toBe(false);
      // A question put in words, with nothing to pick, is theirs to answer.
      await within(dock()).findByText(/What should the dark mode start from/, {}, { timeout: 5000 });
      await turnOver(plan.id);
      await waitFor(() => expect(rim()).toBe(true));
      // A card with options is not: the composer is away, and the rim with it.
      say("ask me");
      const card = within(await within(dock()).findByRole("group", { name: "How the queue is split" }));
      await turnOver(plan.id);
      expect(composer().closest(".composer")?.hasAttribute("hidden")).toBe(true);
      // Their own words opened on the card wait the same way, until they begin.
      fireEvent.click(card.getAllByRole("radio", { name: /Something else/ })[0]!);
      const own = await card.findByLabelText("Your own words for 1a");
      expect(own.classList.contains("awaiting-words")).toBe(true);
      fireEvent.change(own, { target: { value: "at the queue" } });
      expect(own.classList.contains("awaiting-words")).toBe(false);
    });

    it("puts Something else and Architect's call side by side, and opens the first over the second", async () => {
      await onSpec();
      say("ask me");
      const card = await within(dock()).findByRole("group", { name: "How the queue is split" });
      const pair = (): HTMLElement => card.querySelectorAll<HTMLElement>(".choice-pair")[0]!;
      const named = (): string[] => [...pair().children].map((child) => child.textContent ?? "");
      // One row, Something else on the left and the interview's on the right.
      expect(named()).toHaveLength(2);
      expect(named()[0]).toContain("Something else");
      expect(named()[1]).toContain("Architect's call");
      // Drawn as the actions they are: both in the one row, both carrying the
      // pair's class that gives them an answer's height, and neither showing
      // the radio an answer shows — theirs is there for the keyboard, unseen.
      const buttons = [
        within(card).getAllByRole("radio", { name: /Something else/ })[0]!.closest("label")!,
        within(card).getAllByRole("radio", { name: /Architect's call/ })[0]!.closest("label")!,
      ];
      for (const button of buttons) {
        expect(button.parentElement).toBe(pair());
        expect(button.classList.contains("choice--paired")).toBe(true);
        expect(button.querySelector("input")!.classList.contains("unseen")).toBe(true);
        expect(button.querySelector("svg")).toBeNull();
      }
      const answer = within(card).getByRole("radio", { name: /Split at the read/ }).closest("label")!;
      expect(answer.classList.contains("choice--paired")).toBe(false);
      expect(answer.querySelector("input")!.classList.contains("unseen")).toBe(false);
      // Opened, it takes the row and grows into the box; the other goes.
      fireEvent.click(within(pair()).getByRole("radio", { name: /Something else/ }));
      const own = (await within(card).findByLabelText("Your own words for 1a")) as HTMLTextAreaElement;
      expect(pair().contains(own)).toBe(true);
      expect(named()).toHaveLength(1);
      expect(pair().classList.contains("choice-pair--open")).toBe(true);
      // It has no close of its own, and Escape leaves it open: the one way to
      // close it is picking Something else again.
      fireEvent.change(own, { target: { value: "at the queue" } });
      expect(within(card).queryByRole("button", { name: /^Close/ })).toBeNull();
      expect(own.closest(".choice")?.textContent ?? "").not.toContain("×");
      fireEvent.keyDown(own, { key: "Escape" });
      expect(within(card).getByLabelText("Your own words for 1a")).toBe(own);
      // Picked again, it closes and gives the pair back, keeping what was typed.
      fireEvent.click(within(pair()).getByRole("radio", { name: /Something else/ }));
      expect(within(card).queryByLabelText("Your own words for 1a")).toBeNull();
      expect(named()).toHaveLength(2);
      expect(pair().classList.contains("choice-pair--open")).toBe(false);
      fireEvent.click(within(pair()).getByRole("radio", { name: /Something else/ }));
      expect(((await within(card).findByLabelText("Your own words for 1a")) as HTMLTextAreaElement).value).toBe(
        "at the queue",
      );
    });

    it("moves a pick with the arrow keys, Enter makes it, and nothing goes until the bar is pressed", async () => {
      const plan = await onSpec();
      say("ask me");
      const group = await within(dock()).findByRole("group", { name: "How the queue is split" });
      const card = within(group);
      const lettered = async (): Promise<string[]> =>
        (await editingRead(plan.id)).conversation.flatMap((line) =>
          line.line.kind === "turn" && line.line.text.startsWith("a) ") ? [line.line.text] : [],
        );
      fireEvent.click(card.getByRole("radio", { name: /Split at the read/ }));
      // The last part, walked with the arrow keys as a browser walks a radio
      // group: each step is the key, then a click on the answer reached.
      const unit = card.getByRole("radio", { name: /A unit test per node/ }) as HTMLInputElement;
      const whole = card.getByRole("radio", { name: /One integration test/ }) as HTMLInputElement;
      fireEvent.keyDown(unit, { key: "ArrowDown" });
      fireEvent.click(unit);
      fireEvent.keyUp(unit, { key: "ArrowDown" });
      fireEvent.keyDown(unit, { key: "ArrowDown" });
      fireEvent.click(whole);
      fireEvent.keyUp(whole, { key: "ArrowDown" });
      // The pick moved with the keys, and nothing went.
      expect(whole.checked).toBe(true);
      expect(unit.checked).toBe(false);
      await settle();
      expect(await lettered()).toEqual([]);
      expect(within(dock()).getByRole("group", { name: "How the queue is split" })).toBeTruthy();
      // Enter on the answer the keys are on makes the pick, and sends nothing.
      fireEvent.keyDown(whole, { key: "Enter" });
      expect(whole.checked).toBe(true);
      await settle();
      expect(await lettered()).toEqual([]);
      sendGroup(group);
      await waitFor(async () => expect(await lettered()).toEqual(["a) Split at the read\nb) One integration test"]));
    });

    it("keeps only the questions behind the dot, since the answers are in the chat", async () => {
      await onSpec();
      say("ask me");
      const said = (await within(dock()).findByText(/^Asked 3 questions/)).closest("p")!;
      const hint = within(said).getByRole("tooltip", { hidden: true }).textContent ?? "";
      expect(hint).toContain("Where does the split go?");
      expect(hint).toContain("What happens to the old node?");
      for (const answer of ["Split at the read", "A unit test per node", "Delete it"])
        expect(hint).not.toContain(answer);
    });

    it("puts no line under the note that hands the spec over, for the rest of its turn", () => {
      // The note is the status for the rest of the turn it is said in,
      // whatever the session does after it (D-102); the next turn starts over.
      const turn = entry(1, { kind: "turn", text: "write it" });
      const note = entry(2, { kind: "note", text: INTERVIEW_WROTE_THE_SPEC, notable: true });
      const tool = entry(3, { kind: "tool", tool: "read_plan", ok: true, detail: "", edit: null });
      expect(handedOver([turn, note])).toBe(true);
      expect(handedOver([turn, note, tool])).toBe(true);
      expect(handedOver([turn, entry(2, { kind: "note", text: "Named specs/x." })])).toBe(false);
      expect(handedOver([turn, note, entry(4, { kind: "turn", text: "and more" })])).toBe(false);
    });

    it("gives the chat no hints on how to answer: no key hints, no explaining placeholders, no helper lines", async () => {
      await onSpec();
      // Nothing said yet, and nothing telling them what to say.
      expect(within(dock()).queryByText(/^Nothing yet/)).toBeNull();
      expect(within(dock()).queryByText(/↵/)).toBeNull();
      expect(composer().getAttribute("placeholder")).toBeNull();
      say("ask me");
      const card = await within(dock()).findByRole("group", { name: "How the queue is split" });
      // The bar at its foot is the send and nothing else: no words on it.
      expect(card.querySelector(".asked-bar")?.textContent).toBe("");
      expect(within(card).queryByText(/Pick an answer|Sent in|Say the ones/)).toBeNull();
      // The two answers every part carries are named, not explained.
      expect(within(card).queryByText(/Answer in your own words instead|Its own recommendation/)).toBeNull();
      fireEvent.click(within(card).getAllByRole("radio", { name: /Something else/ })[0]!);
      const own = await within(card).findByLabelText("Your own words for 1a");
      expect(own.getAttribute("placeholder")).toBeNull();
    });

    it("is the chat throughout, and its questions are put by The Architect", async () => {
      await onSpec();
      // Before any plan, as after one.
      expect(screen.getByRole("complementary", { name: "Chat" })).toBeTruthy();
      expect(screen.queryByRole("complementary", { name: "Interview" })).toBeNull();
      expect(within(dock()).getByRole("button", { name: "Stop the chat" })).toBeTruthy();
      say("ask me");
      const card = await within(dock()).findByRole("group", { name: "How the queue is split" });
      expect(within(card).getAllByText("Architect's call")).toHaveLength(2);
      // The session's own words are headed with its name.
      const line = (await within(dock()).findByText(/Questions are with you/)).closest(".msg")!;
      expect(line.querySelector(".msg-who")?.textContent).toBe("The Architect");
      expect(within(dock()).queryByText(/^the interview$/i)).toBeNull();
    });

    it("puts The Architect's bubble up with its dots in place of the status line until its words arrive", async () => {
      await onSpec();
      // Every frame the dock draws, watched: the bubble with dots and the
      // status line are never up together, and the dots give way to words.
      const seen: { dots: boolean; status: boolean }[] = [];
      const watch = new MutationObserver(() =>
        seen.push({
          dots: dock().querySelector(".msg--speaking .speaking-dots") !== null,
          status: dock().querySelector(".chat-working") !== null,
        }),
      );
      watch.observe(dock(), { childList: true, subtree: true });
      try {
        say("ask me plainly");
        await within(dock()).findByText(/What should the dark mode start from/, {}, { timeout: 5000 });
      } finally {
        watch.disconnect();
      }
      expect(seen.some((frame) => frame.dots)).toBe(true);
      expect(seen.some((frame) => frame.dots && frame.status)).toBe(false);
      expect(seen.some((frame) => frame.status)).toBe(true);
      const bubble = dock().querySelector(".msg--speaking");
      expect(bubble, "the words have taken the dots' place").toBeNull();
      expect(
        within(dock()).getByText(/What should the dark mode start from/).closest(".msg")?.querySelector(".msg-who")
          ?.textContent,
      ).toBe("The Architect");
    });

    it("keeps the rim off after a plain statement, and off through a question until its turn is over", async () => {
      const plan = await onSpec();
      // A turn that ends on a statement, with no card: nothing is waiting on them.
      say("tell me about the colours");
      await within(dock()).findByText(/^Noted: /, {}, { timeout: 5000 });
      await turnOver(plan.id);
      expect(rim()).toBe(false);
      // A question said mid-turn is not theirs yet: the turn is still going.
      say("ask me plainly");
      await waitFor(async () =>
        expect(
          (await editingRead(plan.id)).conversation.some(
            (line) => line.line.kind === "said" && line.line.text.startsWith("What should the dark mode"),
          ),
        ).toBe(true),
      );
      expect(await working(plan.id)).toBe(true);
      expect(rim()).toBe(false);
      // Once the turn is over, it is.
      await turnOver(plan.id);
      await waitFor(() => expect(rim()).toBe(true));
    });

    it("reads what the conversation leaves to the person's words", () => {
      const turn = entry(1, { kind: "turn", text: "go on" });
      const said = (text: string) => entry(2, { kind: "said", text });
      // The first message, where nothing of the conversation was dropped.
      expect(waitsOnWords([], 0)).toBe(true);
      // A conversation cut to its last lines had a first message, dropped.
      expect(waitsOnWords([entry(401, { kind: "said", text: "Done." })], 400)).toBe(false);
      // A question, however it is closed.
      for (const text of ["Which one?", 'Which one?"', "Which one?)", "Which one?**", "Which one?”", "Which one? "])
        expect(waitsOnWords([turn, said(text)], 0), text).toBe(true);
      expect(waitsOnWords([turn, said("That is done.")], 0)).toBe(false);
      // Work after the question does not take it back; a note does.
      const tool = entry(3, { kind: "tool", tool: "read_plan", ok: true, detail: "", edit: null });
      expect(waitsOnWords([turn, said("Which one?"), tool], 0)).toBe(true);
      expect(waitsOnWords([turn, said("Which one?"), entry(3, { kind: "note", text: "The chat ended: gone." })], 0)).toBe(
        false,
      );
    });

    it("sends the chat's box on Enter", async () => {
      const plan = await onSpec();
      // Shift+Enter is a new line, not a send.
      fireEvent.change(composer(), { target: { value: "ask me" } });
      fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });
      await settle();
      expect((await editingRead(plan.id)).conversation.some((line) => line.line.kind === "turn")).toBe(false);
      fireEvent.keyDown(composer(), { key: "Enter" });
      expect(await within(dock()).findByRole("group", { name: "How the queue is split" })).toBeTruthy();
    });

    it("sends from the round button in the box's corner as Enter does, muted until there is something to send", async () => {
      const plan = await onSpec();
      const send = within(dock()).getByRole("button", { name: "Send" }) as HTMLButtonElement;
      // Inside the box, beside what is typed.
      expect(send.closest(".composer-box")).toBe(composer().closest(".composer-box"));
      expect(send.disabled).toBe(true);
      fireEvent.change(composer(), { target: { value: "   " } });
      expect(send.disabled, "nothing but spaces is nothing to send").toBe(true);
      fireEvent.change(composer(), { target: { value: "tell me about the colours" } });
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(async () =>
        expect(
          (await editingRead(plan.id)).conversation.some(
            (line) => line.line.kind === "turn" && line.line.text === "tell me about the colours",
          ),
        ).toBe(true),
      );
      // Sent as Enter sends: the box is emptied, and the button muted again.
      expect(composer().value).toBe("");
      expect(send.disabled).toBe(true);
    });
  });

  it("stays visible and usable on the Spec, Explorer and Graph panes", async () => {
    const plan = await spoken();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    for (const name of ["Spec", "Explorer", "Impact"]) {
      fireEvent.click(pane(name));
      // The dock is beside the pane, not inside it, so it survives the switch.
      await waitFor(() => expect(dock()).toBeTruthy());
      expect(within(dock()).getByText("why two nodes?")).toBeTruthy();
      expect(composer().disabled).toBe(false);
      expect(screen.getByRole("button", { name: "Stop the chat" })).toBeTruthy();
    }
  });

  it("leaves the written spec with the person, and drafts only when they press the pane's button", async () => {
    // The interview writes the spec and stops there (D-102): the plan is the
    // person's to generate. So the turn that writes it leaves them on the
    // Spec pane, with the chat saying the spec is theirs to read and naming
    // the ways on — and the one press that drafts is at the foot of the Spec
    // pane, under the spec it drafts from, and nowhere else.
    const plan = await spoken();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    // The earlier turn over, and its last line's words in place of its dots.
    await waitFor(async () =>
      expect(((await sampleBridge.request({ kind: "snapshot" })).working ?? []).includes(plan.id)).toBe(false),
    );
    await waitFor(() => expect(dock().querySelector(".msg--speaking")).toBeNull());
    // The dock is the chat before the plan as after it — the head and the
    // name it is found by are the same word.
    expect(screen.getByRole("complementary", { name: "Chat" })).toBeTruthy();
    expect(within(dock()).getByText("Chat")).toBeTruthy();
    fireEvent.change(composer(), { target: { value: "please write the spec" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    // Said while it was happening, too, on the status line: the spec is a pane
    // away.
    await within(dock()).findByText("Writing the spec…", {}, { timeout: 5000 });
    const note = await within(dock()).findByText(/^The spec is written/, {}, { timeout: 5000 });
    // Nothing was drafted and nothing moved: they are still on the spec.
    expect(location.hash).toMatch(/^#planning\/[^/]+\/spec$/);
    expect((await editingRead(plan.id)).key).toBeNull();
    // Words, and no press: not on the note, and nowhere else in the chat.
    expect(within(note).queryByRole("button", { name: "Generate plan" })).toBeNull();
    expect(within(dock()).queryByRole("button", { name: "Generate plan" })).toBeNull();
    // And the pane beside the chat says the same thing over its own button:
    // the spec came from the interview, and reading it comes before drafting.
    expect(
      await screen.findByText(/^The chat has drafted the spec/, {}, { timeout: 5000 }),
    ).toBeTruthy();

    // The press is the pane's, and it is theirs.
    const press = screen.getByRole("button", { name: "Generate plan" }) as HTMLButtonElement;
    expect(press.closest('[role="complementary"]'), "at the foot of the spec").toBeNull();
    fireEvent.click(press);
    await waitFor(
      () => expect(location.hash).toMatch(/^#planning\/[^/]+\/(graph|criteria)$/),
      { timeout: 5000 },
    );
    expect((await editingRead(plan.id)).key).not.toBeNull();
    // The note stays in the conversation to be read, behind the line that
    // opens the chat from before the plan.
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Chat" })).toBeTruthy(),
    );
    expect(within(dock()).getByText("Chat")).toBeTruthy();
    fireEvent.click(await within(dock()).findByRole("button", { name: /^Show the earlier chat/ }));
    expect(within(dock()).getByText(/^The spec is written/)).toBeTruthy();
  });

  it("hands the spec over mid-turn, with nothing under the note saying the session is working", async () => {
    // The write lands and the session goes on composing — often for as long
    // again — and what the person is waiting for is readable already. So the
    // chat says so then, and while that note is the last thing said it is the
    // whole status: no line under it saying work is in hand, because nothing
    // more is owed before the person may act on it (D-102).
    const plan = await spoken();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "please write the spec" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    // The working line is there while the session is writing, which is what
    // makes its absence under the note mean something.
    await waitFor(() => expect(dock().querySelector(".chat-working")).not.toBeNull());
    const note = await within(dock()).findByText(/^The spec is written/, {}, { timeout: 5000 });

    // Mid-turn: the session still owes the person the rest of its answer.
    expect(
      ((await sampleBridge.request({ kind: "snapshot" })).working ?? []).includes(plan.id),
      "said before the turn is over, not at its end",
    ).toBe(true);
    expect(dock().querySelector(".chat-working"), "the note is the status").toBeNull();
    expect(within(dock()).queryByText("Thinking…")).toBeNull();
    // And the way on is the Spec pane's own button, not one in the chat.
    expect(within(note).queryByRole("button", { name: "Generate plan" })).toBeNull();
    expect(within(dock()).queryByRole("button", { name: "Generate plan" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Generate plan" }));
    await waitFor(
      () => expect(location.hash).toMatch(/^#planning\/[^/]+\/(graph|criteria)$/),
      { timeout: 5000 },
    );
    expect((await editingRead(plan.id)).key).not.toBeNull();
  });

  it("stops the interview and drafts the plan on one press", async () => {
    // The person who has read enough of the spec should not have to stop the
    // interview by hand and then press Generate plan: the press does both
    // (D-102). So a turn in flight leaves the button where it is, and the
    // press that lands the plan is what ends the conversation.
    const plan = await spoken();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "please write the spec" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await within(dock()).findByText(/^The spec is written/, {}, { timeout: 5000 });
    const press = (): HTMLButtonElement =>
      screen.getByRole("button", { name: "Generate plan" }) as HTMLButtonElement;
    await waitFor(() => expect(press().disabled).toBe(false), { timeout: 5000 });

    // A turn under way, which the pane reads off the snapshot: its button says
    // what the press will do rather than refusing it.
    fireEvent.change(composer(), { target: { value: "one more thing" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await screen.findByText(
      "The chat is still talking. Pressing stops it and drafts the plan from the spec as it stands.",
      {},
      { timeout: 5000 },
    );
    expect(press().disabled).toBe(false);

    // One press, and it does both: the interview is stopped and the plan is
    // drafted from the spec that turn left behind.
    fireEvent.click(press());
    await waitFor(
      () => expect(location.hash).toMatch(/^#planning\/[^/]+\/(graph|criteria)$/),
      { timeout: 5000 },
    );
    expect((await editingRead(plan.id)).key).not.toBeNull();
    const after = await sampleBridge.request({ kind: "snapshot" });
    expect(after.interviews ?? []).not.toContain(plan.id);
    expect(after.working ?? []).not.toContain(plan.id);
    expect(within(dock()).getByText("not running")).toBeTruthy();
  });

  it("says why the drafter refused a spec the chat rewrote, and drafts on the next press once it is put right", async () => {
    // A planning started with a first message, whose spec the chat writes and
    // then rewrites on a later turn — here with Requirements the pane reads
    // and the drafter does not. The press is refused, and the refusal is said
    // on the pane the press was made from; the planning stays editable, so
    // once the chat has put the spec right the next press drafts the plan.
    const opened = await openFresh();
    await sampleBridge.request({ kind: "interviewTurn", id: opened.id, text: "Can you add a dark mode toggle" });
    location.hash = `planning/${opened.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    await waitFor(async () =>
      expect(((await sampleBridge.request({ kind: "snapshot" })).working ?? []).includes(opened.id)).toBe(false),
    );
    say("please write the spec");
    await within(dock()).findByText(/^The spec is written/, {}, { timeout: 5000 });
    const press = (): HTMLButtonElement =>
      screen.getByRole("button", { name: "Generate plan" }) as HTMLButtonElement;
    await waitFor(() => expect(press().disabled).toBe(false), { timeout: 5000 });

    say("write the requirements");
    await waitFor(() => expect(screen.getByLabelText("Spec Requirements").textContent).toContain("R2. The choice"), {
      timeout: 5000,
    });
    await waitFor(() => expect(press().disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(press());
    // Said on the pane, not only on the working screen it hides once the job is over.
    await waitFor(
      () =>
        expect(
          screen
            .queryAllByText(/Requirements section names no requirement/)
            .filter((each) => each.closest(".spec-typed--away") === null),
        ).toHaveLength(1),
      { timeout: 5000 },
    );
    expect(location.hash).toBe(`#planning/${opened.id}/spec`);
    expect((await editingRead(opened.id)).key).toBeNull();

    say("please write the spec");
    // The rewrite lands 150 ms into the turn: pressed before it, the drafter
    // reads the Requirements the chat has not yet put right.
    await within(screen.getByLabelText("Spec Requirements")).findByText("R1", { selector: ".spec-req-id" }, { timeout: 5000 });
    await waitFor(() => expect(press().disabled).toBe(false), { timeout: 5000 });
    await waitFor(async () =>
      expect(((await sampleBridge.request({ kind: "snapshot" })).working ?? []).includes(opened.id)).toBe(false),
    { timeout: 5000 });
    fireEvent.click(press());
    await waitFor(
      () => expect(location.hash).toMatch(/^#planning\/[^/]+\/(graph|criteria)$/),
      { timeout: 5000 },
    );
    expect((await editingRead(opened.id)).key).not.toBeNull();
  });

  it("withholds Generate plan while a group of questions stands", async () => {
    // The Spec pane withholds Generate plan while a group the interview asked
    // is still in front of the person, because the answers change the spec it
    // would draft from (D-117) — otherwise the plan is drafted around a
    // question the person can still see on screen.
    const plan = await spoken();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "please write the spec" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await within(dock()).findByText(/^The spec is written/, {}, { timeout: 5000 });
    const press = (): HTMLButtonElement =>
      screen.getByRole("button", { name: "Generate plan" }) as HTMLButtonElement;
    await waitFor(() => expect(press().disabled).toBe(false), { timeout: 5000 });

    // A later turn puts questions up. The note is still in the conversation —
    // notes are not folded away — and the button goes with the card's arrival.
    fireEvent.change(composer(), { target: { value: "ask me" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    const first = within(
      await within(dock()).findByRole("group", { name: "How the queue is split" }, { timeout: 5000 }),
    );
    expect(within(dock()).getByText(/^The spec is written/)).toBeTruthy();
    await waitFor(() => expect(press().disabled).toBe(true));
    // And says why, under the button nobody can press.
    expect(
      screen.getByText("Answer the chat's questions first — its answers change the spec this drafts from."),
    ).toBeTruthy();

    // Answered, and the second group with it, and the press is theirs again.
    fireEvent.click(first.getByRole("radio", { name: /Split at the read/ }));
    fireEvent.click(first.getByRole("radio", { name: /A unit test per node/ }));
    fireEvent.click(first.getByRole("button", { name: "Send" }));
    const second = within(
      await within(dock()).findByRole("group", { name: "Question 2" }, { timeout: 5000 }),
    );
    fireEvent.click(second.getAllByRole("radio")[0]!);
    fireEvent.click(second.getByRole("button", { name: "Send" }));
    await waitFor(
      async () =>
        expect(
          (await editingRead(plan.id)).asking,
        ).toBeNull(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(press().disabled).toBe(false), { timeout: 5000 });
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
    fireEvent.keyDown(composer(), { key: "Enter" });
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
    fireEvent.keyDown(composer(), { key: "Enter" });
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
    // The count says how much is still queued; the titles say what it is about.
    expect(shown).toContain("about ");
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
    const bar = screen.getByRole("separator", { name: "Resize the chat" });
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
      screen.getByRole("separator", { name: "Resize the chat" }).getAttribute("aria-valuenow"),
    ).toBe("500");
    expect(localStorage.getItem("perbo:dock")).toBe("500");
  });

  it("holds the interview's width inside its bounds, and the keyboard moves it", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    const bar = () => screen.getByRole("separator", { name: "Resize the chat" });
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
    fireEvent.keyDown(composer(), { key: "Enter" });

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

    // Nothing goes until every part has an answer and the bar is pressed.
    fireEvent.click(within(dock()).getByRole("radio", { name: /Split at the read/ }));
    await settle();
    expect(within(dock()).getByRole("group", { name: "How the queue is split" })).toBeTruthy();
    expect(within(dock()).queryByText(/a\) Split at the read/)).toBeNull();
    fireEvent.click(within(dock()).getByRole("radio", { name: /A unit test per node/ }));
    fireEvent.click(first.getByRole("button", { name: "Send" }));

    // It went as the person's own turn, lettered as the parts were read.
    expect(await within(dock()).findByText(/a\) Split at the read/)).toBeTruthy();

    // Answering the first group brings the second.
    const second = await card("Question 2");
    expect(second.getByText("What happens to the old node?")).toBeTruthy();
    // The first is off the card, though the transcript still holds it behind
    // the dot on the line that says the asking happened.
    expect(second.queryByText("Where does the split go?")).toBeNull();
    expect(askedInTranscript()).toContain("Where does the split go?");
    // Its own two answers, the way out of choosing between them, and the way
    // to say the answer is none of them.
    expect(second.getAllByRole("radio")).toHaveLength(4);
    expect(second.getByText("Architect's call")).toBeTruthy();
    expect(second.getByText("Something else")).toBeTruthy();
    // The card is the only way to answer while one is up: their own words are
    // asked for on it, and the composer beside it stays away throughout.
    expect(composer().closest(".composer")?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(second.getByRole("radio", { name: /Something else/ }));
    const own = await second.findByLabelText("Your own words");
    expect(composer().closest(".composer")?.hasAttribute("hidden")).toBe(true);
    // And the box has the caret: saying the answer is not on the card is
    // already the start of typing it, so the next keystroke lands in the box
    // without a hand leaving the keyboard for the mouse.
    await waitFor(() => expect(document.activeElement).toBe(own));

    await waitFor(() => expect(within(dock()).getAllByText(/Noted:/)).toHaveLength(1));
  });

  it("gives each part of a group its own box, holds the bar until every one is said, and sends them lettered", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "ask me" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    const card = within(
      await within(dock()).findByRole("group", { name: "How the queue is split" }),
    );
    const turns = async (): Promise<number> =>
      (await editingRead(plan.id)).conversation.filter((line) => line.line.kind === "turn").length;
    const before = await turns();

    // One box a part, inside that part's own answer, and neither opens the
    // other's: the parts are answered together but said separately.
    expect(card.queryByLabelText("Your own words for 1a")).toBeNull();
    fireEvent.click(card.getAllByRole("radio", { name: /Something else/ })[0]!);
    const first = await card.findByLabelText("Your own words for 1a");
    expect(card.queryByLabelText("Your own words for 1b")).toBeNull();
    // The other part is still there to pick or to say, and the bar waits on it.
    const send = card.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    fireEvent.change(first, { target: { value: "Split at the queue instead" } });
    expect(send.disabled).toBe(true);
    fireEvent.click(card.getAllByRole("radio", { name: /Something else/ })[1]!);
    const secondBox = await card.findByLabelText("Your own words for 1b");
    // Whitespace is not an answer: a box with nothing said in it holds the
    // group as an unpicked part does.
    fireEvent.change(secondBox, { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    await settle();
    expect(await turns()).toBe(before);
    // Said over two lines and sent as one: a newline in a part would read as
    // a part that was never answered and take the group's answer down with it.
    fireEvent.change(secondBox, { target: { value: "  an end-to-end\n  test of the read  " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    // Down as the person's turn, a line a part, lettered as they were read.
    await waitFor(async () => {
      const session = await editingRead(plan.id);
      expect(
        session.conversation.some(
          (line) =>
            line.line.kind === "turn" &&
            line.line.text === "a) Split at the queue instead\nb) an end-to-end test of the read",
        ),
      ).toBe(true);
    });
    // And it is the group's answer, so the second group follows it.
    await within(dock()).findByRole("group", { name: "Question 2" });
  });

  it("keeps the questions a size of their own, which the bar on its edge sets", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "ask me" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    const card = await within(dock()).findByRole("group", { name: "How the queue is split" });
    expect(card.style.height).toBe(`${DEFAULT_ASKED_HEIGHT}px`);

    // Opening a part's box does not make the card taller: the answers are the
    // part of it that scrolls, and the room comes from the bar on its edge.
    fireEvent.click(within(card).getAllByRole("radio", { name: /Something else/ })[0]!);
    await within(card).findByLabelText("Your own words for 1a");
    expect(card.style.height).toBe(`${DEFAULT_ASKED_HEIGHT}px`);

    // The bar on its top edge sets the height; dragging up makes it taller.
    const bar = within(dock()).getByRole("separator", { name: "Resize the questions" });
    fireEvent.keyDown(bar, { key: "ArrowUp" });
    await waitFor(() => expect(card.style.height).toBe(`${DEFAULT_ASKED_HEIGHT + 16}px`));
    fireEvent.keyDown(bar, { key: "ArrowDown" });
    await waitFor(() => expect(card.style.height).toBe(`${DEFAULT_ASKED_HEIGHT}px`));
    expect(localStorage.getItem("perbo:asked")).toBe(String(DEFAULT_ASKED_HEIGHT));
  });

  it("puts the session's own recommendation at the top of a part's answers", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "ask me" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    const card = within(
      await within(dock()).findByRole("group", { name: "How the queue is split" }),
    );

    // The sample offers "Split at the read" second-to-none but marks it the
    // recommendation; a person reads the top of a list, so it is put there.
    const first = card.getAllByRole("radio")[0]!;
    expect(first.closest("label")?.textContent).toContain("Split at the read");
    expect(first.closest("label")?.textContent).toContain("recommended");
    // The two standing answers come last, as a pair: Something else on the
    // left, the interview's own judgement on the right.
    const labels = card.getAllByRole("radio").map((radio) => radio.closest("label")?.textContent ?? "");
    expect(labels.at(-2)).toContain("Something else");
    expect(labels.at(-1)).toContain("Architect's call");
  });

  it("takes the questions away once the person says something of their own on a lone part", async () => {
    // A turn that is not the group's answer ends the asking: the session
    // answers what was said instead, and a card left standing would answer a
    // question nobody is asking any more. A group of one part has no letter
    // to hang its own words off, so what it sends is a sentence like any
    // other and the asking ends — which is what puts an unclosed problem
    // between the plan and the spec again.
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    fireEvent.change(composer(), { target: { value: "ask me" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    const first = within(await within(dock()).findByRole("group", { name: "How the queue is split" }));
    fireEvent.click(first.getByRole("radio", { name: /Split at the read/ }));
    fireEvent.click(first.getByRole("radio", { name: /A unit test per node/ }));
    fireEvent.click(first.getByRole("button", { name: "Send" }));

    // The second group is one part, and its box is where their own words go.
    const second = within(await within(dock()).findByRole("group", { name: "Question 2" }));
    fireEvent.click(second.getByRole("radio", { name: /Something else/ }));
    fireEvent.change(await second.findByLabelText("Your own words"), {
      target: { value: "what do you mean by split?" },
    });
    fireEvent.click(second.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(within(dock()).queryByRole("group", { name: "Question 2" })).toBeNull(),
    );
    // Bare and unlettered, which is what tells it from the group's answer.
    await waitFor(async () => {
      const session = await editingRead(plan.id);
      expect(
        session.conversation.some(
          (line) => line.line.kind === "turn" && line.line.text === "what do you mean by split?",
        ),
      ).toBe(true);
    });
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

    await sampleBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
    await sampleBridge.request({
      kind: "interviewTurn",
      id: plan.id,
      text: "take your time: what is this piece of work for?",
    });
    expect((await within(dock()).findAllByText(WORKING)).length).toBeGreaterThan(0);

    // It speaks, and then says nothing for a while. The turn is not over, so
    // the dock is still saying so — which is the whole point: the lines alone
    // would read as a session that had finished.
    await within(dock()).findByText(/Nothing here sets a colour mode yet/);
    expect((await within(dock()).findAllByText(WORKING)).length).toBeGreaterThan(0);

    // The rest of the turn lands, and only then does it stop saying it.
    await within(dock()).findByText(/Noted:/, {}, { timeout: 5000 });
    await waitFor(() => expect(within(dock()).queryAllByText(WORKING)).toHaveLength(0));
  });

  it("stops saying it is working when the interview is stopped mid-turn", async () => {
    // Something going wrong, or the person deciding not to wait, is the one
    // case the indicator must not sit through: nothing is coming.
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    await sampleBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: plan.id });
    await sampleBridge.request({ kind: "interviewTurn", id: plan.id, text: "why two nodes?" });
    expect((await within(dock()).findAllByText(WORKING)).length).toBeGreaterThan(0);

    await sampleBridge.request({ kind: "interviewStop", id: plan.id });
    await waitFor(() => expect(within(dock()).queryAllByText(WORKING)).toHaveLength(0));
    // And the turn it was in the middle of still lands without bringing it back.
    await within(dock()).findByText(/Noted:/);
    expect(within(dock()).queryAllByText(WORKING)).toHaveLength(0);
  });

  it("says the interview is working until its answer lands", async () => {
    const plan = await planning();
    location.hash = `planning/${plan.id}/spec`;
    mount();
    await screen.findByLabelText("Spec title");
    // Nothing is waited for before a turn is sent.
    expect(within(dock()).queryAllByText(WORKING)).toHaveLength(0);

    fireEvent.change(composer(), { target: { value: "split the queue node" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect((await within(dock()).findAllByText(WORKING)).length).toBeGreaterThan(0);

    // The answer takes it away and leaves the turn with the person again.
    expect(await within(dock()).findByText(/Noted: “split the queue node”/)).toBeTruthy();
    await waitFor(() => expect(within(dock()).queryAllByText(WORKING)).toHaveLength(0));
  });

  it("names the spec from the person's first turn when the planning has none", async () => {
    // The interview writes specs/<slug>/spec.md, so a planning with no slug
    // has nowhere to write. The person's own first message names it rather
    // than the turn being refused.
    const opened = await openFresh();
    location.hash = `planning/${opened.id}/graph`;
    mount();
    await screen.findByLabelText("Message the chat");
    fireEvent.change(composer(), { target: { value: "Can you add a dark mode toggle" } });
    fireEvent.keyDown(composer(), { key: "Enter" });

    expect(
      await within(dock()).findByText(/Named specs\/dark-mode-toggle from your first message/),
    ).toBeTruthy();
    // The turn was heard: the session answers it, and the composer is ready
    // for the next one.
    expect(await within(dock()).findByText(/Noted:/)).toBeTruthy();
    await waitFor(() => expect(composer().value).toBe(""));
    const after = await sampleBridge.request({ kind: "editingRead", id: opened.id });
    expect(after.specSlug).toBe("dark-mode-toggle");
  });

  it("shows the spec the interview wrote without being left and come back to", async () => {
    // The interview writes this same file, in its own process, so a pane that
    // read it only when it mounted would show a person watching the chat write
    // their spec an empty pane until they left for another and returned
    // (D-102, D-103).
    const opened = await openFresh();
    location.hash = `planning/${opened.id}/spec`;
    mount();
    const title = (await screen.findByLabelText("Spec title")) as HTMLInputElement;
    expect(title.value, "nothing written yet").toBe("");

    fireEvent.change(composer(), { target: { value: "Can you add a dark mode toggle" } });
    fireEvent.keyDown(composer(), { key: "Enter" });

    // On this pane, never remounted and never navigated away from.
    await waitFor(
      () =>
        expect((screen.getByLabelText("Spec title") as HTMLInputElement).value).toBe(
          "Dark mode toggle",
        ),
      { timeout: 5000 },
    );
  });

  it("keeps the turn in the composer when no folder name can come from it", async () => {
    // A message with no letters or digits names nothing, so the refusal still
    // stands and retyping it is not the person's job.
    const opened = await openFresh();
    location.hash = `planning/${opened.id}/graph`;
    mount();
    await screen.findByLabelText("Message the chat");
    fireEvent.change(composer(), { target: { value: "?!?!" } });
    fireEvent.keyDown(composer(), { key: "Enter" });

    expect(await within(dock()).findByText(/spec title first/)).toBeTruthy();
    await waitFor(() => expect(composer().value).toBe("?!?!"));
  });

  // The refused arm of the same rule. A call that worked is dropped for saying
  // what the graph already says; one that was refused is said nowhere else —
  // no `asked` follows a rejected call — so dropping it too would leave the
  // dock on "Working…" and then nothing at all.
  it("keeps a refused tool card, and shows its reason without asking", async () => {
    const session = await planning();
    location.hash = `planning/${session.id}/spec`;
    mount();
    await screen.findByLabelText("Message the chat");
    fireEvent.change(composer(), { target: { value: "refuse it" } });
    fireEvent.keyDown(composer(), { key: "Enter" });

    // Named for what it tried rather than what it did: it never happened.
    expect(await within(dock()).findByText("Changing the plan")).toBeTruthy();
    // The reason is on the page, not behind the i: it is the thing to act on,
    // in one line under the name, its first sentence.
    expect(within(dock()).getByText("Refused: node_404 is not in this plan.")).toBeTruthy();
    expect(
      within(dock()).queryByRole("button", { name: /^What happened/ }),
    ).toBeNull();
    // And the turn ended, so the dock is not left saying it is working.
    await waitFor(() => expect(within(dock()).queryByText("Working…")).toBeNull());
  });

  it("takes a card away once a later edit puts its undo out of reach", async () => {
    const session = await planning();
    const current = await sampleBridge.request({ kind: "editingRead", id: session.id });
    await sampleBridge.request({
      kind: "editingSubmit",
      id: session.id,
      revision: current.revision,
      operationId: crypto.randomUUID(),
      intent: "generate",
    });
    let key: string | null = null;
    await waitFor(
      async () => {
        key = (await sampleBridge.request({ kind: "editingRead", id: session.id })).key;
        expect(key).not.toBeNull();
      },
      { timeout: 5000 },
    );

    // Over the Spec pane, where neither the Graph pane nor the drawer is there
    // to follow the records for it.
    location.hash = `planning/${session.id}/spec`;
    mount();
    await screen.findByLabelText("Message the chat");
    // Two turns: the interview answers the first and edits the plan on the
    // second, which is the edit the card offers to undo.
    for (const text of ["what is this for?", "tighten the first criterion"]) {
      fireEvent.change(composer(), { target: { value: text } });
      fireEvent.keyDown(composer(), { key: "Enter" });
      await waitFor(() => expect(composer().value).toBe(""));
    }
    expect(await within(dock()).findByRole("button", { name: /^Undo/ })).toBeTruthy();
    expect(within(dock()).getByText("Changed the plan")).toBeTruthy();
    // One line, with the undo on it: what the edit changed is on the graph
    // and in the spec, where it is read, so the card does not say it again.
    const card = within(dock()).getByText("Changed the plan").closest(".tool-card")!;
    expect([...card.children].map((child) => child.className)).toEqual(["tool-head"]);
    expect(within(card.querySelector<HTMLElement>(".tool-head")!).getByRole("button", { name: /^Undo/ })).toBeTruthy();

    // A hand edit lands after it, which D-100 says an undo may not reach past.
    const plan = { repoId: session.repoId, key: key! };
    const graph = await sampleBridge.request({ kind: "graphRead", ...plan });
    const second = graph.criteria[1]!;
    await sampleBridge.request({
      kind: "graphEdit",
      ...plan,
      edit: {
        op: "set_criterion",
        id: second.id,
        text: `${second.text} — by hand`,
        expected_verification: { kind: second.kind, assertion: second.assertion },
      },
    });
    // The card asks the plan rather than the snapshot it was drawn from. With
    // the undo out of reach it carries nothing the graph does not already show,
    // so the whole card goes rather than the button alone — asserted on the
    // card's own name, since a missing button cannot tell the two apart.
    await waitFor(() =>
      expect(within(dock()).queryByRole("button", { name: /^Undo/ })).toBeNull(),
    );
    expect(within(dock()).queryByText("Changed the plan")).toBeNull();
    // The conversation it was standing in is untouched: what goes is the panel,
    // not the turns around it.
    expect(within(dock()).getAllByText(/tighten the first criterion/).length).toBeGreaterThan(0);
  });

  // The other arm of the same rule. A card is kept or dropped by which tool
  // made it, and an undo is the only word that a change was taken back: it is
  // said nowhere else, and may not be dropped for being a tool call that
  // worked.
  it("keeps the undo, which is said nowhere else", async () => {
    const session = await planning();
    const current = await sampleBridge.request({ kind: "editingRead", id: session.id });
    await sampleBridge.request({
      kind: "editingSubmit",
      id: session.id,
      revision: current.revision,
      operationId: crypto.randomUUID(),
      intent: "generate",
    });
    await waitFor(
      async () =>
        expect((await sampleBridge.request({ kind: "editingRead", id: session.id })).key).not.toBeNull(),
      { timeout: 5000 },
    );
    location.hash = `planning/${session.id}/spec`;
    mount();
    await screen.findByLabelText("Message the chat");

    const say = async (text: string): Promise<void> => {
      fireEvent.change(composer(), { target: { value: text } });
      fireEvent.keyDown(composer(), { key: "Enter" });
      await waitFor(() => expect(composer().value).toBe(""));
    };
    // A turn to get past the refusal the sample opens with, then an edit, so
    // there is something for the undo to take back.
    await say("what is this for?");
    await say("tighten the first criterion");
    expect(await within(dock()).findByText("Changed the plan")).toBeTruthy();

    // The undo: kept, though no undo is ever offered on an undo's own card —
    // the plan's history refuses to undo one, so it can never be the edit the
    // card's button points at, and a rule that kept only those would lose it.
    await say("take it back");
    expect(await within(dock()).findByText("Took a change back")).toBeTruthy();
    // And the edit it took back is gone from the chat with its undo, while the
    // undo's own card is still there.
    await waitFor(() => expect(within(dock()).queryByText("Changed the plan")).toBeNull());
    expect(within(dock()).getByText("Took a change back")).toBeTruthy();
  });

  it("opens the plan's history over the pane, with the chat still beside it", async () => {
    // A plan with an edit of each author, both through the one edit path.
    const session = await planning();
    const current = await sampleBridge.request({ kind: "editingRead", id: session.id });
    await sampleBridge.request({
      kind: "editingSubmit",
      id: session.id,
      revision: current.revision,
      operationId: crypto.randomUUID(),
      intent: "generate",
    });
    let key: string | null = null;
    await waitFor(
      async () => {
        key = (await sampleBridge.request({ kind: "editingRead", id: session.id })).key;
        expect(key).not.toBeNull();
      },
      { timeout: 5000 },
    );
    const plan = { repoId: session.repoId, key: key! };
    const drafted = await sampleBridge.request({ kind: "graphRead", ...plan });
    const second = drafted.criteria[1]!;
    await sampleBridge.request({
      kind: "graphEdit",
      ...plan,
      edit: {
        op: "set_criterion",
        id: second.id,
        text: `${second.text} — said again`,
        expected_verification: { kind: second.kind, assertion: second.assertion },
      },
    });
    // The sample host answers an edit as a job, so the hand edit is first in
    // the log only once it has settled.
    await waitFor(async () =>
      expect(
        (await sampleBridge.request({ kind: "graphRead", ...plan })).history,
      ).toHaveLength(1),
    );
    await sampleBridge.request({ kind: "interviewStart", repoId: plan.repoId, id: session.id });
    await sampleBridge.request({ kind: "interviewTurn", id: session.id, text: "one" });
    await sampleBridge.request({ kind: "interviewTurn", id: session.id, text: "and make it 60 seconds" });
    await waitFor(async () =>
      expect(
        (await sampleBridge.request({ kind: "graphRead", ...plan })).history.map(
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
    expect(within(drawer).getAllByText("The Architect").length).toBeGreaterThan(0);
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

    restart(`planning/${plan.id}/spec`);
    await screen.findByLabelText("Spec title");
    expect(await within(dock()).findByText("why two nodes?")).toBeTruthy();
    expect(await within(dock()).findByRole("note", { name: "Refused" })).toBeTruthy();
  });

  describe("the chat's dots, its send bar, its box, its questions, its edit cards and its edge", () => {
    /** The renderer's own stylesheet, laid over the document for the length of `during`. */
    async function styled(during: () => Promise<void>): Promise<void> {
      const style = document.createElement("style");
      style.textContent = stylesheet();
      document.head.append(style);
      try {
        await during();
      } finally {
        style.remove();
      }
    }
    const turns = async (id: string): Promise<string[]> =>
      (await editingRead(id)).conversation.flatMap((line) => (line.line.kind === "turn" ? [line.line.text] : []));

    it("puts no dots before a line the host is not holding: its words are up as they arrive", async () => {
      await onSpec();
      // Two lines in one turn, the second 60 ms after the first, and the host
      // holding neither: the dots are for a line on its way, and these are here.
      const first = "Nothing here sets a colour mode yet.";
      const seen: { dots: number; text: string }[] = [];
      const watch = new MutationObserver(() =>
        seen.push({
          dots: dock().querySelectorAll(".msg--speaking .speaking-dots").length,
          text: dock().querySelector(".chat")?.textContent ?? "",
        }),
      );
      watch.observe(dock(), { childList: true, subtree: true, characterData: true });
      try {
        say("tell me about the colours");
        await within(dock()).findByText(/^Noted: /, {}, { timeout: 5000 });
      } finally {
        watch.disconnect();
      }
      expect(seen.some((frame) => frame.text.includes(first)), "the first line was drawn").toBe(true);
      expect(seen.some((frame) => frame.dots > 0)).toBe(false);
    });

    it("sends a group only from the bar at its foot, once every part is answered", async () => {
      const plan = await onSpec();
      say("ask me");
      const group = await within(dock()).findByRole("group", { name: "How the queue is split" });
      const card = within(group);
      // One bar, across the card's foot, the round arrow at its right.
      const send = card.getByRole("button", { name: "Send" }) as HTMLButtonElement;
      expect(send.closest(".asked-bar")?.parentElement).toBe(group);
      expect(group.lastElementChild).toBe(send.closest(".asked-bar"));
      expect(send.disabled).toBe(true);
      const before = await turns(plan.id);
      // Every part picked is not a send: nothing goes until the bar is pressed.
      fireEvent.click(card.getByRole("radio", { name: /Split at the read/ }));
      expect(send.disabled, "one part of two").toBe(true);
      fireEvent.click(card.getByRole("radio", { name: /A unit test per node/ }));
      expect(send.disabled, "both parts picked").toBe(false);
      await settle();
      expect(await turns(plan.id)).toEqual(before);
      // Their own words for a part, which need words before the bar goes.
      fireEvent.click(card.getAllByRole("radio", { name: /Something else/ })[1]!);
      const box = await card.findByLabelText("Your own words for 1b");
      expect(send.disabled, "Something else needs its words").toBe(true);
      fireEvent.change(box, { target: { value: "an end-to-end test" } });
      expect(send.disabled).toBe(false);
      // Enter in the box is the box's own: it sends nothing.
      expect(fireEvent.keyDown(box, { key: "Enter" }), "Enter is left to the box").toBe(true);
      await settle();
      expect(await turns(plan.id)).toEqual(before);
      expect(within(dock()).getByRole("group", { name: "How the queue is split" })).toBe(group);
      fireEvent.click(send);
      await waitFor(async () =>
        expect(await turns(plan.id)).toEqual([...before, "a) Split at the read\nb) an end-to-end test"]),
      );
      await within(dock()).findByRole("group", { name: "Question 2" });
    });

    it("opens Something else without scrolling anything but the card's own answers", async () => {
      await onSpec();
      say("ask me");
      const group = await within(dock()).findByRole("group", { name: "How the queue is split" });
      await styled(async () => {
        // The pair's radio, which the click on its answer focuses, is placed
        // against that answer: held by the card instead, it stays where the
        // answers were before they scrolled, and focusing it scrolls the page.
        const pair = within(group).getAllByRole("radio", { name: /Something else/ })[1]!.closest("label")!;
        expect(getComputedStyle(pair).position).toBe("relative");
      });
      // And the box takes the caret without scrolling anything around it.
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      try {
        fireEvent.click(within(group).getAllByRole("radio", { name: /Something else/ })[1]!);
        const box = await within(group).findByLabelText("Your own words for 1b");
        await waitFor(() => expect(document.activeElement).toBe(box));
        const calls = focus.mock.contexts.flatMap((context, at) => (context === box ? [focus.mock.calls[at]] : []));
        expect(calls).toEqual([[{ preventScroll: true }]]);
      } finally {
        focus.mockRestore();
      }
    });

    it("leaves room in the chat's box for the ink of its first letter", async () => {
      await onSpec();
      await styled(async () => {
        // A textarea clips at its padding edge: with none, a T or a W lost
        // its left edge. The room is given back by the margin, so the words
        // sit where they did.
        const style = getComputedStyle(composer());
        expect(style.paddingInline).toBe("4px");
        expect(style.marginInline).toBe("-4px");
        expect(style.width).toBe("calc(100% + 8px)");
      });
    });

    it("reads each part's question at its answers' size, lettered in a muted label, with room between parts", async () => {
      await onSpec();
      say("ask me");
      const group = await within(dock()).findByRole("group", { name: "How the queue is split" });
      await styled(async () => {
        const [first, second] = [...group.querySelectorAll("legend")] as HTMLElement[];
        const answer = group.querySelector(".choice strong")!;
        expect(getComputedStyle(first!).fontSize).toBe(getComputedStyle(answer).fontSize);
        expect(first!.textContent).toBe("1a)Where does the split go?");
        expect(getComputedStyle(first!.querySelector(".asked-letter")!).color).toBe("var(--muted)");
        expect(getComputedStyle(group.querySelector(".asked-body")!).gap).toBe("24px");
        expect(second!.textContent).toBe("1b)What proves it?");
      });
    });

    it("puts a plan edit's card on one line, and a refused one's reason in one short line under it", async () => {
      await onSpec();
      say("refuse it");
      const name = await within(dock()).findByText("Changing the plan");
      const card = name.closest(".tool-card")!;
      // The name, then one line: no account of what it was changing, and no
      // word for which part of the app refused it.
      expect([...card.children].map((child) => child.className)).toEqual(["tool-head", "tool-why"]);
      expect(card.querySelector(".tool-why")?.textContent).toBe("Refused: node_404 is not in this plan.");
      expect(card.textContent).not.toContain("edit path");
      await styled(async () => {
        const why = getComputedStyle(card.querySelector(".tool-why")!);
        expect([why.whiteSpace, why.overflow, why.textOverflow]).toEqual(["nowrap", "hidden", "ellipsis"]);
      });
      // The first sentence, wherever it ends, and all of it where there is one.
      expect(firstSentence("this changes what PRB-9 promises — specs/x/spec.md does not say so. Write the spec first.")).toBe(
        "this changes what PRB-9 promises — specs/x/spec.md does not say so.",
      );
      expect(firstSentence("  no stop at all\n  here ")).toBe("no stop at all here");
    });

    it("lights the chat's edge for a pointer that reaches for it, and not for one dragging across it", async () => {
      await onSpec();
      const bar = screen.getByRole("separator", { name: "Resize the chat" });
      const lit = (): boolean => bar.classList.contains("dock-handle--hover");
      // A text selection in the spec, dragged over the edge with its button held.
      fireEvent.pointerEnter(bar, { buttons: 1 });
      expect(lit()).toBe(false);
      fireEvent.pointerMove(bar, { buttons: 1, pointerId: 2, clientX: 700 });
      expect(lit()).toBe(false);
      expect(dock().style.width, "a pointer it did not start on does not move it").not.toBe("500px");
      fireEvent.pointerLeave(bar);
      // A pointer with nothing held.
      fireEvent.pointerEnter(bar, { buttons: 0 });
      expect(lit()).toBe(true);
      fireEvent.pointerLeave(bar);
      expect(lit()).toBe(false);
      // The highlight is the class's, not `:hover`'s, which a held button crossing it also matches.
      await styled(async () => {
        const selectors = [...document.styleSheets].flatMap((sheet) =>
          [...sheet.cssRules].map((rule) => (rule as CSSStyleRule).selectorText ?? ""),
        );
        expect(selectors.some((selector) => selector.includes(".dock-handle:hover"))).toBe(false);
        expect(selectors.some((selector) => selector.includes(".dock-handle--hover"))).toBe(true);
      });
      // And a drag that starts on the edge still resizes the chat.
      Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
      fireEvent.pointerDown(bar, { button: 0, buttons: 1, pointerId: 1 });
      fireEvent.pointerMove(bar, { buttons: 1, pointerId: 1, clientX: 700 });
      await waitFor(() => expect(dock().style.width).toBe("500px"));
      fireEvent.pointerUp(bar, { pointerId: 1 });
    });
  });
});

/**
 * The Impact pane (SCP-320, D-015): what this draft is likely to touch that its
 * scope does not cover, listed when a person asks for it, with each warning
 * turnable into the draft's own scope mark or the spec's own No-Go.
 *
 * Driven here through the real renderer against the sample host, which
 * computes the same report from the same `@perbo/planning` code the native
 * host runs.
 */
describe("the Impact pane (SCP-320)", () => {
  const openPane = async (name: string): Promise<void> => {
    fireEvent.click(pane(name));
  };
  /** Planning in one repository, with `paths` as the draft's declared scope. */
  const planningOver = async (repository: RegExp, paths: string[]): Promise<void> => {
    await startPlanning(repository);
    const opened = await session();
    await sampleBridge.request({
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

  // A plan is the thing impact is measured against, so the plan arriving is the
  // question being asked. Somebody who has just had one drafted and opens this
  // pane wants what it disturbs, not a button that will tell them.
  it("asks once on its own when the planning has a plan, and not again", async () => {
    const asked = vi.spyOn(sampleBridge, "request");
    const runs = (): number =>
      asked.mock.calls.filter(([request]) => request.kind === "impactRead").length;
    try {
      await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
      const opened = await session();
      expect(runs()).toBe(0);
      // A plan needs a spec to be drafted from, through the host as the Spec
      // pane's own Generate does.
      await sampleBridge.request({
        kind: "specSave",
        id: opened.id,
        repoId: opened.repoId,
        title: "A light colour mode",
        sections: {
          outcome: "The application supports a usable light colour mode.",
          requirements: "- The person can choose Light, Dark or System without a restart.",
          no_gos: "",
          rabbit_holes: "",
          notes: "",
        },
        base: NOTHING_YET,
      });
      const withSpec = await session();
      await sampleBridge.request({
        kind: "editingSubmit",
        id: withSpec.id,
        revision: withSpec.revision,
        operationId: crypto.randomUUID(),
        intent: "generate",
      });
      const planned = await waitFor(
        async () => {
          const current = await session();
          expect(current.key).not.toBeNull();
          return current;
        },
        { timeout: 5000 },
      );
      // A plan landing takes the person to it, which is the whole point of
      // that landing; this pane is what the test is about, so it comes back —
      // through the rail, the way a person would.
      await waitFor(() => expect(location.hash).toMatch(/\/(graph|criteria)$/), { timeout: 5000 });
      void planned;
      fireEvent.click(pane("Impact"));
      // No button was pressed, and the answer arrives.
      await waitFor(() => expect(runs()).toBeGreaterThan(0), { timeout: 5000 });
      await waitFor(() => expect(screen.queryByText("not checked yet")).toBeNull());
      const once = runs();
      // And it is asked once: the answer is a whole `perbo index` over the
      // tracked tree, so a re-render is not a reason to run it again.
      await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy());
      expect(runs()).toBe(once);
    } finally {
      asked.mockRestore();
    }
  });

  // A person settles a plan from whichever pane answered their last question,
  // so the way onward is on all three rather than only on the Graph. It
  // confirms and never approves: the contract is the page that states what
  // freezes, and it carries the one approval there is.
  it.each(["Impact", "Explorer"])("offers the way to the contract from %s", async (pane) => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    // No plan yet, so there is nothing to confirm and the control is absent —
    // these panes are read while the work is still being described.
    await openPane(pane);
    expect(screen.queryByRole("button", { name: "Confirm the plan" })).toBeNull();

    const opened = await session();
    await sampleBridge.request({
      kind: "specSave",
      id: opened.id,
      repoId: opened.repoId,
      title: "A light colour mode",
      sections: {
        outcome: "The application supports a usable light colour mode.",
        requirements: "- The person can choose Light, Dark or System without a restart.",
        no_gos: "",
        rabbit_holes: "",
        notes: "",
      },
      base: NOTHING_YET,
    });
    const withSpec = await session();
    await sampleBridge.request({
      kind: "editingSubmit",
      id: withSpec.id,
      revision: withSpec.revision,
      operationId: crypto.randomUUID(),
      intent: "generate",
    });
    await waitFor(async () => expect((await session()).key).not.toBeNull(), { timeout: 5000 });

    await openPane(pane);
    // Read before the click: confirming leaves planning, and the session is
    // read off the route this is standing on.
    const key = (await session()).key!;
    fireEvent.click(await screen.findByRole("button", { name: "Confirm the plan" }));
    // The contract, and not an approval taken on a pane that never said what
    // it was freezing.
    await waitFor(() => expect(location.hash).toContain(`${key}/contract`));
  });

  it("sits last in the rail's planning panes, and asks for nothing until it is asked", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    // No plan has been drafted here, so there is no graph to offer and Impact
    // is last of the three that are.
    expect(railNames().slice(0, 6)).toEqual([
      "Create",
      "Spec",
      "Explorer",
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
      (await sampleBridge.request({ kind: "specRead", id: sessionId() })).sections.no_gos;
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
      (await sampleBridge.request({ kind: "specRead", id: sessionId() })).sections.no_gos;
    const button = (): HTMLButtonElement =>
      within(row("packages/auth/package.json")).getByRole("button", {
        name: "Add as a No-Go",
      }) as HTMLButtonElement;

    // Held so a second writer can land in between this action's own read and
    // its save — the window `base` exists to cover. `bridge` and `sampleBridge`
    // are the same object under the sample host, so the interview's own write
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
    expect((await sampleBridge.request({ kind: "specRead", id: sessionId() })).slug).toBeNull();
  });

  it("re-derives on each ask, so Check again answers the draft as it stands now", async () => {
    await planningOver(/example\/webstore/, ["packages/auth/src/**"]);
    await check();
    expect(row("packages/auth/package.json")).toBeTruthy();
    // The draft's scope moves under the pane. The report is held until it is
    // asked for again — it is a parse of the whole tree, not a subscription —
    // so nothing here has changed yet.
    const opened = await session();
    await sampleBridge.request({
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
    const asked = vi.spyOn(sampleBridge, "request");
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

describe("the name of a ticket drafted again from its spec (D-127)", () => {
  it("takes the stopped ticket's name, which is its spec's title, because the stopped ticket is deleted first", async () => {
    // A sample workspace of its own, because this deletes the stopped sample,
    // the one approved ticket with a spec the tests beside it read.
    vi.resetModules();
    const { sampleBridge: sample } = await import("../../sample-host/bridge.js");
    const before = await sample.request({ kind: "snapshot" });
    const stopped = before.tasks.find((task) => task.ticket.key === "PRB-415")!;
    expect(stopped.ticket.title).toBe("Retire the legacy CSV importer");
    // The spec it was drafted from, in the folder the setup above emptied.
    localStorage.setItem(
      "perbo:preview-specs",
      JSON.stringify({
        "retire-the-legacy-csv-importer": [
          "# Retire the legacy CSV importer",
          "",
          "## Outcome",
          "",
          "Every import goes through the current parser, and the legacy path is gone.",
          "",
          "## Requirements",
          "",
          "- An upload of either dialect is read by the current parser.",
          "",
        ].join("\n"),
      }),
    );
    await sample.request({ kind: "replan", repoId: stopped.repoId, key: "PRB-415" });
    const after = await sample.request({ kind: "snapshot" });
    const drafted = after.tasks.find(
      (task) => !before.tasks.some((each) => each.ticket.key === task.ticket.key),
    )!;
    // The plan it replaces is gone before this one is named, so no other
    // ticket carries the spec's title and the new plan is called by it.
    expect(after.tasks.some((task) => task.ticket.key === "PRB-415")).toBe(false);
    expect(drafted.ticket.title).toBe(stopped.ticket.title);
  });
});

describe("a planning deleted from the picker is gone at the click and stays gone", () => {
  it("leaves the planning and the spec it wrote off the list through every read the host answers before its delete has finished", async () => {
    const id = await startPlanning();
    const title = "Every export carries its month";
    const field = screen.getByLabelText("Spec title");
    fireEvent.change(field, { target: { value: title } });
    fireEvent.blur(field);
    await waitFor(async () => {
      const specs = (await sampleBridge.request({ kind: "snapshot" })).specs ?? [];
      expect(specs.map((spec) => spec.title)).toContain(title);
    }, { timeout: 5000 });
    await goHome();
    // The spec's title is on a whole snapshot, which names the planning's row.
    await client.invalidateQueries({ queryKey: ["workspace"] });
    const original = bridge.request.bind(bridge);
    // The host's delete is slow: held open here until released.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent = vi
      .spyOn(bridge, "request")
      .mockImplementation(((request: Parameters<typeof original>[0]) =>
        request.kind === "editingDiscard"
          ? held.then(() => original(request))
          : original(request)) as typeof bridge.request);
    try {
      const picker = await openPicker();
      const listed = (): HTMLElement[] =>
        within(screen.getByRole("dialog", { name: "Plan a piece of work" })).queryAllByRole("button", {
          name: new RegExp("^" + title),
        });
      await waitFor(() => expect(listed()).toHaveLength(1));
      fireEvent.click(within(picker).getByRole("button", { name: "Delete planning: " + title }));
      const asking = await screen.findByRole("dialog", { name: "Delete planning" });
      fireEvent.click(within(asking).getAllByRole("button", { name: "Delete planning" })[0]!);
      // Gone at the click, with the host's delete still in flight: not as the
      // planning, and not as the spec it wrote, which the host has not removed yet.
      expect(listed()).toHaveLength(0);
      expect(sent.mock.calls.some(([request]) => request.kind === "editingDiscard" && request.id === id)).toBe(true);
      // Reads land while the delete runs — a change to the planning, which
      // re-reads the drafts, and a whole snapshot — and each still holds it.
      await sampleBridge.request({ kind: "editingVisited", id, pane: "explorer" });
      await client.invalidateQueries({ queryKey: ["workspace"] });
      await settle();
      const read = client.getQueryData<Snapshot>(["workspace"])!;
      expect(read.drafts?.some((draft) => draft.id === id), "the read still holds the planning").toBe(true);
      expect(listed()).toHaveLength(0);
      // And once the host has finished, it stays gone.
      release!();
      await waitFor(async () => expect((await editingRead(id)).phase).toBe("discarded"));
      await settle();
      await client.invalidateQueries({ queryKey: ["workspace"] });
      expect(listed()).toHaveLength(0);
    } finally {
      sent.mockRestore();
    }
  });
});

describe("a picker delete the host refuses, or that settles behind a closed picker", () => {
  const title = "Every refund names its order";
  const REFUSED = "The spec folder could not be removed.";
  /** A planning that has written its spec, on Home, with the host's delete held until `release`. */
  async function planningWithHeldDelete(fails: boolean) {
    await startPlanning();
    const field = screen.getByLabelText("Spec title");
    fireEvent.change(field, { target: { value: title } });
    fireEvent.blur(field);
    await waitFor(async () => {
      const specs = (await sampleBridge.request({ kind: "snapshot" })).specs ?? [];
      expect(specs.map((spec) => spec.title)).toContain(title);
    }, { timeout: 5000 });
    await goHome();
    await client.invalidateQueries({ queryKey: ["workspace"] });
    const original = bridge.request.bind(bridge);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Reads held while `reads.held` is set, so what the picker shows before the
    // read after the delete lands can be looked at.
    const reads = { held: false, release: () => undefined as void, gate: Promise.resolve() };
    const holdReads = (): void => {
      reads.held = true;
      reads.gate = new Promise<void>((resolve) => {
        reads.release = () => {
          reads.held = false;
          resolve();
        };
      });
    };
    let answered: Promise<unknown> = Promise.resolve();
    const sent = vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) => {
      if (request.kind === "editingDiscard") {
        answered = held.then(() => (fails ? Promise.reject(new Error(REFUSED)) : original(request)));
        return answered;
      }
      if (reads.held && (request.kind === "snapshot" || request.kind === "drafts"))
        return reads.gate.then(() => original(request));
      return original(request);
    }) as typeof bridge.request);
    // Round trips that pass the held reads: `bridge` is the sample host's in a test.
    const around = async (): Promise<void> => {
      for (let round = 0; round < 3; round += 1) await original({ kind: "snapshot" });
    };
    return { release, sent, holdReads, reads, around, answered: () => answered.catch(() => undefined) };
  }
  const bin = (kind: "planning" | "spec"): HTMLElement | null =>
    within(screen.getByRole("dialog", { name: "Plan a piece of work" })).queryByRole("button", {
      name: "Delete " + kind + ": " + title,
    });
  async function deleteFromPicker(): Promise<void> {
    const picker = await openPicker();
    fireEvent.click(await within(picker).findByRole("button", { name: "Delete planning: " + title }));
    const asking = await screen.findByRole("dialog", { name: "Delete planning" });
    fireEvent.click(within(asking).getAllByRole("button", { name: "Delete planning" })[0]!);
    expect(bin("planning")).toBeNull();
    expect(bin("spec")).toBeNull();
  }

  it("puts the planning back, not its spec as a row of its own, and says why", async () => {
    const delete_ = await planningWithHeldDelete(true);
    try {
      await deleteFromPicker();
      delete_.holdReads();
      delete_.release();
      await delete_.answered();
      // Said as soon as the host refuses, with the read after it still in flight:
      // the spec the planning wrote is not a row of its own meanwhile.
      await screen.findByText(REFUSED);
      await delete_.around();
      expect(bin("spec")).toBeNull();
      expect(bin("planning")).toBeNull();
      delete_.reads.release();
      await waitFor(() => expect(bin("planning")).not.toBeNull());
      expect(bin("spec")).toBeNull();
      expect(screen.getByText(REFUSED)).toBeTruthy();
    } finally {
      delete_.sent.mockRestore();
    }
  });

  for (const fails of [false, true])
    it(fails ? "reports a delete refused behind a closed picker when it opens again" : "keeps a delete finished behind a closed picker gone when it opens again", async () => {
      const delete_ = await planningWithHeldDelete(fails);
      try {
        await deleteFromPicker();
        fireEvent.keyDown(window, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Plan a piece of work" })).toBeNull());
        delete_.release();
        await delete_.answered();
        await settle();
        await settle();
        await openPicker();
        if (fails) {
          await waitFor(() => expect(bin("planning")).not.toBeNull());
          expect(screen.getByText(REFUSED)).toBeTruthy();
        } else {
          expect(bin("planning")).toBeNull();
          expect(screen.queryByText(REFUSED)).toBeNull();
        }
        expect(bin("spec")).toBeNull();
      } finally {
        delete_.sent.mockRestore();
      }
    });
});

describe("the first writing of a spec is not a change (D-128)", () => {
  const marks = (root: ParentNode = document): string[] =>
    [...root.querySelectorAll(".change--added, .change--removed, ins, del")].map((mark) => mark.textContent ?? "");

  it("marks nothing the interview wrote into an empty spec, and marks a hand edit of it after", async () => {
    // A fresh planning, named, with every section of its spec still empty.
    const opened = await openFresh();
    const { id, repoId } = opened;
    await sampleBridge.request({
      kind: "specSave",
      id,
      repoId,
      title: "A month view",
      sections: NOTHING_YET.sections,
      base: NOTHING_YET,
    });
    // The interview writes the spec: words into a section that had none.
    await sampleBridge.request({ kind: "interviewStart", repoId, id });
    await sampleBridge.request({ kind: "interviewTurn", id, text: "please write the spec" });
    await waitFor(
      async () => expect((await sampleBridge.request({ kind: "snapshot" })).working ?? []).not.toContain(id),
      { timeout: 5000 },
    );
    const written = await editingRead(id);
    expect(written.conversation.some((entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC)).toBe(true);
    expect(written.change).toBeNull();
    location.hash = `planning/${id}/spec`;
    mount();
    const reading = await screen.findByLabelText("Spec Outcome");
    await waitFor(() => expect(reading.textContent).toContain("A month view shows the days of one month"));
    // The spec as the interview first wrote it reads plain: nothing green, nothing struck.
    expect(marks()).toEqual([]);

    // A hand edit of those words is a change, and the words it changed are marked.
    fireEvent.mouseDown(reading, { clientX: 0, clientY: 0 });
    const box = (await waitFor(() => {
      const shown = screen.getByLabelText("Spec Outcome");
      expect(shown).toBeInstanceOf(HTMLTextAreaElement);
      return shown;
    })) as HTMLTextAreaElement;
    fireEvent.change(box, {
      target: { value: "A month view shows the weeks of one month, and a day shows what is on it." },
    });
    fireEvent.blur(box);
    await waitFor(async () => expect((await editingRead(id)).change?.spec?.after.outcome).toContain("weeks"));
    await waitFor(() => expect(marks(screen.getByLabelText("Spec Outcome"))).toEqual(["days", "weeks"]));
  });
});

describe("the sample host's spec takes its ticket's name, as the host's does (D-127)", () => {
  it("titles the spec with the name the plan is drafted under, and with a name given while it is planned", async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const repoId = workspace.repositories[0]!.id;
    // A title another ticket already carries, so the ticket is called by its
    // outcome and the spec has a name to take that is not its own.
    const taken = workspace.tasks.find((row) => row.repoId === repoId)!.ticket.title;
    const opened = await sampleBridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
    const empty = { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" };
    const outcome = "New users receive a confirmation email within sixty seconds.";
    await sampleBridge.request({
      kind: "specSave",
      id: opened.id,
      repoId,
      title: taken,
      sections: { ...empty, outcome, requirements: "- A signup queues exactly one email." },
      base: { title: "", sections: empty },
    });
    const slug = (await sampleBridge.request({ kind: "editingRead", id: opened.id })).specSlug!;
    await sampleBridge.request({ kind: "generatePlan", repoId, id: opened.id });

    const specTitle = async () =>
      (await sampleBridge.request({ kind: "snapshot" })).specs?.find((spec) => spec.slug === slug)?.title;
    const drafted = async () =>
      (await sampleBridge.request({ kind: "snapshot" })).tasks.find(
        (row) => row.ticket.admission.spec?.path === `specs/${slug}/spec.md`,
      );
    await waitFor(async () => expect((await drafted())?.ticket.title).toBe(outcome), { timeout: 5000 });
    expect(await specTitle()).toBe(outcome);

    const key = (await drafted())!.ticket.key;
    await sampleBridge.request({ kind: "rename", repoId, key, title: "Confirmation email" });
    expect(await specTitle()).toBe("Confirmation email");
  });

  it("leaves an approved ticket's spec as approval read it", async () => {
    const workspace = await sampleBridge.request({ kind: "snapshot" });
    const approved = workspace.tasks.find((row) => row.ticket.approved_at && row.ticket.admission.spec)!;
    const slug = approved.ticket.admission.spec!.path.split("/").at(-2)!;
    // The sample's spec for it, which each test here starts without.
    const before = "Retire the legacy CSV importer";
    localStorage.setItem("perbo:preview-specs", JSON.stringify({ [slug]: `# ${before}\n\n## Outcome\n\nIt is gone.\n` }));
    await sampleBridge.request({ kind: "rename", repoId: approved.repoId, key: approved.ticket.key, title: "Importer retired" });
    const after = await sampleBridge.request({ kind: "snapshot" });
    expect(after.titles?.[approved.repoId + ":" + approved.ticket.key]).toBe("Importer retired");
    expect(after.specs?.find((spec) => spec.slug === slug)?.title).toBe(before);
  });
});

describe("a repository's question page, where a planning starts (D-131)", () => {
  const question = (): HTMLTextAreaElement => screen.getByRole("textbox", { name: ASK }) as HTMLTextAreaElement;
  const page = (): HTMLElement => screen.getByRole("region", { name: "Start planning" });
  const send = (): HTMLButtonElement => within(page()).getByRole("button", { name: "Send" }) as HTMLButtonElement;
  const dock = (): HTMLElement => screen.getByRole("complementary", { name: "Chat" });
  const type = (value: string): void => void fireEvent.change(question(), { target: { value } });
  const repoIdOf = async (name: string): Promise<string> =>
    (await sampleBridge.request({ kind: "snapshot" })).repositories.find((repo) => repo.name === name)!.id;
  /** The open plannings' ids, as the host lists them. */
  const draftIds = async (): Promise<string[]> =>
    ((await sampleBridge.request({ kind: "drafts" })) ?? []).map((draft) => draft.id);
  /** What the host keeps typed for a repository. */
  const kept = async (repoId: string): Promise<string | undefined> =>
    (await sampleBridge.request({ kind: "snapshot" })).asks?.[repoId];
  beforeEach(async () => {
    // Kept by the sample host for as long as its module lives, as the native
    // host keeps it on disk: each case starts with nothing typed anywhere.
    for (const repo of (await sampleBridge.request({ kind: "snapshot" })).repositories)
      await sampleBridge.request({ kind: "askSave", repoId: repo.id, text: "" });
  });
  /** Pick a repository in Create, from wherever the app is; mounts it first where it is not. */
  async function pick(name = "example/webstore"): Promise<void> {
    if (document.querySelector(".rail") === null) mount();
    fireEvent.click(within(await openPicker()).getByRole("button", { name: new RegExp("^" + name) }));
    await screen.findByRole("heading", { name: ASK });
    expect(location.hash).toBe(`#ask/${await repoIdOf(name)}`);
  }
  /** Nothing was sent: no planning opened, no turn asked, and still on the page. */
  async function nothingSent(repoId: string, before: string[], asked: { mock: { calls: unknown[][] } }): Promise<void> {
    await settle();
    const kinds = asked.mock.calls.map(([request]) => (request as { kind: string }).kind);
    expect(kinds.filter((kind) => kind === "interviewTurn" || kind === "editingOpen")).toEqual([]);
    expect(await draftIds()).toEqual(before);
    expect(location.hash).toBe(`#ask/${repoId}`);
  }
  /** The one turn went as the chat's first, and the spec is named from it. */
  async function sentFirst(id: string): Promise<void> {
    const held = await editingRead(id);
    expect(held.specSlug).toBe("dark-mode-toggle");
    expect(held.conversation.filter((entry) => entry.line.kind === "turn").map((entry) => entry.line)).toEqual([
      { kind: "turn", text: "Can you add a dark mode toggle" },
    ]);
  }

  it("is where a repository picked in Create lands, creating nothing, with Create lit and no panes under it", async () => {
    const before = await draftIds();
    await pick();
    expect(await draftIds()).toEqual(before);
    expect(question().value).toBe("");
    // The repository it was picked in, in the box's corner beside the send.
    expect(within(page()).getByText("example/webstore")).toBeTruthy();
    // Nothing to attach: the box's one control is the send, muted while empty.
    expect(within(page()).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Send"]);
    expect(send().disabled).toBe(true);
    const create = within(rail()).getByRole("button", { name: "Create" });
    expect(create.getAttribute("aria-current")).toBe("page");
    expect(create.className).toContain("selected");
    expect(screen.queryByRole("group", { name: "Planning panes" })).toBeNull();
    expect(railNames().slice(0, 3)).toEqual(["Create", "Home", "Archive"]);
    // The page is the question alone: no chat beside it.
    expect(screen.queryByRole("complementary", { name: "Chat" })).toBeNull();
  });

  it("is on the repository when the picker is opened again from it, with no untitled work listed", async () => {
    await pick("example/landing");
    type("Can you add a dark mode toggle");
    // Hovering Create, as a person going back to the picker does.
    fireEvent.mouseEnter(within(rail()).getByRole("button", { name: "Create" }));
    const picker = await screen.findByRole("dialog", { name: "Plan a piece of work" });
    const active = picker.querySelectorAll(".picker-row.active");
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toContain("example/landing");
    expect(active[0]!.textContent).toContain("~/code/landing");
    expect(within(picker).queryByText("Untitled work")).toBeNull();
    expect(picker.textContent).not.toContain("draft in progress");
  });

  it("keeps each repository's own text across a switch to another and back", async () => {
    await pick("example/webstore");
    type("Can you add a dark mode toggle");
    await pick("example/landing");
    expect(question().value).toBe("");
    type("Make the hero load faster");
    await pick("example/webstore");
    expect(question().value).toBe("Can you add a dark mode toggle");
    await pick("example/landing");
    expect(question().value).toBe("Make the hero load faster");
    expect(await kept(await repoIdOf("example/webstore"))).toBe("Can you add a dark mode toggle");
    expect(await kept(await repoIdOf("example/landing"))).toBe("Make the hero load faster");
  });

  it("keeps the text as it is typed, so it is there after a restart", async () => {
    await pick();
    const repoId = await repoIdOf("example/webstore");
    type("Can you add a dark mode toggle");
    // Kept once typing rests, without leaving the page or the box.
    await waitFor(async () => expect(await kept(repoId)).toBe("Can you add a dark mode toggle"), { timeout: 2000 });
    restart(`ask/${repoId}`);
    await screen.findByRole("heading", { name: ASK });
    expect(question().value).toBe("Can you add a dark mode toggle");
  });

  it("keeps the text when it is left for Home, and creates nothing", async () => {
    const before = await draftIds();
    await pick();
    const repoId = await repoIdOf("example/webstore");
    type("Can you add a dark mode toggle");
    // Left at once, by a shortcut from inside the box, which neither blurs it
    // nor waits for typing to rest: the leave is what keeps it.
    const asked = vi.spyOn(bridge, "request");
    try {
      fireEvent.keyDown(question(), { key: "2", code: "Digit2", metaKey: true });
      expect(asked.mock.calls.map(([each]) => each)).toContainEqual({
        kind: "askSave",
        repoId,
        text: "Can you add a dark mode toggle",
      });
    } finally {
      asked.mockRestore();
    }
    await screen.findByRole("heading", { name: /Hi, / });
    expect(await kept(repoId)).toBe("Can you add a dark mode toggle");
    await settle();
    expect(await draftIds()).toEqual(before);
    await pick();
    expect(question().value).toBe("Can you add a dark mode toggle");
  });

  it("puts the caret after the kept text when the page is come back to", async () => {
    const words = "Can you add a dark mode toggle";
    await pick();
    type(words);
    fireEvent.keyDown(question(), { key: "2", code: "Digit2", metaKey: true });
    await screen.findByRole("heading", { name: /Hi, / });
    await pick();
    expect(question().value).toBe(words);
    expect(document.activeElement).toBe(question());
    expect([question().selectionStart, question().selectionEnd]).toEqual([words.length, words.length]);
  });

  it("sends on Enter: opens the planning, sends the chat's first turn, clears the text and lands on the Spec with it in the chat", async () => {
    const before = await draftIds();
    await pick();
    const repoId = await repoIdOf("example/webstore");
    type("Can you add a dark mode toggle");
    // Kept by the time it is sent, as words typed a while before sending are.
    await waitFor(async () => expect(await kept(repoId)).toBe("Can you add a dark mode toggle"), { timeout: 2000 });
    const entries = history.length;
    expect(fireEvent.keyDown(question(), { key: "Enter" }), "Enter is the send, not a new line").toBe(false);
    await screen.findByLabelText("Spec title");
    const id = sessionId();
    expect(location.hash).toBe(`#planning/${id}/spec`);
    expect(await draftIds()).toEqual([id, ...before]);
    // In place of the page, so Back does not go back to it.
    expect(history.length).toBe(entries);
    await waitFor(() => expect(within(dock()).getByText("Can you add a dark mode toggle")).toBeTruthy());
    expect(await within(dock()).findByText(/Named specs\/dark-mode-toggle from your first message/)).toBeTruthy();
    expect(await within(dock()).findByText(/Noted:/)).toBeTruthy();
    await sentFirst(id);
    expect(within(rail()).getByRole("button", { name: "Create" }).getAttribute("aria-current")).toBeNull();
    expect(pane("Spec").getAttribute("aria-current")).toBe("page");
    // Sent, so the repository keeps nothing for the next.
    expect(await kept(repoId)).toBeUndefined();
    await pick();
    expect(question().value).toBe("");
  });

  it("sends the same from the button", async () => {
    await pick();
    type("  Can you add a dark mode toggle\n");
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    await screen.findByLabelText("Spec title");
    const id = sessionId();
    expect(location.hash).toBe(`#planning/${id}/spec`);
    await waitFor(() => expect(within(dock()).getByText("Can you add a dark mode toggle")).toBeTruthy());
    await sentFirst(id);
  });

  it("takes Shift+Enter as a new line in the box, and sends nothing", async () => {
    const before = await draftIds();
    await pick();
    const asked = vi.spyOn(bridge, "request");
    try {
      type("Can you add a dark mode toggle");
      expect(fireEvent.keyDown(question(), { key: "Enter", shiftKey: true }), "left to the box").toBe(true);
      type("Can you add a dark mode toggle\nto settings");
      await nothingSent(await repoIdOf("example/webstore"), before, asked);
      expect(question().value).toBe("Can you add a dark mode toggle\nto settings");
    } finally {
      asked.mockRestore();
    }
  });

  it("sends nothing while the box is empty or only spaces", async () => {
    const before = await draftIds();
    await pick();
    const asked = vi.spyOn(bridge, "request");
    try {
      fireEvent.keyDown(question(), { key: "Enter" });
      expect(send().disabled).toBe(true);
      fireEvent.click(send());
      type("  \n  ");
      expect(send().disabled).toBe(true);
      fireEvent.keyDown(question(), { key: "Enter" });
      fireEvent.click(send());
      await nothingSent(await repoIdOf("example/webstore"), before, asked);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      asked.mockRestore();
    }
  });

  it("keeps the text, says why and leaves no planning when the host refuses the turn", async () => {
    const before = await draftIds();
    await pick();
    const repoId = await repoIdOf("example/webstore");
    const request = bridge.request.bind(bridge);
    let slug: string | null = null;
    const asked = vi.spyOn(bridge, "request").mockImplementation(async (each) => {
      if (each.kind !== "interviewTurn") return request(each);
      // Refused after the turn named the spec, as the host's is when the
      // session fails to start: the planning is past the revision it opened
      // at, and its spec folder is in the repository.
      const empty = { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" };
      await request({
        kind: "specSave",
        id: each.id,
        repoId,
        title: "Dark mode toggle",
        sections: { ...empty, outcome: each.text },
        base: { title: "", sections: empty },
      });
      slug = (await request({ kind: "editingRead", id: each.id })).specSlug;
      throw new Error("The interview could not start.");
    });
    try {
      type("Can you add a dark mode toggle");
      fireEvent.keyDown(question(), { key: "Enter" });
      expect((await screen.findByRole("alert")).textContent).toContain("The interview could not start.");
      expect(question().value).toBe("Can you add a dark mode toggle");
      expect(location.hash).toBe(`#ask/${repoId}`);
      expect(slug).not.toBeNull();
      await waitFor(async () => expect(await draftIds()).toEqual(before));
      expect((await sampleBridge.request({ kind: "snapshot" })).specs?.map((spec) => spec.slug)).not.toContain(slug);
      expect(await kept(repoId)).toBe("Can you add a dark mode toggle");
    } finally {
      asked.mockRestore();
    }
  });

  it("sends once while the host is still answering", async () => {
    await pick();
    const request = bridge.request.bind(bridge);
    let answer: () => void = () => undefined;
    const asked = vi.spyOn(bridge, "request").mockImplementation((each) =>
      each.kind === "interviewTurn"
        ? new Promise<never>((resolve) => {
            answer = () => resolve(undefined as never);
          })
        : request(each),
    );
    try {
      type("Can you add a dark mode toggle");
      fireEvent.keyDown(question(), { key: "Enter" });
      fireEvent.keyDown(question(), { key: "Enter" });
      await settle();
      expect(asked.mock.calls.filter(([each]) => each.kind === "editingOpen")).toHaveLength(1);
      expect(asked.mock.calls.filter(([each]) => each.kind === "interviewTurn")).toHaveLength(1);
      expect(send().disabled).toBe(true);
    } finally {
      answer();
      asked.mockRestore();
    }
  });

  it("is not where a planning opened over a spec lands", async () => {
    const markdown = planningBrowser.renderSpec(
      { ...planningBrowser.EMPTY_SPEC_TEXT, title: "Play tic tac toe" },
      { highWater: 0, existing: [] },
    ).markdown;
    localStorage.setItem("perbo:preview-specs", JSON.stringify({ "play-tic-tac-toe": markdown }));
    mount();
    fireEvent.click(within(await openPicker()).getByRole("button", { name: /^Play tic tac toe/ }));
    await screen.findByLabelText("Spec title");
    expect(location.hash).toMatch(/^#planning\/[^/]+\/spec$/);
    expect(screen.queryByRole("heading", { name: ASK })).toBeNull();
  });
});
