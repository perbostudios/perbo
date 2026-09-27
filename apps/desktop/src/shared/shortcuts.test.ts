import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  actionForBinding,
  bindingFromEvent,
  conflictFor,
  displayBinding,
  effectiveShortcuts,
  setPlatformForTests,
} from "./shortcuts.js";

afterEach(() => setPlatformForTests(null));

describe("keyboard bindings", () => {
  it("normalises events into bindings on both platforms and prints them the platform's way", () => {
    setPlatformForTests(true);
    expect(
      bindingFromEvent({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("Meta+K");
    expect(
      bindingFromEvent({
        key: "!",
        code: "Digit1",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toBe("Shift+Meta+1");
    expect(
      bindingFromEvent({
        key: "Meta",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
    expect(displayBinding("Shift+Meta+Enter")).toEqual(["⇧", "⌘", "↵"]);
    setPlatformForTests(false);
    expect(
      bindingFromEvent({
        key: "k",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("Meta+K");
    expect(displayBinding("Meta+K")).toEqual(["Ctrl", "K"]);
  });

  it("refuses a binding another action holds, names it, and never moves the two fixed ones", () => {
    expect(conflictFor({}, "create", "Meta+K")?.action).toBe("search");
    expect(conflictFor({}, "create", "Shift+Meta+M")?.fixed).toBe(true);
    expect(conflictFor({}, "create", "Meta+N")).toBeNull();
    const effective = effectiveShortcuts({
      create: "Meta+J",
      approve: "Meta+9",
    });
    expect(effective.create).toBe("Meta+J");
    expect(effective.approve).toBe(
      DEFAULT_SHORTCUTS.find((entry) => entry.action === "approve")!.binding,
    );
    expect(actionForBinding({ create: "Meta+J" }, "Meta+J")).toBe("create");
    expect(actionForBinding({ create: "Meta+J" }, "Meta+N")).toBeNull();
  });

  it("names what the pull request shortcut does where the run kept its branch as well as where it opened one", () => {
    // D-NEW-publish-a-retained-branch-later: on a retained ticket the press pushes first.
    expect(DEFAULT_SHORTCUTS.find((one) => one.action === "openPullRequest")?.label).toBe(
      "Open the pull request, pushing a retained branch first",
    );
  });
});
