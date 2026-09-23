import { useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog, FactList, InkIcon, Notice, SectionLabel } from "../ui/index.js";
import { WizardHeader } from "./wizard.js";
import { Rename } from "./Rename.js";
import { bridge, errorMessage, useAction } from "../workspace/index.js";
import { useShortcut } from "../shell/shortcuts.js";
import { useDiscardTicket } from "../shell/create.js";
import { displayKey } from "./ticket-workspace.js";
import { EFFORT_LABELS, planNodes, type EffortLevel } from "@perbo/contracts/browser";
import { curates, leftAt } from "../planning/panes.js";
import { ModelPicker, useProviders } from "../settings/ConnectionScreens.js";
import { TaskModelsSchema, type PlanningPane, type TaskModels } from "../../shared/protocol.js";
import { costLabel, pendingScope, taskRecords } from "./task-context.js";
import type { TaskContext } from "./task-context.js";
/** An approved contract's effort, where one was chosen; the provider's own default says nothing. */
const effortText = (effort: EffortLevel | null): string =>
  effort === null ? "" : " · " + EFFORT_LABELS[effort] + " effort";
export function ContractScreen(context: TaskContext) {
  const { detail, repoId, navigate, show, workspace } = context;
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
  // The pane that planning was left at (D-NEW-a-planning-reopens-where-it-was-left);
  // where it no longer offers that pane, the one holding the plan, by the same
  // rule the rail uses. Problems still open do not hold this way back: it goes
  // where the person was, and the rail offers the Problems pane from there.
  const curatingPane: PlanningPane =
    (curating && leftAt(workspace.drafts, curating.id)) ??
    ((curating?.nodes ?? 0) > 0 ? "graph" : "criteria");
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
  useShortcut("approve", busy || action.isPending || pending !== null ? null : start);
  useShortcut("rename", () => setRenaming(true));
  return (
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
          {/* What a graph freezes, on the page that freezes it. A divided plan
              is approved here and curated on the Graph pane, so the division
              has to be readable here too — approving what you cannot see is
              the one thing this screen exists to prevent. */}
          {planNodes(contract).length > 0 && (
            <section className="contract-nodes" aria-label="How the work divides">
              <SectionLabel>How the work divides</SectionLabel>
              <ol>
                {planNodes(contract).map((node) => (
                  <li key={node.id}>
                    <b>{node.title}</b>
                    <span className="small muted">
                      {node.criteria.length} {node.criteria.length === 1 ? "criterion" : "criteria"}
                      {node.paths.length > 0 ? ` · ${node.paths.join(" · ")}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
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
              (D-NEW-the-plan-answers-the-spec-and-says-so). */}
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
                contract&rsquo;s scope, not this one, so compile it in first:
                open the contract again with Back and save it.
              </Notice>
            )}
            <Button
              variant="primary"
              disabled={busy || action.isPending || pending !== null}
              onClick={start}
            >
              {ticket.approved_at
                ? "Start the loop"
                : "Approve · start the loop"}
            </Button>
            <div className="row">
              <Button
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
              </Button>
              <Button onClick={() => navigate({ page: "home" })}>
                Save draft
              </Button>
            </div>
            {/* Offered at every stage, the loop included: a piece of work is
                deleted whole and the evidence goes with it
                (D-NEW-a-spec-outlives-its-planning). One stage is not: a ticket
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
  );
}
