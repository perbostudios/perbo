import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { InterviewTurnSchema, encodeInterviewTurn, planNodes } from "@perbo/contracts";
import { redact } from "../process.js";
import { readLatestDraftEdit } from "../records.js";
import { ticketPath } from "../repository/layout.js";
import { mintSpecFromTitle, specPath, specTitles } from "../plan/spec.js";
import { specTitleFromMessage } from "@perbo/planning";
import {
  INTERVIEW_NEEDS_A_TITLE,
  INTERVIEW_WROTE_THE_SPEC,
  TaskModelsSchema,
} from "../../shared/protocol.js";
import { interviewModelFor, type PromisePair } from "../../shared/contract-editing.js";
import { interviewArgv, interviewProvider } from "./argv.js";
import { relayed } from "./relay.js";
import type { Cli } from "../cli.js";
import type { Changes } from "../changes.js";
import type { ContractEditing } from "../../shared/contract-editing.js";
import type { ChangeMarks } from "../plan/marks.js";
import type { ModelCatalogs } from "../providers/catalogs.js";
import type { LineProcess } from "../process.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { TicketReads } from "../tickets/reads.js";
import type {
  Detail,
  EditingSession,
  InterviewDoing,
  InterviewEdit,
  InterviewEntry,
  InterviewStatus,
  TaskModels,
} from "../../shared/protocol.js";

/**
 * How long after a write is admitted the spec's bytes are read.
 *
 * The session announces the write and the file lands as the call returns, so
 * the reading waits out that gap. A pause nobody notices, next to the rest of
 * the turn.
 */
const SPEC_SETTLES_IN_MS = 300;

export interface InterviewDeps {
  editing: Pick<
    ContractEditing,
    | "read"
    | "converse"
    | "recordInterview"
    | "recordSpec"
    | "architectTitled"
    | "beginAsking"
    | "answerAsking"
    | "countNodes"
    | "adopt"
  >;
  repository(id: string): RegisteredRepository;
  tickets: Pick<TicketReads, "contract">;
  /** The plan as the contract page reads it, so a pane drawing from the session draws what was written. */
  detail(repoId: string, key: string): Promise<Detail>;
  cli: Pick<Cli, "spawn">;
  changes: Pick<Changes, "changed">;
  marks: Pick<ChangeMarks, "pairOf" | "recordChangeSince">;
  catalogs: Pick<ModelCatalogs, "known">;
  /** Every planning this host keeps, live or not. */
  sessions(): readonly EditingSession[];
  /** The one ticket in plan_review drafted from this spec, where there is one to be sure of. */
  draftedFrom(repo: RegisteredRepository, slug: string): Promise<string | null>;
  /** The plan read against its spec again, as a turn over a planning with problems ends. */
  reread(id: string): void;
  /**
   * The gap between a spec write being admitted and the bytes being read
   * ({@link SPEC_SETTLES_IN_MS}); injected by tests, which need that reading to
   * fall provably before or provably after the ending they are asserting
   * about, since the two say the same thing and only the first of them speaks.
   */
  specSettleMs?: number | undefined;
}

/**
 * The interview beside each planning session, by that session's id (D-102).
 *
 * One at a time per session, and any number across sessions: the interview is
 * planning-lane work, so it is never in a run's way and a run is never in its.
 * It outlives the pane it was started from, as drafting outlives the screen
 * that asked for it (D-095), and goes when it is stopped, when its planning is
 * discarded, or when the app closes.
 */
export class InterviewHost {
  private readonly deps: InterviewDeps;
  private readonly live = new Map<
    string,
    { repoId: string; child: LineProcess; model: string; exited: Promise<void> }
  >();
  /**
   * The chats asked to start and not spawned yet, while the model they run on
   * is read from the catalog. A stop or a discard in that gap is owed to a chat
   * that is not in {@link live} yet, and reaches it here: `stopped` is set by a
   * stop, and the start then spawns nothing.
   */
  private readonly starting = new Map<
    string,
    { stopped: boolean; settled: Promise<InterviewStatus> }
  >();
  /**
   * The plannings whose interview is working on what it will say next (D-119).
   *
   * Held here rather than on the record: it is about a process running now, and
   * a session reopened is a session that has said everything it was going to.
   *
   * Counted rather than flagged, because turns can be in flight together: a
   * person who sends a second before the first is answered is owed two, and the
   * first answer arriving does not mean the session has stopped working.
   */
  private readonly owed = new Map<string, number>();
  /**
   * What each planning's turn in flight is doing that its conversation does
   * not show yet: writing the spec, or holding a line of the session's to say.
   * Cleared by the next line the turn puts in the conversation, and as the
   * turn ends.
   */
  private readonly doing = new Map<string, InterviewDoing>();
  /**
   * The first thing a session says in a turn, held until the turn shows what it
   * was.
   *
   * "I'll look at what's here first" and "Yes — the second node is the
   * migration" arrive the same way, and which one it is is only decided by what
   * comes after: a line followed by tools, questions or refusals was the
   * session announcing itself, and the dock's own indicator says that better
   * because it keeps saying it for as long as the wait lasts. A line with
   * nothing after it is the answer to what was asked, and dropping it would
   * lose the turn (D-102).
   *
   * So it waits. Held here rather than written, released at the end of the turn
   * if it was the whole of it, and dropped the moment the session does
   * something — which is what {@link wentToWork} is for.
   *
   * The prompt asks for the same restraint, and a prompt is not a guarantee.
   */
  private readonly heldSaid = new Map<string, string>();
  /**
   * The turns past their opening, where every line is said as it arrives.
   *
   * Only the opening line is ever in question. Once a turn has done something,
   * or has said two things in a row, what it says next is the work it is
   * reporting: a session two tools deep that says "node 2 is the cutover" is
   * answering, and holding that would lose the middle of every turn.
   */
  private readonly opened = new Set<string>();
  /**
   * The spec as it stood when this turn was sent, by the digest of its bytes,
   * and whether the turn has changed the plan.
   *
   * A turn through the chat may move both: a person who asks for a criterion to
   * change is asking for the spec to say something else and the plan to do it,
   * and the interview writes both (D-103). The spec is on another pane, so a
   * person watching the chat never sees the second half happen. These two are
   * what the turn is measured against to tell them.
   *
   * Keyed by session and replaced at every turn, so nothing accumulates: a
   * session that has gone leaves at most one entry, dropped when the interview
   * closes.
   */
  private readonly specAtTurn = new Map<string, string | null>();
  private readonly planMovedThisTurn = new Set<string>();
  /**
   * The title the spec stated when the turn began, so a turn that leaves it
   * stating another is recorded as the Architect titling it (D-127). Moved on
   * to the title each ending read, so the ending a closing session reports
   * after a stop measures only what came after the stop; dropped when the
   * interview closes.
   */
  private readonly titleAtTurn = new Map<string, string | null>();
  /**
   * The pair as it stood when the turn began, keyed by planning, so the turn can
   * be measured once it is over; null where it could not be read then, and the
   * turn is not measured. Replaced at every first turn owed and dropped when the
   * turn ends or the interview goes, so nothing accumulates.
   */
  private readonly pairAtTurn = new Map<string, PromisePair | null>();
  /**
   * The sessions that have already been handed the written spec this turn.
   *
   * Two things say it — the reading taken shortly after a write, and the turn's
   * endings — and the person needs it once. Cleared wherever a turn ends, so the
   * next turn that moves the spec says it again.
   */
  private readonly saidDrafted = new Set<string>();
  /**
   * The sessions whose written spec has been handed over since the person last
   * said anything. What the session says from there to the turn's end is not
   * shown: the note is what the turn says (D-102). A turn the person sends
   * meanwhile is answered as any turn is.
   */
  private readonly afterTheNote = new Set<string>();
  /**
   * The reading owed after an admitted write, per session.
   *
   * One at a time: a turn that writes the file and then edits it again admits
   * two writes, and the first reading already finds bytes that moved. Cleared
   * wherever a turn ends, so nothing fires into a session that has stopped.
   */
  private readonly specChecks = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * What the session said while the reading after a write was owed, on a
   * planning with no plan: dropped if that reading hands the spec over, since
   * the note is then what the turn says, and said if it does not.
   */
  private readonly heldForNote = new Map<string, string[]>();

  constructor(deps: InterviewDeps) {
    this.deps = deps;
  }

  /** The planning sessions whose interview is still there, or on its way. */
  running(): string[] {
    return [...new Set([...this.live.keys(), ...this.starting.keys()])];
  }

  /** The planning sessions whose interview owes the person a turn (D-119). */
  working(): string[] {
    return [...this.owed.entries()].flatMap(([id, owed]) => (owed > 0 ? [id] : []));
  }

  /** Whether this planning's interview owes the person a turn. */
  isWorking(id: string): boolean {
    return (this.owed.get(id) ?? 0) > 0;
  }

  status(id: string): InterviewStatus {
    const session = this.deps.editing.read(id);
    return {
      id,
      running: this.live.has(id),
      interview: session.interviewSession,
      conversation: session.conversation,
    };
  }

  /**
   * Start the interview beside this planning, or answer with the one already
   * running: one session, one interview.
   */
  async start(id: string, repoId?: string): Promise<InterviewStatus> {
    const asked = this.deps.editing.read(id);
    if (repoId !== undefined && asked.repoId !== repoId)
      throw new Error("This planning belongs to another repository.");
    if (this.live.has(id)) return this.status(id);
    // Asked twice while the catalog was read, it starts once.
    const already = this.starting.get(id);
    if (already) return already.settled;
    const stop = { stopped: false };
    const pending = Object.assign(stop, { settled: this.launch(id, asked, stop) });
    this.starting.set(id, pending);
    try {
      return await pending.settled;
    } finally {
      if (this.starting.get(id) === pending) this.starting.delete(id);
    }
  }

  /**
   * Spawn the chat {@link start} was asked for, once its model is read, unless
   * it was stopped or its planning thrown away meanwhile: a chat spawned then
   * is one nothing will stop, over a spec a delete is removing.
   */
  private async launch(
    id: string,
    asked: EditingSession,
    pending: { stopped: boolean },
  ): Promise<InterviewStatus> {
    const model = await this.chatModel(TaskModelsSchema.strip().parse(asked.form.models));
    const session = this.deps.editing.read(id);
    if (pending.stopped || session.phase === "discarded") return this.status(id);
    const repo = this.deps.repository(session.repoId);
    const args = interviewArgv(repo, session, model);
    let stderr = "";
    let gone: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      gone = resolve;
    });
    const child = this.deps.cli.spawn(args, repo, {
      onLine: (line) => this.relay(id, line),
      // What the chat shows comes off the events; stderr is the same refusals
      // in prose, and is kept only to say why a session that never started did
      // not start.
      onStderr: (text) => {
        stderr = (stderr + text).slice(-4000);
      },
      // The child itself has gone while something it started still holds its
      // output, so `onClose` may never come: whatever waits for the child to
      // exit before it reads or deletes the spec stops waiting here.
      onExit: () => gone(),
      onClose: ({ code, stopped }) => {
        this.live.delete(id);
        gone();
        // Whatever the session owed the person, it is not going to say it now:
        // a dock still reporting work on a child that has gone is the reading
        // the indicator exists to prevent.
        this.owed.delete(id);
        // And a turn that will now never end is over, said before the ending: a
        // line it already said was the whole of what it had to say, and what it
        // moved is still on disk to be read — a spec the session wrote before it
        // went is written, and the way on from it is the person's whether the
        // session is still there or not.
        this.endTurn(id);
        this.titleAtTurn.delete(id);
        this.deps.reread(id);
        this.say(
          id,
          code === 0 || stopped
            ? null
            : {
                kind: "note",
                text: `The chat stopped with code ${String(code)}.${
                  stderr.trim() ? ` ${stderr.trim()}` : ""
                }`,
              },
        );
      },
      onError: (error) => {
        this.live.delete(id);
        gone();
        this.owed.delete(id);
        this.titleAtTurn.delete(id);
        this.say(id, { kind: "note", text: redact(error.message).slice(0, 12_000) });
      },
    });
    this.live.set(id, { repoId: repo.id, child, model, exited });
    // Nothing is said yet: the interview's own `started` event is what says it
    // is there, and until then the only honest word is that it is starting,
    // which is what `running` on this change carries.
    this.say(id, null);
    return this.status(id);
  }

  /**
   * The person's turn, down the interview's stdin as a `turn` line, after the
   * interview has been started where it is not running: leaving planning mode
   * leaves it running, and a restart starts it again with `--session`, which
   * continues the same conversation (D-102).
   *
   * Validated before it is written, and recorded only once it has been: a turn
   * nothing heard is not part of the conversation.
   */
  async turn(id: string, text: string): Promise<InterviewStatus> {
    const turn = InterviewTurnSchema.parse({ type: "turn", text });
    if (!this.live.has(id)) {
      this.nameSpecFromTurn(id, turn.text);
      await this.start(id);
    }
    const live = this.live.get(id);
    if (!live)
      throw new Error(
        "The chat is not listening. Start it again, then send this once it is running.",
      );
    // What the spec and the plan say now, to measure this turn against once it
    // is over. Read before the turn goes down the pipe: the session may move
    // either the moment it has the turn, and a reading made after the write
    // would find the turn's own work already there and call it nothing.
    //
    // Only where this is the turn: `owed` is a counter because a person can send
    // again while the session is still answering, and a second turn that reset
    // these would measure the first one's change against a spec it had already
    // moved, and forget the edit it had already made. A queued second turn is
    // measured with the first, as one change: what the person sees is the two
    // turns' work together.
    const owed = (this.owed.get(id) ?? 0) + 1;
    const specBefore = owed === 1 ? this.specDigest(id) : null;
    const titleBefore = owed === 1 ? this.specTitle(id) : null;
    const pairBefore = owed === 1 ? this.deps.marks.pairOf(id, live.repoId) : null;
    if (!live.child.write(encodeInterviewTurn(turn)))
      throw new Error(
        "The chat is not listening. Start it again, then send this once it is running.",
      );
    // The turn is with the session now: it is working until it says otherwise,
    // so the dock can say so through a pause that would otherwise read as
    // something having gone wrong. A turn nothing heard leaves no reading behind
    // it, so the readings are kept only once the turn has gone.
    this.owed.set(id, owed);
    this.afterTheNote.delete(id);
    if (owed === 1) {
      this.specAtTurn.set(id, specBefore);
      this.titleAtTurn.set(id, titleBefore);
      this.pairAtTurn.set(id, pairBefore);
      this.planMovedThisTurn.delete(id);
      this.heldSaid.delete(id);
      this.opened.delete(id);
    }
    this.say(id, { kind: "turn", text: turn.text });
    // Recorded before it is answered, so the asking is judged against a
    // conversation that already holds this turn.
    this.deps.editing.answerAsking(id, turn.text);
    this.askingChanged(id);
    return this.status(id);
  }

  /**
   * End the interview's stdin, which is how a session of its own ends; the
   * process group is signalled only for a child still there after that
   * ({@link ../process.ts}). It stays listed as running until it has actually
   * gone, so nothing starts a second one over the top of it.
   */
  stop(id: string): InterviewStatus {
    this.live.get(id)?.child.stop();
    const pending = this.starting.get(id);
    if (pending) pending.stopped = true;
    // Said now rather than at `onClose`, which is up to eight seconds later:
    // the person has stopped waiting, so the dock stops saying they should.
    this.owed.delete(id);
    // The spec the stopped turn had already written is written, and the plan is
    // the person's to generate from it: stopping the session does not take the
    // way on with it.
    this.endTurn(id);
    this.deps.reread(id);
    this.askingChanged(id);
    return this.status(id);
  }

  /**
   * Settled once this planning's interview has gone, and at once where none is
   * running. A stop ends stdin and the session finishes the turn it is in, so
   * the child can still write the spec between the stop and its exit: whatever
   * reads or deletes the spec after a stop waits for this first.
   */
  exited(id: string): Promise<void> {
    // A chat still starting has nothing to wait for once it is stopped: the
    // stop is what keeps it from spawning ({@link starting}).
    return this.live.get(id)?.exited ?? Promise.resolve();
  }

  /** Every interview goes when the app closes; each ends through its own stdin. */
  shutdown(): void {
    for (const pending of this.starting.values()) pending.stopped = true;
    for (const live of this.live.values()) live.child.stop();
    this.live.clear();
    this.owed.clear();
    for (const id of [...this.specChecks.keys()]) this.forgetSpecCheck(id);
  }

  /**
   * Append one line of the conversation and push it to the renderer as it
   * arrives, or say only what is running where there is no line to add.
   *
   * The record is saved by the append itself, so the change is pushed without
   * a second write.
   *
   * Two things can stop a line landing, and they are answered differently. A
   * session that has gone while its interview was speaking takes the line with
   * it: there is nowhere left for it to land. A line the record will not hold
   * is said as a note instead of being dropped, because the person is watching
   * the chat for it — what the line carries is clipped where it is read
   * ({@link ../records.ts}), so this is the belt rather than the route.
   */
  say(id: string, line: InterviewEntry["line"] | null): InterviewEntry | null {
    const at = new Date().toISOString();
    let entry: InterviewEntry | null = null;
    if (line !== null) {
      try {
        entry = this.deps.editing.converse(id, line, at);
      } catch (error) {
        try {
          entry = this.deps.editing.converse(
            id,
            {
              kind: "note",
              text: `A line of the chat could not be recorded: ${redact(
                error instanceof Error ? error.message : String(error),
              )}`.slice(0, 12_000),
            },
            at,
          );
        } catch {
          return null;
        }
      }
      // A line of the turn's own is what the status is read from next.
      if (line.kind !== "note") this.doing.delete(id);
    }
    this.deps.changes.changed(false, {
      kind: "interview",
      sessionId: id,
      running: this.live.has(id),
      entry,
      asking: this.askingOf(id),
      working: this.isWorking(id),
      doing: this.doingOf(id),
    });
    return entry;
  }

  /**
   * Say what the asking is now, with no line to add.
   *
   * The dock reads it off this stream rather than off the session, which the
   * editor refuses to re-read while a save of its own is in flight: a card that
   * waited for that would come and go with whether the person was saving.
   */
  askingChanged(id: string): void {
    this.say(id, null);
  }

  /**
   * Put the ticket {@link InterviewDeps.draftedFrom} this planning's spec on the
   * planning, leaving the session alone where there is none to be sure of.
   *
   * A session that already holds a ticket re-drafted its own plan; that is a
   * plan change, and it is told as one.
   */
  async planDrafted(id: string): Promise<void> {
    try {
      const session = this.deps.editing.read(id);
      const repoId = this.live.get(id)?.repoId ?? session.repoId;
      if (session.key !== null) {
        await this.planChanged(id);
        return;
      }
      if (session.specSlug === null) return;
      const key = await this.deps.draftedFrom(this.deps.repository(repoId), session.specSlug);
      if (key === null) return;
      // Not one another live planning is already curating: two sessions on one
      // ticket is the conflict `open` guards against, and this must not make one
      // behind their back.
      const taken = this.deps
        .sessions()
        .some(
          (entry) =>
            entry.id !== id &&
            entry.repoId === repoId &&
            entry.key === key &&
            entry.phase !== "discarded",
        );
      if (taken) return;
      const detail = await this.deps.detail(repoId, key);
      this.deps.editing.adopt(id, detail, planNodes(detail.contract).length);
      this.deps.changes.changed(true, { kind: "records", repoId, key });
    } catch {
      // A session that has gone, or records that cannot be read, leave the plan
      // where it is: the picker still reaches it by its ticket.
    }
  }

  /**
   * The model this planning's chat starts on (`interviewModelFor`, D-102). Only
   * Claude Code offers the chat's own model, so only its catalog is read: the
   * one the model pickers last read, or else read here once and kept. A catalog
   * that cannot be read offers nothing, and the chat starts on the person's own
   * default.
   */
  private async chatModel(models: TaskModels): Promise<string> {
    if (models.draftingProvider !== "claude-cli") return interviewModelFor(models, null);
    const catalog = await this.deps.catalogs.known("claude-cli");
    return interviewModelFor(models, catalog?.models.map((row) => row.id) ?? null);
  }

  /** What the turn in flight is doing that its lines do not show, or null. */
  private doingOf(id: string): InterviewDoing | null {
    return this.isWorking(id) ? (this.doing.get(id) ?? null) : null;
  }

  /** Say what the turn is doing now, with no line to add. */
  private nowDoing(id: string, doing: InterviewDoing): void {
    this.doing.set(id, doing);
    this.askingChanged(id);
  }

  /** The asking this planning is putting, or null where it holds none or has gone. */
  private askingOf(id: string): { entry: number; answered: number } | null {
    try {
      return this.deps.editing.read(id).asking;
    } catch {
      return null;
    }
  }

  /**
   * The spec this planning writes, named from the person's first turn where
   * they have not named it in the Spec pane (D-118).
   *
   * The interview is started with `--spec`, so a planning with no slug has
   * nowhere to write. The person's own words name it: a title is cut from the
   * turn, the spec is written, and the slug it mints is recorded exactly as a
   * save from the Spec pane records one. Nothing a model returned reaches the
   * folder, so it stays the person's own parameter (ADR-0023 §4), and the slug
   * still goes through `safePath` where the argv is built.
   *
   * A turn no folder name can come from falls through to the refusal, which
   * asks for the title the message could not give.
   */
  private nameSpecFromTurn(id: string, text: string): void {
    const session = this.deps.editing.read(id);
    if (session.specSlug !== null) return;
    const repo = this.deps.repository(session.repoId);
    let title;
    try {
      title = specTitleFromMessage(text);
    } catch (error) {
      // Only a message that names nothing asks for a title. A spec already at
      // that folder is a different problem and says so in its own words.
      throw new Error(INTERVIEW_NEEDS_A_TITLE, { cause: error });
    }
    const written = mintSpecFromTitle(repo, title);
    this.deps.editing.recordSpec(id, written.slug, title);
    // The folder is minted once and never moves, so the person is told what it
    // was called while the spec is still empty enough to start again.
    // That the title can be changed is what an editable field says by being
    // one, and that a folder keeps its name is how folders work.
    this.say(id, {
      kind: "note",
      text: `Named ${written.folder} from your first message.`,
    });
  }

  /** One line of the interview's stdout, recorded and told as the reading says. */
  private relay(id: string, line: string): void {
    const read = relayed(line);
    if (read.kind === "nothing") return;
    if (read.kind === "said") {
      // Once the note has handed the written spec over, it is what the turn
      // says: the session's own closing words after it repeat it less well
      // (D-102). Its orientation asks it to end the turn there without a
      // message; this is what makes that true of a model that does not.
      if (this.afterTheNote.has(id)) return;
      // Nor before the note, in the moment between the write and the reading
      // that hands the spec over: a closing line arriving there would be said
      // ahead of the note it repeats. Held until the reading says whether there
      // is a note to come.
      if (this.specChecks.has(id) && this.planless(id)) {
        this.heldForNote.set(id, [...(this.heldForNote.get(id) ?? []), read.text]);
        return;
      }
      this.sayOrHold(id, read.text);
      return;
    }
    if (read.kind === "line") {
      if (read.line.kind === "refused") this.wentToWork(id);
      this.say(id, read.line);
      return;
    }
    if (read.kind === "wroteSpec") {
      // The spec is a pane away and writing it is what the person waits
      // through, so it is said as it happens — on the status line, which moves
      // on with the turn, rather than as a line in the conversation that stays
      // behind it once the write is done.
      this.wentToWork(id);
      this.nowDoing(id, "writing_the_spec");
      // And then, a moment later, that it is written. The session goes on
      // composing after the write — often for as long again — and what it is
      // composing is prose about a spec the person can already read, so the
      // turn's end is too late to hand the next act back.
      this.checkSpecWritten(id);
      return;
    }
    if (read.kind === "idle") {
      // The turns this ending answered: one sent mid-turn can be answered
      // inside the turn it was sent into. The rest stay owed: a person whose
      // second turn gets an ending of its own is still waiting on it.
      const owed = (this.owed.get(id) ?? 0) - read.turns;
      if (owed > 0) this.owed.set(id, owed);
      else {
        this.owed.delete(id);
        this.endTurn(id);
      }
      this.askingChanged(id);
      // A turn over with problems open was an answer to one: the plan is read
      // again to see whether it closed it, which is how the next appears.
      if (owed <= 0) this.deps.reread(id);
      return;
    }
    if (read.kind === "ended") {
      // The turn it was in ends with it, as any turn ends: what it moved is
      // marked and handed over before the line that says the session is over.
      this.owed.delete(id);
      this.endTurn(id);
      this.say(id, read.line);
      return;
    }
    if (read.kind === "started") {
      try {
        this.deps.editing.recordInterview(
          id,
          read.session,
          interviewProvider(this.deps.editing.read(id)),
          this.live.get(id)?.model ?? null,
        );
      } catch {
        // The session's record is where `--session` is read from when the
        // interview is started again, so a planning that has gone takes the
        // conversation with it and there is nothing to say it to.
        return;
      }
      this.say(id, read.note);
      return;
    }
    this.wentToWork(id);
    if (read.kind === "tool") {
      this.say(id, {
        ...read.line,
        edit: read.planMoved ? this.interviewEdit(id) : null,
      });
      // The plan really moved, so the surfaces reading those records are told,
      // as they are for an edit the Graph pane makes. Nothing else says it: the
      // interview runs `perbo edit` inside its own process rather than as a job
      // of this host's. Said whether or not the card could be drawn, because
      // what moved is the records rather than the card.
      if (read.planMoved) {
        void this.planChanged(id);
        this.planMovedThisTurn.add(id);
      }
      return;
    }
    const asked = this.say(id, read.line);
    // What the person is being put, from the line it arrived on: recorded
    // rather than counted back out of the turns (D-117).
    if (asked !== null) {
      this.deps.editing.beginAsking(id, asked.n);
      this.askingChanged(id);
    }
  }

  /** Say this, or hold it where it may yet turn out to be an announcement. */
  private sayOrHold(id: string, text: string): void {
    if (!this.isWorking(id) || this.opened.has(id)) {
      this.say(id, { kind: "said", text });
      return;
    }
    const held = this.heldSaid.get(id);
    if (held === undefined) {
      this.heldSaid.set(id, text);
      // The session has words for the person that are not shown yet: the dock
      // puts its bubble up, with the dots, until they are.
      this.nowDoing(id, "speaking");
      return;
    }
    // Two lines running, with nothing done between them. Only work proves a
    // line was the session announcing itself, and no work happened here, so
    // both are said and the turn is open from now on.
    this.heldSaid.delete(id);
    this.opened.add(id);
    this.say(id, { kind: "said", text: held });
    this.say(id, { kind: "said", text });
  }

  /**
   * The session did something, so a line it said immediately before that was
   * it saying it was about to, and the turn is open from here.
   */
  private wentToWork(id: string): void {
    this.heldSaid.delete(id);
    this.opened.add(id);
  }

  /**
   * The turn is over — answered, stopped, or its session gone — and what it
   * moved can now be read off the files. A line held through it was the whole
   * of it. The drafted spec is said first: both notes are measured against the
   * reading taken when the turn began, and the second of them clears it. The
   * change is then marked on the panes, and the next turn hands the spec over
   * again once it has written it.
   */
  private endTurn(id: string): void {
    this.sayWhatWasHeld(id);
    this.saySpecIsDrafted(id);
    this.sayWhatWaitedOnTheNote(id);
    this.saySpecMovedToo(id);
    this.recordArchitectsTitle(id);
    this.deps.marks.recordChangeSince(id, this.pairAtTurn.get(id), this.live.get(id)?.repoId);
    this.pairAtTurn.delete(id);
    this.doing.delete(id);
    this.saidDrafted.delete(id);
    this.afterTheNote.delete(id);
    this.forgetSpecCheck(id);
  }

  /** Say what was held, where the turn ended with it as the whole of it. */
  private sayWhatWasHeld(id: string): void {
    const held = this.heldSaid.get(id);
    this.heldSaid.delete(id);
    this.opened.delete(id);
    if (held !== undefined) this.say(id, { kind: "said", text: held });
  }

  /**
   * Read the spec shortly after a write was admitted, and hand it over if it
   * moved.
   *
   * Deferred rather than read now because the event is the call being admitted
   * and the file lands as that call returns: a reading taken here would find
   * the spec as it was and call the turn's own work nothing. Long enough for
   * the bytes to be on disk, short enough that the person is told while they
   * are still watching the write be announced.
   */
  private checkSpecWritten(id: string): void {
    if (this.specChecks.has(id) || this.saidDrafted.has(id)) return;
    const timer = setTimeout(() => {
      this.specChecks.delete(id);
      this.saySpecIsDrafted(id);
      this.sayWhatWaitedOnTheNote(id);
      // The title the write gave the spec names the planning from now, not
      // from the turn's end (D-118).
      this.recordArchitectsTitle(id);
    }, this.deps.specSettleMs ?? SPEC_SETTLES_IN_MS);
    timer.unref?.();
    this.specChecks.set(id, timer);
  }

  /** Say what was held for a note that did not come; after one, it has gone. */
  private sayWhatWaitedOnTheNote(id: string): void {
    const held = this.heldForNote.get(id) ?? [];
    this.heldForNote.delete(id);
    for (const text of held) this.sayOrHold(id, text);
  }

  /** Whether this planning has no plan yet, which is when the spec is handed over. */
  private planless(id: string): boolean {
    try {
      return this.deps.editing.read(id).key === null;
    } catch {
      return false;
    }
  }

  /** Drop the reading a turn owed, because the turn is over. */
  private forgetSpecCheck(id: string): void {
    const timer = this.specChecks.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.specChecks.delete(id);
  }

  /**
   * The digest of this planning's spec file, or null where there is no spec to
   * read — it has no folder yet, or the file has gone.
   *
   * The bytes rather than the parse: what this answers is "did the file move",
   * and a change the parser drops is still a change to the document the person
   * would open.
   */
  private specDigest(id: string): string | null {
    try {
      const session = this.deps.editing.read(id);
      if (session.specSlug === null) return null;
      const repo = this.deps.repository(this.live.get(id)?.repoId ?? session.repoId);
      return createHash("sha256").update(readFileSync(specPath(repo, session.specSlug))).digest("hex");
    } catch {
      return null;
    }
  }

  /** The title this planning's spec states, or null where there is no spec to read. */
  private specTitle(id: string): string | null {
    try {
      const { repoId, specSlug } = this.deps.editing.read(id);
      return specSlug === null ? null : specTitles(this.deps.repository)(repoId, specSlug);
    } catch {
      return null;
    }
  }

  /**
   * Record the Architect titling the spec, where the turn left it stating a
   * title other than the one it began with (D-127). Only the first reading
   * after a turn begins measures from its start: the next is measured from
   * this one.
   */
  private recordArchitectsTitle(id: string): void {
    if (!this.titleAtTurn.has(id)) return;
    const before = this.titleAtTurn.get(id) ?? null;
    const now = this.specTitle(id);
    this.titleAtTurn.set(id, now);
    if (now === null || now === before) return;
    try {
      this.deps.editing.architectTitled(id, now);
    } catch {
      // The planning has gone, and its name with it.
    }
  }

  /**
   * Say that the spec is written and the three ways on from it are the
   * person's (D-102): read and change it on the Spec pane, ask for a change
   * here, or press Generate plan.
   *
   * The interview writes the spec and stops there, so the write leaves nothing
   * happening on screen for anybody who is not on the Spec pane — and the next
   * act is theirs. Words and no button: what the person does next is theirs to
   * decide, and the one press that turns the spec into a plan is at the foot of
   * the Spec pane, under the spec it drafts from.
   *
   * Once a turn, whoever asks. The reading taken after a write says it while
   * the session is still composing, which is when the person is looking at a
   * chat that has stopped moving; the turn's endings say it where that reading
   * never ran, on a turn stopped before it came round. Saying it twice would put
   * the same news twice in a row.
   *
   * Only where this planning holds no plan yet: a session with a key has one
   * already, and a spec written beside it is a change to a plan that exists,
   * which is {@link saySpecMovedToo}'s to report. And only where the spec
   * actually moved this turn, so a turn that only answered a question says
   * nothing.
   */
  private saySpecIsDrafted(id: string): void {
    if (this.saidDrafted.has(id)) return;
    // Asked of the map rather than of the reading it holds: a planning whose
    // spec had no file when the turn began holds a null here, and that is the
    // very turn this is for — the first one, which writes it.
    if (!this.specAtTurn.has(id)) return;
    const before = this.specAtTurn.get(id) ?? null;
    try {
      if (this.deps.editing.read(id).key !== null) return;
    } catch {
      // The planning has gone; there is nothing to say it to.
      return;
    }
    const now = this.specDigest(id);
    if (now === null || now === before) return;
    this.saidDrafted.add(id);
    this.afterTheNote.add(id);
    this.heldForNote.delete(id);
    this.say(id, { kind: "note", text: INTERVIEW_WROTE_THE_SPEC, notable: true });
  }

  /**
   * Say, once the turn is over, that it moved the spec as well as the plan.
   *
   * Told rather than warned: this is the interview doing what was asked of it —
   * the two are one document in two places, and changing a criterion without
   * changing the requirement it answers would be the drift the approval check
   * exists to catch. What a person needs is to know the other page moved, so
   * they read it before they confirm.
   *
   * Only where both moved. A turn that changed the plan alone has nothing to
   * report here, and a spec written on its own is the Spec pane's own text
   * arriving, which that pane shows as it lands.
   */
  private saySpecMovedToo(id: string): void {
    const moved = this.planMovedThisTurn.delete(id);
    const before = this.specAtTurn.get(id) ?? null;
    this.specAtTurn.delete(id);
    if (!moved || before === null) return;
    const now = this.specDigest(id);
    if (now === null || now === before) return;
    this.say(id, {
      kind: "note",
      text: "The spec changed with the plan. Read it on the Spec pane before you confirm.",
      notable: true,
    });
  }

  /**
   * Say the ticket's records moved, for every surface drawing this plan.
   *
   * The repository is the one this interview was started against rather than
   * the one the session names now: `perbo edit` wrote where the argv pointed,
   * and a session whose repository was changed under a running interview would
   * otherwise have the wrong one told.
   */
  private async planChanged(id: string): Promise<void> {
    try {
      const session = this.deps.editing.read(id);
      if (session.key === null) return;
      const repoId = this.live.get(id)?.repoId ?? session.repoId;
      // An edit can divide a plan that was not divided, or put a divided one
      // back together, and the rail is drawn where no contract can be read — it
      // asks this count instead. Settling a job writes it and so does a
      // contract re-read; an edit reaches neither, so a plan the interview split
      // would have a graph the rail never offered a way into.
      const now = this.deps.tickets.contract(this.deps.repository(repoId), session.key);
      // The plan as it now reads, so the pane that draws it from the session
      // draws what the interview just wrote rather than what was there before.
      let plan;
      try {
        plan = await this.deps.detail(repoId, session.key);
      } catch {
        // Unreadable is a count without a redraw, not a failure.
      }
      this.deps.editing.countNodes(id, planNodes(now.contract).length, now.digest, plan);
      this.deps.changes.changed(true, { kind: "records", repoId, key: session.key });
    } catch {
      // A session that has gone has no plan for anything to be drawing.
    }
  }

  /**
   * The plan edit an `edit_plan` or an `undo_edit` made, read off the ticket's
   * own draft record (D-100) so the chat's card carries an Undo on its number.
   *
   * The edit the command wrote down, not the one the tool said it made: the
   * record is written by `perbo edit`, which is the one path a plan changes
   * through, and the tool's own account of itself is a model's output
   * ([ADR-0023](../../../../../docs/adr/0023-untrusted-context-boundary.md)).
   */
  private interviewEdit(id: string): InterviewEdit | null {
    try {
      const session = this.deps.editing.read(id);
      if (session.key === null) return null;
      // The repository this interview was started against, which is where
      // `perbo edit` wrote, and the one {@link planChanged} names.
      const repo = this.deps.repository(this.live.get(id)?.repoId ?? session.repoId);
      return readLatestDraftEdit(ticketPath(repo, session.key, ".draft.json"), "interview");
    } catch {
      // No record to read is a card without an undo, not a failed relay.
      return null;
    }
  }
}
