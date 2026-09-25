import { Button, IconButton, InkIcon, Notice, PageFooter } from "../ui/index.js";
import { WaitScreen, WizardHeader } from "./wizard.js";
import { useEffect, useRef } from "react";
import { CriteriaEditor } from "./CriteriaEditor.js";
import { DraftSchema } from "../../shared/protocol.js";
import type { Detail, Draft, EditingTarget } from "../../shared/protocol.js";
import { useContractEditing } from "../contract-editor.js";
import type { PageProps } from "../shell/route.js";
import { isLive } from "../../shared/jobs.js";
import { confirmRoute, planApproved } from "../planning/panes.js";
export function Composer({
  workspace, navigate, existing, existingRepoId, onCancel, target: chosen, plan = false,
}: PageProps & {
  existing?: Detail;
  existingRepoId?: string;
  onCancel?: () => void;
  target?: EditingTarget;
  /**
   * Whether this stands in planning mode, as the Spec pane's screen for a
   * draft in hand, rather than as the ticket's own editor. There it is that
   * screen and nothing else: planning decides where a drafted plan lands, and
   * a plan's criteria are read and changed on its Graph or its contract
   * (D-NEW-basic-and-epic-flows).
   */
  plan?: boolean;
}) {
  // Planning mode hands over the session it holds; a ticket's own editor names the ticket.
  const target: EditingTarget = chosen ?? (existing && existingRepoId
    ? { kind: "ticket" as const, repoId: existingRepoId, key: existing.ticket.key }
    : { kind: "new" as const, repoId: workspace.repositories[0]?.id ?? "" });
  const editor = useContractEditing(target, workspace.settings, existing);
  const { draft, editing, newPath } = editor.form;
  const { repoId, record, session } = editor;
  const currentKey = session?.key ?? session?.operation?.resultKey;
  const setDraft = (draft: Draft): void => editor.update({ draft });
  const setNewPath = (newPath: string | null): void => editor.update({ newPath });
  const handled = useRef<string | null>(session?.phase === "ready" ? session.operation?.id ?? null : null);
  const currentJob = workspace.jobs.find((job) => job.id === session?.operation?.jobId && job.repoId === repoId);
  // Only this session's own drafting holds its Start: planning runs beside a run and beside another session (D-101).
  const pending = Boolean(currentJob && isLive(currentJob));
  const restoring = editor.loading || !session || ["conflict", "outcome-unknown"].includes(session.phase);
  const readError = editor.error;
  useEffect(() => {
    if (session?.phase !== "ready" || !session.key || handled.current === session.operation?.id) return;
    handled.current = session.operation?.id ?? null;
    // In planning mode a plan drafted from the spec settles under the person,
    // and planning decides where that lands.
    if (plan) return;
    // Otherwise, always the ticket. Where a drafted ticket belongs — the graph
    // it was divided into, or the contract — is a question about the ticket,
    // and `TaskPage` answers it once for everybody: landing here and clicking
    // the same ticket on Home have to agree, and a rule written twice does not.
    navigate({ page: "task", repoId: session.repoId, key: session.key, view: "auto" });
    onCancel?.();
  }, [session, navigate, onCancel, plan]);
  const compile = (): void => editor.submit("compile");
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
  if (plan) return null;
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
      <WizardHeader />
      <div className="wizard-body criteria-body">
          <div className="criteria-intro">
            <h2>Acceptance criteria</h2>
            <p>
              Each one states what must be <strong>proven</strong>, not where
              the proof will live. The test doesn’t exist yet — the reviewer
              records what actually proved it, afterwards.
            </p>
          </div>
          <CriteriaEditor editor={editor} />
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
          <Button onClick={() => navigate(currentKey
            ? confirmRoute({
                repoId,
                key: currentKey,
                sessionId: null,
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
        <Button onClick={() => { void editor.discard().then((discarded) => { if (discarded) cancel(); }); }}>
          Discard saved edits
        </Button>
        <Button onClick={cancel}>Cancel</Button>
        <Button variant="primary" disabled={!valid || pending} onClick={compile}>
          Compile the contract
        </Button>
      </PageFooter>
    </section>
  );
}
