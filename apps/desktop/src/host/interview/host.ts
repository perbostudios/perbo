import { InterviewTurnSchema, encodeInterviewTurn } from "@perbo/contracts/interview-protocol";
import { redact } from "../process.js";
import { readLatestDraftEdit } from "../records.js";
import { ticketPath } from "../repository/layout.js";
import { mintSpecFromTitle } from "../plan/spec.js";
import { specTitleFromMessage } from "@perbo/planning";
import { INTERVIEW_NEEDS_A_TITLE } from "../../shared/protocol.js";
import { interviewArgv, interviewProvider } from "./argv.js";
import { relayed } from "./relay.js";
import type { Cli } from "../cli.js";
import type { Changes } from "../changes.js";
import type { ContractEditing } from "../../shared/contract-editing.js";
import type { LineProcess } from "../process.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { InterviewEdit, InterviewEntry, InterviewStatus } from "../../shared/protocol.js";

export interface InterviewDeps {
  editing: Pick<
    ContractEditing,
    "read" | "converse" | "recordInterview" | "recordSpec" | "beginAsking" | "answerAsking"
  >;
  repository(id: string): RegisteredRepository;
  cli: Pick<Cli, "spawn">;
  changes: Pick<Changes, "changed">;
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
  private readonly live = new Map<string, { repoId: string; child: LineProcess }>();

  constructor(deps: InterviewDeps) {
    this.deps = deps;
  }

  /** The planning sessions whose interview is still there. */
  running(): string[] {
    return [...this.live.keys()];
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
  start(id: string, repoId?: string): InterviewStatus {
    const session = this.deps.editing.read(id);
    if (repoId !== undefined && session.repoId !== repoId)
      throw new Error("This planning belongs to another repository.");
    if (this.live.has(id)) return this.status(id);
    const repo = this.deps.repository(session.repoId);
    const args = interviewArgv(repo, session);
    let stderr = "";
    const child = this.deps.cli.spawn(args, repo, {
      onLine: (line) => this.relay(id, line),
      // What the chat shows comes off the events; stderr is the same refusals
      // in prose, and is kept only to say why a session that never started did
      // not start.
      onStderr: (text) => {
        stderr = (stderr + text).slice(-4000);
      },
      onClose: ({ code, stopped }) => {
        this.live.delete(id);
        this.converse(
          id,
          code === 0 || stopped
            ? null
            : {
                kind: "note",
                text: `The interview stopped with code ${String(code)}.${
                  stderr.trim() ? ` ${stderr.trim()}` : ""
                }`,
              },
        );
      },
      onError: (error) => {
        this.live.delete(id);
        this.converse(id, { kind: "note", text: redact(error.message).slice(0, 12_000) });
      },
    });
    this.live.set(id, { repoId: repo.id, child });
    // Nothing is said yet: the interview's own `started` event is what says it
    // is there, and until then the only honest word is that it is starting,
    // which is what `running` on this change carries.
    this.converse(id, null);
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
  turn(id: string, text: string): InterviewStatus {
    const turn = InterviewTurnSchema.parse({ type: "turn", text });
    if (!this.live.has(id)) {
      this.nameSpecFromTurn(id, turn.text);
      this.start(id);
    }
    const live = this.live.get(id);
    if (!live || !live.child.write(encodeInterviewTurn(turn)))
      throw new Error(
        "The interview is not listening. Start it again, then send this once it is running.",
      );
    this.converse(id, { kind: "turn", text: turn.text });
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
    return this.status(id);
  }

  /** Every interview goes when the app closes; each ends through its own stdin. */
  shutdown(): void {
    for (const live of this.live.values()) live.child.stop();
    this.live.clear();
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
    this.deps.editing.recordSpec(id, written.slug);
    // The folder is minted once and never moves, so the person is told what it
    // was called while the spec is still empty enough to start again.
    this.converse(id, {
      kind: "note",
      text:
        `Named from your first message: ${written.folder}. The folder keeps this name; ` +
        "the title itself you can change in the Spec pane.",
    });
  }

  /** One line of the interview's stdout, recorded and told as the reading says. */
  private relay(id: string, line: string): void {
    const read = relayed(line);
    if (read.kind === "nothing") return;
    if (read.kind === "line") {
      this.converse(id, read.line);
      return;
    }
    if (read.kind === "started") {
      try {
        this.deps.editing.recordInterview(
          id,
          read.session,
          interviewProvider(this.deps.editing.read(id)),
        );
      } catch {
        // The session's record is where `--session` is read from when the
        // interview is started again, so a planning that has gone takes the
        // conversation with it and there is nothing to say it to.
        return;
      }
      this.converse(id, read.note);
      return;
    }
    if (read.kind === "tool") {
      this.converse(id, {
        ...read.line,
        edit: read.planMoved ? this.interviewEdit(id) : null,
      });
      // The plan really moved, so the surfaces reading those records are told,
      // as they are for an edit the Graph pane makes. Nothing else says it: the
      // interview runs `perbo edit` inside its own process rather than as a
      // job of this host's. Said whether or not the card could be drawn,
      // because what moved is the records rather than the card.
      if (read.planMoved) this.planChanged(id);
      return;
    }
    const asked = this.converse(id, read.line);
    // What the person is being put, from the line it arrived on: recorded
    // rather than counted back out of the turns (D-117).
    if (asked !== null) {
      this.deps.editing.beginAsking(id, asked.n);
      this.askingChanged(id);
    }
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
  private converse(id: string, line: InterviewEntry["line"] | null): InterviewEntry | null {
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
              text: `A line of the interview could not be recorded: ${redact(
                error instanceof Error ? error.message : String(error),
              )}`.slice(0, 12_000),
            },
            at,
          );
        } catch {
          return null;
        }
      }
    }
    this.deps.changes.changed(false, {
      kind: "interview",
      sessionId: id,
      running: this.live.has(id),
      entry,
      asking: this.askingOf(id),
    });
    return entry;
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
   * Say what the asking is now, with no line to add.
   *
   * The dock reads it off this stream rather than off the session, which the
   * editor refuses to re-read while a save of its own is in flight: a card that
   * waited for that would come and go with whether the person was saving.
   */
  private askingChanged(id: string): void {
    this.deps.changes.changed(false, {
      kind: "interview",
      sessionId: id,
      running: this.live.has(id),
      entry: null,
      asking: this.askingOf(id),
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
  private planChanged(id: string): void {
    try {
      const session = this.deps.editing.read(id);
      if (session.key === null) return;
      const repoId = this.live.get(id)?.repoId ?? session.repoId;
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
