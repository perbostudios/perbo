// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  ShortcutProvider,
  useShortcut,
} from "./shortcuts.js";

function DecisionScreen({ onNext }: { onNext: () => void }) {
  useShortcut("decisionNext", onNext);
  return <button type="button">edit</button>;
}

describe("shortcut dispatcher", () => {
  it("leaves a bare Enter to the focused button and takes it from the page", () => {
    const next = vi.fn();
    const { getByRole } = render(
      <ShortcutProvider overrides={{}}>
        <DecisionScreen onNext={next} />
      </ShortcutProvider>,
    );
    const button = getByRole("button", { name: "edit" });
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
    expect(next).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(next).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
