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
import { PLANNING_PANES, contractState, flowFor, remembered, reopenPane } from "./panes.js";
import { SimpleTaskNotice, useDraftLanding } from "./SimpleTask.js";
import { WaitScreen } from "../tasks/wizard.js";
import type { PageProps } from "../shell/route.js";
import type { PlanningPane } from "../../shared/protocol.js";
const SpecPane = lazy(() =>
  import("./SpecPane.js").then((module) => ({ default: module.SpecPane })),
);
const GraphPane = lazy(() =>
  import("./GraphPane.js").then((module) => ({ default: module.GraphPane })),
);
const ContractPane = lazy(() =>
  import("./ContractPane.js").then((module) => ({ default: module.ContractPane })),
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
 * (D-128), the lowest tab while a problem is open; and the contract, above
 * it, where the one approval is. Which
 * of them a planning offers is `flowFor`'s (D-NEW-basic-and-epic-flows).
 *
 * One pane at a time, with the interview docked beside it (D-102) and the
 * plan's history opening as a drawer over the pane, so the chat is there from
 * the first question to the contract. Two panes are without it: Problems,
 * where a problem is a card of the chat's own shape and the pane takes the
 * width for it, while the chat shows the same card beside every other pane;
 * and the contract, whose criteria are edited by hand. The dock is outside
 * the panes, so a pane knows nothing about it and adding one adds an entry to
 * {@link PLANNING_PANES} and a branch here.
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
  // Where the person is, written down as they get there, so every way back
  // into this planning opens it on the same pane
  // (D-130). Once per pane, and nothing
  // as the page goes: going Home and closing Perbo each find the pane already
  // recorded by the move that reached it. Only a pane that is a place to be
  // left at, and only one this planning offers: an address typed by hand
  // naming a pane it has not got is not where the person is.
  //
  // The contract is written down with the state it was reached at, which
  // keeps it a tab until that state moves (D-NEW-basic-and-epic-flows):
  // once, as the person arrives, so a change that lands elsewhere while they
  // read it — a turn of the chat, another process — still takes the tab
  // away. A change the person makes on a basic ticket's contract is theirs,
  // and the contract page records the state it leaves itself.
  const listed = (workspace.drafts ?? []).some((entry) => entry.id === sessionId);
  const flow = flowFor(workspace, sessionId, pane);
  const visited = flow.panes.find((entry) => entry.id === pane && remembered(entry.id))?.id ?? null;
  const draft = (workspace.drafts ?? []).find((entry) => entry.id === sessionId);
  const arrived = useRef<string | null>(null);
  useEffect(() => {
    const at = visited === null ? null : `${sessionId}:${visited}`;
    if (at === arrived.current) return;
    if (visited === "contract") {
      // Not before the drafts list holds the planning, whose state it is, and
      // its spec as the host read it.
      if (draft === undefined || (draft.specSlug !== null && draft.spec === null)) return;
      arrived.current = at;
      void bridge
        .request({ kind: "editingContractVisited", id: sessionId, state: contractState(workspace, draft) })
        .catch(() => undefined);
      return;
    }
    arrived.current = at;
    if (visited !== null)
      void bridge.request({ kind: "editingVisited", id: sessionId, pane: visited }).catch(() => undefined);
  }, [sessionId, visited, draft, workspace]);
  // A link to the planning itself names no pane, and it opens where it was
  // left — which the drafts list says, so not before the list has this
  // planning in it. In place of that link, so Back does not return to it and
  // be sent on again.
  const reopen = pane === null && listed ? reopenPane(workspace, sessionId) : null;
  useEffect(() => {
    if (reopen !== null) navigate({ page: "planning", sessionId, pane: reopen }, { replace: true });
  }, [reopen, navigate, sessionId]);
  const limit = dockWidthLimit(room);
  const dock = Math.min(stored, limit);
  // The same editor the Composer binds to: the host is asked for the session, and its answer decides whether there is planning to show.
  const editor = useContractEditing({ kind: "session", id: sessionId }, workspace.settings);
  const [history, setHistory] = useState(false);
  const landing = useDraftLanding({ sessionId, editor, navigate, workspace });
  // The pane the person came from, which says whether the contract is being
  // reached through the reading on the way to it, and so compiled, or come
  // back to.
  const trail = useRef<{ pane: PlanningPane | null; from: PlanningPane | null }>({ pane: null, from: null });
  if (trail.current.pane !== pane) trail.current = { pane, from: trail.current.pane };
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
    ) : landing.checking ? (
      // A fresh basic plan, checked for what it disturbs before it lands on
      // Impact or the contract. Nothing reads it against the spec here: the
      // model drafted it from the spec (D-NEW-basic-and-epic-flows).
      <WaitScreen
        bare
        title="Checking the impact"
        description="Reading what the plan is likely to touch outside its scope. This changes nothing."
        status="Checking the impact…"
      />
    ) : pane === "contract" ? (
      <Suspense fallback={<Opening what="the contract" />}>
        <ContractPane
          workspace={workspace}
          navigate={navigate}
          editor={editor}
          confirming={trail.current.from === "drift"}
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
      // The problems a reading of the plan against the spec found, each put
      // on its own, as a card whose answer is a turn, and an epic's step from
      // the plan to the contract (D-128).
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
        {landing.notice && !landing.checking && <SimpleTaskNotice onNext={landing.acknowledge} />}
      </section>
      {/* The chat stays on every pane but Problems and the contract: its work
          after a draft is changing the plan through the validated edit path,
          each change a card with an undo (D-102, D-100). It opens narrow so
          the pane beside it — the graph most of all — has the room, and the
          bar between them still moves. On Problems the card in the pane is the
          chat's own card, and a second beside it would be two ways to do one
          thing; on the contract the criteria are the person's to edit by hand
          (D-NEW-basic-and-epic-flows). Not before the planning has a pane to
          stand beside, either. */}
      {pane !== "drift" && pane !== "contract" && pane !== null && (
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
