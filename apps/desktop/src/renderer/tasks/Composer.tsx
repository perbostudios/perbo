import { Button, Dropdown, Field, IconButton, InkIcon, Notice, PageFooter } from "../ui/index.js";
import { WaitScreen, WizardHeader } from "./wizard.js";
import { useEffect, useMemo, useRef } from "react";
import { MarkedCriterion, RemovedCriteria } from "../planning/ChangeMarks.js";
import { changeKey, criteriaChange, type CriterionChange } from "../planning/change-marks.js";
import {
  CriterionSchema,
  DraftSchema,
} from "../../shared/protocol.js";
import type { Detail, Draft, EditingTarget } from "../../shared/protocol.js";
import { useContractEditing } from "../contract-editor.js";
import type { PageProps } from "../shell/route.js";
import { isLive } from "../../shared/jobs.js";
import { contractDraft } from "../../shared/contract-editing.js";
import { confirmRoute, planApproved } from "../planning/panes.js";
export function Composer({
  workspace, navigate, existing, existingRepoId, onCancel, target: chosen, plan = false,
}: PageProps & {
  existing?: Detail;
  existingRepoId?: string;
  onCancel?: () => void;
  target?: EditingTarget;
  /**
   * Whether this is planning mode's plan pane rather than the ticket's own
   * editor. The criteria are the same; what differs is the way onward, which
   * is a step in a flow rather than a compile, and what else the footer
   * offers, because discarding here would discard the planning.
   */
  plan?: boolean;
}) {
  // Planning mode hands over the session it holds; a ticket's own editor names the ticket.
  const target: EditingTarget = chosen ?? (existing && existingRepoId
    ? { kind: "ticket" as const, repoId: existingRepoId, key: existing.ticket.key }
    : { kind: "new" as const, repoId: workspace.repositories[0]?.id ?? "" });
  const editor = useContractEditing(target, workspace.settings, existing);
  const { draft, editing, criterion: editedCriterion, newPath } = editor.form;
  const { repoId, record, session } = editor;
  const currentKey = session?.key ?? session?.operation?.resultKey;
  const setDraft = (draft: Draft): void => editor.update({ draft });
  const setEditing = (editing: number | null): void => editor.update({ editing });
  const setEditedCriterion = (change: Draft["criteria"][number] | ((value: Draft["criteria"][number]) => Draft["criteria"][number])): void =>
    editor.update({ criterion: typeof change === "function" ? change(editedCriterion) : change });
  const setNewPath = (newPath: string | null): void => editor.update({ newPath });
  const handled = useRef<string | null>(session?.phase === "ready" ? session.operation?.id ?? null : null);
  const compiling = useRef(false);
  const currentJob = workspace.jobs.find((job) => job.id === session?.operation?.jobId && job.repoId === repoId);
  // Only this session's own drafting holds its Start: planning runs beside a run and beside another session (D-101).
  const pending = Boolean(currentJob && isLive(currentJob));
  const restoring = editor.loading || !session || ["conflict", "outcome-unknown"].includes(session.phase);
  const readError = editor.error;
  useEffect(() => {
    if (session?.phase !== "ready" || !session.key || handled.current === session.operation?.id) return;
    handled.current = session.operation?.id ?? null;
    if (plan) {
      // In planning mode this screen is a stage the person is standing on
      // rather than a form that has just been sent, so only what they pressed
      // here leads anywhere. A plan drafted from the spec settles under them —
      // planning decides where that lands, and it has a pane for it — and
      // walking off to the ticket would take them off the page they came to
      // read. Pressing Next is the one thing that means "on to the contract",
      // the way every way there goes.
      if (!compiling.current) return;
      navigate(confirmRoute({
        repoId: session.repoId,
        key: session.key,
        sessionId: session.id,
        approved: planApproved(workspace, session.repoId, session.key),
      }));
      return;
    }
    // Otherwise, always the ticket. Where a drafted ticket belongs — the graph
    // it was divided into, or the contract — is a question about the ticket,
    // and `TaskPage` answers it once for everybody: landing here and clicking
    // the same ticket on Home have to agree, and a rule written twice does not.
    navigate({ page: "task", repoId: session.repoId, key: session.key, view: "auto" });
    onCancel?.();
  }, [session, navigate, onCancel, plan]);
  // The last change to the plan's promise, marked on the rows
  // (D-128). The rows carry no ids —
  // the form holds the criteria as text — so each is matched to the change's
  // after-criteria by its words, first unused match first, which is exact
  // where the form shows the plan as the change left it and marks nothing
  // where it does not. None while a criterion is being edited: the row is
  // then a box, and the list is moving under it. Hooks, so ahead of the
  // waits this screen returns early with.
  const planChange = plan ? (session?.change?.plan ?? null) : null;
  const lastChange = planChange === null ? null : changeKey(session?.change ?? null);
  const changes = useMemo(
    () => (planChange === null ? null : criteriaChange(planChange.before.criteria, planChange.after.criteria)),
    [lastChange],
  );
  const rowChanges = useMemo((): (CriterionChange | undefined)[] => {
    if (changes === null || planChange === null || editing !== null) return [];
    const unused = [...planChange.after.criteria];
    return draft.criteria.map((entry) => {
      const at = unused.findIndex((criterion) => criterion.text === entry.text);
      if (at < 0) return undefined;
      const [matched] = unused.splice(at, 1);
      return changes.of.get(matched!.id);
    });
  }, [changes, planChange, draft.criteria, editing]);
  const compile = (): void => {
    compiling.current = true;
    editor.submit("compile");
  };
  const cancel = (): void => {
    if (session?.phase === "working" || editor.submitting !== null) editor.stop();
    (onCancel ?? (() => navigate({ page: "home" })))();
  };
  if (editor.loading) return <div className="launch"><p>Restoring your saved contract edits…</p></div>;
  if (editor.submitting !== null || session?.phase === "working") {
    const intent = editor.submitting ?? session?.operation?.intent;
    const drafting = intent === "generate" || intent === "startOver";
    return <WaitScreen
      bare={plan}
      title={intent === "generate"
        ? "Drafting the plan from your spec"
        : intent === "startOver"
          ? "Drafting the plan again from your spec"
          : "Compiling your contract"}
      description={drafting
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
  // Whether anything here differs from the contract it was read from. What is
  // compared is the criteria and the scope, which is the whole of what this
  // screen edits; the outcome is not editable here at all.
  const held = record === undefined ? null : contractDraft(record);
  // Scope is compared as a set, as the contract page compares it: marking a
  // path prohibited and allowed again leaves the same scope in a new order,
  // and a plan whose scope did not change should not cost an edit to walk
  // past. Criteria are compared in order, because their order is the order
  // they are read in.
  const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && [...a].sort().every((each, at) => each === [...b].sort()[at]);
  const changed =
    held === null ||
    JSON.stringify(draft.criteria) !== JSON.stringify(held.criteria) ||
    !sameSet(draft.paths, held.paths) ||
    !sameSet(draft.prohibited, held.prohibited);
  const valid =
    DraftSchema.safeParse(draft).success &&
    Boolean(repoId) &&
    editing === null &&
    !restoring;
  const repo = workspace.repositories.find((repo) => repo.id === repoId);
  return (
    <section className="screen" data-screen="s9">
      {/* Planning mode draws its own head over the pane; opened as the
          ticket's own editor this is a page of its own and says so. */}
      {!plan && <WizardHeader />}
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
                      <p className="criterion-text">
                        <MarkedCriterion text={entry.text} change={rowChanges[index]} />
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
                  }}
                />
              </div>
            ))}
            {/* The criteria the last change took away, struck through where
                the list ends, and not while a criterion is being edited. */}
            {changes !== null && editing === null && (
              <RemovedCriteria removed={changes.removed} className="criterion-editor" />
            )}
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
      {(readError || currentJob?.error) && (
        <div className="workspace-errors">
          <Notice tone="danger">{readError ?? currentJob?.error}</Notice>
          <Button onClick={() => { void editor.retry(); }}>Retry saved edits</Button>
          {/* From planning, the contract is reached the way every way there
              goes; an error here is not a reason to skip the reading. */}
          <Button onClick={() => navigate(currentKey
            ? confirmRoute({
                repoId,
                key: currentKey,
                sessionId: plan ? session?.id : null,
                approved: planApproved(workspace, repoId, currentKey),
              })
            : { page: "home" })}>
            {currentKey ? "Open the current contract" : "Check saved tasks"}
          </Button>
        </div>
      )}
      {/* The footer's words on the left; the ways out, then the way on last,
          in the bar's right corner. */}
      <PageFooter>
        <span role="status" className="small muted">{editor.saving ? "Saving edits…" : session ? "Edits saved on this device" : "Edits could not be restored"}</span>
        <span className="small muted">
          Still free to change. Approving on the contract freezes them.
        </span>
        <span className="spacer" />
        {!plan && (
          <Button onClick={() => { void editor.discard().then((discarded) => { if (discarded) cancel(); }); }}>
            Discard saved edits
          </Button>
        )}
        {!plan && <Button onClick={cancel}>Cancel</Button>}
        {/* One control onward, and what it does depends on whether anything
            here moved. In planning this is the plan itself, and a person who
            read it and changed nothing should not spend an edit on the way
            past; where they did change something, the change goes through the
            same validated path every other edit goes through (D-100). */}
        <Button
          variant="primary"
          disabled={!valid || pending}
          onClick={() => {
            if (plan && !changed && currentKey && session)
              navigate(confirmRoute({
                repoId,
                key: currentKey,
                sessionId: session.id,
                approved: planApproved(workspace, repoId, currentKey),
              }));
            else compile();
          }}
        >
          {plan ? "Next" : "Compile the contract"}
        </Button>
      </PageFooter>
    </section>
  );
}
