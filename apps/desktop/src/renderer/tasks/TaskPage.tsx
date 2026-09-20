import { useEffect } from "react";
import { Button, Notice } from "@perbo/ui";
import { errorMessage, useDetail } from "../data.js";
import type { PageProps, TaskView } from "../shell/App.js";
import { Composer } from "./Composer.js";
import { ExplorerScreen } from "./ExplorerScreen.js";
import { ContractScreen } from "./ContractScreen.js";
import { LoopScreen } from "./LoopScreen.js";
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
