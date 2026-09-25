import { useEffect, useRef, useState } from "react";
import { Button, Dialog, InkIcon, Notice } from "../ui/index.js";
import { bridge, errorMessage, useAction } from "../workspace/index.js";
import { isRun } from "../../shared/jobs.js";
import { displayKey } from "./ticket-workspace.js";
import { taskRecords } from "./task-context.js";
import type { TaskContext } from "./task-context.js";
import { TaskHeader } from "./LoopScreen.js";
import { deletes, useCreate, useDiscardTicket, useSettle } from "../shell/create.js";
import { draftedLanding } from "../planning/panes.js";

/**
 * The page a stopped run lands on.
 *
 * A stop is a job-level abort with two endings: inside the executor's window
 * the attempt seals and the ticket goes to `failed`, and outside it the CLI is
 * killed where it stood and the ticket is stranded at `provisioning`,
 * `executing`, `verifying` or `independent_review`. Both are the same thing to
 * a person — the run was stopped and the work is still there — so this page
 * reads for both.
 *
 * It holds the ticket's name, that the run was stopped, and the three ways the
 * records allow, named and nothing more. The contract is approved and frozen
 * (ADR-0016), so there is no editing this plan back into shape: the work
 * deleted, the work planned again from the spec it came from, or another
 * attempt against it. Nothing here changes the lifecycle — the ticket stays
 * where the stop left it until one of the three is taken. At the other end of
 * the same row are the ways to the contract and to the agents' recorded
 * output, because this is the ticket's page for as long as it is stopped, and
 * the highlighted Continue the task at the far right.
 */
export function StoppedScreen(context: TaskContext) {
  const { detail, repoId, navigate, show } = context;
  const { ticket, jobs, latest, busy, held } = taskRecords(context);
  const action = useAction();
  const [deleting, setDeleting] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useCreate();
  const settle = useSettle();
  const discard = useDiscardTicket(action.mutateAsync, navigate);
  // Plan it again takes this ticket off Home at the click. The mark is given
  // back once a read taken after the host answered has replaced every earlier
  // one: at once where the plan was drafted, and when the page is left where
  // it was refused, so the reason stays readable on the page it was pressed on.
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
  // still live has its plan. A pull request open is not offered it at all,
  // because a ticket with one is not deleted.
  const spent = ticket.state === "failed" || ticket.state === "cancelled";
  const carryOn = (): void => {
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
      })
      .then(() => show("loop"))
      .catch(() => undefined);
  };
  // The stopped ticket and everything recorded after its contract go, and a
  // plan is drafted again from the spec, which stays: the work is back before
  // the loop, in the picker, and off Home from the click.
  const planAgain = (): void => {
    setError(null);
    setDrafting(true);
    refused.current?.();
    refused.current = null;
    const release = create.hide([deletes.ticket(repoId, ticket.key)]);
    void bridge
      .request({ kind: "replan", repoId, key: ticket.key })
      .then((opened) => {
        // Into the planning over the new plan, on the page that holds it: an
        // epic's Graph, a basic ticket's contract
        // (D-NEW-basic-and-epic-flows).
        navigate(draftedLanding(opened));
        settle(release);
      })
      .catch((failure: unknown) => {
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
        {error !== null && <Notice tone="danger">{error}</Notice>}
        {action.error && <Notice tone="danger">{errorMessage(action.error)}</Notice>}
      </div>
      <div className="approve-actions pane-confirm stopped-actions">
        <Button disabled={held} onClick={() => setDeleting(true)}>
          Delete this work
        </Button>
        {spec !== null && ticket.state !== "pr_open" && (
          <Button
            disabled={!spent || busy || drafting}
            title={spent ? undefined : `Not yet: the record still says this run is at ${ticket.state.replace("_", " ")}, and one spec is one piece of work while its ticket is live. Continue the task, or delete the work.`}
            onClick={planAgain}
          >
            {drafting ? "Drafting the plan…" : "Plan it again"}
          </Button>
        )}
        <span className="spacer" />
        <Button onClick={() => show("contract")}>Open the contract</Button>
        <Button onClick={() => show("output")}>Watch what the agents did</Button>
        {/* The highlighted action at the far right. */}
        <Button variant="primary" disabled={busy || action.isPending} onClick={carryOn}>
          Continue the task
        </Button>
      </div>
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
