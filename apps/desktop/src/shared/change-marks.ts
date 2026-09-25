import { changeBetween, promiseOf, type PromisePair } from "./contract-editing.js";
import type {
  Detail,
  EditingChange,
  EditingSession,
  InterviewEntry,
  PlanPromise,
  SpecSections,
} from "./protocol.js";

/**
 * What marking a change reads and writes, as each host keeps it: the host off
 * the repository's files, the sample host off its own records (D-120).
 * `Repo` is whatever the host reads a repository's spec and contracts through.
 */
export interface ChangeMarksIO<Repo extends { readonly id: string }> {
  /** The planning's record; throws where the planning has gone. */
  read(id: string): EditingSession;
  /** Every planning the host keeps, live or not. */
  sessions(): readonly EditingSession[];
  /** The repository by id; throws where there is none. */
  repository(id: string): Repo;
  /** The spec's five sections as its file says them, null where there is no file; throws where the file will not read. */
  spec(repo: Repo, slug: string): SpecSections | null;
  /** The ticket's contract; throws where it cannot be read. */
  contract(repo: Repo, key: string): Detail["contract"];
  /** Put the change on the planning's record as the last one; throws where the record will not take it. */
  recordChange(id: string, change: EditingChange): void;
  /** A line in the planning's chat. */
  say(id: string, line: InterviewEntry["line"]): void;
  /** An error's words as the chat may show them. */
  redact(text: string): string;
}

/**
 * The last change to what a planning's spec states and its plan promises,
 * marked on the panes that read them (D-128), and the one implementation both
 * hosts mark with (D-120).
 *
 * The spec and the plan's promise are read before and after whatever may move
 * them — a turn of the chat, an edit, a save, a re-draft — and the two readings
 * compared ({@link changeBetween}); the change between them is recorded on
 * every live planning over the same spec or the same ticket. Nothing is
 * recorded where the two readings say the same, so a turn that only talked,
 * or an edit that only rearranged the graph, leaves the marks of the last real
 * change standing.
 */
export class ChangeMarks<Repo extends { readonly id: string }> {
  private readonly io: ChangeMarksIO<Repo>;

  constructor(io: ChangeMarksIO<Repo>) {
    this.io = io;
  }

  /**
   * The spec and the plan's promise as this planning holds them now: the
   * spec's sections off its file, null where the session has no spec or no
   * file yet, and the plan's promise off the contract, null where there is no
   * plan or it cannot be read. Null as a whole where the pair cannot be read —
   * the session has gone, or the spec's file is there and will not read — and
   * nothing is then measured against it: a spec that could not be read is not
   * a spec that said nothing, and nothing the turn did, its edits to the plan
   * included, is measured against a reading that failed.
   *
   * `repoId` is the repository a running interview was started against, where
   * the caller has one: that is where its writes landed.
   */
  pairOf(id: string, repoId?: string): PromisePair | null {
    try {
      const session = this.io.read(id);
      const repo = this.io.repository(repoId ?? session.repoId);
      return {
        spec: session.specSlug === null ? null : this.io.spec(repo, session.specSlug),
        plan: session.key === null ? null : this.promiseAt(repo, session.key),
      };
    } catch {
      return null;
    }
  }

  /** What the ticket's plan promises, or null where its contract cannot be read. */
  promiseAt(repo: Repo, key: string): PlanPromise | null {
    try {
      return promiseOf(this.io.contract(repo, key));
    } catch {
      return null;
    }
  }

  /**
   * Record on this planning what a turn of the chat changed since `before`,
   * where anything did and both readings could be made.
   */
  recordChangeSince(id: string, before: PromisePair | null | undefined, repoId?: string): void {
    if (before === undefined || before === null) return;
    const after = this.pairOf(id, repoId);
    if (after === null) return;
    const change = changeBetween(before, after, new Date().toISOString(), "chat");
    if (change !== null) this.markChange(id, change);
  }

  /**
   * Record the change between two readings, where anything moved, on every
   * live planning `on` names: an edit reaches the ticket's records through one
   * command whoever asked for it, and a save writes the one spec file, so each
   * planning drawing either records the same change.
   */
  markChangeOn(
    before: PromisePair,
    after: PromisePair,
    on: (session: EditingSession) => boolean,
    by: EditingChange["by"],
  ): void {
    const change = changeBetween(before, after, new Date().toISOString(), by);
    if (change === null) return;
    for (const session of this.io.sessions())
      if (session.phase !== "discarded" && on(session)) this.markChange(session.id, change);
  }

  /** Record a change to what this ticket's plan promises on every planning over it, and who made it. */
  recordPlanChange(repo: Repo, key: string, before: PlanPromise | null, by: EditingChange["by"]): void {
    if (before === null) return;
    const after = this.promiseAt(repo, key);
    if (after !== null)
      this.markChangeOn(
        { spec: null, plan: before },
        { spec: null, plan: after },
        (session) => session.repoId === repo.id && session.key === key,
        by,
      );
  }

  /**
   * Put the change on the planning's record as the last one. The marks are a
   * reading of what happened and never the thing itself: a record that will
   * not take the change — the planning gone, a spec section past what the
   * record holds — is said in the chat, and the edit or the save that made the
   * change, which has already landed, is not failed for it.
   */
  private markChange(id: string, change: EditingChange): void {
    try {
      this.io.recordChange(id, change);
    } catch (error) {
      this.io.say(id, {
        kind: "note",
        text: `The change could not be marked on the panes: ${this.io.redact(
          error instanceof Error ? error.message : String(error),
        )}`.slice(0, 12_000),
      });
    }
  }
}
