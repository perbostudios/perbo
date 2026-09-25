import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DriftVerdictSchema } from "@perbo/planning/browser";
import { Button, InkIcon } from "../ui/index.js";
import { bridge } from "../workspace/index.js";
import { impactAsked, impactQuery } from "./ImpactPane.js";
import { checkedLanding } from "./panes.js";
import { useSettled } from "./settled.js";
import type { Route } from "../shell/route.js";
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
 * opened. An epic lands on its Graph. A basic ticket is checked first — the
 * impact check and the reading of the plan against the spec, side by side —
 * and lands on the Problems pane where the reading found any, else on Impact
 * where the check found paths outside the scope, else on its contract; the
 * pop-up saying the task is simple is put over whichever that is, once per
 * draft, and its Next only puts it away.
 *
 * A draft is watched by its operation: the first one seen is where this
 * planning was when it opened, and one that completes after that — a new
 * operation, or the one seen running — is a draft that landed here.
 */
export function useDraftLanding({
  sessionId,
  editor,
  navigate,
}: {
  sessionId: string;
  editor: Editor;
  navigate: (route: Route) => void;
}): { checking: boolean; notice: boolean; acknowledge: () => void } {
  const client = useQueryClient();
  const settled = useSettled();
  const [checking, setChecking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seen = useRef<{ sessionId: string; operation: string | null; landed: boolean } | null>(null);
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
  useEffect(() => {
    if (session === null) return;
    const before = seen.current;
    const now = { sessionId, operation: operation?.id ?? null, landed };
    seen.current = now;
    if (before?.sessionId !== sessionId || !landed || key === null) return;
    if (before.operation === now.operation && before.landed) return;
    if (nodes > 0) {
      navigate({ page: "planning", sessionId, pane: "graph" });
      return;
    }
    // A basic ticket: both checks at once, and the landing once both are back.
    // A check that could not be made says nothing to land on.
    setChecking(sessionId);
    impactAsked(sessionId, key);
    const flagged = client
      .fetchQuery({ ...impactQuery(sessionId), gcTime: Infinity })
      .then((view) => view.warnings.length + view.truncated > 0)
      .catch(() => false);
    const problems = bridge
      .request({ kind: "driftCheck", id: sessionId })
      .then(settled)
      .then((job) => {
        const verdict = DriftVerdictSchema.safeParse(job.result);
        return verdict.success && !verdict.data.dismissed && verdict.data.findings.length > 0;
      })
      .catch(() => false);
    void Promise.all([flagged, problems]).then(([flagged, problems]) => {
      if (seen.current?.sessionId !== sessionId) return;
      setChecking(null);
      setNotice(sessionId);
      navigate({ page: "planning", sessionId, pane: checkedLanding({ problems, flagged }) });
    });
  }, [session, sessionId, operation?.id, landed, key, nodes, navigate, client, settled]);
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
