// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";
import { CreateContext, type CreateApi } from "./create.js";
import { RailReveal, REVEAL_GRACE, SLIDE_OUT } from "./rail-reveal.js";
import { resetRailSize } from "./rail-size.js";
import { setPlatformForTests } from "../../shared/shortcuts.js";

/** The pointer moving to the window's left edge, and away from it. */
const toEdge = (): void => void fireEvent.pointerMove(document, { clientX: 2 });
const offEdge = (): void => void fireEvent.pointerMove(document, { clientX: 400 });
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>(".rail-reveal");
const revealed = (): boolean => panel()?.classList.contains("is-revealed") ?? false;

describe("the hidden rail brought back by the pointer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const picker = (isOpen: boolean): CreateApi => ({
    open: () => undefined,
    openUnselected: () => undefined,
    toggle: () => undefined,
    enter: () => undefined,
    leave: () => undefined,
    isOpen,
    deleting: new Set(),
    hide: () => () => undefined,
  });
  const tree = (isOpen: boolean) => (
    <CreateContext.Provider value={picker(isOpen)}>
      <RailReveal>
        <nav aria-label="Main navigation">
          <button>Home</button>
        </nav>
      </RailReveal>
    </CreateContext.Provider>
  );
  const hidden = (isOpen = false) => render(tree(isOpen));

  it("mounts nothing until the pointer reaches the window's left edge, then slides the rail in", () => {
    const { container } = hidden();
    // Nothing of its own over the page, so a click or a drag starting at the
    // page's left edge is the page's.
    expect(container.childElementCount).toBe(0);
    fireEvent.pointerMove(document, { clientX: 13 });
    expect(panel()).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    toEdge();
    expect(revealed()).toBe(true);
    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();
  });

  it("slides the rail away a grace after the pointer leaves it, and unmounts it once it is out", () => {
    hidden();
    toEdge();
    fireEvent.pointerEnter(panel()!);
    offEdge();
    fireEvent.pointerLeave(panel()!);
    act(() => vi.advanceTimersByTime(REVEAL_GRACE - 1));
    expect(revealed()).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(revealed()).toBe(false);
    expect(panel()).toBeTruthy();
    act(() => vi.advanceTimersByTime(SLIDE_OUT));
    expect(panel()).toBeNull();
  });

  it("keeps the rail out when the pointer comes back within the grace, or while it slides away", () => {
    hidden();
    toEdge();
    offEdge();
    act(() => vi.advanceTimersByTime(REVEAL_GRACE - 50));
    fireEvent.pointerEnter(panel()!);
    act(() => vi.advanceTimersByTime(REVEAL_GRACE * 4));
    expect(revealed()).toBe(true);
    fireEvent.pointerLeave(panel()!);
    act(() => vi.advanceTimersByTime(REVEAL_GRACE));
    expect(revealed()).toBe(false);
    fireEvent.pointerEnter(panel()!);
    expect(revealed()).toBe(true);
    act(() => vi.advanceTimersByTime(SLIDE_OUT * 2));
    expect(revealed()).toBe(true);
  });

  it("stays out while the Create picker it opened is open, and never comes out for the picker alone", () => {
    const view = hidden(true);
    expect(panel()).toBeNull();
    toEdge();
    offEdge();
    act(() => vi.advanceTimersByTime(REVEAL_GRACE * 4));
    expect(revealed()).toBe(true);
    view.rerender(tree(false));
    act(() => vi.advanceTimersByTime(REVEAL_GRACE));
    expect(revealed()).toBe(false);
  });
});

describe("the rail in the app, hidden from the toggle", () => {
  let client: QueryClient;
  beforeEach(() => {
    sessionStorage.clear();
    location.hash = "home";
    setPlatformForTests(true);
    resetRailSize();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  });
  afterEach(() => {
    cleanup();
    client.clear();
    setPlatformForTests(null);
    resetRailSize();
  });
  const mount = () =>
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );

  it("does not come out while the rail is shown, and slides the same rail in and out once it is hidden", async () => {
    mount();
    const reduce = await screen.findByRole("button", { name: "Reduce the sidebar" });
    expect(document.querySelector(".rail")).toBeTruthy();
    toEdge();
    expect(panel()).toBeNull();
    offEdge();
    fireEvent.click(reduce);
    expect(document.querySelector(".rail")).toBeNull();
    toEdge();
    expect(revealed()).toBe(true);
    const rail = screen.getByRole("complementary", { name: "Main navigation" });
    expect(panel()!.contains(rail)).toBe(true);
    // The same rail, as usable as a shown one.
    fireEvent.click(within(rail).getByRole("button", { name: "Archive" }));
    expect(location.hash).toBe("#archive");
    offEdge();
    await waitFor(() => expect(panel()).toBeNull());
    // Hidden, ⌘4 still goes to settings without bringing the rail out.
    fireEvent.keyDown(window, { key: "4", code: "Digit4", metaKey: true });
    expect(location.hash).toBe("#general");
    expect(panel()).toBeNull();
    // Shown from the toggle, the rail is in its place and the edge brings out no other.
    fireEvent.click(screen.getByRole("button", { name: "Expand the sidebar" }));
    toEdge();
    expect(panel()).toBeNull();
    expect(document.querySelector(".app-body > .rail")).toBeTruthy();
  });

  it("hands the focus to the sidebar toggle when the rail slides away with it inside", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Reduce the sidebar" }));
    toEdge();
    const archive = within(screen.getByRole("complementary", { name: "Main navigation" })).getByRole("button", {
      name: "Archive",
    });
    archive.focus();
    expect(document.activeElement).toBe(archive);
    offEdge();
    await waitFor(() => expect(panel()).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand the sidebar" }));
  });
});
