import { useEffect, useRef, useState } from "react";
import { Button, Dialog, InfoHint, InkIcon, Notice } from "../ui/index.js";
import { useQueryClient } from "@tanstack/react-query";
import { bridge, errorMessage, useAction, useTaskSummary } from "../workspace/index.js";
import { isRun } from "../../shared/jobs.js";
import { displayKey } from "./ticket-workspace.js";
import { gateClosedReasons, runEnding, taskRecords } from "./task-context.js";
import type { StopReason, TaskContext } from "./task-context.js";
import { LoopStages, TaskHeader } from "./LoopScreen.js";
import { ConfirmDelete, deletes, ticketSpec, useCreate, useDiscardTicket, useSettle } from "../shell/create.js";
import { draftedLanding } from "../planning/panes.js";
import { deletePullRequestOpen, pullRequestOpen } from "../../shared/discard.js";
import { ModelPicker, connectionsFor, useProviders } from "../settings/ConnectionScreens.js";
import { providerName } from "../../shared/contract-editing.js";
import { TaskModelsSchema, type ModelProvider, type Provider, type TaskModels } from "../../shared/protocol.js";
import { connectionName, type UsageLimitStop } from "@perbo/contracts/browser";
import { resetLabel } from "./usage-limit.js";

/**
 * The page a stopped run lands on.
 *
 * A stop is a job-level abort with two endings: inside the executor's window
 * the attempt seals and the ticket goes to `failed`, and outside it the CLI is
 * killed where it stood and the ticket is stranded at `provisioning`,
 * `executing`, `verifying` or `independent_review`. A run that ended short of
 * a result for any other reason — Perbo closing, a limit, a refusal, an error
 * — is stopped too, so this page reads for all of them. A run that ended on a
 * verdict for the person is paused for them, and never lands here.
 *
 * It holds the ticket's name, that the run was stopped, the progress wheel
 * where the run had taken it, and the reasons it stopped, one line each, read
 * from the records as the loop page's ended card is (`runEnding`), with the
 * whole of each behind an `i`. The contract is approved and frozen
 * (ADR-0016), so there is no editing this plan back into shape: the work
 * deleted, the work planned again from the spec it came from, or — only after
 * the person's own stop, Perbo closing or a provider's usage limit — another
 * attempt against it. Plan it again asks first, as the picker asks before a
 * delete, saying what goes and what stays ({@link confirmPlanAgain}), and once
 * confirmed opens the planning over the plan it drafts by itself. Nothing here
 * changes the lifecycle — the ticket stays where the stop left it until one of
 * them is taken. Where its pull request reads open, Refresh from GitHub stands
 * in for Delete and Plan it again, and reads it again (D-129). At the other
 * end of the same row is the way to the paused loop, where the agents'
 * recorded output is and the way back here, and the
 * highlighted Continue the task at the far right.
 *
 * A run a provider's usage limit ended (D-NEW-pass-a-limited-loop-on) is
 * said in one sentence with the reset the provider stated, and carries on two
 * ways: Continue on another model, the highlighted one at the far right, which
 * opens the contract's model picker for the role that was limited on the
 * other connections signed in for it and starts the run from the stopped
 * attempt's work on the one chosen; and Continue the task on the same
 * connection, held until the stated reset has passed, since a limit is the
 * connection's. Where no other connection runs that role, the page says so
 * and Continue the task is the one way on.
 */
export function StoppedScreen(context: TaskContext) {
  const { detail, repoId, navigate, show } = context;
  const { ticket, title, jobs, latest, busy, held, projection, models } = taskRecords(context);
  const action = useAction();
  const [deleting, setDeleting] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const client = useQueryClient();
  // The branch the runs left in git, which the confirmation names: the
  // ticket's delivery where it records one, else its attempts', read once the
  // confirmation is asked.
  const summary = useTaskSummary(repoId, ticket.key, confirming && !ticket.delivery.branch);
  const branch = ticket.delivery.branch ?? summary.data?.branch ?? null;
  const [error, setError] = useState<string | null>(null);
  // D-NEW-pass-a-limited-loop-on: the usage limit the run ended on, whether it
  // still holds — read again at the stated reset, so Continue the task is
  // offered the moment it passes — and the other connections that run the
  // role it limited.
  const limit = projection.limited;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (limit === null) return;
    const left = Date.parse(limit.until) - now;
    if (left <= 0) return;
    // A timer longer than this fires at once, so a reset further out is read
    // again when this one fires.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(left + 50, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [limit?.until, now]);
  const holds = limit !== null && Date.parse(limit.until) > now;
  const providers = useProviders();
  const others =
    limit === null || providers.data === undefined
      ? []
      : connectionsFor(providers.data, limit.role).filter((id) => id !== limit.provider);
  const [passing, setPassing] = useState(false);
  const create = useCreate();
  const settle = useSettle();
  const discard = useDiscardTicket(action.mutateAsync, () => navigate({ page: "home" }));
  // Plan it again takes this ticket off Home at the click. The mark is given
  // back once a read taken after the host answered has replaced every earlier
  // one: at once where the plan was drafted, and when the page is left where
  // it was refused, so the reason stays readable on the page it was pressed on.
  // Its spec's mark is given back as the host answers either way.
  const unmounted = useRef(false);
  const refused = useRef<(() => void) | null>(null);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (refused.current) settle(refused.current);
    };
  }, []);
  // What the last attempt sealed, which is what another attempt can be handed.
  // A cancelled attempt still writes its execution bundle, so this is present
  // after a stop inside the executor's window and absent after one outside it.
  const bundle = latest?.bundles.find((bundle) => bundle.kind === "execution");
  // The publication choice the stopped run was started with, which the
  // contract page asked for: carrying on from it is not a new question.
  const publish = jobs.filter(isRun).at(-1)?.publish ?? false;
  // The plan this work was drafted from is planned again from its spec, and a
  // contract admitted at the terminal for work that never had one has no spec
  // to go back to.
  const spec = ticket.admission.spec?.path ?? null;
  // A plan is drafted again only in place of a spent record: a stop inside
  // the executor's window seals the ticket at `failed`, a stop outside it
  // leaves the ticket saying the stage it reached, and a spec whose ticket is
  // still live has its plan. A ticket in `changes_requested` that this page
  // shows asks the person nothing (`ticketRun`): its loop ended on a verdict
  // nobody can answer, so it is spent, and planning again is the way forward
  // (D-132). A ticket whose pull request is open — at `pr_open`, or an
  // escalated run's that published (D-065) — is offered neither this nor
  // Delete, because a ticket with one is not deleted, and the page says so in
  // one sentence naming it (D-129). Nothing else reads the delivery record of
  // a ticket past `pr_open` again, so the page offers the sync that does:
  // once it reads the pull request closed or merged, both return.
  const spent =
    ticket.state === "failed" || ticket.state === "cancelled" || (ticket.state === "changes_requested" && projection.recoverable);
  const prOpen = pullRequestOpen(ticket);
  const refreshable = prOpen && ticket.state !== "pr_open";
  const replannable = spec !== null && !prOpen;
  // Whether Plan it again can be pressed now, which is what a hover may point to.
  const planAgainLive = replannable && spent;
  // Why the run stopped: the reasons of its last run, read as the loop page's
  // ended card reads them, or — a run that closed the gate with nothing left
  // to ask the person — the outcome its row records.
  const ending = runEnding(jobs.filter(isRun), latest);
  const closedGate = ending === null ? gateClosedReasons(ticket.history, detail.attempts) : null;
  const reasons: StopReason[] = ending?.reasons ?? closedGate ?? [
    {
      text: "Perbo holds no record of how this run ended.",
      detail:
        "The command that ran this ticket's loop is not on record here, so what stopped it cannot be read. " +
        "The attempts it recorded and the evidence they sealed are still kept.",
    },
  ];
  // Continue carries on only from the person's own stop, Perbo closing or a
  // provider's usage limit (`carriesOn`):
  // every other reason is one another attempt at the same plan meets again,
  // and where the record is gone nothing says which it was.
  const onward = prOpen
    ? deletePullRequestOpen(ticket)
    : planAgainLive
      ? "Plan it again to change the spec or the plan and start the loop over."
      : "Delete this work to start it over from a new plan.";
  const why = projection.continuable
    ? undefined
    : ending === null && closedGate === null
      ? "Continue the task carries on only from a stop you made, from Perbo closing or from a provider's usage limit, and Perbo holds no record of " +
        `how this run ended, so it cannot tell which this was. ${onward}`
      : "Continue the task carries on only from a stop you made, from Perbo closing or from a provider's usage limit, and this run stopped for " +
        `${reasons.length === 1 ? "the reason" : "the reasons"} listed, which another attempt at the same plan would ` +
        `meet again. ${onward}`;
  const carryOn = (models?: TaskModels): void => {
    setError(null);
    void action
      .mutateAsync({
        kind: "run",
        repoId,
        key: ticket.key,
        digest: detail.digest,
        // The contract is already approved and frozen (ADR-0016). This is
        // another attempt against it, never a second approval.
        approve: false,
        publish,
        resumeFrom: bundle?.bundle_id ?? null,
        // The models the person carries a limited run on with, written to
        // the ticket's models by the host: not part of the contract.
        ...(models === undefined ? {} : { models: TaskModelsSchema.strip().parse(models) }),
      })
      .then(() => show("loop"))
      .catch(() => undefined);
  };
  // After a usage limit, the same connection carries on once the reset the
  // provider stated has passed.
  const connection = limit === null ? "" : connectionName(limit.provider);
  const carryOnTitle = holds
    ? `The usage limit on ${connection} holds until ${resetLabel(limit!)}, as the provider stated, and it covers ` +
      `every model ${connection} runs. Continue the task carries on on ${connection} once it has passed; ` +
      "Continue on another model carries on now."
    : why;
  // Another connection to carry the limited role on with, where one is signed in.
  const passesOn = limit !== null && others.length > 0;
  // The stopped ticket and everything recorded after its contract go, and a
  // plan is drafted again from the spec, which stays: the work is back before
  // the loop, and off Home and out of the picker from the click — its spec
  // too, which the picker would otherwise offer as a spec with no plan while
  // the host has deleted the ticket and not yet drafted the new one, a second
  // way into the same work.
  const planAgain = (): void => {
    setConfirming(false);
    setError(null);
    setDrafting(true);
    refused.current?.();
    refused.current = null;
    const release = create.hide([deletes.ticket(repoId, ticket.key)]);
    const specBack = create.hide(ticketSpec({ repoId, ticket }).map(deletes.specAt));
    void bridge
      .request({ kind: "replan", repoId, key: ticket.key })
      .then(async (opened) => {
        // Into the planning over the new plan by itself, on the page that
        // holds it — an epic's Graph, a basic ticket's contract — once the
        // workspace holds that planning, so the rail offers its panes as it
        // lands (D-138).
        await client.invalidateQueries({ queryKey: ["workspace"] }).catch(() => undefined);
        navigate(draftedLanding(opened));
        release();
        specBack();
      })
      .catch((failure: unknown) => {
        // The spec is back in the picker at once: a refusal after the delete
        // says that is where to draft the plan from.
        specBack();
        setError(errorMessage(failure));
        setDrafting(false);
        if (unmounted.current) settle(release);
        else refused.current = release;
      });
  };
  return (
    <section className="screen" data-screen="stopped">
      <TaskHeader {...context} />
      <div className="stopped-body">
        <div className="stopped-heading">
          <InkIcon name="locked" size={32} />
          <h1>The run was stopped</h1>
        </div>
        <LoopStages stage={projection.stage} mark="stopped" />
        <ul className="stopped-reasons" aria-label="Why the run stopped">
          {reasons.map((reason, index) => (
            <li key={index}>
              <InkIcon name="alert" size={16} />
              <span>
                {reason.text} <InfoHint text={reason.detail} label="Why the run stopped" />
              </span>
            </li>
          ))}
        </ul>
        {prOpen && <Notice tone="warning">{deletePullRequestOpen(ticket)}</Notice>}
        {limit !== null && providers.data !== undefined && others.length === 0 && (
          <p className="stopped-limit">
            {`No other connection that runs the ${limit.role} is signed in, so the task carries on on ${connection} ` +
              (holds ? `once its limit resets ${resetLabel(limit)}.` : "now that its limit has reset.")}
          </p>
        )}
        {error !== null && <Notice tone="danger">{error}</Notice>}
        {action.error && <Notice tone="danger">{errorMessage(action.error)}</Notice>}
      </div>
      <div className="approve-actions pane-confirm stopped-actions">
        {refreshable && (
          <Button
            disabled={busy || action.isPending}
            onClick={() => {
              setError(null);
              action.mutate({ kind: "sync", repoId, key: ticket.key });
            }}
          >
            Refresh from GitHub
          </Button>
        )}
        {!prOpen && (
          <Button disabled={held} onClick={() => setDeleting(true)}>
            Delete this work
          </Button>
        )}
        {replannable && (
          <Button
            disabled={!spent || busy || drafting}
            title={
              spent
                ? undefined
                : `Not yet: the record still says this run is at ${ticket.state.replace("_", " ")}, and one spec is one piece of work while its ticket is live. ${projection.continuable ? "Continue the task, or delete the work." : "Delete the work to start it over."}`
            }
            onClick={() => setConfirming(true)}
          >
            {drafting ? "Drafting the plan…" : "Plan it again"}
          </Button>
        )}
        <span className="spacer" />
        {/* The loop is paused only where the person stopped it, Perbo closed or
            a provider's usage limit ended it: there Continue carries on from
            it. Every other stop ended it. */}
        <Button onClick={() => show("loop")}>
          {projection.continuable ? "View the paused loop" : "View the loop"}
        </Button>
        {/* The highlighted action at the far right: carrying a usage limit on
            to another connection where there is one, and otherwise this. */}
        <Button
          variant={passesOn ? "secondary" : "primary"}
          disabled={!projection.continuable || holds || busy || action.isPending}
          title={carryOnTitle}
          onClick={() => carryOn()}
        >
          Continue the task
        </Button>
        {limit !== null && (providers.data === undefined || passesOn) && (
          <Button
            variant="primary"
            disabled={!passesOn || busy || action.isPending}
            title={passesOn ? undefined : "Reading which connections are signed in…"}
            onClick={() => setPassing(true)}
          >
            Continue on another model
          </Button>
        )}
      </div>
      {passing && limit !== null && (
        <PassOn
          limit={limit}
          holds={holds}
          models={models}
          connections={providers.data ?? []}
          others={others}
          pending={busy || action.isPending}
          close={() => setPassing(false)}
          start={(chosen) => {
            setPassing(false);
            carryOn(chosen);
          }}
        />
      )}
      {confirming && (
        <ConfirmDelete
          label="Plan it again"
          confirm={confirmPlanAgain(title, branch, projection.continuable)}
          disabled={!spent || busy || drafting}
          keep={() => setConfirming(false)}
          remove={planAgain}
        />
      )}
      {deleting && (
        <Dialog title={"Delete " + displayKey(ticket.key) + "?"} onClose={() => setDeleting(false)}>
          <p>
            This removes the ticket, its contract and plan, the reading of that plan against its
            spec, every attempt it recorded and the evidence those attempts sealed, and the spec
            folder they came from. It cannot be undone.
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

/**
 * Continue on another model (D-NEW-pass-a-limited-loop-on): the contract's
 * model picker for the role the usage limit stopped, open on the first other
 * connection signed in for it, the limited connection marked and held until
 * its reset. What is chosen is written to the ticket's models and the run
 * starts from the stopped attempt's work; the approved contract is untouched
 * (ADR-0016). The reviewer's model is the person's choice (D-010), and the
 * note says it is part of what the review's evidence records.
 */
function PassOn({
  limit,
  holds,
  models,
  connections,
  others,
  pending,
  close,
  start,
}: {
  limit: UsageLimitStop;
  holds: boolean;
  models: TaskModels;
  connections: Provider[];
  others: ModelProvider[];
  pending: boolean;
  close: () => void;
  start: (models: TaskModels) => void;
}) {
  const [chosen, setChosen] = useState<TaskModels | null>(null);
  const connection = connectionName(limit.provider);
  const provider =
    chosen === null ? null : limit.role === "executor" ? chosen.executorProvider : chosen.reviewerProvider;
  return (
    <Dialog title="Continue on another model" onClose={close}>
      <p>
        {`${connection} reached its usage limit, which covers every model it runs` +
          (holds ? ` until ${resetLabel(limit)}` : "") +
          `. Choose the connection and the model the ${limit.role} carries on with: the run starts from the ` +
          "stopped attempt's work, and the approved contract is not changed."}
      </p>
      {limit.role === "reviewer" && (
        <p className="small muted">
          The reviewer&apos;s model is part of what the review&apos;s evidence records: the review this run takes is
          recorded as the model you choose here. Which model reviews is yours to choose, and nothing changes it
          by itself.
        </p>
      )}
      <ModelPicker
        role={limit.role}
        models={chosen ?? models}
        onChange={setChosen}
        connections={connections}
        limited={holds ? { provider: limit.provider as ModelProvider, until: resetLabel(limit) } : null}
        openOn={others[0] ?? null}
      />
      <div className="dialog-actions">
        <Button onClick={close}>Keep it stopped</Button>
        <Button
          variant="primary"
          disabled={chosen === null || pending || (holds && provider === limit.provider)}
          onClick={() => start(chosen!)}
        >
          {provider === null ? "Continue on the model chosen" : `Continue on ${providerName(provider)}`}
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * What Plan it again asks before it deletes anything, as the picker asks
 * before a delete: the work the runs built leaves Perbo and stays only in git,
 * on the branch named where the records name one; the ticket's records go; the
 * spec stays and is planned again, with none of that work carried into the
 * new plan; and, where Continue the task is offered, that it keeps the work.
 */
export function confirmPlanAgain(title: string, branch: string | null, continuable: boolean): string {
  const named = title.trim().length > 0 ? `“${title.trim()}”` : "this work";
  return (
    `Plan ${named} again? ` +
    (branch === null
      ? "The work its runs built will no longer be accessible in Perbo and remains only in git, on any branch the run left. "
      : `The work its runs built will no longer be accessible in Perbo and remains only as the branch ${branch} in git. `) +
    "Its ticket, contract and plan, every attempt it recorded and the evidence those attempts sealed are discarded. " +
    "The spec is kept and planned again, and nothing the runs built is carried into the new plan." +
    (continuable ? " Continue the task keeps that work instead." : "")
  );
}
