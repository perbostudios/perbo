import { planNodes } from "@perbo/contracts/plan";
import { standingGlob, type StandingProhibitedEntry } from "@perbo/contracts/standing";
import {
  DraftSchema,
  EditingFormSchema,
  EditingSessionSchema,
  INTERVIEW_CONVERSATION_CAP,
  InterviewEntrySchema,
  RequestSchema,
  TaskModelsSchema,
} from "./protocol.js";
import type {
  Detail, Draft, DraftEdit, EditingForm, EditingOperation, EditingSession,
  EditingTarget, InterviewEntry, Job, LegacyEditing, OpenDraft, Request, TaskModels,
} from "./protocol.js";

type EditingRequest = Extract<
  Request,
  { kind: "draft" | "admit" | "edit" | "generatePlan" | "startOver" }
>;
export interface EditingOwner { sessionId: string; operationId: string }

/** Internal adapters. Both the native host and the sample host own this module. */
export interface EditingIO {
  records(): readonly EditingSession[];
  persist(records: EditingSession[]): void;
  repository(id: string): void;
  defaults(repoId: string, key: string | null): TaskModels;
  detail(repoId: string, key: string): Promise<Detail>;
  start(request: EditingRequest, owner: EditingOwner): Promise<Job>;
  stop(jobId: string): Promise<void>;
  id(): string;
  /** The repository's standing prohibited list (D-105), which the always box writes. */
  standing(repoId: string): StandingProhibitedEntry[];
  setStanding(repoId: string, entries: StandingProhibitedEntry[]): void;
}

export type DraftMark = "allowed" | "prohibited" | null;

/**
 * What a glob is marked in this draft. Read off the form's own two lists rather
 * than kept beside them: a second record of the same fact would drift from the
 * scope admission actually passes.
 */
export function markOf(form: EditingForm, glob: string): DraftMark {
  if (form.draft.paths.includes(glob)) return "allowed";
  if (form.draft.prohibited.includes(glob)) return "prohibited";
  return null;
}

function applyMark(form: EditingForm, glob: string, mark: DraftMark): void {
  form.draft.paths = form.draft.paths.filter((entry) => entry !== glob);
  form.draft.prohibited = form.draft.prohibited.filter((entry) => entry !== glob);
  if (mark === "allowed") form.draft.paths.push(glob);
  if (mark === "prohibited") form.draft.prohibited.push(glob);
}

export function contractDraft(detail: Detail): Draft {
  return {
    outcome: detail.contract.outcome,
    paths: detail.contract.scope.paths_allowed,
    prohibited: detail.contract.scope.paths_prohibited,
    criteria: "acceptance_criteria" in detail.contract
      ? detail.contract.acceptance_criteria.flatMap((entry) =>
          entry.expected_verification.kind === "manual" ? [] : [{
            text: entry.text,
            assertion: entry.expected_verification.assertion,
            kind: entry.expected_verification.kind,
          }])
      : [],
  };
}

export function editingForm(models: TaskModels, detail?: Detail): EditingForm {
  return {
    draft: detail ? contractDraft(detail) : { outcome: "", criteria: [], paths: ["src/**", "test/**"], prohibited: [] },
    models: TaskModelsSchema.strip().parse(models),
    step: detail ? 2 : 1,
    editing: null,
    criterion: { text: "", assertion: "", kind: "test" },
    newPath: null,
  };
}

const pending = (operation: EditingOperation | null): boolean =>
  operation !== null && ["accepted", "running", "stopping"].includes(operation.state);

/** The sessions a person can pick up again, newest first. Both hosts put this on the snapshot. */
export function openDrafts(records: readonly EditingSession[]): OpenDraft[] {
  return records
    .filter((record) => record.phase !== "discarded")
    .map((record) => ({
      id: record.id,
      repoId: record.repoId,
      key: record.key,
      outcome: record.form.draft.outcome,
      phase: record.phase,
      nodes: record.nodes,
      scope: { paths: [...record.form.draft.paths], prohibited: [...record.form.draft.prohibited] },
    }))
    .reverse();
}

/** Local editable work and its operation receipts, never canonical Ticket state. */
export class ContractEditing {
  private readonly reconciling = new Map<string, Promise<void>>();
  private readonly unsettled = new Map<string, { job: Job; error: string }>();
  private readonly io: EditingIO;
  constructor(io: EditingIO) { this.io = io; }

  read(id: string): EditingSession {
    const record = this.io.records().find((entry) => entry.id === id);
    if (!record) throw new Error("This editing session is no longer available. Open the task again.");
    const session = EditingSessionSchema.parse(structuredClone(record));
    const failure = this.unsettled.get(id);
    if (failure) {
      session.phase = "outcome-unknown";
      session.error = `The command finished, but its editing receipt could not be saved: ${failure.error}. Check Home before retrying.`;
    }
    return session;
  }

  private update(id: string, apply: (record: EditingSession) => void): EditingSession {
    const next = this.read(id);
    apply(next);
    const valid = EditingSessionSchema.parse(next);
    this.io.persist(this.io.records().map((record) => record.id === id ? valid : record));
    return this.read(id);
  }

  recover(): void {
    for (const session of this.io.records()) {
      if (!pending(session.operation)) continue;
      this.update(session.id, (next) => {
        next.operation!.state = "interrupted";
        next.operation!.error = "Perbo closed before this operation reported its outcome.";
        next.phase = "outcome-unknown";
        next.error = "Your edits were saved. Check the task's recorded outcome before submitting again.";
      });
    }
  }

  async open(target: EditingTarget, legacy?: LegacyEditing): Promise<EditingSession> {
    // Planning mode curates a plan nobody has approved (D-100, D-101), so it
    // opens for a ticket in plan_review and for no other. Asked before a
    // session is found or made, so a ticket that has moved on never leaves one
    // behind for the picker to offer.
    if (target.kind === "planning") {
      const { ticket } = await this.io.detail(target.repoId, target.key);
      if (ticket.state !== "plan_review")
        throw new Error(
          `${target.key} is ${ticket.state}, and planning mode opens a plan still in plan_review. ` +
            "Open the task to see where it is.",
        );
    }
    const find = (): EditingSession | undefined => {
      const records = this.io.records();
      if (target.kind === "session") return records.find((entry) => entry.id === target.id);
      if (target.kind === "new") return records.find((entry) => entry.resumeNew && entry.phase !== "discarded");
      if (target.kind === "fresh") return undefined;
      const candidates = records.filter((entry) => entry.repoId === target.repoId && entry.phase !== "discarded");
      // A durable result reserves its Ticket before the asynchronous canonical read.
      return candidates.find((entry) => entry.key === target.key) ??
        candidates.find((entry) => entry.operation?.resultKey === target.key && !entry.operation.reconciled);
    };
    let existing = find();
    if (!existing && target.kind === "session") return this.read(target.id);
    if (!existing) {
      const repoId = target.kind === "new" && legacy ? legacy.repoId : target.kind === "session" ? "" : target.repoId;
      this.io.repository(repoId);
      const key =
        target.kind === "ticket" || target.kind === "planning" ? target.key : legacy?.key ?? null;
      const detail = key ? await this.io.detail(repoId, key) : undefined;
      // Another open request may have created the same target while detail was read.
      existing = find();
      if (!existing) {
        const records = this.io.records().filter((entry) => entry.phase !== "discarded");
        if (records.filter((entry) => entry.phase !== "ready").length >= 100)
          throw new Error("There are 100 unfinished editing sessions. Discard unused edits before creating another.");
        existing = EditingSessionSchema.parse({
          version: 1, id: this.io.id(), repoId, key,
          digest: legacy?.digest ?? detail?.digest ?? null,
          revision: 0, resumeNew: target.kind === "new", history: [],
          form: legacy?.form ?? editingForm(this.io.defaults(repoId, key), detail),
          nodes: detail ? planNodes(detail.contract).length : 0,
          phase: legacy?.pending ? "outcome-unknown" : "editing",
          error: legacy?.pending ? "An older draft has an unconfirmed job. Your text is preserved; check Home before submitting again." : null,
          operation: null,
        });
        this.io.persist([...records, existing]);
      }
    }
    const unsettled = this.unsettled.get(existing.id);
    if (unsettled) {
      try { await this.settled(unsettled.job); } catch { return this.read(existing.id); }
    }
    await this.reconcile(existing.id);
    const current = this.read(existing.id);
    try { this.io.repository(current.repoId); } catch {
      return this.update(current.id, (next) => {
        if (next.phase === "discarded") return;
        next.phase = "conflict";
        next.error = next.key || next.operation
          ? "This repository was disconnected. Your edits are preserved; reconnect it or discard these saved edits."
          : "This repository was disconnected. Choose a connected repository to keep working with these edits.";
      });
    }
    if (current.key && !pending(current.operation) && current.phase !== "discarded") {
      const detail = await this.io.detail(current.repoId, current.key);
      return this.update(current.id, (next) => {
        if (pending(next.operation) || next.phase === "discarded" || next.revision !== current.revision) return;
        const manual = "acceptance_criteria" in detail.contract && detail.contract.acceptance_criteria.some(
          (entry) => entry.expected_verification.kind === "manual",
        );
        // Whether this planning has a graph, for the rail, which is drawn
        // where no contract can be read. Written wherever the contract is,
        // rather than only where a session is made: a planning resumed for a
        // ticket already in plan_review never saw the job that drafted it.
        next.nodes = planNodes(detail.contract).length;
        if (detail.digest !== next.digest || detail.ticket.approved_at || manual) {
          next.phase = "conflict";
          next.error = manual
            ? "This contract has named manual reviewers. Edit it with the CLI to preserve those assignments."
            : "The saved contract changed or was approved. Your local edits are preserved; open the current contract to review it.";
        } else if (next.phase === "ready") next.phase = "editing";
        if (
          next.phase !== current.phase ||
          next.error !== current.error ||
          next.nodes !== current.nodes
        )
          next.revision++;
      });
    }
    return current;
  }

  /**
   * Which spec this planning writes (D-103), so reopening the session opens the
   * same one. Set by the host the first time a spec is saved; the text itself
   * lives in the repository, not here.
   */
  recordSpec(id: string, slug: string): EditingSession {
    return this.update(id, (session) => {
      if (session.specSlug === slug) return;
      session.specSlug = slug;
      session.revision++;
    });
  }

  /**
   * The asking this session is now putting to the person, from the entry it
   * arrived on. A later asking replaces an earlier one whole: the session has
   * said what it wants to know now.
   */
  beginAsking(id: string, entry: number): void {
    this.update(id, (session) => {
      session.asking = { entry, answered: 0 };
    });
  }

  /**
   * What one turn does to the asking in front of the person.
   *
   * An answer to the group they are on moves them to the next, and the last of
   * them ends the asking. Anything else ends it too: they have said something
   * of their own, the session is about to answer that rather than the
   * questions, and a card left standing would answer a question nobody is
   * asking any more. The questions stay in the conversation to be read.
   *
   * The groups come from the conversation, so an asking whose line the cap has
   * dropped ends here rather than leaving a card with nothing behind it.
   */
  answerAsking(id: string, text: string): void {
    this.update(id, (session) => {
      const asking = session.asking;
      if (asking === null) return;
      const entry = session.conversation.find((line) => line.n === asking.entry);
      const line = entry?.line;
      if (line === undefined || line.kind !== "asked") {
        session.asking = null;
        return;
      }
      const group = line.groups[asking.answered];
      if (group === undefined || !answersGroup(group, text)) {
        session.asking = null;
        return;
      }
      const answered = asking.answered + 1;
      session.asking = answered >= line.groups.length ? null : { entry: asking.entry, answered };
    });
  }

  /**
   * Append one line of the interview's conversation (D-102), and return it
   * with the number it was given.
   *
   * Neither an edit nor an operation: it changes nothing the person is
   * editing, so it leaves `revision` where it stands — a chat that bumped it
   * would make every save in flight stale while the session was talking. Past
   * {@link INTERVIEW_CONVERSATION_CAP} the oldest lines go, and the numbers
   * keep counting, so the chat can say the beginning is no longer kept.
   */
  converse(id: string, line: InterviewEntry["line"], at: string): InterviewEntry {
    const entry = InterviewEntrySchema.parse({
      n: (this.read(id).conversation.at(-1)?.n ?? 0) + 1,
      at,
      line,
    });
    this.update(id, (session) => {
      session.conversation = [...session.conversation, entry].slice(-INTERVIEW_CONVERSATION_CAP);
    });
    return entry;
  }

  /**
   * The interview's own session id, as its `started` event reported it, so a
   * later start on the same provider continues the same conversation with
   * `--session`. An id names a session of the provider that reported it, so a
   * start on the other provider begins a new conversation instead.
   */
  recordInterview(
    id: string,
    interviewSession: string,
    interviewProvider: EditingSession["interviewProvider"],
  ): EditingSession {
    return this.update(id, (session) => {
      session.interviewSession = interviewSession;
      session.interviewProvider = interviewProvider;
    });
  }

  save(id: string, revision: number, repoId: string, form: EditingForm): EditingSession {
    const valid = EditingFormSchema.parse(form);
    this.io.repository(repoId);
    return this.update(id, (session) => {
      if (session.revision !== revision) throw new Error("These edits changed in another view. Your unsaved text is still here; reopen the saved session to compare.");
      if (pending(session.operation) || (session.operation && !session.operation.reconciled) || session.phase === "discarded") throw new Error("Wait for this editing operation to settle before changing its submitted fields.");
      if (session.repoId !== repoId && (session.key || session.operation)) throw new Error("This session is tied to its original repository.");
      if (session.repoId !== repoId) { session.phase = "editing"; session.error = null; }
      session.repoId = repoId;
      session.form = valid;
      session.revision++;
    });
  }

  /**
   * Mark a path for this draft, and optionally put it on the repository's
   * standing list (D-105). One edit: the draft's scope and the standing list
   * move together, and the history entry can put both back.
   *
   * The standing list is written before the session, and put back where the
   * session refuses the edit, so a person is never left with an entry no
   * history holds.
   */
  mark(
    id: string,
    revision: number,
    path: string,
    mark: DraftMark,
    always: boolean | null,
  ): EditingSession {
    const session = this.read(id);
    this.io.repository(session.repoId);
    if (session.revision !== revision)
      throw new Error("These edits changed in another view. Reopen the saved session before marking a path.");
    if (pending(session.operation) || session.phase === "working" || session.phase === "discarded")
      throw new Error("Wait for this editing operation to settle before marking a path.");
    const glob = standingGlob(path);
    const before = markOf(session.form, glob);
    const list = this.io.standing(session.repoId);
    const standingBefore = list.find((entry) => entry.path === glob) ?? null;
    const standingAfter =
      always === null
        ? standingBefore
        : always
          ? (standingBefore ?? {
              path: glob,
              draft: session.id,
              source: session.key ?? "this draft",
              added_at: new Date().toISOString(),
            })
          : null;
    const standingMoved = standingBefore !== standingAfter;
    if (standingMoved && standingBefore !== null && standingBefore.draft !== session.id)
      throw new Error(
        `${glob} is on this repository's standing list from ${standingBefore.source}. Change it where it was written.`,
      );
    if (before === mark && !standingMoved) return session;
    const summary = standingMoved
      ? standingAfter
        ? `Always prohibit ${glob} in this repository`
        : `Stop always prohibiting ${glob}`
      : mark === "allowed"
        ? `Allow ${glob}`
        : mark === "prohibited"
          ? `Prohibit ${glob}`
          : `Unmark ${glob}`;
    const edit: DraftEdit = {
      n: (session.history.at(-1)?.n ?? 0) + 1,
      at: new Date().toISOString(),
      author: "you",
      summary,
      undone: false,
      change: {
        kind: "mark",
        glob,
        before,
        after: mark,
        standing: standingMoved ? { before: standingBefore, after: standingAfter } : null,
      },
    };
    return this.write(session, edit, list, standingAfter);
  }

  /**
   * Reverse one edit, taking whatever it put on the standing list with it. An
   * edit a later one built on stays: putting it back would silently discard the
   * later edit, so the later one is named and undone first.
   */
  undo(id: string, revision: number, n: number): EditingSession {
    const session = this.read(id);
    this.io.repository(session.repoId);
    if (session.revision !== revision)
      throw new Error("These edits changed in another view. Reopen the saved session before undoing an edit.");
    if (pending(session.operation) || session.phase === "working" || session.phase === "discarded")
      throw new Error("Wait for this editing operation to settle before undoing an edit.");
    const entry = session.history.find((item) => item.n === n);
    if (!entry) throw new Error("That edit is not in this draft's history.");
    if (entry.undone) throw new Error("That edit is already undone.");
    const blocker = session.history.find(
      (item) => item.n > n && !item.undone && item.change.glob === entry.change.glob,
    );
    if (blocker)
      throw new Error(`Undo edit ${blocker.n} first: it changed ${entry.change.glob} after this one.`);
    const list = this.io.standing(session.repoId);
    const standing = entry.change.standing;
    if (standing && standing.after !== null) {
      const current = list.find((item) => item.path === entry.change.glob);
      if (current && current.draft !== session.id)
        throw new Error(
          `${entry.change.glob} is on this repository's standing list from ${current.source}. Change it where it was written.`,
        );
    }
    return this.write(
      session,
      { ...entry, undone: true },
      list,
      standing ? standing.before : (list.find((item) => item.path === entry.change.glob) ?? null),
      entry.change.before,
    );
  }

  /**
   * The one path both of the above take: the standing list first, the session
   * second, and the standing list put back if the session refuses.
   */
  private write(
    session: EditingSession,
    edit: DraftEdit,
    list: readonly StandingProhibitedEntry[],
    standing: StandingProhibitedEntry | null,
    mark: DraftMark = edit.change.after,
  ): EditingSession {
    const next = [
      ...list.filter((entry) => entry.path !== edit.change.glob),
      ...(standing ? [standing] : []),
    ];
    const moved = JSON.stringify(next) !== JSON.stringify(list);
    if (moved) this.io.setStanding(session.repoId, next);
    try {
      return this.update(session.id, (record) => {
        if (record.revision !== session.revision)
          throw new Error("These edits changed in another view. Reopen the saved session before marking a path.");
        applyMark(record.form, edit.change.glob, mark);
        record.history = [
          ...record.history.filter((item) => item.n !== edit.n),
          edit,
        ].sort((left, right) => left.n - right.n);
        record.revision++;
      });
    } catch (error) {
      if (moved) this.io.setStanding(session.repoId, [...list]);
      throw error;
    }
  }

  async submit(
    id: string,
    revision: number,
    operationId: string,
    intent: EditingOperation["intent"],
  ): Promise<EditingSession> {
    const session = this.read(id);
    this.io.repository(session.repoId);
    if (session.operation?.id === operationId) {
      if (session.operation.inputRevision !== revision || session.operation.intent !== intent)
        throw new Error("This operation identity was already used with different input.");
      return session;
    }
    if (session.revision !== revision || session.phase !== "editing" || pending(session.operation))
      throw new Error("Restore the current saved edits before submitting this contract.");
    if (session.form.editing !== null && (intent === "draft" || intent === "compile"))
      throw new Error("Save or discard the unfinished criterion before compiling.");
    if ((intent === "draft" || intent === "generate") && session.key)
      throw new Error("This session already has a Ticket. Start over from the spec to draft its plan again.");
    if (intent !== "draft" && intent !== "compile" && !session.specSlug)
      throw new Error("Write the spec before generating a plan from it.");
    if (intent === "startOver" && !session.key)
      throw new Error("There is no plan to start over from yet. Generate one from the spec first.");
    const request: EditingRequest = intent === "draft"
      ? { kind: "draft", repoId: session.repoId, outcome: session.form.draft.outcome, models: session.form.models }
      : intent === "generate"
        ? { kind: "generatePlan", repoId: session.repoId, id, models: session.form.models }
        : intent === "startOver"
          ? { kind: "startOver", repoId: session.repoId, id, key: session.key!, models: session.form.models }
          : session.key && session.digest
            ? { kind: "edit", repoId: session.repoId, key: session.key, digest: session.digest, draft: DraftSchema.parse(session.form.draft), models: session.form.models }
            : { kind: "admit", repoId: session.repoId, draft: DraftSchema.parse(session.form.draft), models: session.form.models };
    RequestSchema.parse(request);
    this.update(id, (next) => {
      next.revision++;
      next.phase = "working";
      next.error = null;
      next.operation = { id: operationId, intent, inputRevision: revision, jobId: null, state: "accepted", resultKey: null, error: null, reconciled: false };
    });
    try {
      await this.io.start(request, { sessionId: id, operationId });
    } catch (error) {
      // No job association means the host refused before dispatch (for example, an exclusive command already running).
      this.update(id, (next) => {
        if (next.operation?.id !== operationId) return;
        next.operation.error = String(error instanceof Error ? error.message : error);
        next.operation.state = "failed";
        next.operation.reconciled = next.operation.jobId === null;
        next.phase = next.operation.jobId === null ? "editing" : "outcome-unknown";
        next.error = next.operation.error;
      });
    }
    return this.read(id);
  }

  /** Called synchronously after slot reservation and before the CLI can run. */
  started(owner: EditingOwner, job: Job): void {
    this.update(owner.sessionId, (session) => {
      if (session.operation?.id !== owner.operationId || session.repoId !== job.repoId || session.key !== job.key)
        throw new Error("The editing operation does not belong to this job.");
      session.operation.jobId = job.id;
      session.operation.state = "running";
    });
  }

  async settled(job: Job): Promise<void> {
    const owner = job.editing;
    if (!owner) return;
    const session = this.io.records().find((entry) => entry.id === owner.sessionId);
    if (!session || session.operation?.id !== owner.operationId || session.operation.jobId !== job.id || session.repoId !== job.repoId) return;
    try {
      this.update(session.id, (next) => {
        next.operation!.state = job.state;
        next.operation!.resultKey = job.resultKey;
        next.operation!.error = job.error;
      });
      this.unsettled.delete(session.id);
    } catch (error) {
      this.unsettled.set(session.id, { job: structuredClone(job), error: String(error instanceof Error ? error.message : error) });
      throw error;
    }
    // The result identity is durable before the asynchronous canonical read.
    await this.reconcile(session.id);
  }

  private async reconcile(id: string): Promise<void> {
    const inflight = this.reconciling.get(id);
    if (inflight) return inflight;
    const session = this.read(id), operation = session.operation;
    if (!operation || operation.reconciled || pending(operation) || session.phase === "discarded") return;
    const work = (async () => {
      try {
        const key = operation.resultKey ?? session.key;
        const detail = key ? await this.io.detail(session.repoId, key) : null;
        if (detail && detail.ticket.key !== key) throw new Error("The recorded result belongs to another task.");
        this.update(id, (next) => {
          if (next.operation?.id !== operation.id || next.phase === "discarded" || next.revision !== session.revision) return;
          if (detail && operation.state === "completed" && operation.resultKey) {
            const otherEditor = this.io.records().find((entry) => entry.id !== id && entry.repoId === session.repoId &&
              entry.key === detail.ticket.key && entry.phase !== "discarded");
            if (!next.key && otherEditor) {
              next.phase = "conflict";
              next.error = "Another editor already holds this task. Your submitted fields remain here; open the current contract to continue from that editor.";
            } else {
              next.key = detail.ticket.key;
              next.digest = detail.digest;
              // Whether this plan has a graph, for the rail that cannot read a
              // contract from where it is drawn.
              next.nodes = planNodes(detail.contract).length;
              next.form = { ...next.form, draft: contractDraft(detail), step: 2, editing: null, newPath: null };
              next.phase = operation.intent === "draft" ? "editing" : "ready";
              // Generating a plan and starting over both land on a contract, as
              // compiling one does: the session now holds a Ticket.
              if (operation.intent !== "draft") next.resumeNew = false;
              next.error = null;
            }
          } else {
            next.phase = detail && detail.digest === next.digest && !detail.ticket.approved_at ? "editing" : "outcome-unknown";
            next.error = operation.error ?? "The operation stopped without a confirmed result. Check Home and the canonical contract before submitting again.";
          }
          next.operation.reconciled = true;
          next.revision++;
        });
      } catch (error) {
        this.update(id, (next) => {
          if (next.operation?.id !== operation.id || next.phase === "discarded" || next.revision !== session.revision) return;
          next.phase = "outcome-unknown";
          next.error = `Your edits and operation were saved, but the recorded result could not be read: ${String(error instanceof Error ? error.message : error)}`;
        });
      }
    })();
    this.reconciling.set(id, work);
    try { await work; } finally { this.reconciling.delete(id); }
  }

  async stop(id: string): Promise<EditingSession> {
    const session = this.read(id);
    if (session.operation?.jobId && pending(session.operation)) {
      await this.io.stop(session.operation.jobId);
      // The command may settle during cancellation; never regress its terminal receipt.
      if (pending(this.read(id).operation)) this.update(id, (next) => { next.operation!.state = "stopping"; });
    }
    return this.read(id);
  }

  discard(id: string, revision?: number): EditingSession {
    return this.update(id, (session) => {
      // A revision guards a discard made from an open editor against one that
      // has moved under it. A delete from the picker carries none — it is an
      // explicit "throw this draft away", not an edit of a known revision — so
      // only a pending operation, which a discard would race, still blocks it.
      if ((revision !== undefined && session.revision !== revision) || pending(session.operation))
        throw new Error("Wait for the current editing operation before discarding its saved edits.");
      session.phase = "discarded";
      session.resumeNew = false;
      session.revision++;
    });
  }
}

/**
 * The answer every part of a group carries whatever the session offered, so a
 * person with no view on a question can leave it to the interview rather than
 * picking one of its options to get past it. The dock offers it and the host
 * reads it back, so it is declared once here.
 */
export const LEAVE_IT_TO_THE_INTERVIEW = "Let the interview decide";

/** The letters a group's parts are read and answered under: 1a, 1b, 1c. */
export const PART_LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Whether one turn is this group's answer, in the shape the dock sends: the
 * option's own words for a single part, and the parts lettered as they were
 * read for more than one.
 *
 * Read back rather than flagged on the way in, so a person who types the
 * wording out themselves is answering as much as one who picked it, and so
 * nothing has to be threaded through the turn the host writes down.
 */
export function answersGroup(
  group: Extract<InterviewEntry["line"], { kind: "asked" }>["groups"][number],
  text: string,
): boolean {
  const offered = (part: (typeof group.parts)[number]): string[] => [
    ...part.options.map((option) => option.label),
    LEAVE_IT_TO_THE_INTERVIEW,
  ];
  if (group.parts.length === 1) return offered(group.parts[0]!).includes(text.trim());
  const lines = text.trim().split("\n");
  if (lines.length !== group.parts.length) return false;
  return group.parts.every((part, index) =>
    offered(part).some(
      (label) => lines[index]!.trim() === `${PART_LETTERS[index] ?? index + 1}) ${label}`,
    ),
  );
}

/** Which session a planning's interview runs on, from the models it drafts with. */
export function interviewProviderFor(models: { draftingProvider: string }): "claude" | "codex" {
  return models.draftingProvider === "codex-cli" ? "codex" : "claude";
}

/**
 * The argv `perbo interview` is started with, past the spec and the model:
 * the provider this planning drafts with, and the session to continue where
 * there is one of that provider's (D-102, SCP-312).
 *
 * A recorded id belongs to the provider that reported it and the two keep
 * separate namespaces, so a planning whose drafting choice has changed since
 * starts a session of its own rather than asking the new provider to continue
 * a conversation it has never had. An id recorded before the provider was
 * written down is Claude's, which is how `perbo interview` reads the record
 * beside the spec, so a planning in flight when this build arrives keeps its
 * session. Here rather than in the host because the rule is worth a test of
 * its own, and the host's own argv is built around it.
 */
export function interviewSessionArgs(session: {
  interviewSession: string | null;
  interviewProvider: "claude" | "codex" | null;
}, provider: "claude" | "codex"): string[] {
  const carries =
    session.interviewSession !== null && (session.interviewProvider ?? "claude") === provider;
  return carries ? ["--session", session.interviewSession!] : [];
}
