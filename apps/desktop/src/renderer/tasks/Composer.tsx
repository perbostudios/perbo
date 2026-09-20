import { Button, Dropdown, Field, IconButton, InkIcon, Notice, PageFooter } from "../ui/index.js";
import { WaitScreen, WizardHeader } from "./wizard.js";
import { useEffect, useRef } from "react";
import {
  CriterionSchema,
  DraftSchema,
} from "../../shared/protocol.js";
import type { Detail, Draft, EditingTarget, TaskModels } from "../../shared/protocol.js";
import { useContractEditing } from "./contract-editor.js";
import { ModelPicker, useProviders } from "../settings/ConnectionScreens.js";
import type { PageProps } from "../shell/App.js";
import { isLive } from "../../shared/jobs.js";
export { contractDraft } from "../../shared/contract-editing.js";
export function Composer({
  workspace, navigate, existing, existingRepoId, onCancel, target: chosen,
}: PageProps & { existing?: Detail; existingRepoId?: string; onCancel?: () => void; target?: EditingTarget }) {
  // Planning mode hands over the session it holds; a ticket's own editor names the ticket.
  const target: EditingTarget = chosen ?? (existing && existingRepoId
    ? { kind: "ticket" as const, repoId: existingRepoId, key: existing.ticket.key }
    : { kind: "new" as const, repoId: workspace.repositories[0]?.id ?? "" });
  const editor = useContractEditing(target, workspace.settings, existing);
  const { draft, step, models, editing, criterion: editedCriterion, newPath } = editor.form;
  const { repoId, record, session } = editor;
  const currentKey = session?.key ?? session?.operation?.resultKey;
  const setDraft = (draft: Draft): void => editor.update({ draft });
  const setStep = (step: 1 | 2): void => editor.update({ step });
  const setRepoId = (repoId: string): void => editor.update({}, repoId);
  const setModels = (models: TaskModels): void => editor.update({ models });
  const setEditing = (editing: number | null): void => editor.update({ editing });
  const setEditedCriterion = (change: Draft["criteria"][number] | ((value: Draft["criteria"][number]) => Draft["criteria"][number])): void =>
    editor.update({ criterion: typeof change === "function" ? change(editedCriterion) : change });
  const setNewPath = (newPath: string | null): void => editor.update({ newPath });
  const providers = useProviders(), handled = useRef<string | null>(session?.phase === "ready" ? session.operation?.id ?? null : null);
  const submitted = useRef<"draft" | "compile" | "generate" | "startOver">("draft");
  const currentJob = workspace.jobs.find((job) => job.id === session?.operation?.jobId && job.repoId === repoId);
  // Only this session's own drafting holds its Start: planning runs beside a run and beside another session (D-101).
  const pending = Boolean(currentJob && isLive(currentJob));
  const restoring = editor.loading || !session || ["conflict", "outcome-unknown"].includes(session.phase);
  const readError = editor.error;
  useEffect(() => {
    if (session?.phase !== "ready" || !session.key || handled.current === session.operation?.id) return;
    handled.current = session.operation?.id ?? null;
    navigate({ page: "task", repoId: session.repoId, key: session.key, view: "contract" });
    onCancel?.();
  }, [session, navigate, onCancel]);
  const start = (model: boolean): void => {
    submitted.current = model ? "draft" : "compile";
    editor.submit(submitted.current);
  };
  const cancel = (): void => {
    if (session?.phase === "working" || editor.submitting) editor.stop();
    (onCancel ?? (() => navigate({ page: "home" })))();
  };
  if (editor.loading) return <div className="launch"><p>Restoring your saved contract edits…</p></div>;
  if (editor.submitting || session?.phase === "working") {
    const intent = editor.submitting ? submitted.current : session?.operation?.intent;
    const drafting = intent === "generate" || intent === "startOver";
    return <WaitScreen
      step={intent === "draft" ? 1 : 2}
      title={intent === "draft"
        ? "Drafting your acceptance criteria"
        : intent === "generate"
          ? "Drafting the plan from your spec"
          : intent === "startOver"
            ? "Drafting the plan again from your spec"
            : "Compiling your contract"}
      description={intent === "draft"
        ? "Reading the packages your outcome touches, so the criteria say what must be proven rather than restating the title."
        : drafting
          ? "Reading the spec and the packages it names, and proposing the criteria, the scope and the execution graph. You will review the plan before anything runs."
          : "Pinning the base commit and deriving the plan level from the scope. You will review the contract before the coding loop starts."}
      status={session?.operation?.state === "stopping" ? "Stopping…" : currentJob?.label ?? "Reading the recorded outcome…"}
      onCancel={cancel}
    />;
  }
  const updateCriterion = (
    index: number,
    change: Partial<Draft["criteria"][number]>,
  ): void =>
    setDraft({
      ...draft,
      criteria: draft.criteria.map((entry, position) =>
        position === index ? { ...entry, ...change } : entry,
      ),
    });
  const saveCriterion = (): void => {
    const criterion = CriterionSchema.safeParse(editedCriterion);
    if (editing !== null && criterion.success) {
      updateCriterion(editing, criterion.data);
      setEditing(null);
    }
  };
  const beginEditing = (index: number): void => {
    const criterion = draft.criteria[index];
    if (!criterion) return;
    setEditing(index);
    setEditedCriterion({ ...criterion });
  };
  const canDraft =
    Boolean(repoId && draft.outcome.trim()) && !pending && !restoring;
  const valid =
    DraftSchema.safeParse(draft).success &&
    Boolean(repoId) &&
    editing === null &&
    !restoring;
  const repo = workspace.repositories.find((repo) => repo.id === repoId);
  return (
    <section className="screen" data-screen={step === 1 ? "s7" : "s9"}>
      <WizardHeader step={step} />
      {step === 1 ? (
        <div className="wizard-body">
          <Field id="repository" label="Repository">
            <div className="repo-field">
              <Dropdown
                id="repository"
                value={repoId}
                disabled={Boolean(session?.key || session?.operation)}
                onChange={(event) => setRepoId(event.target.value)}
              >
                <option value="" disabled>
                  Choose a repository
                </option>
                {workspace.repositories.map((repo) => (
                  <option value={repo.id} key={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </Dropdown>
            </div>
          </Field>
          <div>
            <div className="outcome-label">
              <label htmlFor="outcome">Outcome</label>
              <span>
                one sentence, in your words — this becomes the thing the
                reviewer measures against
              </span>
            </div>
            <textarea
              id="outcome"
              className="outcome-input"
              autoFocus
              value={draft.outcome}
              maxLength={12_000}
              placeholder="What should be true when this task is finished?"
              onChange={(event) =>
                setDraft({ ...draft, outcome: event.target.value })
              }
            />
            <div className="outcome-foot">
              <span className="handwritten">
                no task name to invent — start with the outcome, and rename the
                compiled task if you like
              </span>
              <span className="mono">{draft.outcome.length} characters</span>
            </div>
          </div>
          <div className="confirm-models">
            <div className="column-heading">
              <strong>Confirm the models</strong>
              <span className="small muted">
                your defaults, changeable for this task only
              </span>
            </div>
            <div className="row">
              {(["executor", "reviewer"] as const).map((role) => (
                <div className="role-card" key={role}>
                  <span className="connection-dot" />
                  <ModelPicker
                    role={role}
                    models={models}
                    connections={providers.data}
                    onChange={setModels}
                  />
                </div>
              ))}
            </div>
          </div>
          {!repoId && (
            <Button onClick={() => navigate({ page: "repositories" })}>
              Add a repository
            </Button>
          )}
        </div>
      ) : (
        <div className="wizard-body criteria-body">
          <div className="criteria-intro">
            <h2>Acceptance criteria</h2>
            <p>
              Each one states what must be <strong>proven</strong>, not where
              the proof will live. The test doesn’t exist yet — the reviewer
              records what actually proved it, afterwards.
            </p>
          </div>
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
                      <p className="criterion-text">{entry.text}</p>
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
                  }}
                />
              </div>
            ))}
            <button
              className="add-row"
              disabled={draft.criteria.length >= 4}
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
              <span className="small">
                3 is the suggested number · four stays reviewable
              </span>
            </button>
          </div>
          <div className="scope-editor">
            <div className="column-heading">
              <h3>Allowed scope</h3>
              <span className="small muted">
                proposed from the repository — it bounds the diff and keeps
                review cheap
              </span>
            </div>
            <div className="path-chips">
              {draft.paths.map((path, index) => (
                <span className="path-chip" key={index}>
                  {path}
                  <IconButton
                    icon="reject"
                    size={12}
                    label={"Remove path " + path}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        paths: draft.paths.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    }
                  />
                </span>
              ))}
              {newPath === null ? (
                <button
                  className="path-chip dashed"
                  onClick={() => setNewPath("")}
                >
                  + add a path
                </button>
              ) : (
                <form
                  className="row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (newPath.trim()) {
                      setDraft({
                        ...draft,
                        paths: [...draft.paths, newPath.trim()],
                      });
                      setNewPath(null);
                    }
                  }}
                >
                  <input
                    aria-label="New allowed path"
                    placeholder="packages/example/**"
                    autoFocus
                    value={newPath}
                    onChange={(event) => setNewPath(event.target.value)}
                  />
                  <Button className="small" type="submit">
                    Add
                  </Button>
                </form>
              )}
              <span className="path-chip dashed">
                {record?.contract.scope.expansion_budget_files ?? 0} files of
                headroom
              </span>
            </div>
            <div className="scope-message">
              <InkIcon name="locked" size={20} />
              <span>
                Off limits regardless of scope:{" "}
                <code>
                  {(
                    record?.contract.scope.paths_prohibited ??
                    repo?.prohibitedPaths ?? [
                      ".github/workflows/**",
                      "infra/**",
                      "**/*.env*",
                    ]
                  ).join(" · ")}
                </code>
                . The runner enforces the approved scope.
              </span>
            </div>
          </div>
        </div>
      )}
      {(readError || currentJob?.error) && (
        <div className="workspace-errors">
          <Notice tone="danger">{readError ?? currentJob?.error}</Notice>
          <Button onClick={() => { void editor.retry(); }}>Retry saved edits</Button>
          <Button onClick={() => navigate(currentKey
            ? { page: "task", repoId, key: currentKey, view: "contract" }
            : { page: "home" })}>
            {currentKey ? "Open the current contract" : "Check saved tasks"}
          </Button>
        </div>
      )}
      <PageFooter>
        <span role="status" className="small muted">{editor.saving ? "Saving edits…" : session ? "Edits saved on this device" : "Edits could not be restored"}</span>
        <Button onClick={() => { void editor.discard().then((discarded) => { if (discarded) cancel(); }); }}>
          Discard saved edits
        </Button>
        <Button
          variant="primary"
          disabled={step === 1 ? !canDraft : !valid || pending}
          onClick={() => {
            if (step === 1 && record) setStep(2);
            else start(step === 1);
          }}
        >
          {step === 1
            ? record
              ? "Review the criteria"
              : "Draft the criteria"
            : "Compile the contract"}
        </Button>
        <Button onClick={step === 1 ? cancel : () => setStep(1)}>
          {step === 1 ? "Cancel" : "Back"}
        </Button>
        {step === 1 && !record && (
          <button
            className="text-button small"
            disabled={!repoId || !draft.outcome.trim() || restoring}
            onClick={() => {
              setStep(2);
              if (!draft.criteria.length) {
                setDraft({
                  ...draft,
                  criteria: [{ text: "", assertion: "", kind: "test" }],
                });
                setEditing(0);
                setEditedCriterion({ text: "", assertion: "", kind: "test" });
              }
            }}
          >
            Write criteria myself
          </button>
        )}
        <span className="spacer" />
        <span className="small muted">
          {step === 1
            ? "Drafting uses your subscription. Coding starts after approval."
            : "Still free to change. After step 3 these four fields freeze."}
        </span>
      </PageFooter>
    </section>
  );
}
