import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { Button, InfoHint, LineIcon, Notice, ThinkingStatus, cx } from "../ui/index.js";
import { useQueryClient } from "@tanstack/react-query";
import { bridge, errorMessage, useGraph } from "../workspace/index.js";
import { graphHistory, latestUndoable } from "./history.js";
import { LEAVE_IT_TO_THE_INTERVIEW, PART_LETTERS } from "../../shared/contract-editing.js";
import { AskedHandle } from "./AskedHandle.js";
import { askedHeightLimit, useAskedHeight } from "../shell/asked-size.js";
import {
  INTERVIEW_CONVERSATION_CAP,
  INTERVIEW_WROTE_THE_SPEC,
  INTERVIEWER_NAME,
} from "../../shared/protocol.js";
import type {
  Asking,
  Change,
  InterviewDoing,
  InterviewEdit,
  InterviewEntry,
  Snapshot,
} from "../../shared/protocol.js";
import type { useContractEditing } from "../contract-editor.js";

/**
 * The interview, docked beside whichever pane is open (D-101, D-102).
 *
 * It sits outside the panes' own layouts and never collapses: a chat that can
 * be put away is one the plan gets changed without, and criterion by criterion
 * this is the surface the plan is supposed to be argued into shape on. The
 * conversation belongs to the planning session rather than to this screen, so
 * leaving planning mode and restarting the app both come back to it, and the
 * interview itself keeps running until it is stopped, as drafting keeps
 * running while the person navigates elsewhere (D-095).
 *
 * The dock writes nothing: a turn goes to the host, which validates it and
 * writes it down the interview's stdin, and every line comes back as a change.
 */

type Editor = ReturnType<typeof useContractEditing>;

/**
 * The conversation as the chat draws it: what the record holds, with whatever
 * has arrived since laid over it by line number, so a line counts once
 * whichever of the two reached this screen first.
 */
function mergeConversation(
  stored: readonly InterviewEntry[],
  live: readonly InterviewEntry[],
): InterviewEntry[] {
  if (live.length === 0) return [...stored];
  const held = new Map(stored.map((entry) => [entry.n, entry]));
  for (const entry of live) held.set(entry.n, entry);
  return [...held.values()].sort((left, right) => left.n - right.n).slice(-INTERVIEW_CONVERSATION_CAP);
}

/**
 * The plannings whose interview the person has opened in the chat, for as long
 * as this window is open. A convenience of the person reading, not the record:
 * the conversation is kept whole either way (D-102).
 */
const interviewShown = new Set<string>();

/**
 * The plannings with a turn on its way to the host from this window: sent,
 * and not yet answered by the request that took it. The host says a turn is
 * under way once it has it, and a chat that has to start first takes a while
 * to get there; in that time the turn is in flight all the same, and the Spec
 * pane holds Generate plan for it as it does for a turn the host reports.
 */
const turnsSending = new Map<string, number>();
const sendingListeners = new Set<() => void>();
function markSending(id: string, by: 1 | -1): void {
  const count = (turnsSending.get(id) ?? 0) + by;
  if (count > 0) turnsSending.set(id, count);
  else turnsSending.delete(id);
  for (const listener of sendingListeners) listener();
}
/** Whether a turn this window sent to this planning's chat is still on its way to the host. */
export function useTurnSending(id: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      sendingListeners.add(listener);
      return () => sendingListeners.delete(listener);
    },
    () => turnsSending.has(id),
  );
}

export function InterviewDock({
  workspace,
  editor,
  historyOpen,
  onHistory,
  width,
}: {
  workspace: Snapshot;
  editor: Editor;
  historyOpen: boolean;
  onHistory: () => void;
  /** How wide the person has dragged it, from the shell's own record. */
  width: number;
}) {
  const client = useQueryClient();
  const session = editor.session;
  const id = session?.id ?? null;
  const repoId = editor.repoId;
  const [live, setLive] = useState<InterviewEntry[]>([]);
  // The asking as the host last pushed it. Held here rather than read off the
  // session, because the editor holds a re-read back while a save of its own is
  // in flight and the card would come and go with that.
  const [pushed, setPushed] = useState<Asking | null | undefined>(undefined);
  // How tall the card is, and the most the dock can give it: the conversation
  // above it keeps a little, and what is left over is the card's.
  const stored = useAskedHeight();
  const [room, setRoom] = useState(0);
  const dockRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const held = dockRef.current;
    if (held === null) return;
    const measure = (): void => setRoom(held.getBoundingClientRect().height - 180);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(held);
    return () => observer.disconnect();
  }, []);
  const askedLimit = askedHeightLimit(room);
  const asked = Math.min(stored, askedLimit);
  // Whether the session is working, as the host last pushed it. Held here for
  // the reason the asking is: the editor holds a re-read back while a save is
  // in flight, and a pause is exactly when this has to be right.
  const [busyTurn, setBusyTurn] = useState<boolean | null>(null);
  // What the turn in flight is doing, as the host last pushed it; undefined
  // until something is pushed.
  const [doingTurn, setDoingTurn] = useState<InterviewDoing | null | undefined>(undefined);
  // Whether the interview that came before the plan is drawn, once there is a
  // plan: folded away behind one line until the person opens it.
  const [interviewOpen, setInterviewOpen] = useState(() => interviewShown.has(id ?? ""));
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const chat = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setLive([]);
    setPushed(undefined);
    setBusyTurn(null);
    setDoingTurn(undefined);
    setFailure(null);
    setInterviewOpen(interviewShown.has(id ?? ""));
  }, [id]);
  useEffect(
    () =>
      bridge.subscribe((change: Change) => {
        if (change.kind !== "interview" || change.sessionId !== id) return;
        setPushed(change.asking);
        setBusyTurn(change.working);
        setDoingTurn(change.doing);
        const entry = change.entry;
        if (entry === null) return;
        setLive((held) => (held.some((line) => line.n === entry.n) ? held : [...held, entry]));
      }),
    [id],
  );
  const conversation = useMemo(
    () => mergeConversation(session?.conversation ?? [], live),
    [session?.conversation, live],
  );
  // A run of commands the session may not run is one thing that happened, not
  // several: it reached for a shape outside its list, was told so, and read
  // another way. Folded here rather than in the record, which keeps every line
  // (D-102) — what is folded is the reading of them.
  const folded = useMemo(() => foldAllowList(conversation), [conversation]);
  // The plan's history as it stands, not as the card recorded it: an edit that
  // landed since is what D-100 lets an undo take back, and the host refuses
  // any other. The drawer reads the same query, so this costs no second read.
  const key = session?.key ?? null;
  const graph = useGraph(repoId, key);
  const undoable = latestUndoable(graphHistory(graph.data?.history ?? []))?.n ?? null;
  // The newest line is what the person is reading; a chat that stayed where it
  // was would answer somewhere off the bottom of the screen.
  useEffect(() => {
    const held = chat.current;
    if (held) held.scrollTop = held.scrollHeight;
  }, [conversation.length]);

  // The snapshot says which planning has a live interview; the change stream
  // moves that list the moment one starts or goes, rather than at the next poll.
  const running = (workspace.interviews ?? []).includes(id ?? "");
  const models = editor.form.models;

  const ask = useCallback(
    async (send: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setFailure(null);
      try {
        await send();
        return true;
      } catch (error) {
        setFailure(errorMessage(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  // One turn, whoever composed it: what the person typed, or the options they
  // picked in their own words. The host is given a string either way, so a
  // picked option is the person's own sentence and nothing more (ADR-0023 §4).
  const sendText = (turn: string, onRefused?: () => void): void => {
    if (id === null || turn.length === 0 || busy) return;
    markSending(id, 1);
    void ask(() => bridge.request({ kind: "interviewTurn", id, text: turn })).then((sent) => {
      markSending(id, -1);
      if (!sent) onRefused?.();
    });
  };
  const sendTurn = (): void => {
    const turn = text.trim();
    if (id === null || turn.length === 0 || busy) return;
    setText("");
    // A turn nothing heard is put back where it was typed, unless something
    // else has been typed since: retyping it is not the person's job.
    sendText(turn, () => setText((now) => (now.length === 0 ? turn : now)));
  };
  const undo = (n: number): void => {
    const key = session?.key ?? null;
    if (key === null) return;
    void ask(async () => {
      await bridge.request({ kind: "graphUndo", repoId, key, edit: n });
      await client.invalidateQueries({ queryKey: ["graph", repoId, key] });
    });
  };

  // The group in front of the person, as the session's own record has it. The
  // host moves this on as each group is answered and drops it when the person
  // says something of their own instead, so the card can neither stand over a
  // question the session has left nor be counted back out of turns that cannot
  // tell an answer from a question (D-117).
  const asking = useMemo(() => {
    // What was pushed, until something is pushed the record is what there is.
    const held = pushed === undefined ? (session?.asking ?? null) : pushed;
    if (held === null) return null;
    const line = conversation.find((entry) => entry.n === held.entry)?.line;
    if (line === undefined || line.kind !== "asked") return null;
    const group = line.groups[held.answered];
    if (group === undefined) return null;
    return {
      key: `${held.entry}:${held.answered}`,
      group,
      number: held.answered + 1,
      of: line.groups.length,
      // A problem between the plan and the spec is headed as which of how
      // many, and named by what it is about: the same card the Problems pane
      // shows, answered from here the same way.
      head: line.drift === undefined ? undefined : problemHead(line.drift.open),
      standing: line.drift === undefined ? ("interview" as const) : ("problem" as const),
    };
  }, [pushed, session?.asking, conversation]);

  // Whether a turn is in flight: the session owes the person a word, through
  // the pauses it takes mid-answer, until it reports the turn over (D-119).
  // Until something is pushed, what the snapshot says: a dock opened part way
  // through a turn missed the change that said so.
  const inFlight = busyTurn === null ? (workspace.working ?? []).includes(id ?? "") : busyTurn;
  // Said for the whole of the turn, the part after the spec-written note
  // included: Generate plan is held until the turn is over (D-102), so the
  // chat says the turn is still going for as long as the press waits on it.
  const told = inFlight;
  const handed = handedOver(conversation);
  // The session has words for the person that are not shown yet: its bubble
  // stands at the foot of the log with the dots, in place of the status line,
  // until they are. Not once the spec-written note stands, since nothing the
  // session says after it is shown.
  const speaking = told && doingTurn === "speaking" && !handed;
  // The one status line at the foot of the log, saying what the turn is doing
  // as it moves from reading the person's answer to thinking, writing the spec
  // and changing the plan, or null where there is none to show. Writing the
  // spec is the host's to say, because it leaves no line to read it from; the
  // rest is read from the last line the turn put in the conversation.
  const working = useMemo(() => {
    if (!told || speaking) return null;
    // Whatever the session does after the note is not shown, so neither is
    // what it is doing: only that the turn is still going.
    if (handed) return FINISHING;
    if (doingTurn === "writing_the_spec") return "Writing the spec…";
    return sayWorking(conversation.at(-1)?.line, conversation.at(-2)?.line);
  }, [told, speaking, handed, doingTurn, conversation]);

  const dropped = (conversation[0]?.n ?? 1) - 1;
  // What the log draws: every line but a tool call that only repeated itself.
  const drawn = folded.filter(
    (item) => item.tried !== undefined || !quiet(item.entry.line, key !== null ? undoable : null),
  );
  // Once there is a plan, the interview that led to it is folded away behind
  // one line at the top of the log, and the chat from the plan onward is what
  // the dock shows. Where the plan begins is the moment its ticket was
  // admitted, which is when Generate plan drafted it.
  const admitted =
    key === null
      ? undefined
      : workspace.tasks.find((row) => row.repoId === repoId && row.ticket.key === key)?.ticket.admitted_at;
  const planFrom =
    admitted === undefined ? 0 : drawn.findIndex((item) => Date.parse(item.entry.at) >= Date.parse(admitted));
  const before = planFrom < 0 ? drawn.length : planFrom;
  const folding = before > 0 && !interviewOpen;
  const showing = folding ? drawn.slice(before) : drawn;
  // Whether the app is waiting on words the person types: their first message,
  // or a question the interview put in its own words with no card to pick
  // from. Not while a card stands, a turn is in flight or they have begun.
  const awaitingWords =
    id !== null &&
    asking === null &&
    !inFlight &&
    !busy &&
    text.length === 0 &&
    waitsOnWords(conversation, dropped);
  return (
    <aside className="dock" aria-label="Chat" style={{ width }} ref={dockRef}>
      <div className="dock-head">
        <div className="dock-session">
          <span className={cx("prov-dot", models.draftingProvider === "codex-cli" && "prov-dot--codex")} />
          <strong>{models.draftingProvider === "codex-cli" ? "Codex" : "Claude"}</strong>
          {/* The model the session was started on, once one has run (D-102). */}
          <span className="mono">{session?.interviewModel ?? models.executorModel}</span>
          <span className="spacer" />
          <span className="small muted">{running ? "running" : "not running"}</span>
          {/* What the session may do is the same paragraph on every planning,
              read once and then in the way: it is behind the dot. */}
          <InfoHint
            label="What this session may do"
            text={
              "Your own session. It reads anything, writes only this spec's folder, CONTEXT.md " +
              "and the ADR folder, and cannot approve, publish or merge. Anything else is refused " +
              "rather than put to you."
            }
          />
        </div>

        <div className="dock-acts">
          <strong>Chat</strong>
          <button type="button" className="text-button small" aria-expanded={historyOpen} onClick={onHistory}>
            History
          </button>
          <span className="spacer" />
          <Button
            className="small"
            disabled={busy || id === null || !running}
            onClick={() => {
              if (id !== null) void ask(() => bridge.request({ kind: "interviewStop", id }));
            }}
          >
            Stop the chat
          </Button>
        </div>
      </div>
      <div className="chat" ref={chat} aria-label="Conversation" aria-live="polite">
        {before > 0 && (
          <button
            type="button"
            className="text-button small chat-earlier"
            aria-expanded={interviewOpen}
            onClick={() => {
              const open = !interviewOpen;
              if (open) interviewShown.add(id ?? "");
              else interviewShown.delete(id ?? "");
              setInterviewOpen(open);
            }}
          >
            {interviewOpen
              ? "Hide the earlier chat"
              : `Show the earlier chat (${before} ${before === 1 ? "line" : "lines"})`}
          </button>
        )}
        {dropped > 0 && !folding && (
          <p className="small muted">
            The first {dropped} {dropped === 1 ? "line" : "lines"} of this conversation are no
            longer kept here; the last {INTERVIEW_CONVERSATION_CAP} are. The session itself still
            has all of it.
          </p>
        )}
        {showing.map((item) =>
          item.tried !== undefined ? (
            <AllowList key={item.entry.n} tried={item.tried} />
          ) : (
            <Line
              key={item.entry.n}
              entry={item.entry}
              onUndo={key !== null ? undo : null}
              undoable={undoable}
              busy={busy}
            />
          ),
        )}
        {speaking && <Speaking />}
        {working !== null && (
          <p className="chat-working">
            <img className="chat-working-mark" src="./brand/perbo-mark.png" alt="" />
            <ThinkingStatus text={working} />
          </p>
        )}
      </div>
      {asking !== null && (
        <>
          <AskedHandle height={asked} limit={askedLimit} />
          <QuestionCard
            key={asking.key}
            group={asking.group}
            number={asking.number}
            of={asking.of}
            head={asking.head}
            standing={asking.standing}
            busy={busy}
            height={asked}
            onSend={(answer) => sendText(answer)}
          />
        </>
      )}
      {failure !== null && <Notice tone="danger">{failure}</Notice>}
      {/* The card is the only way to answer while one is up: every answer it
          wants is on it, the person's own words included, and a box beside it
          would be a second way to do one thing. */}
      <div className="composer" hidden={asking !== null}>
        {/* Its rim pulses while the app is waiting on words only the person
            can type, so a question with nothing to pick is not mistaken for
            one still being worked on. */}
        <div className={cx("composer-box", awaitingWords && "awaiting-words")}>
          <textarea
            ref={box}
            aria-label="Message the chat"
            value={text}
            disabled={id === null}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={sendOnEnter(sendTurn)}
          />
          <SendButton disabled={id === null || busy || text.trim().length === 0} onClick={sendTurn} />
        </div>
      </div>
    </aside>
  );
}

/**
 * The same send as Enter, in a box's bottom-right corner: muted with nothing
 * to send, inked once there is. The chat's box and a repository's question
 * page both send with it, and so does the bar at the foot of a group of
 * questions.
 */
export function SendButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="composer-send" aria-label="Send" disabled={disabled} onClick={onClick}>
      <LineIcon name="send" size={14} strokeWidth={2} />
    </button>
  );
}

/** A box's Enter, which sends as its Send button does; with a modifier it is a new line. */
export const sendOnEnter =
  (send: () => void) =>
  (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    send();
  };

/**
 * The session's bubble with its dots, while the host holds a line of its own
 * still to be said: only then, because dots before words already here only
 * hold the words back.
 */
function Speaking() {
  return (
    <div className="msg msg--interview msg--speaking" aria-label={`${INTERVIEWER_NAME} is about to say something`}>
      <span className="msg-who">{INTERVIEWER_NAME}</span>
      <span className="speaking-dots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </div>
  );
}

/**
 * Whether the conversation leaves the next word to what the person types:
 * their first message, where none of the conversation has been dropped, or a
 * question the session put in its own words as the last thing said. A note
 * after it — the chat ending, a crash — is the last thing said instead, and
 * the question is no longer waiting on them. Tools and refusals are the
 * session working, and are passed over.
 */
export function waitsOnWords(conversation: readonly InterviewEntry[], dropped: number): boolean {
  if (dropped === 0 && !conversation.some((entry) => entry.line.kind === "turn")) return true;
  const last = conversation.findLast(({ line }) => ["turn", "said", "asked", "note"].includes(line.kind))?.line;
  // A question closed by a quote, a bracket or emphasis is still a question.
  return last?.kind === "said" && /\?["'”’)\]*_]*\s*$/.test(last.text);
}

/** One answer on offer: the session's own, or the one every part carries. */
type Choice = Extract<
  InterviewEntry["line"],
  { kind: "asked" }
>["groups"][number]["parts"][number]["options"][number];

/**
 * What each of the interview's tools is called in the chat.
 *
 * The tool's own name is an argument in a protocol; what the person is
 * following is the work. A name not here is shown as it is, so a tool added
 * later reads as itself rather than as nothing.
 */
const TOOL_NAMES: Record<string, { did: string; tried: string }> = {
  ask_options: { did: "Questions", tried: "Questions" },
  edit_plan: { did: "Changed the plan", tried: "Changing the plan" },
  undo_edit: { did: "Took a change back", tried: "Taking a change back" },
  read_plan: { did: "Read the plan", tried: "Reading the plan" },
};

/**
 * What a card calls what happened, in the tense it happened in.
 *
 * A card is written when the tool returns, so one that worked is past: "Draft
 * the plan" reads as a button for something not yet done, over work already
 * finished. One that was refused never happened at all, and saying it did would
 * be the card contradicting the word beside it.
 */
const toolName = (tool: string, ok: boolean): string => {
  const named = TOOL_NAMES[tool];
  if (named === undefined) return tool;
  return ok ? named.did : named.tried;
};

/**
 * The answer every part carries whatever the session offered, as the decision
 * screen carries it: a person asked something they have no view on leaves it to
 * the session rather than picking one of its options to get past the question.
 * Added here rather than asked of the session, so it is always there.
 */
const LEAVE_IT: Choice = {
  label: LEAVE_IT_TO_THE_INTERVIEW,
  detail: null,
  recommended: false,
};

/** The keys that move a pick through a part's answers without making it. */
const ARROW_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * The answer that is none of the offered ones.
 *
 * Picking it opens a box inside that answer, where the part is said in the
 * person's own words: a person whose answer is not on the card should not have
 * to pick the nearest wrong one, and a card that offers no way out is a form
 * rather than a question.
 */
const SOMETHING_ELSE: Choice = {
  label: "Something else",
  detail: null,
  recommended: false,
};

/** The status while the turn winds up after the spec-written note, which Generate plan waits on. */
const FINISHING = "Finishing this turn…";

/**
 * What the session is doing, in the words of the last thing it did.
 *
 * "Thinking…" is true of every pause and says nothing about any of them. What
 * the dock actually knows is the last line: a tool that has just returned names
 * the work in hand, because a session does not call `edit_plan` and then do
 * something else; a turn just sent is the session reading it; a question just
 * put is the session going on with what it was doing.
 *
 * It is a reading of what happened, not a report from the session, so it is
 * written as what is in hand rather than as a claim about the next moment.
 *
 */
export function sayWorking(
  line: InterviewEntry["line"] | undefined,
  previous?: InterviewEntry["line"],
): string {
  if (line === undefined) return "Reading the repository…";
  // The spec is written and the note says so, and the session is winding the
  // turn up: Generate plan waits on that (D-102), so the status says it is
  // going on rather than falling quiet under the note.
  if (line.kind === "note" && line.text === INTERVIEW_WROTE_THE_SPEC) return FINISHING;
  // An answer to a problem between the plan and the spec: the session is
  // applying it, and the plan is read again once it has.
  if (line.kind === "turn" && previous?.kind === "asked" && previous.drift !== undefined)
    return "Resolving the problem…";
  if (line.kind === "asked" && line.drift !== undefined) return "Resolving the problem…";
  if (line.kind === "turn") return "Reading what you said…";
  if (line.kind === "asked") return "Working on the rest…";
  if (line.kind === "refused") return "Trying another way…";
  if (line.kind === "tool") {
    const named = TOOL_NAMES[line.tool];
    // A tool that failed is being answered, not repeated.
    if (!line.ok) return "Reading what came back…";
    return named === undefined ? "Working…" : `${named.tried}…`;
  }
  return "Thinking…";
}

/**
 * Whether the note that hands the written spec over has been said since the
 * person's last turn: from there on nothing the session says in that turn is
 * shown (D-102).
 */
export function handedOver(conversation: readonly InterviewEntry[]): boolean {
  return (
    conversation.findLast(
      ({ line }) => line.kind === "turn" || (line.kind === "note" && line.text === INTERVIEW_WROTE_THE_SPEC),
    )?.line.kind === "note"
  );
}

/**
 * Whether a line is a tool call that only repeated itself, which the chat does
 * not draw: what it changed is on the graph, what it asked is on the card, and
 * a panel saying it happened is a third telling of something already told.
 * One run of edits made eight of them in a row and pushed the conversation off
 * the top.
 *
 * What is drawn is what is said nowhere else:
 *
 *  - a refusal, because no `asked` follows a rejected call;
 *  - an undo, which is rare, person-asked, and the only word that a change
 *    was taken back;
 *  - the edit at the head of the plan's history, which carries the undo
 *    D-100 allows: a control rather than a report. `undoable` is that edit's
 *    number, or null where no undo is offered.
 *
 * What is left is a repeated `edit_plan` and a `read_plan`, which is exactly
 * the run that buried the conversation.
 */
function quiet(line: InterviewEntry["line"], undoable: number | null): boolean {
  if (line.kind !== "tool" || !line.ok || line.tool === "undo_edit") return false;
  return !(line.edit !== null && undoable === line.edit.n);
}

/**
 * The refusals where nothing shows a write.
 *
 * The runner's own rules split this way, and say so: `unreadable_inline_program`
 * is recorded rather than ending the attempt because "nothing about it shows a
 * write", where a write rule ends it
 * ({@link ../../../../../packages/runner/src/admission.ts}). These three are
 * the session reaching for a shape this guard cannot vouch for — a command off
 * the read-only list, a program position it cannot resolve, inline code it
 * cannot classify — and reading another way.
 *
 * Everything else keeps its card: a write outside the worktree or the scope, a
 * prohibited path, a denied command, a credential config. Those are the ones a
 * person should act on, and the red belongs to them.
 */
const NOTHING_WRITTEN: readonly string[] = [
  "command_allow_list",
  "unreadable_program",
  "unreadable_inline_program",
];

/**
 * The conversation with runs of allow-list refusals folded into one.
 *
 * A refusal is always reported and never asked (D-102), and that is right for
 * the ones that matter: a write it may not make, a path outside the spec
 * folder. Reaching for a command shape it does not have is not that. It is the
 * session finding the edge of what it may run and reading another way, and a
 * red card for each one buries the refusals a person should act on under the
 * ones they should not.
 *
 * Only a run, and only consecutive: three in a row are one thing that happened.
 * A refusal with anything between them is its own event and keeps its line.
 */
export function foldAllowList(
  conversation: readonly InterviewEntry[],
): { entry: InterviewEntry; tried?: number }[] {
  const out: { entry: InterviewEntry; tried?: number }[] = [];
  for (const entry of conversation) {
    const listed =
      entry.line.kind === "refused" && NOTHING_WRITTEN.includes(entry.line.rule);
    const last = out.at(-1);
    if (listed && last?.tried !== undefined) {
      out[out.length - 1] = { entry: last.entry, tried: last.tried + 1 };
      continue;
    }
    out.push(listed ? { entry, tried: 1 } : { entry });
  }
  return out;
}

/**
 * A run of commands the session reached for and may not run.
 *
 * Said as what happened rather than as what was refused. Nothing went wrong:
 * it reached for a way of reading it does not have, was told so, and read
 * another way — which is the session working, not failing. A red card for each
 * one reads as an alarm and buries the refusals a person should act on.
 */
function AllowList({ tried }: { tried: number }) {
  return (
    <p className="msg msg--note allow-list" role="note" aria-label="Commands not run">
      Tried {tried === 1 ? "a way of reading" : `${tried} ways of reading`} this session does not
      have, and read another way instead. Nothing was written.
    </p>
  );
}

/** "Problem 1 of N": the head of a card putting one of the problems between the plan and the spec. */
export function problemHead(open: number): string {
  return `Problem 1 of ${open}`;
}

/**
 * One group of questions, with the answers to pick from
 * (D-117).
 *
 * Its parts are read together and answered together: a part whose answer
 * depends on another's cannot be asked on its own, which is what a group is
 * for. Picking and typing send nothing; the bar at the card's foot sends the
 * whole group as one turn, and is only enabled once every part has an answer,
 * because a half-answered group asked again is worse than one not yet sent. A
 * pick clicked again is taken back, which is how a person changes their mind
 * before they send; Something else is taken back by a click on its opened
 * answer around the box, since a click in the box is the person typing.
 *
 * A part whose answer is none of the offered ones is said in a box of its own,
 * inside that part's answer, so the group's other parts stay pickable and the
 * whole group still goes in one turn; Enter in the box is a new line, like any
 * other key. That box is the only place a person's own words are asked for
 * while a card stands: one card, one way to answer.
 *
 * What goes down is the options' own words, or the person's for a part they
 * said themselves. The session wrote the labels, the person picked them, and
 * what the host is given is a turn like any other — neither a picked option nor
 * a typed sentence ever becomes a path, a command or an argument.
 */
export function QuestionCard({
  group,
  number,
  of,
  head,
  standing,
  busy,
  height,
  onSend,
}: {
  group: Extract<InterviewEntry["line"], { kind: "asked" }>["groups"][number];
  number: number;
  of: number;
  /**
   * A head over the group's own title, where the question is the host's and
   * not the session's: "Problem 1 of N" over a problem between the plan and
   * the spec, whose title then says what it is about.
   */
  head?: string | undefined;
  /**
   * Whose question this is. The interview's own carries the answer that hands
   * the choice back to it; a problem between the plan and the spec is the
   * host's, and the interview has no judgement of its own to hand it to — it
   * is the one being asked to move the plan or the spec — so that answer is
   * not on the card. "Something else" is on both.
   */
  standing: "interview" | "problem";
  busy: boolean;
  /**
   * How tall the person has dragged it, from the shell's own record; left
   * out on a page that gives the card its own room.
   */
  height?: number;
  onSend: (answer: string) => void;
}) {
  const [picked, setPicked] = useState<Record<number, number>>({});
  // What the person has typed for each part they said the answer to is none of
  // the offered ones. Kept per part and not thrown away when they pick an
  // option instead or take Something else back, so changing their mind twice
  // does not cost them the sentence they wrote.
  const [own, setOwn] = useState<Record<number, string>>({});
  // The part whose box is to take the caret as soon as it is there. Picking
  // "Something else" is already the start of typing the answer, so the next
  // keystroke lands in the box without a hand leaving the keyboard. Set on the
  // pick rather than read off the state, which is also true while the card
  // simply re-renders — focus then would take the card off where it was.
  const wanted = useRef<number | null>(null);
  // The session's recommendation first, because a person reading a list of
  // answers reads the top of it, and the one it would pick is the one most of
  // them want. Its own order is kept under that. The two answers every part
  // carries come last, and are drawn apart from these as a pair.
  const choicesOf = (part: (typeof group.parts)[number]): readonly Choice[] => [
    ...[...part.options].sort(
      (left, right) => Number(right.recommended) - Number(left.recommended),
    ),
    ...(standing === "interview" ? [LEAVE_IT] : []),
    SOMETHING_ELSE,
  ];
  /** Whether this part is one the person is answering in their own words. */
  const typedIn = (held: Record<number, number>, index: number): boolean =>
    choicesOf(group.parts[index]!)[held[index] ?? -1]?.label === SOMETHING_ELSE.label;
  // A lettered part's answer goes down as one line, so what was typed over
  // several arrives as one: a newline in it would read as a part that was never
  // answered and take the whole group's answer down with it. A lone part is the
  // turn whole and carries no letter, so nothing reads its lines as parts and
  // the person's own paragraphs go down as they wrote them.
  const said = (index: number): string => {
    const typed = (own[index] ?? "").trim();
    return group.parts.length === 1 ? typed : typed.replace(/\s+/g, " ");
  };
  const answered = group.parts.every(
    (_part, index) => picked[index] !== undefined && (!typedIn(picked, index) || said(index).length > 0),
  );
  /** The label a part's box is addressed by, lettered where the parts are. */
  const ownLabel = (index: number): string =>
    group.parts.length === 1
      ? "Your own words"
      : `Your own words for ${number}${PART_LETTERS[index] ?? index + 1}`;
  const send = (): void => {
    if (!answered || busy) return;
    const chosen = group.parts.map((part, index) =>
      typedIn(picked, index) ? said(index) : choicesOf(part)[picked[index]!]!.label,
    );
    // One part goes as the sentence whole; several are lettered as they were
    // read, so the answers arrive in the shape the question was put. A lone
    // part keeps no letter, which is what tells its own words from an answer
    // to the question it was asked.
    onSend(
      chosen.length === 1
        ? chosen[0]!
        : chosen.map((label, index) => `${PART_LETTERS[index] ?? index + 1}) ${label}`).join("\n"),
    );
  };
  /**
   * Make a pick, never taking it back: the keyboard's Enter, or Space, on an
   * answer the arrow keys moved to, where the arrows have already put the pick
   * there and the key is the person saying it is the one.
   */
  const commit = (index: number, choice: number): void => {
    if (busy) return;
    const held = { ...picked, [index]: choice };
    if (typedIn(held, index)) wanted.current = index;
    setPicked(held);
  };
  /** Pick an answer for a part, or take the pick back where it is already that one. */
  const pick = (index: number, choice: number): void => {
    if (busy) return;
    if (picked[index] === choice) setPicked(({ [index]: _dropped, ...rest }) => rest);
    else commit(index, choice);
  };
  // What the last key on an answer was. An arrow key moves the pick through a
  // part's answers, and the browser reports each step as a click on the
  // answer reached: that step moves the pick, and neither takes it back nor
  // moves the caret into a box, or walking a part's answers would stop in the
  // first box it passed.
  const keyed = useRef<"arrow" | "space" | null>(null);

  /** One answer as a line to pick, or as one of the pair every part carries. */
  const choice = (index: number, option: Choice, at: number, paired: boolean) => {
    const custom = option.label === SOMETHING_ELSE.label;
    const chosen = picked[index] === at;
    const answer = (): void => {
      const by = keyed.current;
      keyed.current = null;
      if (by === "space") commit(index, at);
      else if (by === "arrow" && !chosen) setPicked((held) => ({ ...held, [index]: at }));
      else pick(index, at);
    };
    return (
      <label
        className={cx(
          "choice",
          paired && "choice--paired",
          // The box's own styling, worn only while the box is there:
          // unpicked, this answer is one of the pair like its neighbour.
          custom && chosen && "choice--custom",
          chosen && "selected",
        )}
        key={at}
      >
        <span className="choice-heading">
          {/* The circle every answer carries, the pair's included: filled
              while it is the pick, and while the box it opened is being
              typed in. */}
          <input
            type="radio"
            name={`asked-${number}-${index}`}
            checked={chosen}
            disabled={busy}
            // A click on the pick already made takes it back: a radio fires
            // no change for that click, so it is read here. Space on it is
            // the keyboard's way of making it, and is not a take-back. A click
            // anywhere on the answer reaches here through its label but one
            // in the box Something else opened, which is the box's own: so
            // that answer is taken back by its opened card around the box,
            // and never by typing in it.
            onClick={() => {
              if (chosen) answer();
            }}
            onChange={answer}
            onKeyDown={(event) => {
              keyed.current = ARROW_KEYS.has(event.key) ? "arrow" : event.key === " " ? "space" : null;
              if (event.key !== "Enter") return;
              event.preventDefault();
              commit(index, at);
            }}
            // The step an arrow key takes lands before the key comes up, so
            // nothing after it is read as one.
            onKeyUp={() => {
              if (keyed.current === "arrow") keyed.current = null;
            }}
          />
          <strong>{option.label}</strong>
          {option.recommended && <span className="choice-recommended">recommended</span>}
        </span>
        {option.detail !== null && <p>{option.detail}</p>}
        {/* Inside the answer it belongs to, and only once it is picked: the
            part is answered here the way its neighbours are answered above,
            and the rest of the group is still there to pick. */}
        {custom && chosen && (
          <textarea
            ref={(held) => {
              if (held === null || wanted.current !== index) return;
              wanted.current = null;
              // Without scrolling: focus scrolls every box around the one it
              // lands in, the page and the pane beside the chat included.
              // What moves is the card's own list of answers, just far enough
              // to show the box.
              held.focus({ preventScroll: true });
              reveal(held);
              // At the end of what is there: a box picked, left and picked
              // again keeps the sentence, and that is where the writing
              // carries on from.
              held.setSelectionRange(held.value.length, held.value.length);
            }}
            aria-label={ownLabel(index)}
            value={own[index] ?? ""}
            disabled={busy}
            onChange={(event) => setOwn((held) => ({ ...held, [index]: event.target.value }))}
          />
        )}
      </label>
    );
  };

  return (
    <div
      className="asked-card"
      role="group"
      aria-label={group.title ?? `Question ${number}`}
      {...(height === undefined ? {} : { style: { height } })}
    >
      <div className="asked-head">
        <b>{head ?? group.title ?? `${INTERVIEWER_NAME} asks`}</b>
        {head !== undefined && group.title !== null && (
          <span className="small muted asked-about">{group.title}</span>
        )}
        {of > 1 && (
          <span className="small muted">
            {number} of {of}
          </span>
        )}
      </div>
      <div className="asked-body">
        {group.parts.map((part, index) => {
          const choices = choicesOf(part);
          const ownAt = choices.length - 1;
          const leaveAt = standing === "interview" ? ownAt - 1 : null;
          const ownOpen = picked[index] === ownAt;
          return (
            <fieldset className="asked-part" key={index}>
              <legend>
                {group.parts.length > 1 && (
                  <span className="asked-letter">
                    {number}
                    {PART_LETTERS[index] ?? index + 1})
                  </span>
                )}
                {part.question}
              </legend>
              {choices.slice(0, leaveAt ?? ownAt).map((option, at) => choice(index, option, at, false))}
              {/* The two answers every part carries, side by side: its own
                  words on the left, the interview's judgement on the right.
                  Opened, its own words take the row and the other goes until
                  the box is closed again. */}
              <div className={cx("choice-pair", ownOpen && "choice-pair--open")}>
                {choice(index, SOMETHING_ELSE, ownAt, true)}
                {leaveAt !== null && !ownOpen && choice(index, LEAVE_IT, leaveAt, true)}
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="asked-bar">
        <SendButton disabled={busy || !answered} onClick={send} />
      </div>
    </div>
  );
}

/**
 * Scroll the nearest box around this one that scrolls, and no other, just far
 * enough to show all of it.
 */
function reveal(element: HTMLElement): void {
  let box = element.parentElement;
  while (box !== null && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (box === null) return;
  const inner = element.getBoundingClientRect();
  const outer = box.getBoundingClientRect();
  if (inner.bottom > outer.bottom) box.scrollTop += Math.min(inner.bottom - outer.bottom, inner.top - outer.top);
  else if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
}

/** One line of the conversation, in the shape its kind is read in. */
function Line({
  entry,
  onUndo,
  undoable,
  busy,
}: {
  entry: InterviewEntry;
  onUndo: ((n: number) => void) | null;
  /** The edit the plan's history says an undo may take back, or null for none. */
  undoable: number | null;
  busy: boolean;
}) {
  const line = entry.line;
  if (line.kind === "turn")
    return (
      <div className="msg msg--you">
        <span className="msg-who">you</span>
        {line.text}
      </div>
    );
  if (line.kind === "said")
    return (
      <div className="msg msg--interview">
        <span className="msg-who">{INTERVIEWER_NAME}</span>
        {line.text}
      </div>
    );
  // A note the host marked is about a page the person is not on, so it is
  // drawn to be read rather than to be scrolled past. It is told, not warned:
  // nothing has gone wrong, so it takes no danger colour. A note is words and
  // never a press: the one saying the spec is written leaves drafting to the
  // foot of the Spec pane, and the one saying every problem is resolved
  // leaves confirming to the Confirm the plan every other pane carries.
  if (line.kind === "note")
    return (
      <p
        className={cx("msg", "msg--note", line.notable && "msg--notable")}
        {...(line.notable ? { role: "note", "aria-label": "Worth knowing" } : {})}
      >
        {line.text}
      </p>
    );
  // The questions are put one group at a time under the conversation, and they
  // are written out here as well. A person who says something of their own
  // takes the rest off the card — the session is about to answer what they
  // said — so what was asked has to stay somewhere they can still read it.
  if (line.kind === "asked" && line.drift !== undefined) {
    // One of the problems between the plan and the spec, put by the host: the
    // card is above while it is in front of the person, and this is the line
    // that says it was put, with the difference behind its dot.
    const group = line.groups[0]!;
    return (
      <p className="msg msg--note asked-said">
        {problemHead(line.drift.open)}
        {group.title !== null && `: ${group.title}`}.
        {/* What was asked, and not what could be answered: the answer given
            is in the chat under it. */}
        <InfoHint
          label="The problem that was put"
          text={group.parts.map((part) => part.question).join("\n\n")}
        />
      </p>
    );
  }
  if (line.kind === "asked") {
    const parts = line.groups.reduce((count, group) => count + group.parts.length, 0);
    // What the questions are about, which is what a person reading the chat
    // later wants from this line. The count is what is left when the session
    // titled none of them.
    const about = line.groups.flatMap((group) => (group.title === null ? [] : [group.title]));
    // Titles are the session's own words, four groups of up to two hundred
    // characters: said in the line they would be the long account the card
    // exists to keep out of the chat.
    const subjects = (titles: string[]): string => {
      const joined =
        titles.length === 1 ? titles[0]! : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
      return joined.length > 120 ? `${joined.slice(0, 117).trimEnd()}…` : joined;
    };
    return (
      <p className="msg msg--note asked-said">
        {`Asked ${parts === 1 ? "one question" : `${parts} questions`}${
          line.groups.length > 1 ? ` in ${line.groups.length} groups` : ""
        }`}
        {about.length > 0 && `, about ${subjects(about)}`}.
        {/* The questions alone: the answers given are in the chat, as the
            person's own turns. */}
        <InfoHint
          label="The questions that were asked"
          text={line.groups
            .map((group, number) =>
              [
                group.title === null ? null : group.title,
                ...group.parts.map(
                  (part, index) =>
                    `${number + 1}${group.parts.length > 1 ? (PART_LETTERS[index] ?? index + 1) : ""}) ` +
                    part.question,
                ),
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n")}
        />
      </p>
    );
  }
  if (line.kind === "refused")
    return (
      <div className="refusal" role="note" aria-label="Refused">
        <div className="refusal-head">
          <b>Refused</b>
          <code>{line.tool}</code>
          {line.target !== null && <code className="refusal-target">{line.target}</code>}
        </div>
        <p className="refusal-why">{line.reason}</p>
        {/* No hint here, and no control of any kind: a refusal carries nothing
            to answer, and D-102 is that it is never put to the person as a
            question. The rule that refused it is part of the report. */}
        <p className="small muted">
          {line.rule} · this session is never asked to allow something; a call outside what it may
          do is refused and told to you.
        </p>
      </div>
    );
  return <ToolCard line={line} edit={line.edit} onUndo={onUndo} undoable={undoable} busy={busy} />;
}

/**
 * What one of the interview's own tools did, as one line: its name, in the
 * tense it happened in. What an edit changed is on the graph and in the spec,
 * where the person reads it, so the card does not say it again. An
 * `edit_plan` or an `undo_edit` carries the edit the plan's own record took
 * from it, and the undo D-100 allows is on its number. A refused call adds a
 * muted line under it: the first sentence of why, whole, over as many lines
 * as it takes, with the rest of the reason behind an `i` after it where there
 * is more than that sentence.
 */
export function ToolCard({
  line,
  edit,
  onUndo,
  undoable,
  busy,
}: {
  line: Extract<InterviewEntry["line"], { kind: "tool" }>;
  edit: InterviewEdit | null;
  onUndo: ((n: number) => void) | null;
  undoable: number | null;
  busy: boolean;
}) {
  return (
    <div className={cx("tool-card", !line.ok && "tool-card--failed")}>
      <div className="tool-head">
        {/* What the tool is for, rather than what it is called: a person
            reading the chat is following the work, and `ask_options` is the
            name of a thing they never call. */}
        <b>{toolName(line.tool, line.ok)}</b>
        {line.ok && (
          <InfoHint text={line.detail} label={`What happened: ${toolName(line.tool, true)}`} />
        )}
        {edit !== null && onUndo !== null && undoable === edit.n && (
          <button
            type="button"
            className="text-button small"
            disabled={busy}
            aria-label={`Undo: ${edit.summary}`}
            onClick={() => onUndo(edit.n)}
          >
            Undo
          </button>
        )}
      </div>
      {!line.ok && (
        <p className="tool-why">
          {`Refused: ${firstSentence(line.detail)}`}
          {firstSentence(line.detail) !== flat(line.detail) && (
            <InfoHint text={line.detail} label={`Why it was refused: ${toolName(line.tool, false)}`} />
          )}
        </p>
      )}
    </div>
  );
}

/** What a tool said, on one line: its whitespace run together. */
const flat = (text: string): string => text.trim().replace(/\s+/g, " ");

/** The first sentence of what a tool said, or all of it where it has no end to a sentence. */
export function firstSentence(text: string): string {
  const said = flat(text);
  const end = said.search(/[.!?](\s|$)/);
  return end < 0 ? said : said.slice(0, end + 1);
}
