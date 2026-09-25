import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, InfoHint, InkIcon, Notice } from "../ui/index.js";
import type { SpecField } from "@perbo/planning/browser";
import { specSymbolNames } from "@perbo/planning/browser";
import { bridge } from "../workspace/index.js";
import { useContractEditing } from "../contract-editor.js";
import { changeKey, textMarks } from "./change-marks.js";
import { SpecSection } from "./SpecSection.js";
import { useTurnSending } from "./InterviewDock.js";
import { INTERVIEW_WROTE_THE_SPEC } from "../../shared/protocol.js";
import type { Change, ExportedName, SpecSections, SpecView } from "../../shared/protocol.js";
import type { PageProps } from "../shell/route.js";
import { confirmLabel, confirmRoute, flowFor, planApproved } from "./panes.js";

const Composer = lazy(() =>
  import("../tasks/Composer.js").then((module) => ({ default: module.Composer })),
);

/**
 * The Spec pane (D-103): the spec this planning is for, kept in the repository
 * at `specs/<slug>/spec.md`, and the plan drafted from it.
 *
 * **The file is the spec.** A section is written to the repository when it is
 * left, and the pane reads the file back — so between one save and the next the
 * repository is what the spec says, and a spec edited outside the app is what
 * the pane shows the next time it opens. What the session keeps is the slug,
 * which is how it opens the same spec again (D-095).
 *
 * **This pane's save never overwrites what it did not read.** The person
 * here, the interview, and the Impact pane turning a warning into a No-Go all
 * write this file, but only this pane's save and the Impact pane's go through
 * the check: each says what it last read *and was shown* — while a refusal
 * is open that is what the refusal itself showed, not a later read landing
 * underneath it, so settling one section never resends against a base that
 * already carries a move the person never saw — the host compares that
 * against the file section by section, and a section both sides changed
 * comes back refused with the file's own text beside it rather than being
 * overwritten (SCP-321). Nothing is written at all while that is open: a
 * refused save is not half a save. The interview writes through its own
 * tools, not this check, so what happens when it writes over a section the
 * person changed after the interview last read it is the interview's own
 * behaviour.
 *
 * Under it, the contract steps this pane has always held. They are not an
 * alternative mode but the rest of the same page, because the choice is not a
 * setting a person makes once: it is which of the two they happen to have — a
 * spec, or a sentence and three criteria — and a mode switch would hide one of
 * them from somebody who had already started down the other.
 */

/** The five sections, in the order the spec writes them, with what each is for. */
const SECTIONS = [
  ["outcome", "Outcome", "One sentence: what is true when this is done."],
  ["requirements", "Requirements", "One per line. Each is given an id when it is saved."],
  ["no_gos", "No-Gos", "Behaviour deliberately left out. These reach the plan's approach."],
  ["rabbit_holes", "Rabbit holes", "Where the work could sink time."],
  ["notes", "Notes", "Anything else. Name code as @Symbol or by path."],
] as const satisfies readonly [keyof SpecSections, string, string][];

/** What each field is called where a refusal names it. */
const LABELS: Record<SpecField, string> = {
  title: "The title",
  outcome: "Outcome",
  requirements: "Requirements",
  no_gos: "No-Gos",
  rabbit_holes: "Rabbit holes",
  notes: "Notes",
};

const EMPTY: SpecSections = {
  outcome: "",
  requirements: "",
  no_gos: "",
  rabbit_holes: "",
  notes: "",
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function SpecPane({
  workspace,
  navigate,
  sessionId,
}: PageProps & { sessionId: string }) {
  const editor = useContractEditing({ kind: "session", id: sessionId }, workspace.settings);
  const client = useQueryClient();
  const [dialog, setDialog] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const spec = useQuery({
    queryKey: ["spec", sessionId],
    queryFn: () => bridge.request({ kind: "specRead", id: sessionId }),
    enabled: Boolean(editor.session),
  });
  const view: SpecView | undefined = spec.data;

  // Read again when the interview has been at the file.
  //
  // The interview writes this same spec, in its own process, so the file moves
  // without this pane asking for anything, and a pane that read it only when
  // it mounted would show a person watching the chat write their spec an
  // empty pane until they left for another and came back (D-102, D-103).
  //
  // On this planning's own turns, and on this repository's records moving:
  // between them they cover everything that writes this file that is not this
  // pane. A refused save holds its own two texts and is not disturbed — the
  // query is left alone while a conflict is open, which `conflict` guards
  // below.
  useEffect(
    () =>
      bridge.subscribe((change: Change) => {
        const mine =
          // Mid-turn as well as at its end: the spec is written partway
          // through a turn, and the rest of the turn can be minutes.
          (change.kind === "interview" && change.sessionId === sessionId) ||
          // And a write from anywhere else — the command line, a second
          // window, a planning discarded beside this one.
          (change.kind === "records" && (change.repoId === null || change.repoId === editor.repoId));
        if (!mine) return;
        void client.invalidateQueries({ queryKey: ["spec", sessionId] });
      }),
    [client, sessionId, editor.repoId],
  );

  // The names `@Symbol` completes from, built by the host running `perbo index`
  // over the registered repository (D-015). Nothing the renderer holds names a
  // file or a symbol; this asks for a repository and gets back a list.
  const index = useQuery({
    queryKey: ["symbolIndex", editor.repoId],
    queryFn: () => bridge.request({ kind: "symbolIndex", repoId: editor.repoId }),
    enabled: Boolean(editor.repoId),
    // Building it reads every tracked TypeScript file, and the answer carries
    // the commit it was read at, so a person can see for themselves how old it
    // is. Leaving and coming back to the pane is not a reason to read the tree
    // again; the index going stale under a spec is SCP-315's question.
    staleTime: 5 * 60_000,
  });
  const indexed = index.data?.supported === true ? index.data : null;
  const symbols: ExportedName[] | null = indexed?.names ?? null;

  // What the person has typed and not yet committed. The file is what the pane
  // renders from; this is only the section being edited right now.
  const [title, setTitle] = useState<string | null>(null);
  const [edited, setEdited] = useState<Partial<SpecSections>>({});
  const seen = useRef<string | null>(null);
  // The sections a save came back refused on, and so the sections whose two
  // texts are both on screen waiting to be settled. Null when there are none.
  const [conflict, setConflict] = useState<SpecField[] | null>(null);
  // The view a refusal came back with: what the person actually read and is
  // choosing against. `view` itself keeps moving under a refetch, so while a
  // refusal is open this, not `view`, is the file's side of the card and
  // what the next attempt is read against — a further move comes back
  // refused in its turn rather than being read as if this writer had seen
  // it. Replaced by each further refusal's reply, and cleared wherever an
  // attempt ends without one: a save that goes through, one that errors, and
  // a resend that finds nothing left to send — anything else leaves the next
  // save read against a base the person can no longer see.
  const refused = useRef<SpecView | null>(null);
  // The title a file's title line gives the field: none while it is still the
  // cut the host named the folder from (D-118), which is no title, and no
  // plan has been drafted. The field is then empty, for the person to name
  // the work or for the Architect's title to fill once it replaces the cut in
  // the file; once a plan is drafted the title line is the ticket's name
  // (D-127), whatever its words.
  const cut = editor.session?.key == null ? editor.session?.specCut : null;
  const titleIn = (source: SpecView | null | undefined): string =>
    !source || source.title === cut ? "" : source.title;

  // One save at a time. Two in flight would each read the file without the
  // other's ids and number the same requirements twice; a section left while a
  // save is out waits for it and goes with the file that comes back.
  const inFlight = useRef(false);
  const queued = useRef(false);
  const send = (input: { title: string; sections: SpecSections; base: SpecView }) =>
    bridge.request({
      kind: "specSave",
      id: sessionId,
      repoId: editor.repoId,
      title: input.title,
      sections: input.sections,
      // What this save is against: the file as the pane last read it, so the
      // host can tell a section this writer changed from one somebody else did.
      base: { title: input.base.title, sections: input.base.sections },
    });
  const save = useMutation({
    mutationFn: send,
    onSuccess: (reply, sent) => {
      setFailure(null);
      // The file is what the pane shows, refused or not: after a refusal it is
      // the other writer's text, which is the half of the conflict the person
      // does not already have on screen.
      seen.current = JSON.stringify([reply.view.title, reply.view.sections]);
      client.setQueryData(["spec", sessionId], reply.view);
      if (reply.conflicting.length > 0) {
        // Nothing was written, so nothing typed is dropped: what was sent stays
        // where it is and the person settles each section named. What this
        // reply read is held so the next attempt is read against it, not
        // against whatever the query has fetched by then.
        refused.current = reply.view;
        setConflict(reply.conflicting);
        return;
      }
      refused.current = null;
      setConflict(null);
      // What was sent is now what the file says, so it is shown from the file;
      // a section changed since then is kept as typed.
      setTitle((current) => (current === sent.title ? null : current));
      setEdited((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([field, value]) => value !== sent.sections[field as keyof SpecSections],
          ),
        ),
      );
    },
    onError: (error: unknown) => {
      // An error while a conflict card is open is not the resend settling
      // it — Generate and Start over can reach the mutation directly, past
      // commit()'s own guard, while a card is still up — so the held view
      // stays until the card itself is settled or dismissed. Elsewhere,
      // this attempt is over without a refusal, and nothing is held
      // against it.
      if (conflict === null) refused.current = null;
      setFailure(message(error));
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  useEffect(() => {
    if (view === undefined) return;
    // A read of the file replaces what is shown, including a section somebody
    // else changed — except while a refused save is open. Its card holds two
    // texts a person is choosing between: the file's, in `refused`, and
    // their own, in `title` and `edited`. A further change to the file must
    // not pick one of those for them, so both stay until they settle it.
    if (conflict !== null) return;
    // `view` and not `conflict`: settling the last refused section clears
    // `conflict` and queues a save in the same render, and that save has to
    // read `title` and `edited` before anything clears them. Watching
    // `conflict` too would rerun this the instant it goes null — ahead of
    // the queued save reading that state — and clear what was just chosen.
    const stamp = JSON.stringify([view.title, view.sections]);
    if (seen.current === stamp) return;
    const first = seen.current === null;
    seen.current = stamp;
    // The fields are there before the first read lands. What was typed into
    // one the file leaves empty stands, since there is nothing of the file's
    // under it; what was typed over one the file fills goes, because the pane
    // never showed that text and saving against it would replace it unseen.
    if (first) {
      if (titleIn(view) !== "") setTitle(null);
      setEdited((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([field]) => view.sections[field as keyof SpecSections] === "",
          ),
        ),
      );
      return;
    }
    setTitle(null);
    setEdited({});
    setConflict(null);
  }, [view]);

  const sections: SpecSections = { ...(view?.sections ?? EMPTY), ...edited };
  const shownTitle = title ?? titleIn(view);
  // The last change to the spec, as marks placed in each section's after-text
  // (D-128). Diffed once per change
  // rather than per render or per session read: a keystroke in one section
  // re-renders the others, a re-read hands over a fresh object for the same
  // change, and a diff of a long section is not free. Shown on a section only
  // while its text is the change's after-text — typed into since, the marks
  // would fall on the wrong characters, and the save that follows is a change
  // of its own.
  const change = editor.session?.change?.spec ?? null;
  const changed = changeKey(editor.session?.change ?? null);
  const marks = useMemo(
    () =>
      change === null
        ? null
        : Object.fromEntries(
            SECTIONS.map(([field]) => [field, textMarks(change.before[field], change.after[field])]),
          ),
    [changed],
  );
  /**
   * The save the shown text calls for, or null where the file already says it.
   *
   * `over` is a section just changed by something other than typing — a
   * completion accepted, a name replaced — whose new text is not in state yet.
   */
  const pending = (
    over: Partial<SpecSections> = {},
  ): { title: string; sections: SpecSections; base: SpecView } | null => {
    if (view === undefined) return null;
    // Against the view a refusal came back with while one is open, not the
    // live query: the file may have moved again since, and that move has to
    // come back refused in its turn rather than be read as if this writer
    // had already seen it.
    // A title the person has not typed, or has typed blank, is the file's,
    // the cut included: a save of a section leaves the title line as it is
    // rather than being held back for want of one.
    const wanted = { title: title?.trim() ? title : view.title, sections: { ...sections, ...over }, base: refused.current ?? view };
    if (wanted.title.trim().length === 0) return null;
    if (
      wanted.title === view.title &&
      JSON.stringify(wanted.sections) === JSON.stringify(view.sections)
    )
      return null;
    return wanted;
  };
  // The latest render's `pending`, for a draft that is already under way and
  // asks again after each save it awaits.
  const latest = useRef(pending);
  latest.current = pending;
  const starting = useRef(false);
  const commit = (over?: Partial<SpecSections>): void => {
    // Both texts are on screen and neither has been chosen: writing now would
    // pick one of them without being asked, which is the whole thing this is
    // here to prevent.
    if (conflict !== null) return;
    if (inFlight.current || starting.current) {
      queued.current = true;
      return;
    }
    const wanted = pending(over);
    if (wanted === null) {
      // Nothing left to send, so this attempt is over without a refusal —
      // the same clearing `onError` above does, for the same reason.
      refused.current = null;
      return;
    }
    inFlight.current = true;
    save.mutate(wanted);
  };
  useEffect(() => {
    if (save.isPending || starting.current || !queued.current) return;
    queued.current = false;
    commit();
  });
  // What is typed and not yet saved goes to the file as the pane goes away:
  // leaving planning from inside a field, by a shortcut, never blurs it, and a
  // title typed there is a planning somebody put something into
  // (D-129). Sent straight over the bridge rather
  // than through the mutation, which reaches its request only after a
  // microtask: this way it is ahead of the leave's own read of the planning,
  // which App sends in the same commit. Nothing is sent over an open conflict,
  // or beside a save already out, which is ahead of that read in its turn.
  const leftUnsaved = useRef<() => void>(() => undefined);
  leftUnsaved.current = () => {
    if (conflict !== null || inFlight.current || starting.current) return;
    const wanted = pending();
    if (wanted !== null) void send(wanted).catch(() => undefined);
  };
  useEffect(() => () => leftUnsaved.current(), []);

  /** One refused section settled, with the text the person chose for it. */
  const settle = (field: SpecField, text: string): void => {
    if (field === "title") setTitle(text);
    else setEdited((current) => ({ ...current, [field]: text }));
    setConflict((current) => {
      const left = (current ?? []).filter((each) => each !== field);
      // The last one settled, so the save that was refused goes again — with
      // the file it came back with as what it is now against.
      if (left.length === 0) queued.current = true;
      return left.length === 0 ? null : left;
    });
  };
  const mine = (field: SpecField): string =>
    field === "title" ? shownTitle : sections[field];
  // The file's side of the card: what a refusal read, while one is open —
  // the same view the next attempt is read against — falling back to the
  // live read the rest of the time, when there is nothing refused to show.
  const theirs = (field: SpecField): string => {
    const source = refused.current ?? view;
    return field === "title" ? (source?.title ?? "") : (source?.sections[field] ?? "");
  };

  const key = editor.session?.key ?? null;
  const written = Boolean(view?.slug);
  // Whether the interview drafted what is on this pane, which changes what the
  // button beside it has to say: a spec the person wrote themselves needs no
  // invitation to read it. Taken from the chat's own note rather than guessed
  // at, so the two surfaces say the same thing about the same moment (D-102).
  const drafted = (editor.session?.conversation ?? []).some(
    (entry) => entry.line.kind === "note" && entry.line.text === INTERVIEW_WROTE_THE_SPEC,
  );
  const busy =
    editor.submitting !== null || editor.session?.phase === "working" || save.isPending;
  // A group of questions still in front of the person. Drafting over one turns
  // the spec into a plan while the thing that would have changed it is still
  // being asked — the answers land in a spec the contract was already drafted
  // from.
  const asked = editor.session?.asking ?? null;
  // A turn the chat is still taking, from the moment the person sends it —
  // over the bridge, before the host has said it is under way — to the
  // moment the host says it is over. The press waits for it: whatever the
  // person last asked the chat for reaches the spec before the drafter reads
  // it (D-102).
  const midTurn = useTurnSending(sessionId) || (workspace.working ?? []).includes(sessionId);
  // The drafter reads the file, so the press is offered once a title and an
  // outcome are in it: `parseSpec` refuses a spec without either.
  const stated = Boolean(view?.slug) && (view?.sections.outcome.trim().length ?? 0) > 0;
  // Why a plan cannot be drafted from this stated spec yet, or null where it
  // can. One sentence, read under this pane's own button, which is held while
  // it says anything: this is the one press that turns a spec into a plan
  // (D-102), so a person who cannot make it reads why before they reach for it
  // rather than after.
  const notReady =
    asked !== null
      ? "Answer the chat's questions first — its answers change the spec this drafts from."
      : midTurn
        ? "The chat is still talking. Generate plan is yours once it has finished this turn."
        : null;
  const ready = stated && notReady === null;
  // What the drafter refused the last press with, said where the press was
  // made: the job runs on the working screen, and the pane it hands back to is
  // the only place a person looks for why no plan came of it.
  const operation = editor.session?.operation ?? null;
  const refusedDraft =
    operation?.state === "failed" && (operation.intent === "generate" || operation.intent === "startOver")
      ? (editor.session?.error ?? null)
      : null;
  // What is shown reaches the file before the drafter reads it: every save
  // the text calls for is awaited, including one a section left meanwhile
  // asks for, and a save that fails or is refused leaves the draft unsent.
  const start = async (intent: "generate" | "startOver"): Promise<void> => {
    setFailure(null);
    starting.current = true;
    inFlight.current = true;
    try {
      let sent: string | null = null;
      for (let wanted = pending(); wanted !== null; wanted = latest.current()) {
        // The same text again is the file already: nothing more to send.
        const stamp = JSON.stringify(wanted);
        if (stamp === sent) break;
        sent = stamp;
        inFlight.current = true;
        const reply = await save.mutateAsync(wanted);
        // Refused: the spec on disk is not what is on screen, and drafting from
        // it would draft from somebody else's half of it.
        if (reply.conflicting.length > 0) return;
        // A render between saves, so what is asked next is what is shown now.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } catch {
      return;
    } finally {
      // A section left after the last save was asked for is still queued,
      // and goes with the next save once the draft is under way.
      starting.current = false;
      inFlight.current = false;
    }
    // Where the plan lands once it is drafted, first or again, is planning
    // mode's to say (D-NEW-basic-and-epic-flows).
    editor.submit(intent);
  };

  // While a command runs the Composer takes the pane, as it does for the
  // contract steps: one thing is happening and it says what. It is the same
  // element either way and is never unmounted, because it is what lands on the
  // drafted contract when the job settles.
  const working = editor.submitting !== null || editor.session?.phase === "working";

  // Every name the spec refers to that the index does not hold, counted over
  // the whole document because the head speaks for the whole document.
  const missing =
    symbols === null
      ? []
      : (() => {
          const known = new Set(symbols.map((each) => each.name));
          return specSymbolNames(SECTIONS.map(([field]) => sections[field]).join("\n")).filter(
            (name) => !known.has(name),
          );
        })();

  return (
    <section className="screen spec-screen">
      {!working && (
        <>
          <div className="pane-head">
            <h2>Spec</h2>
            {/* The two ways to a plan, said once and in passing: a heading over
                the contract steps made a second way look like a second place
                to be, when it is the same page further down. */}
            <span className="sub mono">{view?.path ?? "specs/…/spec.md"}</span>
            <span className="spacer" />
            <span role="status" className="small muted">
              {save.isPending ? "Saving…" : written ? "Saved" : "not written yet"}
            </span>
            {/* Only what a person can act on. That every `@name` resolves is
                the absence of the warning below it, and that a repository with
                no TypeScript has nothing to check is not news twice — it was
                said here and again in the line under it. What is left of the
                index is for somebody who went looking, so it is behind the
                dot. */}
            {missing.length > 0 && (
              <span className="small spec-missing">
                {missing.length} {missing.length === 1 ? "name is not" : "names are not"} in the
                index
              </span>
            )}
            {index.isError ? (
              <span className="small muted">the index could not be read</span>
            ) : index.data === undefined ? (
              <span className="small muted">reading the index…</span>
            ) : (
              <>
                {/* Nothing checked is not the same as everything resolved, and
                    a blank head cannot tell them apart. Said once, here. */}
                {!index.data.supported && <span className="small muted">no names to check here</span>}
                <InfoHint
                  label="About the symbol index"
                  text={
                    index.data.supported
                      ? `${index.data.names.length} exported TypeScript symbols, read at ` +
                        `${index.data.headCommit.slice(0, 7)}` +
                        (index.data.workingTree === "clean" ? "." : " with uncommitted changes.")
                      : `No @name is checked here: ${index.data.reason}`
                  }
                />
              </>
            )}
          </div>
          {failure !== null && <Notice tone="danger">{failure}</Notice>}
          {refusedDraft !== null && <Notice tone="danger">{refusedDraft}</Notice>}
          {conflict !== null && (
            <Notice tone="warning">
              <p>
                <strong>Nothing was saved.</strong> {listOf(conflict.map((field) => LABELS[field]))}{" "}
                {conflict.length === 1 ? "was" : "were"} written in the file since this pane read it
                — by the chat, or in another window. Both texts are here: settle each one and
                the save goes again. Nothing else in the spec is written until you do.
              </p>
              <ul className="spec-conflicts">
                {conflict.map((field) => (
                  <li key={field}>
                    <h4>{LABELS[field]}</h4>
                    <div className="spec-conflict-sides">
                      <div>
                        <span className="small muted">in the file</span>
                        <pre>{theirs(field) || "— nothing —"}</pre>
                      </div>
                      <div>
                        <span className="small muted">yours</span>
                        <pre>{mine(field) || "— nothing —"}</pre>
                      </div>
                    </div>
                    <div className="spec-conflict-actions">
                      {field !== "title" && (
                        <Button
                          onClick={() =>
                            settle(field, [theirs(field), mine(field)].filter(Boolean).join("\n"))
                          }
                        >
                          Keep both
                        </Button>
                      )}
                      <Button onClick={() => settle(field, mine(field))}>Keep yours</Button>
                      <Button onClick={() => settle(field, theirs(field))}>Use the file's</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="spec-doc">
            <p className="small muted">
              The spec is a document in the repository, committed with the change. Write it here, and
              the plan is drafted from it. Type @ to name code: the completion comes from the
              repository's exported TypeScript symbols.
            </p>
            <label className="spec-title-label" htmlFor="spec-title">
              Spec title
            </label>
            <input
              id="spec-title"
              className="spec-title"
              placeholder="What is this piece of work?"
              value={shownTitle}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => commit()}
            />
            {SECTIONS.map(([field, name, hint]) => (
              <SpecSection
                key={field}
                field={field}
                name={name}
                hint={hint}
                value={sections[field]}
                symbols={symbols}
                nodes={
                  field === "requirements"
                    ? new Map(
                        (view?.requirements ?? []).flatMap((requirement) =>
                          requirement.id === null ? [] : [[requirement.id, requirement.nodes]],
                        ),
                      )
                    : undefined
                }
                marks={
                  change !== null && marks !== null && sections[field] === change.after[field]
                    ? (marks[field] ?? null)
                    : null
                }
                onChange={(value) => setEdited((current) => ({ ...current, [field]: value }))}
                onCommit={(text) => commit(text === undefined ? undefined : { [field]: text })}
              >
              </SpecSection>
            ))}
          </div>
          {(key !== null || stated) && (
            <div className="spec-generate">
              {key === null ? (
                <>
                  <Button variant="primary" disabled={!ready || busy} onClick={() => void start("generate")}>
                    Generate plan
                  </Button>
                  <span className="small muted">
                    {notReady ??
                      (drafted
                        ? "The chat has drafted the spec: read it and change what you want first. Press once, and the drafter turns it into a contract and an execution graph."
                        : "Press once. The drafter turns the spec into a contract and an execution graph.")}
                  </span>
                </>
              ) : (
                <>
                  {/* One button, whatever the spec has done. What the chat
                      changes it is held to writing here in the same turn
                      (D-128), so nothing
                      it did needs reporting. A person's own edit is not held to
                      it, so the way to the contract reads the plan against this
                      spec first, as every way there does. And it waits for a
                      turn in flight, as the Graph's way onward does: a reading
                      made mid-turn is of half a plan, and the turn's own end
                      is what carries the verdict forward. */}
                  <Button
                    disabled={midTurn}
                    onClick={() =>
                      navigate(
                        confirmRoute({
                          repoId: editor.repoId,
                          key,
                          sessionId,
                          approved: planApproved(workspace, editor.repoId, key),
                        }),
                      )
                    }
                  >
                    {flowFor(workspace, sessionId).shape === "basic" ? confirmLabel("basic") : "Open the plan"}
                  </Button>
                  <button
                    className="text-button small"
                    disabled={busy}
                    onClick={() => setDialog(true)}
                  >
                    Start over from the spec…
                  </button>
                  <span className="small muted">
                    {midTurn
                      ? "Waiting for the chat to finish this turn…"
                      : "After the first draft the plan changes by editing it. Starting over drafts it again."}
                  </span>
                </>
              )}
            </div>
          )}
        </>
      )}
      {/* The composer stays mounted whatever is on screen — it is what lands
          on the drafted contract when the job settles — but its own steps are
          not a second way to plan offered beside the first. A spec written
          with the interview is how a plan is made here; the steps are what a
          command running takes the pane with. */}
      <div className={working ? "spec-working" : "spec-typed spec-typed--away"}>
        <Suspense fallback={<div className="launch"><InkIcon name="dots" /><p>Opening…</p></div>}>
          <Composer
            workspace={workspace}
            navigate={navigate}
            target={{ kind: "session", id: sessionId }}
            // This one is here for the working screen, not for its own sake.
            // Planning mode decides where a drafted plan lands — it has a pane
            // for one — so this must not walk off to the ticket the moment the
            // job settles.
            plan
          />
        </Suspense>
      </div>
      {dialog && key !== null && (
        <Dialog title="Start over from the spec?" onClose={() => setDialog(false)}>
          <p>
            The drafter drafts a new contract and graph from <code>{view?.path}</code>, on the same
            task. The edits made to the plan since the last draft are dropped and stay in its
            history, marked replaced; the spec and its No-Gos are in the file, so they stay as they
            are.
          </p>
          <div className="dialog-actions">
            <Button autoFocus onClick={() => setDialog(false)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setDialog(false);
                void start("startOver");
              }}
            >
              Start over
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** "Outcome", "Outcome and Notes", "Outcome, Notes and the title". */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}
