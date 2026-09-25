import { useEffect, useRef } from "react";
import { Button, Notice } from "../ui/index.js";
import { bridge, errorMessage, useDetail } from "../workspace/index.js";
import type { PageProps, TaskView } from "../shell/route.js";
import type { TaskContext } from "./task-context.js";
import { Composer } from "./Composer.js";
import { ExplorerScreen } from "./ExplorerScreen.js";
import { ContractScreen } from "./ContractScreen.js";
import { LoopScreen } from "./LoopScreen.js";
import { StoppedScreen } from "./StoppedScreen.js";
import { planNodes } from "@perbo/contracts/browser";
import { projectTicket, unseenAttention } from "./ticket-workspace.js";
import { curates, leftAt, planApproved, problemsOpen } from "../planning/panes.js";
import type { PlanningPane } from "../../shared/protocol.js";
import {
  CompletionScreen,
  MergeScreen,
  OutputScreen,
  ReviewScreen,
} from "./ReviewScreens.js";
import { WaitScreen } from "./wizard.js";
import { deletes, useCreate } from "../shell/create.js";
import { DELETE_TICKET_GONE } from "../../shared/discard.js";
export function TaskPage({
  workspace,
  navigate,
  repoId,
  taskKey,
  view,
  edit,
}: PageProps & {
  repoId: string;
  taskKey: string;
  view: TaskView;
  edit: boolean;
}) {
  const query = useDetail(repoId, taskKey);
  // A ticket being deleted from under this page — Plan it again deletes it
  // before it drafts the new plan — keeps the page it was on until the delete
  // settles, rather than turning into the read that no longer finds it.
  const deleting = useCreate().deleting.has(deletes.ticket(repoId, taskKey));
  const projection = query.data ? projectTicket(workspace, { repoId, ticket: query.data.ticket }, query.data, view) : null;
  const show = (view: TaskView): void =>
    navigate({ page: "task", repoId, key: taskKey, view });
  const resultReady = projection?.resultReady;
  // Opening a ticket is what orders Home within each group, most recent first,
  // and what clears its claim on the person. One that comes to need them while
  // its page is open is seen as it does, so the opening is recorded again
  // whenever Home would count it unseen: that opening is newer than the moment
  // it came to stand there, so it records once each time.
  const listed = workspace.tasks.find((row) => row.repoId === repoId && row.ticket.key === taskKey);
  const unseen = listed !== undefined && unseenAttention(workspace, listed);
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    const page = repoId + ":" + taskKey;
    if (recorded.current === page && !unseen) return;
    recorded.current = page;
    void bridge.request({ kind: "ticketOpened", repoId, key: taskKey }).catch(() => undefined);
  }, [repoId, taskKey, unseen]);
  useEffect(() => {
    if (view === "loop" && resultReady) show("review");
  }, [resultReady, view]);
  // Where a plan still in planning is read, asked here, of the ticket, so that
  // landing on a freshly drafted plan and clicking the same ticket on Home
  // agree — a rule about where a ticket belongs, written once.
  //
  // For `auto`, and for the contract asked for by name: a plan waiting for
  // approval in the planning curating it has its contract inside that
  // planning, as its last tab (D-NEW-basic-and-epic-flows).
  const planning = (workspace.drafts ?? []).find(
    (draft) => draft.repoId === repoId && draft.key === taskKey && draft.phase !== "discarded",
  );
  const detail = query.data;
  const awaiting =
    detail !== undefined &&
    detail.ticket.state === "plan_review" &&
    detail.ticket.approved_at === null &&
    planning !== undefined;
  // `edit` is as explicit an ask as a named view: the contract editor is
  // reached by it and nothing else, so answering over it would leave an epic
  // with no way into its own editor.
  const plannable = (view === "auto" || view === "contract") && !edit && awaiting;
  // The contract asked for by name, in the planning curating it. Otherwise
  // the problems first, whatever the plan's shape: they are what the planning
  // is about until each is resolved or the person goes on past them
  // (D-128). Then where the planning was
  // left, the contract included, where it is the planning curating this plan:
  // coming back to it is coming back to that pane
  // (D-130), and a session the ticket's own
  // editor made is no such planning, so its ticket stays on this page.
  // Then the division on its graph, not on the page that cannot show it, asked
  // of the contract, which is where it actually is — the session carries a
  // copy for the rail, and a copy can be behind — and a plan left flat on its
  // contract, which is its plan.
  const curating = planning !== undefined && curates(planning);
  const landing: PlanningPane | null = !plannable
    ? null
    : view === "contract"
      ? curating
        ? "contract"
        : null
      : problemsOpen(workspace.drafts, planning.id)
        ? "drift"
        : ((curating ? leftAt(workspace, planning.id) : null) ??
          (planNodes(detail.contract).length > 0 ? "graph" : curating ? "contract" : null));
  // In place of this page, which then only ever sends the person on.
  useEffect(() => {
    if (landing !== null && planning)
      navigate({ page: "planning", sessionId: planning.id, pane: landing }, { replace: true });
  }, [landing, planning?.id, navigate]);
  // The contract of a plan still in planning, asked for by name while
  // `perbo inspect` reads the ticket: the step between the plan and the page
  // that freezes it. Every other way onto a ticket's page is only reading the
  // ticket.
  const confirming =
    view === "contract" &&
    !edit &&
    planning !== undefined &&
    !planApproved(workspace, repoId, taskKey);
  if (query.isPending)
    return confirming ? (
      // The same waiting the drafting screens use, because the wait is the
      // same kind: a command is running and there is nothing to read until it
      // answers.
      <WaitScreen
        title="Compiling the contract"
        description="Reading the plan, its scope and the base it will run from, so the page that freezes them states what it is freezing."
        status="Reading the ticket and its evidence…"
      />
    ) : (
      <div className="launch">
        <p>Reading the task and its evidence…</p>
      </div>
    );
  // A ticket deleted elsewhere — the store says it is gone and the listing no
  // longer holds it — has no page to keep. Not one this page is deleting,
  // which keeps the page it was on until the delete settles.
  const gone =
    !deleting &&
    query.error?.message === DELETE_TICKET_GONE &&
    !workspace.tasks.some((row) => row.repoId === repoId && row.ticket.key === taskKey);
  // Otherwise only a ticket never read is a page that could not load. Once one
  // is held, a read that fails is a refresh that failed: the page keeps what it
  // read, says the refresh failed, and the next read replaces it.
  if (!detail || gone)
    return (
      <div className="launch">
        <Notice key={query.errorUpdatedAt} tone="danger">
          {errorMessage(query.error)}
        </Notice>
        <Button
          onClick={() => {
            void query.refetch();
          }}
        >
          Try again
        </Button>
        <Button onClick={() => navigate({ page: "home" })}>Home</Button>
      </div>
    );
  const context = { detail, workspace, navigate, repoId, show };
  if (edit)
    return (
      <Composer
        workspace={workspace}
        navigate={navigate}
        existing={detail}
        existingRepoId={repoId}
      />
    );
  // A ticket being deleted from under this page is expected to fail its reads.
  const stale = query.error && !deleting && (
    <div className="workspace-errors">
      <Notice key={query.errorUpdatedAt} tone="warning">
        This ticket could not be read again: {errorMessage(query.error)} What is
        shown is the last reading, until the next refresh reads it.
      </Notice>
    </div>
  );
  return (
    <>
      {stale}
      {taskScreen(projection!.screen, context)}
    </>
  );
}
function taskScreen(screen: Exclude<TaskView, "auto">, context: TaskContext) {
  if (screen === "output") return <OutputScreen {...context} />;
  if (screen === "merge") return <MergeScreen {...context} />;
  if (screen === "called-off")
    return <CompletionScreen {...context} merged={false} />;
  if (screen === "complete")
    return <CompletionScreen {...context} merged />;
  if (screen === "contract") return <ContractScreen {...context} />;
  if (screen === "stopped") return <StoppedScreen {...context} />;
  if (screen === "explorer") return <ExplorerScreen {...context} />;
  if (screen === "review") return <ReviewScreen {...context} />;
  return <LoopScreen {...context} decisions={screen === "decisions"} />;
}
