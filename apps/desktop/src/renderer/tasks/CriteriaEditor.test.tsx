// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { CriteriaEditor } from "./CriteriaEditor.js";
import type { Draft, EditingForm } from "../../shared/protocol.js";
import type { useContractEditing } from "../contract-editor.js";

afterEach(cleanup);

type Editor = ReturnType<typeof useContractEditing>;

const criterion = (text: string): Draft["criteria"][number] => ({ text, assertion: text, kind: "test" });

/**
 * The editor's form held in state, as the editing session holds it: only the
 * two things the criteria read and write of it.
 */
function Harness({ criteria, onCommit }: { criteria: string[]; onCommit: () => void }) {
  const [form, setForm] = useState<Pick<EditingForm, "draft" | "editing" | "criterion">>({
    draft: { outcome: "The legacy importer is retired.", criteria: criteria.map(criterion), paths: ["src/**"], prohibited: [] },
    editing: null,
    criterion: criterion(""),
  });
  const editor = {
    form,
    update: (patch: Partial<EditingForm>) => setForm((held) => ({ ...held, ...patch })),
  } as unknown as Editor;
  return (
    <>
      <CriteriaEditor editor={editor} onCommit={onCommit} />
      <output aria-label="Criteria held">{form.draft.criteria.map((each) => each.text).join(" | ")}</output>
    </>
  );
}

const held = (): string => screen.getByRole("status", { name: "Criteria held" }).textContent ?? "";

describe("the criteria a contract is edited with (D-NEW-basic-and-epic-flows)", () => {
  it("rewords a criterion and tells the caller, which writes it through", () => {
    const onCommit = vi.fn();
    render(<Harness criteria={["The importer is removed.", "Its routes answer 404."]} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit criterion 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 2" }), { target: { value: "Its routes answer 410." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(held()).toBe("The importer is removed. | Its routes answer 410.");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("deletes a criterion while another is left, and offers no delete of the last one", () => {
    const onCommit = vi.fn();
    render(<Harness criteria={["The importer is removed.", "Its routes answer 404."]} onCommit={onCommit} />);
    const deletes = () => screen.getAllByRole("button", { name: /^Delete criterion / }) as HTMLButtonElement[];
    expect(deletes().map((button) => button.disabled)).toEqual([false, false]);
    fireEvent.click(deletes()[0]!);
    expect(held()).toBe("Its routes answer 404.");
    expect(onCommit).toHaveBeenCalledTimes(1);
    // One left: a contract promises at least one thing.
    expect(deletes().map((button) => button.disabled)).toEqual([true]);
    fireEvent.click(deletes()[0]!);
    expect(held()).toBe("Its routes answer 404.");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("adds a criterion, saved only once it says something", () => {
    const onCommit = vi.fn();
    render(<Harness criteria={["The importer is removed."]} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a criterion/ }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Criterion 2" }), { target: { value: "Nothing links to the importer." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(held()).toBe("The importer is removed. | Nothing links to the importer.");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
