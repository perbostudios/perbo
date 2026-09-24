import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button, EmptyState, InkIcon } from "../ui/index.js";
import { useCreate } from "../shell/create.js";
import { useContractEditing } from "../contract-editor.js";
import { ExplorerPane } from "./ExplorerPane.js";
import { ImpactPane } from "./ImpactPane.js";
import { HistoryDrawer } from "./HistoryDrawer.js";
import { InterviewDock } from "./InterviewDock.js";
import { DockHandle } from "./DockHandle.js";
import { dockWidthLimit, useDockWidth } from "../shell/dock-size.js";
import { bridge } from "../workspace/index.js";
import { PLANNING_PANES, panesFor, planPaneFor, remembered, reopenPane } from "./panes.js";
import type { PageProps } from "../shell/route.js";
import type { PlanningPane } from "../../shared/protocol.js";
const SpecPane = lazy(() =>
  import("./SpecPane.js").then((module) => ({ default: module.SpecPane })),
);
const GraphPane = lazy(() =>
  import("./GraphPane.js").then((module) => ({ default: module.GraphPane })),
);
const Composer = lazy(() =>
  import("../tasks/Composer.js").then((module) => ({ default: module.Composer })),
);
const DriftPane = lazy(() =>
  import("./DriftPane.js").then((module) => ({ default: module.DriftPane })),
);

/**
 * Planning mode (D-101): one piece of work in one repository, held as a
 * contract editing session so it survives leaving and restarting. The Spec
 * pane holds the spec the plan is drafted from, and the contract steps under
 * it (D-103); the Explorer pane reads the repository and marks paths for the
 * draft's scope; the Graph pane curates the execution graph and confirms it
 * to the contract, where the one approval is (D-100); the Impact pane lists
 * what the draft is likely to touch that its scope does not cover (D-015),
 * checked once when the plan first arrives and by its button after that; the
 * Problems pane, on the way from the plan to the contract, reads the plan
 * against the spec and puts each place the two have parted, one at a time
 * (D-128).
 *
 * One pane at a time, with the interview docked beside it (D-102) and the
 * plan's history opening as a drawer over the pane, so the chat is there from
 * the first question to the approval. The one pane without it is Problems: a
 * problem is a card of the chat's own shape, and the pane takes the width for
 * it, while the chat shows the same card beside every other pane. The dock is
 * outside the panes, so a pane knows nothing about it and adding one adds an
 * entry to {@link PLANNING_PANES} and a branch here.
 */
export function PlanningMode({
  workspace,
  navigate,
  sessionId,
  pane,
}: PageProps & { sessionId: string; pane: PlanningPane | null }) {
  const create = useCreate();
  const stored = useDockWidth();
  // How much room there is for the two of them, measured rather than assumed:
  // the rail and the window both move it, and the drag has to stop where the
  // dock actually stops.
  const plan = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const held = plan.current;
    if (held === null) return;
    const measure = (): void => setRoom(held.getBoundingClientRect().width);
    measure();
    // A window that has no ResizeObserver still has a resize event, which is
    // what moves this in practice; the observer also catches the rail opening
    // and closing beside it.
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(held);
    return () => observer.disconnect();
  }, []);
  // Landing on the plan the moment there is one.
  //
  // Drafting it is the one thing in planning that takes minutes and finishes
  // somewhere the person is not looking: they press Generate plan on the Spec
  // pane, or ask for it in the chat, and the pane they are on has nothing more
  // to say when it lands. The rail grows a pane at that moment, and a new
  // entry in the rail is not an answer — it is something to notice. So the
  // page goes where the work went: the Graph for work the drafter divided, the
  // criteria for work it did not.
  //
  // Only on the change, and only a change seen from this page: a planning
  // opened on the Spec pane over a plan that already exists is a person who
  // came to read the spec, and this leaves them there.
  // Which pane holds this planning's plan, or null where it has none — and
  // undefined where the drafts have not been read yet, which is not the same
  // thing. A list that has not arrived says nothing about whether there is a
  // plan, and treating it as "none" makes every planning look like one whose
  // plan has just landed the moment the list does.
  const listed = (workspace.drafts ?? []).some((entry) => entry.id === sessionId);
  const planPane = listed ? planPaneFor(workspace.drafts, sessionId) : undefined;
  // Remembered against the planning it was read for: this component is not
  // remounted when the session changes under it, so a bare flag would carry
  // one planning's answer into the next and send a person opening a plan that
  // already has one straight to it.
  const wasPlanned = useRef<{ sessionId: string; pane: typeof planPane } | null>(null);
  useEffect(() => {
    const before = wasPlanned.current;
    wasPlanned.current = { sessionId, pane: planPane };
    if (before?.sessionId !== sessionId || before.pane === undefined || planPane === undefined)
      return;
    // A first plan, and a re-draft that changed its shape — dividing work that
    // was one piece, or putting a divided plan back together. Both move the
    // plan to a pane the person is not on. Not off the Problems pane, though:
    // the ticket lands there while problems are open, and a plan reshaped
    // under it is still the plan the problems are about.
    if (before.pane !== planPane && planPane !== null && pane !== "drift")
      navigate({ page: "planning", sessionId, pane: planPane });
  }, [planPane, navigate, sessionId, pane]);
  // Where the person is, written down as they get there, so every way back
  // into this planning opens it on the same pane
  // (D-130). Once per pane, and nothing
  // as the page goes: going Home and closing Perbo each find the pane already
  // recorded by the move that reached it. Only a pane that is a place to be
  // left at, and only one this planning offers: an address typed by hand
  // naming a pane it has not got is not where the person is.
  const visited =
    panesFor(workspace.drafts, sessionId).find((entry) => entry.id === pane && remembered(entry.id))?.id ?? null;
  useEffect(() => {
    if (visited !== null)
      void bridge.request({ kind: "editingVisited", id: sessionId, pane: visited }).catch(() => undefined);
  }, [sessionId, visited]);
  // A link to the planning itself names no pane, and it opens where it was
  // left — which the drafts list says, so not before the list has this
  // planning in it. In place of that link, so Back does not return to it and
  // be sent on again.
  const reopen = pane === null && listed ? reopenPane(workspace.drafts, sessionId) : null;
  useEffect(() => {
    if (reopen !== null) navigate({ page: "planning", sessionId, pane: reopen }, { replace: true });
  }, [reopen, navigate, sessionId]);
  const limit = dockWidthLimit(room);
  const dock = Math.min(stored, limit);
  // The same editor the Composer binds to: the host is asked for the session, and its answer decides whether there is planning to show.
  const editor = useContractEditing({ kind: "session", id: sessionId }, workspace.settings);
  const [history, setHistory] = useState(false);
  const discarded = editor.session?.phase === "discarded";
  if (discarded || (!editor.loading && !editor.session && editor.error))
    return (
      <section className="screen">
        <EmptyState
          title={discarded ? "This planning was discarded" : "This planning could not be opened"}
          action={
            <span className="empty-actions">
              <Button variant="primary" onClick={create.open}>
                Create a task
              </Button>
              <Button onClick={() => navigate({ page: "home" })}>Back to Home</Button>
              {!discarded && <Button onClick={() => void editor.retry()}>Try again</Button>}
            </span>
          }
        >
          {discarded
            ? "Its edits were thrown away. Start again from Create, or go back to Home."
            : `${editor.error} Start again from Create, go back to Home, or try again.`}
        </EmptyState>
      </section>
    );
  const open =
    pane === null ? (
      <Opening what="planning" />
    ) : pane === "criteria" ? (
      // The plan, for work the drafter did not divide: the criteria it will be
      // judged against, which is the whole of what there is to check.
      <Suspense fallback={<div className="launch"><InkIcon name="dots" /><p>Opening…</p></div>}>
        <Composer
          key={sessionId}
          workspace={workspace}
          navigate={navigate}
          target={{ kind: "session", id: sessionId }}
          plan
        />
      </Suspense>
    ) : pane === "explorer" ? (
      <ExplorerPane workspace={workspace} navigate={navigate} editor={editor} />
    ) : pane === "impact" ? (
      <ImpactPane workspace={workspace} navigate={navigate} editor={editor} />
    ) : pane === "graph" ? (
      <Suspense fallback={<Opening what="the graph" />}>
        <GraphPane workspace={workspace} navigate={navigate} editor={editor} />
      </Suspense>
    ) : pane === "drift" ? (
      // The step from the plan to the contract: the plan read against the
      // spec, and each problem put on its own, as a card whose answer is a
      // turn (D-128).
      <Suspense fallback={<Opening what="the problems" />}>
        <DriftPane key={sessionId} workspace={workspace} navigate={navigate} editor={editor} />
      </Suspense>
    ) : (
      <Suspense fallback={<Opening what="planning" />}>
        <SpecPane key={sessionId} workspace={workspace} navigate={navigate} sessionId={sessionId} />
      </Suspense>
    );
  return (
    <div className="plan" ref={plan}>
      <section
        className="pane"
        aria-label={PLANNING_PANES.find((entry) => entry.id === pane)?.label ?? "Planning"}
      >
        {open}
        {history && <HistoryDrawer editor={editor} onClose={() => setHistory(false)} />}
      </section>
      {/* The chat stays on every pane but Problems: its work after a draft is
          changing the plan through the validated edit path, each change a card
          with an undo (D-102, D-100). It opens narrow so the pane beside it —
          the graph most of all — has the room, and the bar between them still
          moves. On Problems the card in the pane is the chat's own card, and a
          second beside it would be two ways to do one thing. Not before the
          planning has a pane to stand beside, either. */}
      {pane !== "drift" && pane !== null && (
        <>
          <DockHandle width={dock} limit={limit} />
          <InterviewDock
            workspace={workspace}
            editor={editor}
            historyOpen={history}
            onHistory={() => setHistory((shown) => !shown)}
            width={dock}
          />
        </>
      )}
    </div>
  );
}

function Opening({ what }: { what: string }) {
  return (
    <div className="launch">
      <InkIcon name="dots" />
      <p>Opening {what}…</p>
    </div>
  );
}
