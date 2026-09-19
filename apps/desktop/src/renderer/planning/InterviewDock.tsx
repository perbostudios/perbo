import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Notice, cx } from "@perbo/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bridge, errorMessage } from "../data.js";
import { graphHistory, latestUndoable } from "./history.js";
import { LEAVE_IT_TO_THE_INTERVIEW, PART_LETTERS } from "../../shared/contract-editing.js";
import { AskedHandle } from "./AskedHandle.js";
import { askedHeightLimit, useAskedHeight } from "../shell/asked-size.js";
import { InfoHint } from "../InfoHint.js";
import { ThinkingStatus } from "../Screen.js";
import { INTERVIEW_CONVERSATION_CAP } from "../../shared/protocol.js";
import type {
  Asking,
  Change,
  InterviewEdit,
  InterviewEntry,
  Snapshot,
} from "../../shared/protocol.js";
import type { useContractEditing } from "../tasks/contract-editor.js";

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
  // Whether the card in front of the person has asked for the box back. While
  // a card is up the box is not: every answer it wants is on the card, and a
  // box beside it is a second way to do one thing. "Something else" is how the
  // person says their answer is not there, and it brings the box back.
  const [typing, setTyping] = useState(false);
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
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const chat = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLive([]);
    setPushed(undefined);
    setTyping(false);
    setBusyTurn(null);
    setFailure(null);
  }, [id]);
  useEffect(
    () =>
      bridge.subscribe((change: Change) => {
        if (change.kind !== "interview" || change.sessionId !== id) return;
        setPushed(change.asking);
        setBusyTurn(change.working);
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
  // The plan's history as it stands, not as the card recorded it: an edit that
  // landed since is what D-100 lets an undo take back, and the host refuses
  // any other. The drawer reads the same query, so this costs no second read.
  const key = session?.key ?? null;
  const graph = useQuery({
    queryKey: ["graph", repoId, key],
    queryFn: () => bridge.request({ kind: "graphRead", repoId, key: key ?? "" }),
    networkMode: "always",
    enabled: key !== null,
    staleTime: 1000,
  });
  const undoable = latestUndoable(graphHistory(graph.data?.history ?? []))?.n ?? null;
  // And it follows the records itself: the Graph pane and the history drawer
  // each invalidate this query, and over the Spec or the Explorer pane with the
  // drawer closed neither is there — which would leave the card offering an
  // undo for an edit the plan has passed, or none for the edit it just made.
  useEffect(
    () =>
      bridge.subscribe((change: Change) => {
        if (change.kind !== "records" || key === null) return;
        if (change.repoId !== null && change.repoId !== repoId) return;
        void client.invalidateQueries({ queryKey: ["graph", repoId, key] });
      }),
    [client, key, repoId],
  );
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
    void ask(() => bridge.request({ kind: "interviewTurn", id, text: turn })).then((sent) => {
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
    };
  }, [pushed, session?.asking, conversation]);

  // What the interview is doing between the person's turn and its answer, or
  // null where the answer is in and the turn is the person's again. Read from
  // the conversation rather than from the request in flight: the line landing
  // is what the person is waiting for, and it is what takes this away.
  //
  // Not gated on `running`: that is read from the snapshot and lags a turn
  // that has only just started the interview, which is exactly when the person
  // is first waiting. A stopped interview says so as a note, which ends this.
  // What the session is doing while it says nothing, or null where the next
  // word is the person's.
  //
  // Read from the session's own report of finishing a turn rather than from the
  // last line: a session that has just said something and gone quiet to read
  // the repository looks, from the lines alone, exactly like one that has
  // finished — and the pause that follows is the one that reads as something
  // having gone wrong (D-119).
  const working = useMemo(() => {
    // Until something is pushed, what the snapshot says: a dock opened part way
    // through a turn missed the change that said so.
    const busy = busyTurn === null ? (workspace.working ?? []).includes(id ?? "") : busyTurn;
    if (!busy) return null;
    const last = conversation.at(-1)?.line.kind;
    return last === "tool" ? "Working…" : "Thinking…";
  }, [busyTurn, workspace.working, id, conversation]);

  const dropped = (conversation[0]?.n ?? 1) - 1;
  return (
    <aside className="dock" aria-label="Interview" style={{ width }} ref={dockRef}>
      <div className="dock-head">
        <div className="dock-session">
          <span className={cx("prov-dot", models.draftingProvider === "codex-cli" && "prov-dot--codex")} />
          <strong>{models.draftingProvider === "codex-cli" ? "Codex" : "Claude"}</strong>
          <span className="mono">{models.executorModel}</span>
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
            Stop the interview
          </Button>
        </div>
      </div>
      <div className="chat" ref={chat} aria-label="Conversation" aria-live="polite">
        {dropped > 0 && (
          <p className="small muted">
            The first {dropped} {dropped === 1 ? "line" : "lines"} of this conversation are no
            longer kept here; the last {INTERVIEW_CONVERSATION_CAP} are. The session itself still
            has all of it.
          </p>
        )}
        {conversation.length === 0 && (
          <p className="small muted">
            Nothing yet. Ask a question, or say what this piece of work is for — the interview
            writes the spec from what you tell it, and drafts the plan from the spec.
          </p>
        )}
        {conversation.map((entry) => (
          <Line
            key={entry.n}
            entry={entry}
            onUndo={key !== null ? undo : null}
            undoable={undoable}
            busy={busy}
          />
        ))}
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
            busy={busy}
            height={asked}
            onSend={(answer) => sendText(answer)}
            onOwnWords={setTyping}
          />
        </>
      )}
      {failure !== null && <Notice tone="danger">{failure}</Notice>}
      {/* The card is the only way to answer while one is up, unless the person
          has said their answer is not on it. */}
      <div className="composer" hidden={asking !== null && !typing}>
        <div className="composer-box">
          <textarea
            aria-label="Message the interview"
            value={text}
            placeholder="Answer, or tell the interview something…"
            disabled={id === null}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
                return;
              event.preventDefault();
              sendTurn();
            }}
          />
          <div className="composer-row">
            <span className="small muted">↵ send · ⇧↵ new line</span>
            <span className="spacer" />
            <Button
              variant="primary"
              className="small"
              disabled={id === null || busy || text.trim().length === 0}
              onClick={sendTurn}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** One answer on offer: the session's own, or the one every part carries. */
type Choice = Extract<
  InterviewEntry["line"],
  { kind: "asked" }
>["groups"][number]["parts"][number]["options"][number];

/**
 * The answer every part carries whatever the session offered, as the decision
 * screen carries it: a person asked something they have no view on leaves it to
 * the session rather than picking one of its options to get past the question.
 * Added here rather than asked of the session, so it is always there.
 */
/**
 * What each of the interview's tools is called in the chat.
 *
 * The tool's own name is an argument in a protocol; what the person is
 * following is the work. A name not here is shown as it is, so a tool added
 * later reads as itself rather than as nothing.
 */
const TOOL_NAMES: Record<string, string> = {
  ask_options: "Questions",
  generate_plan: "Draft the plan",
  edit_plan: "Change the plan",
  undo_edit: "Undo a change",
  read_plan: "Read the plan",
};

const LEAVE_IT: Choice = {
  label: LEAVE_IT_TO_THE_INTERVIEW,
  detail: "Its own recommendation, or its judgement where it made none.",
  recommended: false,
};

/**
 * The answer that is none of the offered ones.
 *
 * Picking it is not an answer, it is asking for the box back: a person whose
 * answer is not on the card should not have to pick the nearest wrong one, and
 * a card that offers no way out is a form rather than a question.
 */
const SOMETHING_ELSE: Choice = {
  label: "Something else",
  detail: "Answer in your own words instead.",
  recommended: false,
};

/**
 * One group of questions, with the answers to pick from
 * (D-117).
 *
 * Its parts are read together and answered together: a part whose answer
 * depends on another's cannot be asked on its own, which is what a group is
 * for. Send is held until every part has an answer, because a half-answered
 * group asked again is worse than one not yet sent.
 *
 * What goes down is the options' own words. The session wrote them, the person
 * picked them, and what the host is given is a turn like any other — a picked
 * option never becomes a path, a command or an argument.
 */
function QuestionCard({
  group,
  number,
  of,
  busy,
  height,
  onSend,
  onOwnWords,
}: {
  group: Extract<InterviewEntry["line"], { kind: "asked" }>["groups"][number];
  number: number;
  of: number;
  busy: boolean;
  /** How tall the person has dragged it, from the shell's own record. */
  height: number;
  onSend: (answer: string) => void;
  /** Whether the person has asked for the box back on this group. */
  onOwnWords: (wanted: boolean) => void;
}) {
  const [picked, setPicked] = useState<Record<number, number>>({});
  // The session's recommendation first, because a person reading a list of
  // answers reads the top of it, and the one it would pick is the one most of
  // them want. Its own order is kept under that.
  const choicesOf = (part: (typeof group.parts)[number]): readonly Choice[] => [
    ...[...part.options].sort(
      (left, right) => Number(right.recommended) - Number(left.recommended),
    ),
    LEAVE_IT,
    SOMETHING_ELSE,
  ];
  // Whether the person has asked for the box back on any part of this group.
  const ownWords = group.parts.some(
    (part, index) => choicesOf(part)[picked[index] ?? -1]?.label === SOMETHING_ELSE.label,
  );
  useEffect(() => onOwnWords(ownWords), [ownWords, onOwnWords]);
  const answered = group.parts.every((_part, index) => picked[index] !== undefined);
  const send = (): void => {
    if (!answered || busy || ownWords) return;
    const chosen = group.parts.map((part, index) => choicesOf(part)[picked[index]!]!.label);
    // One part is the person's sentence whole; several are lettered as they
    // were read, so the answers arrive in the shape the question was put.
    onSend(
      chosen.length === 1
        ? chosen[0]!
        : chosen.map((label, index) => `${PART_LETTERS[index] ?? index + 1}) ${label}`).join("\n"),
    );
  };
  return (
    <div
      className="asked-card"
      role="group"
      aria-label={group.title ?? `Question ${number}`}
      style={{ height }}
    >
      <div className="asked-head">
        <b>{group.title ?? "The interview asks"}</b>
        {of > 1 && (
          <span className="small muted">
            {number} of {of}
          </span>
        )}
      </div>
      <div className="asked-body">
        {group.parts.map((part, index) => (
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
          {choicesOf(part).map((option, choice) => (
            <label className={cx("choice", picked[index] === choice && "selected")} key={choice}>
              <span className="choice-heading">
                <input
                  type="radio"
                  name={`asked-${number}-${index}`}
                  checked={picked[index] === choice}
                  disabled={busy}
                  onChange={() => setPicked((held) => ({ ...held, [index]: choice }))}
                />
                <strong>{option.label}</strong>
                {option.recommended && <span className="choice-recommended">recommended</span>}
              </span>
              {option.detail !== null && <p>{option.detail}</p>}
            </label>
          ))}
          </fieldset>
        ))}
      </div>
      <div className="asked-foot">
        <span className="small muted">
          {ownWords
            ? "Answer in the box below."
            : answered
              ? "Sent in the options' own words."
              : "Pick an answer to each."}
        </span>
        <span className="spacer" />
        {!ownWords && (
          <Button variant="primary" disabled={!answered || busy} onClick={send}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
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
        <span className="msg-who">the interview</span>
        {line.text}
      </div>
    );
  if (line.kind === "note") return <p className="msg msg--note">{line.text}</p>;
  // The questions are put one group at a time under the conversation, and they
  // are written out here as well. A person who says something of their own
  // takes the rest off the card — the session is about to answer what they
  // said — so what was asked has to stay somewhere they can still read it.
  if (line.kind === "asked") {
    const parts = line.groups.reduce((count, group) => count + group.parts.length, 0);
    return (
      <p className="msg msg--note asked-said">
        Asked {parts === 1 ? "one question" : `${parts} questions`}
        {line.groups.length > 1 && `, in ${line.groups.length} groups`}.
        <InfoHint
          label="The questions that were asked"
          text={line.groups
            .map((group, number) =>
              [
                group.title === null ? null : group.title,
                ...group.parts.map(
                  (part, index) =>
                    `${number + 1}${group.parts.length > 1 ? (PART_LETTERS[index] ?? index + 1) : ""}) ` +
                    `${part.question}\n   ${part.options.map((option) => option.label).join(" · ")}`,
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
        <p>{line.reason}</p>
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
 * What one of the interview's own tools did. An `edit_plan` or an `undo_edit`
 * carries the edit the plan's own record took from it, before and after, with
 * the undo D-100 allows on its number.
 */
function ToolCard({
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
  const keys = (entries: string[]): string => (entries.length > 0 ? entries.join(" · ") : "nothing");
  return (
    <div className={cx("tool-card", !line.ok && "tool-card--failed")}>
      <div className="tool-head">
        {/* What the tool is for, rather than what it is called: a person
            reading the chat is following the work, and `ask_options` is the
            name of a thing they never call. */}
        <b>{TOOL_NAMES[line.tool] ?? line.tool}</b>
        <span className="small muted">
          {line.ok
            ? "done"
            : line.tool === "edit_plan" || line.tool === "undo_edit"
              ? "refused by the edit path"
              : "refused"}
        </span>
        {/* What the tool said is read when it is asked for: the name and the
            word beside it are what the card is for, and the account underneath
            them was most of the dock. */}
        {line.ok && (
          <InfoHint text={line.detail} label={`What ${TOOL_NAMES[line.tool] ?? line.tool} did`} />
        )}
      </div>
      {/* What a tool did is read when it is asked for; why one was refused is
          read without asking, because it is the thing to act on. */}
      {!line.ok && <p className="tool-why">{line.detail}</p>}
      {edit !== null && (
        <>
          <div className="edit-title">
            Edit {edit.n} · {edit.summary}
          </div>
          <div className="ba">
            <span className="ba-label">before</span>
            <span>{keys(edit.before)}</span>
          </div>
          <div className="ba">
            <span className="ba-label">after</span>
            <span>{keys(edit.after)}</span>
          </div>
          {edit.undoes !== null && (
            <p className="small muted">It undid edit {edit.undoes}.</p>
          )}
          {onUndo !== null && undoable === edit.n && (
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
        </>
      )}
    </div>
  );
}
