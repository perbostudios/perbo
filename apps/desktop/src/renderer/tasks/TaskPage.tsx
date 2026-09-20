import { useEffect } from "react";
import { Button, Notice } from "@perbo/ui";
import { errorMessage, useDetail } from "../data.js";
import type { PageProps, TaskView } from "../shell/App.js";
import { Composer } from "./Composer.js";
import { ExplorerScreen } from "./ExplorerScreen.js";
import { ContractScreen } from "./ContractScreen.js";
import { LoopScreen } from "./LoopScreen.js";
import { planNodes } from "@perbo/contracts/plan";
import { projectTicket } from "./ticket-workspace.js";
import {
  CompletionScreen,
  MergeScreen,
  OutputScreen,
  ReviewScreen,
} from "./ReviewScreens.js";
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
  const projection = query.data ? projectTicket(workspace, { repoId, ticket: query.data.ticket }, query.data, view) : null;
  const show = (view: TaskView): void =>
    navigate({ page: "task", repoId, key: taskKey, view });
  const resultReady = projection?.resultReady;
  useEffect(() => {
    if (view === "loop" && resultReady) show("review");
  }, [resultReady, view]);
  // A plan the drafter divided is read on its graph, not on the page that
  // cannot show the division. Asked here, of the ticket, so that landing on a
  // freshly drafted plan and clicking the same ticket on Home agree — a rule
  // about where a ticket belongs, written once.
  //
  // Only for `auto`: asking for the contract is how a person gets to it from
  // the graph, and that has to keep working.
  const planning = (workspace.drafts ?? []).find(
    (draft) => draft.repoId === repoId && draft.key === taskKey && draft.phase !== "discarded",
  );
  const divided =
    view === "auto" &&
    // `edit` is as explicit an ask as a named view: the contract editor is
    // reached by it and nothing else, so answering over it would leave an
    // epic with no way into its own editor.
    !edit &&
    query.data?.ticket.state === "plan_review" &&
    query.data.ticket.approved_at === null &&
    // Asked of the contract, which is where the division actually is. The
    // session carries a copy for the rail, and a copy can be behind.
    planNodes(query.data.contract).length > 0 &&
    planning !== undefined;
  useEffect(() => {
    if (divided && planning) navigate({ page: "planning", sessionId: planning.id, pane: "graph" });
  }, [divided, planning?.id, navigate]);
  if (query.isPending)
    return (
      <div className="launch">
        <p>Reading the task and its evidence…</p>
      </div>
    );
  if (query.error || !query.data)
    return (
      <div className="launch">
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
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
  const detail = query.data,
    context = { detail, workspace, navigate, repoId, show };
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
  if (screen === "explorer") return <ExplorerScreen {...context} />;
  if (screen === "review") return <ReviewScreen {...context} />;
  return <LoopScreen {...context} decisions={screen === "decisions"} />;
}
