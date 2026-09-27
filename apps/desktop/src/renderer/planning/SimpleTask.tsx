import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, InkIcon } from "../ui/index.js";
import { impactAsked, impactQuery } from "./ImpactPane.js";
import { checkedLanding } from "./panes.js";
import type { Route } from "../shell/route.js";
import type { Snapshot } from "../../shared/protocol.js";
import type { useContractEditing } from "../contract-editor.js";

type Editor = ReturnType<typeof useContractEditing>;

/** What the pop-up over a basic ticket's landing says. */
export const SIMPLE_TASK = "The task is simple, so there is no graph.";

/**
 * Where a plan lands once it is drafted, first or again, seen from planning
 * mode (D-NEW-basic-and-epic-flows).
 *
 * Only a draft this planning watched settle: a planning opened over a plan
 * that already exists is a person who came to read it, and is left where it
 * opened. Nothing is read here: a plan the model drafted from its spec
 * counts as satisfying it, and the host records it as read as it lands, so
 * the first reading is at a confirm, and only of what moved since (D-128).
 * An epic lands on its Graph at once. A basic ticket's impact is checked,
 * and it lands on Impact where the check found paths outside the scope, else
 * on its contract; the pop-up saying the task is simple is put over whichever
 * that is, once per draft, and its Next only puts it away. Neither lands on
 * Problems.
 *
 * A draft is watched by its operation: the first one seen is where this
 * planning was when it opened, and one that completes after that — a new
 * operation, or the one seen running — is a draft that landed here.
 *
 * A basic plan this planning did not watch land — one drafted again from a
 * stopped run, or one whose impact check was never made — has its impact
 * checked as the planning opens, without moving the person, so its Impact tab
 * is there where the check finds paths outside the scope.
 */
export function useDraftLanding({
  sessionId,
  editor,
  navigate,
  workspace,
}: {
  sessionId: string;
  editor: Editor;
  navigate: (route: Route) => void;
  workspace: Pick<Snapshot, "drafts">;
}): { checking: boolean; notice: boolean; acknowledge: () => void } {
  const client = useQueryClient();
  const [checking, setChecking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seen = useRef<{ sessionId: string; operation: string | null; landed: boolean } | null>(null);
  // The plan whose impact has been asked for here, by the planning, its ticket
  // and the operation that drafted it, so a landing and an opening never ask
  // twice for one plan.
  const impactFor = useRef<string | null>(null);
  const session = editor.session?.id === sessionId ? editor.session : null;
  const operation = session?.operation ?? null;
  const drafting = operation !== null && (operation.intent === "generate" || operation.intent === "startOver");
  const landed =
    drafting &&
    operation.state === "completed" &&
    operation.reconciled &&
    session !== null &&
    session.key !== null &&
    session.phase !== "working";
  const key = session?.key ?? null;
  const nodes = session?.nodes ?? 0;
  const listed = (workspace.drafts ?? []).find((draft) => draft.id === sessionId);
  const plan = `${sessionId}:${key}:${operation?.id ?? ""}`;
  useEffect(() => {
    if (session === null) return;
    const before = seen.current;
    const now = { sessionId, operation: operation?.id ?? null, landed };
    seen.current = now;
    if (before?.sessionId !== sessionId || !landed || key === null) return;
    if (before.operation === now.operation && before.landed) return;
    // An epic: on its Graph, with nothing to wait for.
    if (nodes > 0) {
      navigate({ page: "planning", sessionId, pane: "graph" });
      return;
    }
    // A basic ticket: its impact checked, and the landing once it is back. A
    // check that could not be made says nothing to land on.
    setChecking(sessionId);
    impactFor.current = plan;
    impactAsked(sessionId, key);
    void client
      .fetchQuery({ ...impactQuery(sessionId), gcTime: Infinity, staleTime: 0 })
      .then((view) => view.warnings.length + view.truncated > 0)
      .catch(() => false)
      .then((flagged) => {
        if (seen.current?.sessionId !== sessionId) return;
        setChecking(null);
        setNotice(sessionId);
        navigate({ page: "planning", sessionId, pane: checkedLanding({ flagged }) });
      });
  }, [session, sessionId, operation?.id, landed, key, nodes, navigate, client]);
  // Opened over a basic plan whose impact was never checked: checked now, in
  // place, once the drafts list says so. Not while a draft is being made,
  // which is checked as it lands. Asked afresh, here and on landing, since an
  // answer this window holds was of the plan before.
  const unchecked = session !== null && key !== null && nodes === 0 && listed?.impact === null && (!drafting || landed);
  useEffect(() => {
    if (!unchecked || key === null || impactFor.current === plan) return;
    impactFor.current = plan;
    impactAsked(sessionId, key);
    void client.fetchQuery({ ...impactQuery(sessionId), gcTime: Infinity, staleTime: 0 }).catch(() => undefined);
  }, [unchecked, plan, sessionId, key, client]);
  return {
    checking: checking === sessionId,
    notice: notice === sessionId,
    acknowledge: () => setNotice(null),
  };
}

/**
 * The pop-up over a basic ticket's landing: the task is simple, so there is
 * no graph. In the decision card's frame, as the loop's own pop-ups are, with
 * one way on.
 */
export function SimpleTaskNotice({ onNext }: { onNext: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.focus();
  }, []);
  return (
    <div className="decision-overlay" data-screen="simple-task">
      <div
        ref={card}
        tabIndex={-1}
        className="decision-card decision-card--ended t-modal is-open"
        role="dialog"
        aria-label="A simple task"
        aria-modal="false"
      >
        <div className="decision-titlebar">
          <InkIcon name="info" size={15} />
          <h2>A simple task</h2>
        </div>
        <div className="decision-body">
          <p>{SIMPLE_TASK}</p>
          <div className="decision-actions">
            <span className="spacer" />
            <Button variant="primary" onClick={onNext}>
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
