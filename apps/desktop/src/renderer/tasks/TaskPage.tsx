import { useEffect } from "react";
import { Button, Notice } from "../ui/index.js";
import { bridge, errorMessage, useDetail } from "../workspace/index.js";
import type { PageProps, TaskView } from "../shell/route.js";
import { Composer } from "./Composer.js";
import { ExplorerScreen } from "./ExplorerScreen.js";
import { ContractScreen } from "./ContractScreen.js";
import { LoopScreen } from "./LoopScreen.js";
import { StoppedScreen } from "./StoppedScreen.js";
import { planNodes } from "@perbo/contracts/browser";
import { projectTicket } from "./ticket-workspace.js";
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
  useEffect(() => {
    if (view === "loop" && resultReady) show("review");
  }, [resultReady, view]);
  // Where a plan still in planning is read, asked here, of the ticket, so that
  // landing on a freshly drafted plan and clicking the same ticket on Home
  // agree — a rule about where a ticket belongs, written once.
  //
  // Only for `auto`: asking for the contract is how a person gets to it from
  // the graph, and that has to keep working.
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
  const plannable = view === "auto" && !edit && awaiting;
  // The contract first where the person was last on it: coming back to the
  // ticket is coming back there (D-130).
  // Then the problems, whatever the plan's shape: they are what the planning
  // is about until each is resolved or the person goes on past them
  // (D-128). Then where the planning was
  // left, where it is the planning curating this plan: coming back to it is
  // coming back to that pane (D-130), and
  // a session the ticket's own editor made is no such planning, so its ticket
  // stays on this page.
  // Then the division on its graph, not on the page that cannot show it, asked
  // of the contract, which is where it actually is — the session carries a
  // copy for the rail, and a copy can be behind.
  const landing: PlanningPane | null = !plannable || planning.lastView === "contract"
    ? null
    : problemsOpen(workspace.drafts, planning.id)
      ? "drift"
      : ((curates(planning) ? leftAt(workspace.drafts, planning.id) : null) ??
        (planNodes(detail.contract).length > 0 ? "graph" : null));
  // In place of this page, which then only ever sends the person on.
  useEffect(() => {
    if (landing !== null && planning)
      navigate({ page: "planning", sessionId: planning.id, pane: landing }, { replace: true });
  }, [landing, planning?.id, navigate]);
  // The contract of a plan waiting for approval, written down as the person
  // reaches it, as planning mode writes the pane: the one page of a ticket
  // the ladder would send them away from on their way back. Not while this
  // page is only sending them on.
  const atContract = awaiting && !edit && landing === null && projection?.screen === "contract";
  useEffect(() => {
    if (atContract && planning.lastView !== "contract")
      void bridge.request({ kind: "editingContractVisited", id: planning.id }).catch(() => undefined);
  }, [atContract, planning?.id, planning?.lastView]);
  // Confirming a plan lands on its contract while `perbo inspect` reads the
  // ticket, which is the step between the plan and the page that freezes it:
  // the contract of a plan still in planning and not yet approved, asked for
  // by name, by a person arriving from planning rather than coming back to a
  // contract they were last on. Every other way onto a ticket's page is only
  // reading the ticket.
  const confirming =
    view === "contract" &&
    !edit &&
    planning !== undefined &&
    planning.lastView !== "contract" &&
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
  if ((query.error && !(deleting && detail)) || !detail)
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
  const screen = projection!.screen;
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
