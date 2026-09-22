import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog, FactList, InkIcon, Notice, SectionLabel } from "../ui/index.js";
import { WizardHeader } from "./wizard.js";
import { Rename } from "./Rename.js";
import { bridge, errorMessage, useAction } from "../workspace/index.js";
import { useShortcut } from "../shell/shortcuts.js";
import { displayKey } from "./ticket-workspace.js";
import { planNodes } from "@perbo/contracts/plan";
import { costLabel, pendingScope, taskRecords } from "./task-context.js";
import type { TaskContext } from "./task-context.js";
export function ContractScreen(context: TaskContext) {
  const { detail, repoId, navigate, show, workspace } = context;
  const { contract, ticket, criteria, models, repo, busy, held, title, latest } =
    taskRecords(context);
  const [publish, setPublish] = useState(false),
    [recover, setRecover] = useState(false),
    [renaming, setRenaming] = useState(false),
    [deleting, setDeleting] = useState(false);
  const action = useAction();
  const unrun = detail.attempts.length === 0 && !ticket.delivery.pull_request_url;
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
