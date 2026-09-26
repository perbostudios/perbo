// The rule for what counts as a group's answer lives in the protocol, because
// the interview counts on it too: it refuses to draft while a group it asked
// is unanswered, and a second copy of the rule would let the two disagree.
import {
  LEAVE_IT_TO_THE_INTERVIEW,
  PART_LETTERS,
  answersGroup,
  planNodes,
  standingGlob,
  type StandingProhibitedEntry,
} from "@perbo/contracts/browser";
import type { DriftFinding, DriftVerdict } from "@perbo/planning/browser";
import {
  DraftSchema,
  EditingFormSchema,
  EditingSessionSchema,
  EVERY_PROBLEM_RESOLVED,
  INTERVIEW_CONVERSATION_CAP,
  InterviewEntrySchema,
  RequestSchema,
  TaskModelsSchema,
} from "./protocol.js";
import { specSlugOf } from "./spec-slug.js";
import type {
  Detail, Draft, DraftEdit, EditingChange, EditingForm, EditingOperation, EditingSession,
  EditingTarget, InterviewEntry, Job, LegacyEditing, OpenDraft, PlanningPane, PlanPromise, Request,
  SpecSections, TaskModels,
} from "./protocol.js";

type EditingRequest = Extract<
  Request,
  { kind: "admit" | "edit" | "generatePlan" | "startOver" }
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
  /**
   * The folder this repository keeps specs in (D-103), which a ticket's
   * recorded spec path is read against. Throws where it cannot be read.
   */
  specFolder(repoId: string): string;
  /** The repository's standing prohibited list (D-105), which the always box writes. */
  standing(repoId: string): StandingProhibitedEntry[];
  setStanding(repoId: string, entries: StandingProhibitedEntry[]): void;
  /**
   * The state a plan just drafted from its spec was read at by its drafting,
   * as {@link readingStateOf} states it: admission writes an agreeing verdict
   * beside the ticket (D-128), so where that verdict holds for the spec as it
   * now is, the plan the record holds has been read. Null where it does not,
   * and the plan is read when the person confirms it. Absent where the host
   * keeps no verdict.
   */
  drafted?(record: EditingSession): string | null;
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
    editing: null,
    criterion: { text: "", assertion: "", kind: "test" },
    newPath: null,
  };
}

const pending = (operation: EditingOperation | null): boolean =>
  operation !== null && ["accepted", "running", "stopping"].includes(operation.state);

/**
 * Whether two readings found the same problems: the same places, saying the
 * same difference, in any order. What a re-read is compared by before the
 * first is put to the person again (D-128).
 * The options are not compared: a model may word the ways to close it afresh
 * each reading, and that is not a new problem; nor is the order, which a
 * model may also give afresh, and a list the same but for its order is the
 * same list.
 */
export function sameProblems(
  left: readonly DriftFinding[],
  right: readonly DriftFinding[],
): boolean {
  const name = (finding: DriftFinding): string => `${finding.heading}\0${finding.difference}`;
  const named = new Set(left.map(name));
  const other = new Set(right.map(name));
  return named.size === other.size && [...named].every((entry) => other.has(entry));
}

/**
 * How a re-read that could not be started is said in the chat, with the
 * reason after it: the Problems pane matches the note by this sentence, since
 * the chat is not beside it and there is no job to read the failure off.
 */
export const REREAD_COULD_NOT_START = "The plan could not be read against the spec again";

/**
 * Why approving a ticket's contract is refused, in one sentence, while a
 * planning over it records problems open from a reading of its plan against
 * its spec; null where none does. Both hosts refuse a `run` that approves by
 * it, for an epic as for a basic ticket, so the hold the pages keep is not
 * the renderer's alone: the only ways past a problem are answering it on the
 * Problems page or changing the plan (D-NEW-basic-and-epic-flows).
 */
export function problemsHoldApproval(
  records: readonly EditingSession[],
  repoId: string,
  key: string,
): string | null {
  const held = records.some(
    (record) =>
      record.phase !== "discarded" &&
      record.repoId === repoId &&
      record.key === key &&
      (record.drift?.open.length ?? 0) > 0,
  );
  return held
    ? `${key} is not approved while its plan and its spec no longer promise the same thing: resolve each problem on the Problems tab, or change the plan, and confirm again.`
    : null;
}

/**
 * Where a planning's interview stood as a reading of its plan started: whether
 * a turn was in flight, and the last turn the person sent, by its entry's
 * number, or 0 before any.
 */
export interface TurnMark {
  working: boolean;
  turn: number;
  /** The planning's operation as the reading started: a draft after it replaces the plan read. */
  operation: string | null;
}
const lastTurnSent = (session: EditingSession): number =>
  session.conversation.findLast((entry) => entry.line.kind === "turn")?.n ?? 0;
export const turnMark = (session: EditingSession, working: boolean): TurnMark => ({
  working,
  turn: lastTurnSent(session),
  operation: session.operation?.id ?? null,
});
/**
 * Whether the plan was drafted again — Generate plan or Start over pressed —
 * since a reading that started at `mark`: what it read is a plan that has
 * gone, and a plan the model drafts from its spec is not read as it lands,
 * so both hosts record nothing of it (D-NEW-basic-and-epic-flows).
 */
export const redraftedSince = (mark: TurnMark, session: EditingSession): boolean => {
  const operation = session.operation;
  return (
    operation != null &&
    operation.id !== mark.operation &&
    (operation.intent === "generate" || operation.intent === "startOver")
  );
};
/**
 * Whether an interview turn overlapped a reading that started at `mark`: in
 * flight as it started or as it lands, or sent between the two
 * ({@link ContractEditing.landDrift}).
 */
export const turnOverlapped = (mark: TurnMark, session: EditingSession, working: boolean): boolean =>
  mark.working || working || lastTurnSent(session) !== mark.turn;

/**
 * The spec and the plan's promise as they stand at one moment, as both hosts
 * read them before and after whatever may move them: null on a side the
 * planning does not have — no spec folder yet, no plan drafted.
 */
export interface PromisePair {
  spec: SpecSections | null;
  plan: PlanPromise | null;
}

/** What a plan promises, read off its contract: the outcome and each criterion's words. */
export function promiseOf(contract: Detail["contract"]): PlanPromise {
  return {
    outcome: contract.outcome,
    criteria:
      "acceptance_criteria" in contract
        ? contract.acceptance_criteria.map((criterion) => ({ id: criterion.id, text: criterion.text }))
        : [],
  };
}

/** The five sections of a spec, without its title: what a change to the spec is measured by. */
export function sectionsOf({ outcome, requirements, no_gos, rabbit_holes, notes }: SpecSections): SpecSections {
  return { outcome, requirements, no_gos, rabbit_holes, notes };
}

/**
 * Where this plan and the spec it was drafted from disagree.
 *
 * Two questions, both answerable from ids alone and neither needing a model:
 * a requirement the spec states that no criterion answers, and a criterion
 * citing a requirement the spec no longer states. Read on the contract page,
 * which is where approving freezes both. Each host reads the spec's
 * requirements its own way and hands them here.
 */
export function specFindings(
  requirements: readonly { id: string | null; text: string }[],
  criteria: readonly { id: string; requirement_id?: string | undefined }[],
): Detail["specFindings"] {
  const stated = requirements.flatMap((each) => (each.id === null ? [] : [{ id: each.id, text: each.text }]));
  const states = new Map(stated.map((each) => [each.id, each.text]));
  const cited = new Map<string, string[]>();
  for (const criterion of criteria)
    if (criterion.requirement_id !== undefined)
      cited.set(criterion.requirement_id, [...(cited.get(criterion.requirement_id) ?? []), criterion.id]);
  return [
    ...stated
      .filter((each) => !cited.has(each.id))
      .map((each) => ({ kind: "uncited" as const, requirementId: each.id, criteria: [], text: each.text })),
    ...[...cited]
      .filter(([id]) => !states.has(id))
      .map(([id, criteria]) => ({ kind: "dangling" as const, requirementId: id, criteria, text: null })),
  ];
}

const EMPTY_SECTIONS: SpecSections = { outcome: "", requirements: "", no_gos: "", rabbit_holes: "", notes: "" };

/**
 * The change between two readings of the pair, or null where nothing moved
 * (D-128). Each side is compared by its
 * text: a save that wrote the same words, or an edit that rearranged a plan
 * without touching a promise, is not a change to mark. The first writing of
 * a thing is not a change to it either: a spec section written where it was
 * empty, or no spec at all, is read as unchanged, and a plan drafted where
 * there was none is not recorded, because the first words put into an empty
 * box are not an edit, and marking the whole of them green says nothing. A
 * later edit of those words is a change, recorded with who made it.
 */
export function changeBetween(
  before: PromisePair,
  after: PromisePair,
  at: string,
  by: EditingChange["by"],
): EditingChange | null {
  const spec = after.spec === null ? null : specChange(before.spec ?? EMPTY_SECTIONS, after.spec);
  const plan =
    before.plan !== null && after.plan !== null && JSON.stringify(before.plan) !== JSON.stringify(after.plan)
      ? { before: before.plan, after: after.plan }
      : null;
  return spec === null && plan === null ? null : { at, by, spec, plan };
}

/**
 * The spec's side of a change, or null where no section moved. A section
 * that was empty takes its new words as its before, so the two sides agree
 * on it and nothing in it is marked.
 */
function specChange(was: SpecSections, now: SpecSections): NonNullable<EditingChange["spec"]> | null {
  const before = { ...now };
  for (const field of Object.keys(EMPTY_SECTIONS) as (keyof SpecSections)[])
    if (was[field].trim().length > 0) before[field] = was[field];
  return JSON.stringify(before) === JSON.stringify(now) ? null : { before, after: now };
}

/**
 * A planning that holds nothing: opened fresh, and nothing put into it
 * (D-129).
 *
 * `revision` is the count of edits, so zero is "nothing edited" and covers the
 * form, the history, the nodes and the drift without naming any of them. The
 * rest are the things that are true at birth for a session opened over
 * something that already existed — a ticket carries `key`, a spec carries
 * `specSlug`, both at revision 0 — and the conversation, which is deliberately
 * not an edit and so never bumps `revision` (see `converse`): a turn the person
 * sent is writing, and `revision` alone cannot see it. The pane the person was
 * last on is not asked about: looking around a planning puts nothing into it
 * (see `visit`).
 */
export function untouchedPlanning(session: EditingSession): boolean {
  return (
    session.phase === "editing" &&
    session.revision === 0 &&
    session.key === null &&
    session.specSlug === null &&
    session.operation === null &&
    session.conversation.length === 0 &&
    !session.resumeNew
  );
}

/**
 * A spec as a host reads it from where it keeps specs: its title, and its
 * five sections where they were read, or null where there is no spec.
 */
export type SpecReader = (repoId: string, slug: string) => { title: string; sections: SpecSections | null } | null;

/**
 * A short fingerprint of a text, the same in every process that computes it:
 * for telling whether something moved, never for trusting what it is. Two
 * 32-bit FNV-1a lanes with different offsets, as 16 hex digits.
 */
export function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/**
 * The state a reading of the plan against its spec is of: the spec's
 * sections, as the host fingerprints them onto the drafts list, and the
 * plan's promise — its outcome and each criterion's words, sorted, which is
 * what the reading reads and all it reads of the plan (D-128). While it is the
 * state recorded as the last reading's (`read`), nothing that reading judged
 * has moved, and a basic ticket's Confirm contract needs no reading of its own
 * (D-NEW-basic-and-epic-flows).
 */
export function readingState(
  spec: string | null,
  promise: { outcome: string; criteria: readonly { text: string }[] },
): string {
  return fingerprint(
    JSON.stringify([spec, promise.outcome.trim(), promise.criteria.map((criterion) => criterion.text.trim()).sort()]),
  );
}

/**
 * {@link readingState} of a planning as its record holds it now: the spec's
 * fingerprint as the drafts list carries it, and the plan the session holds.
 * The state a host records a reading it asked for itself at — a re-read owed
 * once a turn ends, and the reading of a plan drafted again from a stopped
 * run — so the confirm, which compares the same two, reads nothing again.
 */
export function readingStateOf(record: EditingSession, spec: SpecReader): string {
  return readingState(openDrafts([record], spec)[0]?.spec ?? null, record.form.draft);
}

/**
 * The sessions a person can pick up again, newest first. Both hosts put this
 * on the snapshot, each reading a spec from where it keeps specs (`spec`,
 * null where there is none): its title, where a title that is still the cut
 * the folder was named from is none (D-118), and a fingerprint of its
 * sections, which is the spec's part of the state the contract was reached
 * at (D-NEW-basic-and-epic-flows).
 */
export function openDrafts(records: readonly EditingSession[], spec: SpecReader): OpenDraft[] {
  return records
    .filter((record) => record.phase !== "discarded")
    .map((record) => {
      const text = record.specSlug === null ? null : spec(record.repoId, record.specSlug);
      return {
      id: record.id,
      repoId: record.repoId,
      key: record.key,
      admitted: record.admitted,
      outcome: record.form.draft.outcome,
      phase: record.phase,
      nodes: record.nodes,
      drift:
        record.drift === null
          ? null
          : { open: record.drift.open.length, resolved: record.drift.resolved },
      scope: { paths: [...record.form.draft.paths], prohibited: [...record.form.draft.prohibited] },
      specSlug: record.specSlug,
      title: titleOfSpec(record, text?.title ?? null),
      lastPane: record.lastPane,
      confirmed: record.confirmed,
      read: record.read,
      spec: text?.sections == null ? null : fingerprint(JSON.stringify(sectionsOf(text.sections))),
      impact: record.impact,
      };
    })
    .reverse();
}

function titleOfSpec(record: EditingSession, stated: string | null): string | null {
  const title = stated?.trim();
  return !title || title === record.specCut ? null : title;
}

/** A title on one line, as the spec's title line and a ticket's name hold it. */
const oneLineTitle = (title: string): string => title.replace(/\s+/g, " ").trim().slice(0, 500);

/**
 * Whether a spec save changed the title its writer read: the person typed
 * one. Spacing alone changes no title.
 */
export const titleChanged = (save: { title: string; base: { title: string } }): boolean =>
  oneLineTitle(save.title) !== oneLineTitle(save.base.title);

/**
 * Whether the plan is drafted under the name the person gave the work, with
 * `admit --keep-title` (D-127): they were the last to title this planning's
 * spec, and the spec still states that title.
 */
export function keepsPersonsTitle(session: EditingSession, specTitle: string | null): boolean {
  return session.named?.by === "person" && specTitle !== null && oneLineTitle(specTitle) === session.named.title;
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
      // A spec has one planning at a time, which is the whole of what D-103's
      // one-folder-one-spec rule is protecting: opening a spec already being
      // written returns that planning rather than starting a second beside it.
      if (target.kind === "spec")
        return records.find(
          (entry) =>
            entry.repoId === target.repoId &&
            entry.specSlug === target.slug &&
            entry.phase !== "discarded",
        );
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
          // Named from birth for a spec being reopened, so the first save
          // writes the folder that is already there rather than minting a
          // second from the same title.
          specSlug: target.kind === "spec" ? target.slug : null,
          specCut: null,
          named: null,
          lastPane: null,
          confirmed: null,
          read: null,
          impact: null,
          drift: null,
          change: null,
          phase: legacy?.pending ? "outcome-unknown" : "editing",
          error: legacy?.pending ? "An older draft has an unconfirmed job. Your text is preserved; check Home before submitting again." : null,
          operation: null,
          interviewModel: null,
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
      // A spec folder the configuration cannot name is no slug to fill in.
      let drafted: string | null;
      try {
        drafted = specSlugOf(detail.ticket.admission.spec?.path, this.io.specFolder(current.repoId));
      } catch {
        drafted = null;
      }
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
        // And which spec it was drafted from, for the same reason: a planning
        // opened over a ticket — from the picker, or one the command line
        // admitted — never saw the save that named the folder, so without this
        // its Spec pane has nothing to read while its Graph shows the plan
        // drafted from that very file (D-103).
        //
        // The ticket is where the answer is: admission records the spec's path,
        // and the slug is the folder it names inside this repository's spec
        // folder, as `specSlugOf` reads it for the host. Only filled in, never
        // corrected, because a session already writing a spec is writing the
        // one it knows.
        if (next.specSlug === null && drafted !== null) next.specSlug = drafted;
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
   * lives in the repository, not here. `cut` is the title line the host wrote,
   * Untitled, where the person's first turn is what named the folder (D-118).
   */
  recordSpec(id: string, slug: string, cut: string | null = null): EditingSession {
    return this.update(id, (session) => {
      if (session.specSlug === slug) return;
      session.specSlug = slug;
      session.specCut = cut;
      session.revision++;
    });
  }

  /**
   * The person titled this planning's spec from the Spec pane: the name they
   * gave is the one the plan is drafted under and the spec keeps (D-127).
   */
  personTitled(id: string, title: string): void {
    const given = oneLineTitle(title);
    if (given.length === 0) return;
    this.update(id, (session) => {
      session.named = { by: "person", title: given };
    });
  }

  /**
   * Who named the spec, carried from the planning of a stopped plan to the
   * one over the plan drafted again from the same spec: the name is the
   * spec's, and planning it again does not take it from the person (D-127).
   */
  carryNamed(id: string, named: EditingSession["named"]): void {
    if (named === null) return;
    this.update(id, (session) => {
      session.named = { ...named };
    });
  }

  /**
   * A turn of the chat left this planning's spec with a title other than the
   * one it began with: the Architect titled it. A title that is still the one
   * the host wrote as it named the folder names nobody's work (D-118), and one
   * that is already the recorded name was not changed by the turn, whoever
   * saved it while the turn ran.
   */
  architectTitled(id: string, title: string): void {
    const written = oneLineTitle(title);
    this.update(id, (session) => {
      if (!written || written === session.specCut || written === session.named?.title) return;
      session.named = { by: "architect", title: written };
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
   * End the asking without a turn: what it put no longer waits on the person
   * — a problem between the plan and the spec that a reading found closed,
   * because they moved the plan or the spec by hand rather than answering.
   * The line stays in the conversation to be read.
   */
  endAsking(id: string): void {
    this.update(id, (session) => {
      session.asking = null;
    });
  }

  /**
   * Take the ticket already drafted from this planning's spec.
   *
   * A ticket admitted at the command line is reconciled by nothing, so the
   * planning that wrote its spec still holds no ticket: the rail offers no
   * Graph over a plan that exists, and the plan is reachable only as a second
   * row in the picker, which makes one piece of work look like two (D-101,
   * D-103). This is the planning finding it.
   *
   * Only ever fills a session holding none. One already on a ticket re-drafted
   * its own plan, and the key it has is the key to keep.
   *
   * Leaves `revision` where it stands, as {@link countNodes} does and for the
   * same reason: this is not an edit of what the person is editing, and a bump
   * would make a spec save in flight stale for a change they did not make.
   */
  adopt(id: string, detail: Detail, nodes: number): EditingSession {
    return this.update(id, (session) => {
      if (session.key !== null || session.phase === "discarded") return;
      session.key = detail.ticket.key;
      session.digest = detail.digest;
      session.nodes = nodes;
      // And the contract's own fields, exactly as {@link reconcile} takes them
      // when it adopts one: the form still holds `editingForm`'s placeholder
      // scope, and a session carrying a scope the contract does not is a
      // planning the contract page reads as having unsaved paths — which
      // blocks approving it and points at an editor this planning never used.
      session.form = { ...session.form, draft: contractDraft(detail), editing: null, newPath: null };
      // Not this planning's ticket to have made: whether it was is what lets a
      // planning's own discard take its ticket with it, and a planning that
      // finds a ticket already drafted from its spec — one the command line
      // admitted — is opening somebody else's work. Claimed only where a
      // caller watched the admission happen, which is {@link settled}'s job
      // and never this one's.
      session.admitted = false;
      session.resumeNew = false;
    });
  }

  /**
   * Write down how many nodes this planning's plan has.
   *
   * The rail is drawn where a contract cannot be read, so it asks this rather
   * than the plan itself ({@link ../renderer/planning/panes.ts}). Recorded
   * wherever the plan moves, which is a job settling, a contract being read
   * again, and an edit — an edit divides a plan or puts one back together just
   * as a draft does.
   */
  countNodes(id: string, nodes: number, digest?: string, plan?: Detail): void {
    this.update(id, (session) => {
      session.nodes = nodes;
      // And the plan as it now reads, where the caller had it.
      //
      // The form is what the criteria pane draws and what its Next sends back:
      // left at the contract this session last saw, the pane shows the plan as
      // it was before the interview's edit, and moving on writes that stale
      // copy over an edit that really happened — against a digest that has
      // since caught up, so nothing refuses it.
      //
      // Not while a criterion is open: that text is being typed, and a session
      // is allowed to lose a race it is not in the middle of.
      if (plan !== undefined && session.form.editing === null)
        session.form = { ...session.form, draft: contractDraft(plan), newPath: null };
      // And the contract this planning is now on, where the caller read one.
      //
      // The interview writes the contract through `perbo edit`, in its own
      // process, so a session that did not follow it still holds the digest of
      // the contract as it was: reopening the planning finds the file changed
      // and calls it somebody else's edit, which is the conflict {@link open}
      // is there to catch and this is not one. A session the interview drafted
      // holds a ticket from {@link adopt} on, so this holds for it too.
      if (digest !== undefined) session.digest = digest;
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
   * Write down the pane the person is now on, which is where the planning
   * reopens (D-130).
   *
   * Leaves `revision` where it stands, as {@link converse} does: moving
   * between panes puts nothing into the planning, so a planning opened fresh
   * and only looked around in is still one {@link untouchedPlanning} throws
   * away, and a save in flight is not made stale by the person looking
   * elsewhere. Where the person already is writes nothing, and a discarded
   * planning is reopened nowhere.
   */
  visit(id: string, pane: Exclude<PlanningPane, "contract">): EditingSession {
    const session = this.read(id);
    if (session.lastPane === pane || session.phase === "discarded") return session;
    return this.update(id, (next) => {
      next.lastPane = pane;
    });
  }

  /**
   * Write down that the person is now on this planning's contract, which is
   * where the planning reopens (D-130),
   * and the state they reached it at, which keeps the contract a tab of the
   * planning until that state moves (D-NEW-basic-and-epic-flows),
   * as {@link visit} writes a pane: no revision moves, and a discarded
   * planning records nothing.
   */
  visitContract(id: string, state: string): EditingSession {
    const session = this.read(id);
    if ((session.lastPane === "contract" && session.confirmed === state) || session.phase === "discarded")
      return session;
    return this.update(id, (next) => {
      next.lastPane = "contract";
      next.confirmed = state;
    });
  }

  /**
   * How many paths the impact check of this planning's draft just found
   * outside its scope (D-NEW-basic-and-epic-flows).
   * Leaves `revision` where it stands, as {@link visit} does: a check puts
   * nothing into the planning.
   */
  recordImpact(id: string, outside: number): void {
    const session = this.read(id);
    if (session.impact === outside || session.phase === "discarded") return;
    this.update(id, (next) => {
      next.impact = outside;
    });
  }

  /**
   * The state of the spec and the plan's promise a reading of the two has just
   * landed of (D-NEW-basic-and-epic-flows). Leaves `revision` where it
   * stands, as {@link recordImpact} does: a reading puts nothing into the
   * planning.
   */
  recordRead(id: string, state: string): void {
    const session = this.read(id);
    if (session.read === state || session.phase === "discarded") return;
    this.update(id, (next) => {
      next.read = state;
    });
  }

  /**
   * The interview's own session id, as its `started` event reported it, so a
   * later start on the same provider continues the same conversation with
   * `--session`. An id names a session of the provider that reported it, so a
   * start on the other provider begins a new conversation instead. The model
   * the session was started on is recorded beside it, for the chat to name.
   */
  recordInterview(
    id: string,
    interviewSession: string,
    interviewProvider: EditingSession["interviewProvider"],
    interviewModel: string | null,
  ): EditingSession {
    return this.update(id, (session) => {
      session.interviewSession = interviewSession;
      session.interviewProvider = interviewProvider;
      session.interviewModel = interviewModel;
    });
  }

  /**
   * What the last reading of the plan against its spec found
   * (D-128): the problems still open,
   * or none. None after problems were open is the reading that resolved them,
   * which is recorded as such so the page can offer the contract; none where
   * none were ever open is nothing to record, and the session stays without a
   * Problems pane. Leaves `revision` where it stands, as {@link converse}
   * does: nothing the person is editing has changed.
   */
  recordDrift(id: string, open: readonly DriftFinding[]): void {
    this.update(id, (session) => {
      const previous = session.drift;
      if (open.length === 0 && previous === null) return;
      session.drift = { open: [...open], resolved: open.length === 0 && previous !== null };
    });
  }

  /**
   * Forget the problems: they were dismissed at the command line, or the plan
   * was approved, and either way there is nothing left to put to anyone.
   */
  clearDrift(id: string): void {
    this.update(id, (session) => {
      session.drift = null;
    });
  }

  /**
   * What a reading does to the planning it was of
   * (D-128): the problems it found go
   * on the session, and the first of them is put to the person as a question
   * of the interview's own shape, so the Problems pane and the chat show the
   * same card and either answers it with a turn. None found, after some were,
   * is the reading that resolved them: recorded so, and said as a note —
   * once, since a reading that finds none after that is nothing new. A
   * dismissed reading clears them, and problems found again
   * after a resolved round re-open them: a hand rewording after the round is
   * what that is.
   *
   * One problem at a time, and never the same one twice while its card is
   * up: a re-read that finds the same list — the interview's turn did not
   * close the one in hand — leaves the record as it is, and puts the first
   * again only where no question stands, because an answer that was not one
   * took the card down and the person is left with nothing to answer.
   *
   * Nothing is put, and nothing resolved, by a reading the interview's turn
   * overlapped — one in flight as it started or as it landed, or sent between
   * the two — because it read a plan that turn may still be moving, and an
   * answer it has not applied yet would find its problem put straight back.
   * The turn's end owes the planning a reading that did not overlap it — or,
   * where the turn had ended as this one landed, this one's settling does —
   * which puts or resolves; this one leaves the record as it stands, and
   * writes one only where there was none, so the owed reading has a record to
   * read against.
   *
   * Both hosts land a reading here, once they have checked the plan is still
   * one the person has not gone past; `say` is the host's own relay into the
   * chat, and `askingChanged` tells the dock.
   */
  landDrift(
    id: string,
    verdict: DriftVerdict,
    overlapped: boolean,
    say: (line: InterviewEntry["line"]) => InterviewEntry | null,
    askingChanged: () => void,
  ): void {
    const session = this.read(id);
    if (verdict.dismissed) {
      if (session.drift !== null) this.clearDrift(id);
      return;
    }
    if (overlapped) {
      if (session.drift === null && verdict.findings.length > 0) this.recordDrift(id, verdict.findings);
      return;
    }
    // The line the question in front of the person arrived on, if one stands:
    // the interview's own, or one of the problems put by a reading.
    const standing =
      session.asking === null
        ? undefined
        : session.conversation.find((entry) => entry.n === session.asking!.entry)?.line;
    if (verdict.findings.length === 0) {
      if (session.drift === null || session.drift.resolved) return;
      // A problem's card still up was closed by hand rather than answered —
      // the person moved the plan or the spec themselves, and this reading
      // found nothing — so the card comes down with the problems: left
      // standing, it would put a problem that is gone, and the Problems page
      // would withhold the way on for it.
      if (standing?.kind === "asked" && standing.drift !== undefined) {
        this.endAsking(id);
        askingChanged();
      }
      this.recordDrift(id, []);
      say({ kind: "note", text: EVERY_PROBLEM_RESOLVED, notable: true });
      return;
    }
    const same = session.drift !== null && !session.drift.resolved && sameProblems(session.drift.open, verdict.findings);
    if (same && session.asking !== null) return;
    if (!same) this.recordDrift(id, verdict.findings);
    // A question the interview is asking of its own stands ahead of the
    // problems: it is waiting on the answer, and a problem put over it would
    // be answered as if it were that question. The record holds the problems
    // meanwhile, and the reading after the interview's answer puts the first.
    if (standing?.kind === "asked" && standing.drift === undefined) return;
    const open = same ? session.drift!.open : verdict.findings;
    const first = open[0]!;
    const asked = say({
      kind: "asked",
      groups: [{ title: first.heading, parts: [{ question: first.difference, options: first.options }] }],
      drift: { open: open.length },
    });
    if (asked !== null && asked.line.kind === "asked") {
      this.beginAsking(id, asked.n);
      askingChanged();
    }
  }

  /**
   * The last change to the spec and the plan's promise
   * (D-128): what the panes mark, until
   * the next change replaces it whole. The previous change is gone the moment
   * this one lands — nothing accumulates, because the marks are for the last
   * thing that happened and not a history. Leaves `revision` where it stands,
   * as {@link converse} does: nothing the person is editing has changed by
   * the record of it.
   */
  recordChange(id: string, change: EditingChange): void {
    this.update(id, (session) => {
      session.change = change;
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
    if (session.form.editing !== null && intent === "compile")
      throw new Error("Save or discard the unfinished criterion before compiling.");
    if (intent === "generate" && session.key)
      throw new Error("This session already has a Ticket. Start over from the spec to draft its plan again.");
    if (intent !== "compile" && !session.specSlug)
      throw new Error("Write the spec before generating a plan from it.");
    if (intent === "startOver" && !session.key)
      throw new Error("There is no plan to start over from yet. Generate one from the spec first.");
    const request: EditingRequest = intent === "generate"
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
              // Admitted by this planning only where it held no ticket before:
              // a session that started over on one it was opened with did not
              // make that ticket, however much of it the re-draft replaced.
              if (next.key === null) next.admitted = true;
              next.key = detail.ticket.key;
              next.digest = detail.digest;
              // Whether this plan has a graph, for the rail that cannot read a
              // contract from where it is drawn.
              next.nodes = planNodes(detail.contract).length;
              next.form = { ...next.form, draft: contractDraft(detail), editing: null, newPath: null };
              // A plan drafted afresh has had no impact check: the last one
              // was of the plan it replaces. It counts as satisfying the spec
              // the model drafted it from: its reading is the one its drafting
              // wrote, where that still holds, so its first confirm unchanged
              // reads nothing again, and the problems a reading found in the
              // plan it replaces go with that plan, so it never lands on
              // Problems (D-NEW-basic-and-epic-flows).
              if (operation.intent !== "compile") {
                next.impact = null;
                next.read = this.io.drafted?.(next) ?? null;
                next.drift = null;
              }
              // Every operation lands on a contract: the session now holds a Ticket.
              next.phase = "ready";
              next.resumeNew = false;
              next.error = null;
            }
          } else {
            // A first draft from the spec that failed, was cancelled or was
            // interrupted before any ticket was read back leaves the planning
            // editable with the operation's error, since `submit` refuses to
            // generate for a session that holds a key and `admit --from-spec`
            // refuses a second live ticket from one spec.
            const draftStopped = detail === null && operation.intent === "generate" &&
              ["failed", "cancelled", "interrupted"].includes(operation.state);
            next.phase = draftStopped || (detail && detail.digest === next.digest && !detail.ticket.approved_at) ? "editing" : "outcome-unknown";
            next.error = operation.error ?? (draftStopped && operation.state === "cancelled" ? null :
              "The operation stopped without a confirmed result. Check Home and the canonical contract before submitting again.");
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

export { LEAVE_IT_TO_THE_INTERVIEW, PART_LETTERS, answersGroup };

/**
 * The model the chat runs on wherever its provider offers it (D-102): Claude
 * Opus 5.5, on Claude Code.
 */
export const CHAT_MODEL = "claude-opus-5-5";

/**
 * The model `perbo interview` is started on: {@link CHAT_MODEL} where this
 * planning drafts on Claude Code and that provider's catalog lists it, under
 * its own id or its 1M-context one, and otherwise the model this planning
 * drafts with, which is the person's own default executor. `offered` is the
 * catalog's ids, or null where none could be read, which offers nothing.
 */
export function interviewModelFor(
  models: { draftingProvider: string; executorModel: string },
  offered: readonly string[] | null,
): string {
  if (models.draftingProvider !== "claude-cli" || offered === null) return models.executorModel;
  return [CHAT_MODEL, CHAT_MODEL + "[1m]"].find((id) => offered.includes(id)) ?? models.executorModel;
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
