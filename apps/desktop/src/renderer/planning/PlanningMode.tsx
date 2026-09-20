import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button, EmptyState } from "@perbo/ui";
import { InkIcon } from "../InkIcon.js";
import { useCreate } from "../shell/create.js";
import { useContractEditing } from "../tasks/contract-editor.js";
import { ExplorerPane } from "./ExplorerPane.js";
import { ImpactPane } from "./ImpactPane.js";
import { HistoryDrawer } from "./HistoryDrawer.js";
import { InterviewDock } from "./InterviewDock.js";
import { DockHandle } from "./DockHandle.js";
import { dockWidthLimit, useDockWidth } from "../shell/dock-size.js";
import { PLANNING_PANES } from "./panes.js";
import type { PageProps } from "../shell/App.js";
import type { PlanningPane } from "./panes.js";
const SpecPane = lazy(() =>
  import("./SpecPane.js").then((module) => ({ default: module.SpecPane })),
);
const GraphPane = lazy(() =>
  import("./GraphPane.js").then((module) => ({ default: module.GraphPane })),
);

/**
 * Planning mode (D-101): one piece of work in one repository, held as a
 * contract editing session so it survives leaving and restarting. The Spec
 * pane holds the spec the plan is drafted from, and the contract steps under
 * it (D-103); the Explorer pane reads the repository and marks paths for the
 * draft's scope; the Graph pane curates the execution graph and approves it
 * once (D-100); the Impact pane lists, on demand, what the draft is likely to
 * touch that its scope does not cover (D-015).
 *
 * One pane at a time, with the interview docked beside it (D-102) and the
 * plan's history opening as a drawer over the pane, so the chat is there from
 * the first question to the approval. The dock is outside the panes, so a pane
 * knows nothing about it and adding one adds an entry to
 * {@link PLANNING_PANES} and a branch here.
 */
export function PlanningMode({
  workspace,
  navigate,
  sessionId,
  pane,
}: PageProps & { sessionId: string; pane: PlanningPane }) {
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
    pane === "explorer" ? (
      <ExplorerPane workspace={workspace} editor={editor} />
    ) : pane === "impact" ? (
      <ImpactPane workspace={workspace} editor={editor} />
    ) : pane === "graph" ? (
      <Suspense fallback={<Opening what="the graph" />}>
        <GraphPane workspace={workspace} navigate={navigate} editor={editor} />
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
        aria-label={PLANNING_PANES.find((entry) => entry.id === pane)?.label ?? "Spec"}
      >
        {open}
        {history && <HistoryDrawer editor={editor} onClose={() => setHistory(false)} />}
      </section>
      {/* The chat stays on every pane: its work after a draft is changing the
          plan through the validated edit path, each change a card with an undo
          (D-102, D-100). It opens narrow so the pane beside it — the graph
          most of all — has the room, and the bar between them still moves. */}
      <DockHandle width={dock} limit={limit} />
      <InterviewDock
        workspace={workspace}
        editor={editor}
        historyOpen={history}
        onHistory={() => setHistory((shown) => !shown)}
        width={dock}
      />
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
