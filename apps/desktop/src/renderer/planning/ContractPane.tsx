import { Button, InkIcon, Notice } from "../ui/index.js";
import { errorMessage, useDetail } from "../workspace/index.js";
import { ContractScreen } from "../tasks/ContractScreen.js";
import { WaitScreen } from "../tasks/wizard.js";
import type { PageProps } from "../shell/route.js";
import type { useContractEditing } from "../contract-editor.js";

type Editor = ReturnType<typeof useContractEditing>;

/**
 * The planning's contract tab (D-NEW-basic-and-epic-flows):
 * the contract page, and the one approval there is, reached inside planning
 * with its tabs beside it rather than as a page of its own.
 */
export function ContractPane({
  workspace,
  navigate,
  editor,
  confirming,
}: PageProps & {
  editor: Editor;
  /** Whether the person is arriving from the reading on the way, which compiles it, rather than coming back. */
  confirming: boolean;
}) {
  const key = editor.session?.key ?? null;
  if (key === null)
    return (
      <div className="launch">
        <InkIcon name="dots" />
        <p>Opening the contract…</p>
      </div>
    );
  return (
    <Contract workspace={workspace} navigate={navigate} editor={editor} ticketKey={key} confirming={confirming} />
  );
}

function Contract({
  workspace,
  navigate,
  editor,
  ticketKey,
  confirming,
}: PageProps & { editor: Editor; ticketKey: string; confirming: boolean }) {
  const repoId = editor.repoId;
  const query = useDetail(repoId, ticketKey);
  if (query.isPending && !confirming)
    return (
      <div className="launch">
        <p>Reading the task and its evidence…</p>
      </div>
    );
  if (query.isPending)
    // On the way from the plan, the same waiting the drafting screens use,
    // because the wait is the same kind: a command is running and there is
    // nothing to read until it answers.
    return (
      <WaitScreen
        bare
        title="Compiling the contract"
        description="Reading the plan, its scope and the base it will run from, so the page that freezes them states what it is freezing."
        status="Reading the ticket and its evidence…"
      />
    );
  if (!query.data)
    return (
      <div className="launch">
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
        <Button onClick={() => void query.refetch()}>Try again</Button>
      </div>
    );
  return (
    <ContractScreen
      detail={query.data}
      workspace={workspace}
      navigate={navigate}
      repoId={repoId}
      show={(view) => navigate({ page: "task", repoId, key: ticketKey, view })}
      planning={{ editor }}
    />
  );
}
