import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog, FactList, InkIcon, Notice, SectionLabel } from "../ui/index.js";
import { WaitScreen, WizardHeader } from "./wizard.js";
import { Rename } from "./Rename.js";
import { bridge, errorMessage, useAction } from "../workspace/index.js";
import { useShortcut } from "../shell/shortcuts.js";
import { useDiscardTicket } from "../shell/create.js";
import { displayKey } from "./ticket-workspace.js";
import { EFFORT_LABELS, planNodes, type EffortLevel } from "@perbo/contracts/browser";
import { confirmRoute, contractState, curates, leftAt, planPaneFor, problemsOpen } from "../planning/panes.js";
import { readingState } from "../../shared/contract-editing.js";
import { useSettled } from "../planning/settled.js";
import { DriftVerdictSchema } from "@perbo/planning/browser";
import { CriteriaEditor } from "./CriteriaEditor.js";
import { ReadingFailedNotice } from "../planning/ReadingFailed.js";
import { changeKey, chatChange, criteriaChange } from "../planning/change-marks.js";
import type { useContractEditing } from "../contract-editor.js";
import { ModelPicker, useProviders } from "../settings/ConnectionScreens.js";
import { TaskModelsSchema, type Detail, type PlanningPane, type TaskModels } from "../../shared/protocol.js";
import { costLabel, pendingScope, taskRecords } from "./task-context.js";
import type { TaskContext } from "./task-context.js";
const ContractGraph = lazy(() =>
  import("../planning/GraphPane.js").then((module) => ({ default: module.ContractGraph })),
);
/** Why a confirm is refused while a reading of the plan against its spec has problems open, for either shape. */
export const PROBLEMS_HOLD =
  "The plan and the spec no longer promise the same thing. Resolve each problem on the Problems tab, or change the plan, then confirm again.";
/** Why a basic ticket's Confirm contract waits while the drafts list does not yet carry its planning. */
export const NOT_LISTED = "The planning is still being read. Confirm again in a moment.";

/** An approved contract's effort, where one was chosen; the provider's own default says nothing. */
const effortText = (effort: EffortLevel | null): string =>
  effort === null ? "" : " · " + EFFORT_LABELS[effort] + " effort";

/**
 * What a contract shows of its plan, on the planning's contract tab and on
 * the ticket's contract after approval alike, so the two cannot differ
 * (D-NEW-basic-and-epic-flows): an epic's
 * graph, read, panned and zoomed, and changed only on the Graph pane; a basic
 * ticket's criteria, open to edit on the contract tab while the plan waits for
 * approval and read-only everywhere else.
 */
export function contractShows(contract: Detail["contract"], editable: boolean): "graph" | "criteria-editor" | "criteria" {
  if (planNodes(contract).length > 0) return "graph";
  return editable ? "criteria-editor" : "criteria";
}

type Editor = ReturnType<typeof useContractEditing>;

/**
 * The contract, and the one approval there is. Inside planning (`planning`)
 * it is one of the planning's tabs, above Problems
 * (D-NEW-basic-and-epic-flows): the tabs are the way back, and a basic
 * ticket's criteria are edited here, each change written into the contract as
 * it is made, and the plan read against the spec as the person confirms
 * (D-128). An open problem holds the confirm for either shape.
 */
export function ContractScreen(context: TaskContext & { planning?: { editor: Editor } }) {
  const { detail, repoId, navigate, show, workspace, planning } = context;
  const { contract, ticket, criteria, models, repo, busy, held, title, latest } =
    taskRecords(context);
  const [publish, setPublish] = useState(false),
    [recover, setRecover] = useState(false),
    [renaming, setRenaming] = useState(false),
    [deleting, setDeleting] = useState(false);
  const action = useAction();
  const discard = useDiscardTicket(action.mutateAsync, navigate);
  const providers = useProviders();
  const [modelError, setModelError] = useState<string | null>(null);
  // Written straight to the ticket rather than through a contract edit: the
  // models are not part of the contract, and nothing about changing them
  // touches what approving freezes.
  const setModels = (next: TaskModels): void => {
    setModelError(null);
    try {
      // Narrowed before it is sent. What the picker hands back is what it was
      // given plus the change, and what it was given is the person's whole
      // settings object wherever this ticket has no models of its own — which
      // is every plan the interview drafted. `TaskModels` is a strict pick of
      // those settings, so the extra keys are refused at the boundary and the
      // choice is lost.
      const models = TaskModelsSchema.strip().parse(next);
      void bridge
        .request({ kind: "taskModels", repoId, key: detail.ticket.key, models })
        .catch((failure: unknown) => setModelError(errorMessage(failure)));
    } catch (failure) {
      // A bridge can refuse before it returns a promise, so this catches both.
      setModelError(errorMessage(failure));
    }
  };
  // The planning curating this ticket, where one is still open. Read from the
  // drafts rather than remembered from the way in: a page reached again from
  // Home is the same page, and it should not send somebody somewhere else for
  // having taken a different route to it.
  const curating = (workspace.drafts ?? []).find(
    (draft) => draft.repoId === repoId && draft.key === detail.ticket.key && curates(draft),
  );
  // The pane that planning was left at (D-130);
  // where it no longer offers that pane, the one holding the plan, by the same
  // rule the rail uses. Problems still open do not hold this way back: it goes
  // where the person was, and the rail offers the Problems pane from there.
  const curatingPane: PlanningPane =
    (curating && leftAt(workspace, curating.id)) ??
    (curating ? planPaneFor(workspace.drafts, curating.id) : null) ??
    "spec";
  // A change to a basic ticket's criteria, written into the contract as it is
  // made — the operation it waits on is the first after the one it saw. The
  // person stays here: the plan is read against the spec when they confirm
  // (D-NEW-basic-and-epic-flows).
  const editor = planning?.editor ?? null;
  const [writing, setWriting] = useState<{ after: string | null } | null>(null);
  // Why the host turned the last write away, kept here because the editor's
  // own error is replaced by the session's as soon as it reads it again.
  const [turnedAway, setTurnedAway] = useState<string | null>(null);
  const writeThrough = (): void => {
    if (editor === null) return;
    setTurnedAway(null);
    setWriting({ after: editor.session?.operation?.id ?? null });
    editor.submit("compile");
  };
  const operation = editor?.session?.operation ?? null;
  const written =
    writing !== null &&
    editor !== null &&
    editor.submitting === null &&
    operation !== null &&
    operation.id !== writing.after &&
    operation.intent === "compile" &&
    operation.reconciled &&
    editor.session?.phase !== "working";
  // A write that never became an operation — the host turned the submission
  // away, or it was called off before it was sent — starts nothing to wait
  // on: the submission is over and the operation is the one it saw. A refusal
  // is the editor's error, which the page shows in place of the wait.
  const refused =
    writing !== null &&
    editor !== null &&
    editor.submitting === null &&
    (operation?.id ?? null) === writing.after;
  useEffect(() => {
    if (!refused) return;
    setTurnedAway(editor?.error ?? null);
    setWriting(null);
  }, [refused]);
  // The planning's own entry in the drafts list, which holds the states the
  // contract tab and the confirm are compared by.
  const session = editor?.session ?? null;
  const listed = session === null ? undefined : (workspace.drafts ?? []).find((draft) => draft.id === session.id);
  // A write that landed moves the plan the person is looking at, which is not
  // a change made behind their back: the state it leaves is recorded as the
  // contract reached, once the drafts list carries it, so the contract stays
  // a tab (D-NEW-basic-and-epic-flows).
  const [reachedAgain, setReachedAgain] = useState<string | null>(null);
  useEffect(() => {
    if (!written || session === null) return;
    setWriting(null);
    if (operation?.state === "completed" && listed !== undefined) setReachedAgain(listed.confirmed);
  }, [written]);
  const reachedState = listed === undefined ? null : contractState(workspace, listed);
  useEffect(() => {
    if (reachedAgain === null || session === null || reachedState === null || reachedState === reachedAgain) return;
    setReachedAgain(null);
    void bridge
      .request({ kind: "editingContractVisited", id: session.id, state: reachedState })
      .catch(() => undefined);
  }, [reachedAgain, reachedState]);
  const shows = contractShows(contract, editor !== null && ticket.approved_at === null);
  // A basic ticket's Confirm contract, inside the planning over it: the plan
  // is read against the spec first, where the spec or the criteria have moved
  // since the last reading, and the confirm is refused while problems are
  // open — resolved on the Problems tab, or by changing the criteria here and
  // confirming again (D-NEW-basic-and-epic-flows). A plan with no spec to read
  // it against confirms as it is.
  const settled = useSettled();
  const reads =
    shows === "criteria-editor" &&
    planning !== undefined &&
    session !== null &&
    listed !== undefined &&
    session.specSlug !== null &&
    ticket.admission.spec !== null;
  const readAt = reads ? readingState(listed.spec, session.form.draft) : null;
  const [confirming, setConfirming] = useState(false);
  const [holding, setHolding] = useState<string | null>(null);
  // Why the confirm's reading did not run, once the host tried it until it
  // ran and every try failed: said in a pop-up over this page, which puts the
  // person back here with the confirm offered again. Nothing is confirmed
  // without the reading (D-NEW-basic-and-epic-flows).
  const [failedReading, setFailedReading] = useState<string | null>(null);
  // The last change the chat made to a basic ticket's criteria, marked over
  // the words it left; a change made here by hand is the person's own and is
  // marked nowhere (D-128). Diffed once per change.
  const chatPlan = chatChange(editor?.session?.change)?.plan ?? null;
  const chatKey = changeKey(chatChange(editor?.session?.change));
  const marks = useMemo(
    () =>
      chatPlan === null
        ? null
        : { change: criteriaChange(chatPlan.before.criteria, chatPlan.after.criteria), after: chatPlan.after.criteria },
    [chatKey],
  );
  // Which criteria are proven differently from how the draft proposed. A
  // criterion whose assertion moved reads exactly as it did, because the claim
  // is untouched, so nothing else on this page would show it.
  const moved = new Set(detail.changedAssertions);
  // Read-only once approved: what runs is settled with the approval.
  const model = (role: "executor" | "reviewer", approved: string): ReactNode =>
    ticket.approved_at === null ? (
      <ModelPicker role={role} models={models} onChange={setModels} connections={providers.data} compact />
    ) : (
      approved
    );
  // Marks made in the Explorer live in the saved session until a compile moves
  // them into the contract, and approval freezes the contract. Approving over
  // the difference would freeze a scope the person has already changed.
  const pending = ticket.approved_at === null ? pendingScope(workspace.drafts, repoId, ticket.key, contract.scope) : null;
  const bundle = latest?.bundles.find((bundle) => bundle.kind === "execution");
  const start = (): void => {
    void action
      .mutateAsync({
        kind: "run",
        repoId,
        key: ticket.key,
        digest: detail.digest,
        approve: ticket.approved_at === null,
        publish,
        resumeFrom: recover && bundle ? bundle.bundle_id : null,
      })
      .then(() => show("loop"))
      .catch(() => undefined);
  };
  // A planning the drafts list does not carry yet has no state to compare a
  // reading with, so its confirm waits for the list rather than going ahead
  // unread.
  const unlisted =
    shows === "criteria-editor" &&
    planning !== undefined &&
    session !== null &&
    listed === undefined &&
    session.specSlug !== null &&
    ticket.admission.spec !== null;
  // Whether a planning over this ticket records problems open. Any open
  // problem holds approving, for an epic as for a basic ticket, whichever
  // route reached this page: the only ways past are answering on the Problems
  // page or changing the plan (D-NEW-basic-and-epic-flows). Both hosts refuse
  // the approval too.
  const problemsHeld =
    ticket.approved_at === null &&
    (workspace.drafts ?? []).some(
      (draft) => draft.repoId === repoId && draft.key === ticket.key && problemsOpen(workspace.drafts, draft.id),
    );
  // An epic's plan is read at Confirm the plan, by way of the Problems pane.
  // One whose spec or criteria moved since the last reading goes back that
  // way from here, so the reading runs as it does there, and the pane lands
  // on this tab again where it finds nothing open.
  const epicUnread =
    shows === "graph" &&
    ticket.approved_at === null &&
    planning !== undefined &&
    session !== null &&
    listed !== undefined &&
    session.specSlug !== null &&
    ticket.admission.spec !== null &&
    listed.read !== readingState(listed.spec, session.form.draft);
  const confirm = async (): Promise<void> => {
    if (unlisted) return setHolding(NOT_LISTED);
    if (epicUnread && session !== null)
      return navigate(confirmRoute({ repoId, key: ticket.key, sessionId: session.id, approved: false, basic: false }));
    if (!reads || readAt === null || session === null || listed === undefined) {
      if (problemsHeld) setHolding(PROBLEMS_HOLD);
      else start();
      return;
    }
    setHolding(null);
    // Problems still open hold the confirm whatever else is true.
    if (listed.read === readAt) {
      if (problemsOpen(workspace.drafts, session.id)) setHolding(PROBLEMS_HOLD);
      else start();
      return;
    }
    // A reading that did not run holds the confirm too: the pop-up says why,
    // and the next press reads again.
    setConfirming(true);
    try {
      const job = await settled(await bridge.request({ kind: "driftCheck", id: session.id, state: readAt }));
      const verdict = job.state === "completed" ? DriftVerdictSchema.safeParse(job.result) : null;
      if (verdict === null)
        setFailedReading(job.error ?? "The reading did not finish.");
      else if (!verdict.success)
        setFailedReading("The reading came back in a shape this page does not understand.");
      else if (!verdict.data.dismissed && verdict.data.findings.length > 0) setHolding(PROBLEMS_HOLD);
      else start();
    } catch (error) {
      setFailedReading(errorMessage(error));
    } finally {
      setConfirming(false);
    }
  };
  // What this scope does not cover, asked here because here is where it can
  // still be acted on: a scope frozen is a scope no warning can move. It is
  // advice and never a gate — somebody who has read it and is content approves
  // straight through, and a warning that held the button would be a warning
  // people learn to click past.
  const impact = useQuery({
    queryKey: ["impact-contract", repoId, ticket.key, detail.digest],
    queryFn: () => bridge.request({ kind: "impactContract", repoId, key: ticket.key }),
    networkMode: "always",
    enabled: ticket.approved_at === null,
    // Keyed by the contract's own digest, so a re-compiled contract is a new
    // question and an unchanged one is never asked twice.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const outside = impact.data?.warnings.length ?? 0;
  const approving =
    busy || action.isPending || pending !== null || writing !== null || confirming || failedReading !== null;
  useShortcut("approve", approving ? null : () => void confirm());
  useShortcut("rename", () => setRenaming(true));
  // While the confirm's reading runs, that is the page: the contract is not
  // pressed again under it, and approving follows only where it finds nothing
  // open (D-NEW-basic-and-epic-flows).
  if (confirming)
    return (
      <WaitScreen
        bare
        title="Checking for drift"
        description="Reading the plan against the spec, where either has moved since it was last read, for anything they no longer promise alike. Nothing is changed by the reading."
        status="Reading the plan against the spec…"
      />
    );
  return (
    <>
      <section className="screen" data-screen="s11">
        <WizardHeader>
          <span className="mono muted small">{costLabel(detail)} spent</span>
        </WizardHeader>
        <div className="contract-layout">
          <div className="contract-main">
            <div>
              <div className="contract-title">
                <span className="mono muted">{displayKey(ticket.key)}</span>
                <Rename
                  title={title}
                  size={17}
                  open={renaming}
                  onOpenChange={setRenaming}
                  onSave={(title) =>
                    action.mutateAsync({
                      kind: "rename",
                      repoId,
                      key: ticket.key,
                      title,
                    })
                  }
                />
                <span className="small muted">click to rename</span>
              </div>
              <div className="outcome-summary">{contract.outcome}</div>
            </div>
            {shows === "graph" ? (
              // What a graph freezes, on the page that freezes it: the division
              // itself, read and never curated here — that is the Graph pane's
              // (D-NEW-basic-and-epic-flows).
              <div>
                <SectionLabel>Execution graph · {criteria.length} criteria</SectionLabel>
                <Suspense fallback={<p className="small muted">Reading the graph…</p>}>
                  <ContractGraph repoId={repoId} ticketKey={ticket.key} />
                </Suspense>
                {/* Approving freezes how each criterion is proven, and a graph
                    shows what is proven rather than how, so what moved since the
                    draft is named under it (D-128). */}
                {criteria.some((criterion) => moved.has(criterion.id)) && (
                  <p className="criterion-note">
                    Proven differently from the draft:{" "}
                    <span className="mono">
                      {criteria.filter((criterion) => moved.has(criterion.id)).map((criterion) => criterion.id).join(", ")}
                    </span>
                  </p>
                )}
              </div>
            ) : shows === "criteria-editor" && editor !== null ? (
              // A basic ticket's plan is its criteria, and this is where they
              // are changed: each change written into the contract as it is
              // made. The marks are the chat's last change; direct edits carry
              // none (D-128).
              <div>
                <SectionLabel>Acceptance criteria · {criteria.length}</SectionLabel>
                <CriteriaEditor editor={editor} onCommit={writeThrough} marks={marks} />
                {(writing !== null || turnedAway !== null || editor.error) && (
                  <p className="small muted" role="status">
                    {writing !== null
                      ? "Writing the change into the contract…"
                      : (turnedAway ?? editor.error)}
                  </p>
                )}
              </div>
            ) : (
            <div>
              <SectionLabel>Acceptance criteria · {criteria.length}</SectionLabel>
              <div className="contract-criteria">
                {criteria.map((criterion, index) => (
                  <div key={criterion.id}>
                    <span className="criterion-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="criterion-content">
                      <p>{criterion.text}</p>
                      <p className="criterion-note">
                        Expected {criterion.expected_verification.kind}:{" "}
                        {criterion.expected_verification.assertion}
                        {/* Approving freezes this, so the eye goes to what moved
                            rather than evenly over every line. An assertion
                            changed on purpose is the ordinary case — this is an
                            invitation to read one line, not a warning. */}
                        {moved.has(criterion.id) && (
                          <span className="criterion-moved"> · changed since the draft</span>
                        )}
                      </p>
                      {criterion.expected_verification.kind === "manual" && (
                        <>
                          <p className="criterion-note">
                            Reviewer:{" "}
                            {criterion.expected_verification.manual_reviewer}
                          </p>
                          <p className="criterion-note">
                            Why manual:{" "}
                            {criterion.expected_verification.manual_reason}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            )}
            <FactList
              className="boundary-facts"
              rows={[
                [
                  "Allowed scope",
                  contract.scope.paths_allowed.join(" · ") +
                    " · " +
                    contract.scope.expansion_budget_files +
                    " files of headroom",
                ],
                ["Off limits", contract.scope.paths_prohibited.join(" · ")],
                [
                  "Base commit",
                  contract.base.base_commit.slice(0, 7) +
                    " · " +
                    (repo?.branch ?? "") +
                    (repo?.head === contract.base.base_commit
                      ? " · still current"
                      : " · verify before running"),
                ],
              ]}
            />
            {/* The scope reads as globs; the files it reaches are what a person
                is actually approving. This opens them read-only, beside the
                contract, rather than asking anyone to hold a glob in their head. */}
            <button
              type="button"
              className="text-button small"
              onClick={() => show("explorer")}
            >
              Browse the files this scope reaches
            </button>
            {/* Where the plan and the spec disagree, read before the contract is
                frozen: this is the last moment either can still move. Beside the
                impact count and in its manner — advice, never a gate, because a
                warning that held the button is one people learn to click past
                (D-128). */}
            {ticket.approved_at === null && detail.specFindings.length > 0 && (
              <div className="spec-findings">
                {detail.specFindings.map((finding) => (
                  <p className="scope-outside" key={`${finding.kind}:${finding.requirementId}`}>
                    <InkIcon name="document" size={18} />
                    <span>
                      {finding.kind === "uncited" ? (
                        <>
                          <b>{finding.requirementId}</b> is in the spec and nothing in this plan
                          answers it{finding.text === null ? "" : `: “${finding.text}”`}. Add a
                          criterion for it, or ask the chat to take it out of the spec.
                        </>
                      ) : (
                        <>
                          {finding.criteria.length === 1 ? "A criterion" : "Criteria"}{" "}
                          <span className="mono">{finding.criteria.join(", ")}</span> cite{" "}
                          <b>{finding.requirementId}</b>, which the spec no longer states. Point them
                          at a requirement it does carry, or ask the chat to put it back —
                          approving is refused while a citation points at nothing.
                        </>
                      )}
                    </span>
                  </p>
                ))}
              </div>
            )}
            {/* Only where there is something to say. A scope that covers what the
                work reaches is the ordinary case, and a line reporting nothing is
                a line in the way of the one that matters. */}
            {ticket.approved_at === null && outside > 0 && (
              <p className="scope-outside">
                <InkIcon name="growth-chart" size={18} />
                <span>
                  {outside} {outside === 1 ? "file" : "files"} outside this scope{" "}
                  {outside === 1 ? "imports" : "import"} what it changes, or sit in a class worth
                  reading — a migration, a manifest, configuration, CI. Widening the scope is
                  free now and a new contract later.
                </span>
                <button type="button" className="text-button small" onClick={() => show("explorer")}>
                  Read them
                </button>
              </p>
            )}
            <div className="scope-message">
              <InkIcon name="locked" size={22} />
              <span>
                Four fields freeze when you approve: outcome, criteria, scope,
                base. How the work gets done stays the agent’s — you never approve
                steps, and a change to any frozen field is a new version of the
                contract.
              </span>
            </div>
            {action.error && (
              <Notice tone="danger">{errorMessage(action.error)}</Notice>
            )}
          </div>
          <aside className="contract-side">
            <section>
              <SectionLabel>Repository</SectionLabel>
              <div className="row">
                <InkIcon name="folder" size={17} />
                <span className="mono spacer">{repo?.name}</span>
                <span className="mono muted small">{repo?.branch}</span>
              </div>
            </section>
            <section>
              <SectionLabel>Computation</SectionLabel>
              {/* Chosen here, on the last page before the loop starts. The
                  models are not among the four fields approving freezes
                  (ADR-0016), so they stay a choice right up to that moment. */}
              <FactList
                className="run-facts"
                rows={[
                  ["Executor", model("executor", models.executorModel + effortText(models.executorEffort))],
                  [
                    "Reviewer",
                    model("reviewer", models.reviewerModel + effortText(models.reviewerEffort) + " · independent"),
                  ],
                  ["Plan level", contract.level],
                  ...(models.executorSkills.length
                    ? ([["Skills", models.executorSkills.join(" · ")]] as [
                        string,
                        ReactNode,
                      ][])
                    : []),
                ]}
              />
              {modelError !== null && <Notice tone="danger">{modelError}</Notice>}
            </section>
            <section>
              <SectionLabel>This run</SectionLabel>
              <FactList
                className="run-facts"
                rows={[
                  [
                    "Stops after",
                    detail.effective.stallMinutes + " min with no tool activity",
                  ],
                  ["Time, tokens, commands", "No ceiling"],
                  [
                    "Cost cap",
                    "$" +
                      detail.effective.ticketDollars.toFixed(2) +
                      " a ticket, on an API key",
                  ],
                ]}
              />
            </section>
            <section>
              <span className="small muted">Likely cost</span>
              <div className="cost-estimate">Not estimated</div>
              <p className="small muted">
                On a subscription nothing caps the spend, because the figure the
                runner measures is not your bill. The cost cap above applies only
                where your executor authenticates with an API key.
              </p>
            </section>
            <div className="approval-buttons">
              {bundle && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={recover}
                    onChange={(event) => setRecover(event.target.checked)}
                  />
                  <span>Continue from the last attempt’s retained changes.</span>
                </label>
              )}
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={publish}
                  onChange={(event) => setPublish(event.target.checked)}
                />
                <span>
                  After the review gate passes, push the branch and open a pull
                  request. I will merge it myself.
                </span>
              </label>
              {pending !== null && (
                <Notice tone="warning">
                  This planning holds a scope the contract does not carry yet —{" "}
                  {pending.allowed.length} allowed{" "}
                  {pending.allowed.length === 1 ? "path" : "paths"} and{" "}
                  {pending.prohibited.length} prohibited. Approving freezes the
                  contract&rsquo;s scope, not this one, so write it in first
                  {shows === "criteria-editor" ? "." : ": open the contract again with Back and save it."}
                  {shows === "criteria-editor" && (
                    <Button disabled={writing !== null || busy} onClick={writeThrough}>
                      Write the scope in
                    </Button>
                  )}
                </Notice>
              )}
              {confirming && (
                <p className="small muted" role="status">
                  Reading the plan against the spec…
                </p>
              )}
              {holding !== null && <Notice tone="warning">{holding}</Notice>}
              <Button variant="primary" disabled={approving} onClick={() => void confirm()}>
                {ticket.approved_at
                  ? "Start the loop"
                  : "Approve · start the loop"}
              </Button>
              <div className="row">
                {/* Inside planning the planning's tabs are the way back. */}
                {planning === undefined && <Button
                  // Shut only where it leads to the ticket's own editor: a
                  // contract with named manual reviewers is edited with the CLI
                  // so the assignments survive, and an approved one is frozen
                  // (ADR-0016). Neither is a reason not to go back to a planning
                  // — a person not ready to approve has nowhere else to go.
                  disabled={
                    curating === undefined &&
                    (criteria.some(
                      (criterion) => criterion.expected_verification.kind === "manual",
                    ) ||
                      ticket.approved_at !== null)
                  }
                  onClick={() =>
                    // The contract states what freezes; changing it is done in
                    // the planning curating it, or else the ticket's own editor.
                    curating === undefined
                      ? navigate({ page: "task", repoId, key: ticket.key, edit: true })
                      : navigate({ page: "planning", sessionId: curating.id, pane: curatingPane })
                  }
                >
                  Back to planning
                </Button>}
                <Button onClick={() => navigate({ page: "home" })}>
                  Save draft
                </Button>
              </div>
              {/* Offered at every stage, the loop included: a piece of work is
                  deleted whole and the evidence goes with it
                  (D-129). One stage is not: a ticket
                  whose pull request is open has a record on GitHub that this
                  machine does not own, and the host refuses it there too. */}
              {ticket.state !== "pr_open" && (
                <button
                  className="text-button small muted contract-delete"
                  disabled={held}
                  onClick={() => setDeleting(true)}
                >
                  Delete this contract
                </button>
              )}
            </div>
          </aside>
        </div>
        {deleting && (
          <Dialog title={"Delete " + displayKey(ticket.key) + "?"} onClose={() => setDeleting(false)}>
            <p>
              This removes the ticket, its contract and plan, the reading of that plan against its
              spec, every attempt it recorded and the evidence those attempts sealed, and the spec
              folder they came from. A piece of work is deleted whole. It cannot be undone.
            </p>
            <div className="dialog-actions">
              <Button onClick={() => setDeleting(false)}>Keep it</Button>
              <Button
                variant="danger"
                disabled={busy || action.isPending}
                onClick={() => discard(repoId, ticket.key, () => setDeleting(false))}
              >
                Delete permanently
              </Button>
            </div>
            {action.error && <Notice tone="danger">{errorMessage(action.error)}</Notice>}
          </Dialog>
        )}
      </section>
      {/* Over the pane rather than inside the page, which scrolls: the pop-up
          stays in the centre wherever the page is scrolled to. */}
      {failedReading !== null && (
        <ReadingFailedNotice error={failedReading} onAcknowledge={() => setFailedReading(null)} />
      )}
    </>
  );
}
