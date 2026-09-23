import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Notice } from "../ui/index.js";
import { bridge, errorMessage } from "../workspace/index.js";
import { withDraft } from "../shell/create.js";
import { SendButton, sendOnEnter } from "./InterviewDock.js";
import type { EditingSession, Snapshot } from "../../shared/protocol.js";
import type { PageProps } from "../shell/route.js";

/** How long typing rests before what is typed is kept. */
const SAVE_AFTER_MS = 300;

/**
 * A repository's question page, "What do you want to build?", with one box
 * for the answer (D-NEW-a-planning-starts-with-what-to-build). The repository
 * row in the Create picker opens it, and it creates nothing: a planning is
 * made when the answer is sent.
 *
 * What is typed and not sent is the repository's, kept by the host as it is
 * typed, so the page shows it again when the repository is picked again, after
 * another repository's page and after a restart. Leaving keeps it.
 *
 * Send opens a fresh planning and sends the answer as the chat's first turn,
 * as the Spec pane's chat sends one: the host names the spec from it (D-118)
 * and starts the session. The repository's text is then cleared, and the page
 * goes on to the planning's Spec pane, where the chat shows the turn and its
 * answer. In place of the question, so Back does not return to it.
 */
export function AskPage({ workspace, navigate, repoId }: PageProps & { repoId: string }) {
  const heading = useId();
  const client = useQueryClient();
  // Read once as the page opens; from then on the text is the page's own, and
  // the host is told as it changes.
  const [text, setText] = useState(() => workspace.asks?.[repoId] ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const repository = workspace.repositories.find((repo) => repo.id === repoId)?.name ?? null;
  // What the host holds, what is typed, and the save waiting on typing to rest.
  const saved = useRef<string | null>(text);
  const typed = useRef(text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // While a send is in flight the text is on its way to being a turn, and
  // nothing keeps it; a send that fails keeps it again.
  const sending = useRef(false);
  const keep = (value: string): void => {
    saved.current = value;
    client.setQueryData<Snapshot>(["workspace"], (current) => {
      if (current === undefined) return current;
      const asks = { ...current.asks };
      if (value.length === 0) delete asks[repoId];
      else asks[repoId] = value;
      return { ...current, asks };
    });
  };
  const save = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    // Words that are only spaces are nothing to keep.
    const value = typed.current.trim().length === 0 ? "" : typed.current;
    if (sending.current || value === saved.current) return;
    keep(value);
    void bridge.request({ kind: "askSave", repoId, text: value }).catch(() => {
      // Not kept: the next change, blur or leave tries again.
      if (saved.current === value) saved.current = null;
    });
  };
  // A leave while the host is still answering is where the person went: the
  // answer does not pull them on to the Spec pane. Leaving keeps what is typed.
  const left = useRef(false);
  // The box opens focused with the caret after what is kept, where typing goes on.
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const end = box.current!.value.length;
    box.current!.focus();
    box.current!.setSelectionRange(end, end);
  }, []);
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
      save();
    };
  }, []);
  const send = async (): Promise<void> => {
    const turn = text.trim();
    if (turn.length === 0 || busy) return;
    setBusy(true);
    setFailure(null);
    sending.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    let session: EditingSession | null = null;
    try {
      session = await bridge.request({ kind: "editingOpen", target: { kind: "fresh", repoId } });
      await bridge.request({ kind: "interviewTurn", id: session.id, text: turn });
    } catch (error) {
      // A turn nothing heard stays where it was typed, with why, and the
      // planning opened for it goes, with the spec the turn may have named:
      // naming it moved the planning past the revision it opened at.
      if (session !== null)
        void bridge.request({ kind: "editingDiscard", id: session.id }).catch(() => undefined);
      sending.current = false;
      save();
      setFailure(errorMessage(error));
      setBusy(false);
      return;
    }
    const opened = session;
    client.setQueryData<Snapshot>(["workspace"], (current) => (current ? withDraft(current, opened) : current));
    typed.current = "";
    keep("");
    await bridge.request({ kind: "askSave", repoId, text: "" }).catch(() => undefined);
    if (left.current) return;
    navigate({ page: "planning", sessionId: opened.id, pane: "spec" }, { replace: true });
  };
  return (
    <div className="plan">
      <section className="pane" aria-label="Start planning">
        <div className="ask">
          <h2 id={heading}>What do you want to build?</h2>
          <div className="composer-box ask-box">
            <textarea
              aria-labelledby={heading}
              rows={1}
              maxLength={12_000}
              placeholder="Start planning"
              ref={box}
              value={text}
              disabled={busy}
              onChange={(event) => {
                setText(event.target.value);
                typed.current = event.target.value;
                if (timer.current !== null) clearTimeout(timer.current);
                timer.current = setTimeout(save, SAVE_AFTER_MS);
              }}
              onBlur={save}
              onKeyDown={sendOnEnter(() => void send())}
            />
            {repository !== null && <span className="ask-repo mono">{repository}</span>}
            <SendButton disabled={busy || text.trim().length === 0} onClick={() => void send()} />
          </div>
          {failure !== null && <Notice tone="danger">{failure}</Notice>}
        </div>
      </section>
    </div>
  );
}
