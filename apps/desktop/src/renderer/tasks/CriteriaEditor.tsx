import { Button, Dropdown, Field, IconButton } from "../ui/index.js";
import { CriterionSchema } from "../../shared/protocol.js";
import type { Draft } from "../../shared/protocol.js";
import type { useContractEditing } from "../contract-editor.js";

type Editor = ReturnType<typeof useContractEditing>;

/**
 * The acceptance criteria, each open to be reworded, re-proven or deleted, and
 * another added — held in the editing session's form, so what is typed
 * survives leaving the page. The ticket's own editor and a basic ticket's
 * contract inside planning both edit criteria here
 * (D-NEW-basic-and-epic-flows).
 *
 * `onCommit` is told each time a criterion is saved or deleted, which is
 * where a caller that writes every change through at once does so. An edit
 * made here carries no change marks: those are for what the chat changes
 * (D-128).
 */
export function CriteriaEditor({ editor, onCommit }: { editor: Editor; onCommit?: () => void }) {
  const { draft, editing, criterion: editedCriterion } = editor.form;
  const setDraft = (draft: Draft): void => editor.update({ draft });
  const setEditing = (editing: number | null): void => editor.update({ editing });
  const setEditedCriterion = (change: Draft["criteria"][number] | ((value: Draft["criteria"][number]) => Draft["criteria"][number])): void =>
    editor.update({ criterion: typeof change === "function" ? change(editedCriterion) : change });
  const updateCriterion = (index: number, change: Partial<Draft["criteria"][number]>): void =>
    setDraft({
      ...draft,
      criteria: draft.criteria.map((entry, position) => (position === index ? { ...entry, ...change } : entry)),
    });
  const saveCriterion = (): void => {
    const criterion = CriterionSchema.safeParse(editedCriterion);
    if (editing !== null && criterion.success) {
      updateCriterion(editing, criterion.data);
      setEditing(null);
      onCommit?.();
    }
  };
  const beginEditing = (index: number): void => {
    const criterion = draft.criteria[index];
    if (!criterion) return;
    setEditing(index);
    setEditedCriterion({ ...criterion });
  };
  return (
    <div className="criteria-editor">
      {draft.criteria.map((entry, index) => (
        <div
          className={
            "criterion-editor" + (editing === index ? " editing" : "")
          }
          key={index}
        >
          <span className="criterion-number">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div
            className="criterion-content"
            onKeyDown={(event) => {
              if (editing !== index) return;
              if (event.key === "Escape") setEditing(null);
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter"
              ) {
                event.preventDefault();
                saveCriterion();
              }
            }}
          >
            {editing === index ? (
              <>
                <textarea
                  aria-label={"Criterion " + (index + 1)}
                  autoFocus
                  value={editedCriterion.text}
                  onChange={(event) => {
                    const text = event.target.value;
                    setEditedCriterion((current) => ({
                      ...current,
                      text,
                      assertion:
                        current.assertion === current.text
                          ? text
                          : current.assertion,
                    }));
                  }}
                />
                <div className="criterion-controls">
                  <Button
                    className="small"
                    variant="primary"
                    onClick={saveCriterion}
                    disabled={
                      !CriterionSchema.safeParse(editedCriterion).success
                    }
                  >
                    Save
                  </Button>
                  <span className="small muted">
                    editing · esc to discard
                  </span>
                </div>
                <div className="criterion-proof">
                  <p className="small muted">
                    Check that the assertion matches the criterion before
                    saving.
                  </p>
                  <div className="two-columns">
                    <Field
                      id={"proof-kind-" + index}
                      label="Evidence type"
                    >
                      <Dropdown
                        id={"proof-kind-" + index}
                        value={editedCriterion.kind}
                        onChange={(event) =>
                          setEditedCriterion({
                            ...editedCriterion,
                            kind: event.target.value as typeof entry.kind,
                          })
                        }
                      >
                        {["test", "query", "metric", "artifact"].map(
                          (kind) => (
                            <option key={kind}>{kind}</option>
                          ),
                        )}
                      </Dropdown>
                    </Field>
                    <Field
                      id={"proof-" + index}
                      label="Observable assertion"
                    >
                      <textarea
                        id={"proof-" + index}
                        value={editedCriterion.assertion}
                        onChange={(event) =>
                          setEditedCriterion({
                            ...editedCriterion,
                            assertion: event.target.value,
                          })
                        }
                      />
                    </Field>
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className="criterion-text">
                  {entry.text}
                </p>
                <p className="criterion-note">
                  Expected {entry.kind}: {entry.assertion}
                </p>
              </>
            )}
          </div>
          {editing !== index && (
            <IconButton
              icon="locked"
              label={"Edit criterion " + (index + 1)}
              onClick={() => beginEditing(index)}
            />
          )}
          <IconButton
            icon="reject"
            size={16}
            label={"Delete criterion " + (index + 1)}
            onClick={() => {
              setDraft({
                ...draft,
                criteria: draft.criteria.filter(
                  (_, position) => position !== index,
                ),
              });
              setEditing(null);
              onCommit?.();
            }}
          />
        </div>
      ))}
      <button
        className="add-row"
        onClick={() => {
          const index = draft.criteria.length;
          setDraft({
            ...draft,
            criteria: [
              ...draft.criteria,
              { text: "", assertion: "", kind: "test" },
            ],
          });
          setEditing(index);
          setEditedCriterion({ text: "", assertion: "", kind: "test" });
        }}
      >
        + <span>Add a criterion</span>
      </button>
    </div>
  );
}
