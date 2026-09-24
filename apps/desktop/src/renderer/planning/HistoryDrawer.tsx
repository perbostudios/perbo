import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Notice, cx } from "../ui/index.js";
import { bridge, errorMessage, useGraph } from "../workspace/index.js";
import { draftHistory, graphHistory, latestUndoable } from "./history.js";
import type { HistoryRow } from "./history.js";
import { INTERVIEWER_NAME } from "../../shared/protocol.js";
import type { useContractEditing } from "../contract-editor.js";

/**
 * Every change to this planning, over the current pane rather than beside it,
 * so the chat stays where it is and the edit being read about is still in
 * view (D-100, D-102).
 *
 * Two records answer it, and which one depends on how far the planning has
 * got: the plan's own log once a ticket exists — where the interview's edits
 * and the person's sit together, because both go through `perbo edit` — and
 * the editing session's own history before one does, which holds the
 * explorer's marks. The undo goes to whichever record the entry came from.
 */

type Editor = ReturnType<typeof useContractEditing>;

export function HistoryDrawer({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const client = useQueryClient();
  const session = editor.session;
  const repoId = editor.repoId;
  const key = session?.key ?? null;
  const close = useRef<HTMLButtonElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const graph = useGraph(repoId, key);
  const rows: HistoryRow[] =
    key !== null ? graphHistory(graph.data?.history ?? []) : draftHistory(session?.history ?? []);
  const undoable = latestUndoable(rows);

  const dismiss = useRef(onClose);
  dismiss.current = onClose;
  useEffect(() => {
    close.current?.focus();
    const pressed = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss.current();
    };
    window.addEventListener("keydown", pressed);
    return () => window.removeEventListener("keydown", pressed);
  }, []);

  const undo = useCallback(
    (n: number) => {
      if (!session) return;
      setBusy(true);
      setFailure(null);
      void (async () => {
        try {
          if (key !== null) {
            await bridge.request({ kind: "graphUndo", repoId, key, edit: n });
            await client.invalidateQueries({ queryKey: ["graph", repoId, key] });
          } else {
            await bridge.request({
              kind: "explorerUndo",
              id: session.id,
              revision: session.revision,
              edit: n,
            });
          }
        } catch (error) {
          setFailure(errorMessage(error));
        } finally {
          setBusy(false);
        }
      })();
    },
    [client, key, repoId, session],
  );

  return (
    <>
      <div className="hist-scrim" onClick={onClose} />
      <aside className="hist-drawer" role="dialog" aria-label="The plan’s history">
        <div className="hist-head">
          <h3>History</h3>
          <span className="small muted">{rows.length}</span>
          <span className="spacer" />
          <Button ref={close} className="small" onClick={onClose}>
            Close
          </Button>
        </div>
        {failure !== null && <Notice tone="danger">{failure}</Notice>}
        {graph.error && <Notice tone="danger">{errorMessage(graph.error)}</Notice>}
        {rows.length === 0 ? (
          <p className="small muted">
            Nothing yet. Every change to this planning lands here, whether you made it by hand or
            asked the chat for it.
          </p>
        ) : (
          <ol className="hist-rows">
            {[...rows].reverse().map((row) => (
              <li key={row.n} className={cx((row.undone || row.replaced) && "is-undone")}>
                <span className="hist-n">{row.n}</span>
                <span className="hist-line">{row.summary}</span>
                <small className={`author author--${row.author}`}>
                  {row.author === "you" ? "you" : INTERVIEWER_NAME}
                </small>
                {row.replaced && <span className="small muted">replaced by a re-draft</span>}
                {row.n === undoable?.n && (
                  <button
                    type="button"
                    className="text-button small"
                    disabled={busy}
                    aria-label={`Undo: ${row.summary}`}
                    onClick={() => undo(row.n)}
                  >
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </aside>
    </>
  );
}
