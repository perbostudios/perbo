import { useState } from "react";
import { Button, Dialog, Notice } from "@perbo/ui";
import { FactList, Rename, SectionLabel, WizardHeader } from "../Screen.js";
import { InkIcon } from "../InkIcon.js";
import { errorMessage, useAction } from "../data.js";
import { useShortcut } from "../shell/shortcuts.js";
import { displayKey } from "./ticket-workspace.js";
import { costLabel, taskRecords } from "./task-context.js";
import type { TaskContext } from "./task-context.js";
export function ContractScreen(context: TaskContext) {
  const { detail, repoId, navigate, show } = context;
  const { contract, ticket, criteria, models, repo, busy, held, title, latest } =
    taskRecords(context);
  const [publish, setPublish] = useState(false),
    [recover, setRecover] = useState(false),
    [renaming, setRenaming] = useState(false),
    [deleting, setDeleting] = useState(false);
  const action = useAction();
  const unrun = detail.attempts.length === 0 && !ticket.delivery.pull_request_url;
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
  useShortcut("approve", busy || action.isPending ? null : start);
  useShortcut("rename", () => setRenaming(true));
  return (
    <section className="screen" data-screen="s11">
      <WizardHeader step={3}>
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
            <FactList
              className="run-facts"
              rows={[
                ["Executor", models.executorModel],
                ["Reviewer", models.reviewerModel + " · independent"],
                ["Plan level", contract.level],
                ...(models.executorSkills.length
                  ? ([["Skills", models.executorSkills.join(" · ")]] as [
                      string,
                      string,
                    ][])
                  : []),
              ]}
            />
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
            <Button
              variant="primary"
              disabled={busy || action.isPending}
              onClick={start}
            >
              {ticket.approved_at
                ? "Start the loop"
                : "Approve · start the loop"}
            </Button>
            <div className="row">
              <Button
                disabled={
                  criteria.some(
                    (criterion) =>
                      criterion.expected_verification.kind === "manual",
                  ) || ticket.approved_at !== null
                }
                onClick={() =>
                  navigate({
                    page: "task",
                    repoId,
                    key: ticket.key,
                    edit: true,
                  })
                }
              >
                Back
              </Button>
              <Button onClick={() => navigate({ page: "home" })}>
                Save draft
              </Button>
            </div>
            {unrun && (
              <button className="text-button small muted contract-delete" disabled={held} onClick={() => setDeleting(true)}>
                Delete this contract
              </button>
            )}
          </div>
        </aside>
      </div>
      {deleting && (
        <Dialog title={"Delete " + displayKey(ticket.key) + "?"} onClose={() => setDeleting(false)}>
          <p>
            This contract has never run, so nothing else refers to it. Deleting it removes the ticket, its
            contract and its draft from the repository’s ticket store for good.
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setDeleting(false)}>Keep it</Button>
            <Button
              variant="danger"
              disabled={busy || action.isPending}
              onClick={() => {
                void action
                  .mutateAsync({ kind: "discard", repoId, key: ticket.key })
                  .then(() => navigate({ page: "home" }))
                  .catch(() => setDeleting(false));
              }}
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
