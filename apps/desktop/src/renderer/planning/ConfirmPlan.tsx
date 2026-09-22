import { Button } from "../ui/index.js";
import type { PageProps } from "../shell/route.js";
import type { useContractEditing } from "../contract-editor.js";

type Editor = ReturnType<typeof useContractEditing>;

/**
 * The control that says the plan is right, on every pane that shows the plan.
 *
 * A person settles a plan from whichever pane answered their last question:
 * the Graph shows how the work divides, the Explorer which files it reaches,
 * Impact what it disturbs. Any of the three can be the one that convinces
 * them, so the way onward is on all three rather than only where it happened
 * to be written first.
 *
 * It confirms and never approves. Confirming goes to the contract, which is
 * the page that states what freezes — the outcome, the criteria, the scope and
 * the base — and carries the one approval there is. A second approval on a
 * pane that does not say what it is freezing would be a person agreeing to
 * something they were never shown.
 *
 * The Graph keeps its own footer rather than this one: it says the same thing
 * with the division's file count and the run queued ahead of it, which are
 * facts that pane has and these two do not.
 */
export function ConfirmPlan({
  workspace,
  editor,
  navigate,
  busy = false,
}: PageProps & {
  editor: Editor;
  /** Whether the pane has work of its own in flight. */
  busy?: boolean;
}) {
  const key = editor.session?.key ?? null;
  // No plan, nothing to confirm: during the spec these panes are read while the
  // work is still being described, and there is no contract to go to yet.
  if (key === null) return null;
  const approved =
    workspace.tasks.find(
      (row) => row.repoId === editor.repoId && row.ticket.key === key,
    )?.ticket.approved_at != null;
  return (
    <div className="approve-actions pane-confirm">
      <span className="small muted">
        {approved
          ? "This contract is approved; what it froze is on its own page."
          : "The contract is where approving freezes this."}
      </span>
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => navigate({ page: "task", repoId: editor.repoId, key, view: "contract" })}
      >
        {approved ? "Open the contract" : "Confirm the plan"}
      </Button>
    </div>
  );
}
