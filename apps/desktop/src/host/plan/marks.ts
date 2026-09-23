import { redact } from "../process.js";
import { specSectionsAt } from "./spec.js";
import { changeBetween, promiseOf, type PromisePair } from "../../shared/contract-editing.js";
import type { ContractEditing } from "../../shared/contract-editing.js";
import type { RegisteredRepository } from "../profile/store.js";
import type {
  Detail,
  EditingChange,
  EditingSession,
  InterviewEntry,
  PlanPromise,
} from "../../shared/protocol.js";

export interface MarksDeps {
  editing: Pick<ContractEditing, "read" | "recordChange">;
  /** Every planning this host keeps, live or not. */
  sessions(): readonly EditingSession[];
  repository(id: string): RegisteredRepository;
  contract(repo: RegisteredRepository, key: string): { contract: Detail["contract"] };
  /** A line in the planning's chat, where a change could not be marked. */
  say(id: string, line: InterviewEntry["line"]): void;
}

/**
 * The last change to what a planning's spec states and its plan promises,
 * marked on the panes that read them
 * (D-128).
 *
 * The spec and the plan's promise are read before and after whatever may move
 * them — a turn of the chat, an edit, a save, a re-draft — and the two readings
 * compared; the change between them is recorded on every live planning over
 * the same spec or the same ticket. Nothing is recorded where the two readings
 * say the same, so a turn that only talked, or an edit that only rearranged
 * the graph, leaves the marks of the last real change standing.
 */
export class ChangeMarks {
  private readonly deps: MarksDeps;

  constructor(deps: MarksDeps) {
    this.deps = deps;
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
      const session = this.deps.editing.read(id);
      const repo = this.deps.repository(repoId ?? session.repoId);
      return {
        spec: session.specSlug === null ? null : specSectionsAt(repo, session.specSlug),
        plan: session.key === null ? null : this.promiseAt(repo, session.key),
      };
    } catch {
      return null;
    }
  }

  /** What the ticket's plan promises, or null where its contract cannot be read. */
  promiseAt(repo: RegisteredRepository, key: string): PlanPromise | null {
    try {
      return promiseOf(this.deps.contract(repo, key).contract);
    } catch {
      return null;
    }
  }

  /**
   * Record on this planning what changed since `before`, where anything did
   * and both readings could be made.
   */
  recordChangeSince(id: string, before: PromisePair | null | undefined, repoId?: string): void {
    if (before === undefined || before === null) return;
    const after = this.pairOf(id, repoId);
    if (after === null) return;
    const change = changeBetween(before, after, new Date().toISOString());
    if (change !== null) this.markChange(id, change);
  }

  /**
   * Record the change between two readings, where anything moved, on every
   * live planning `on` names: an edit reaches the ticket's records through one
   * command whoever asked for it, and a save writes the one spec file, so each
   * planning drawing either marks the same change.
   */
  markChangeOn(
    before: PromisePair,
    after: PromisePair,
    on: (session: EditingSession) => boolean,
  ): void {
    const change = changeBetween(before, after, new Date().toISOString());
    if (change === null) return;
    for (const session of this.deps.sessions())
      if (session.phase !== "discarded" && on(session)) this.markChange(session.id, change);
  }

  /** Record a change to what this ticket's plan promises on every planning over it. */
  recordPlanChange(repo: RegisteredRepository, key: string, before: PlanPromise | null): void {
    if (before === null) return;
    const after = this.promiseAt(repo, key);
    if (after !== null)
      this.markChangeOn(
        { spec: null, plan: before },
        { spec: null, plan: after },
        (session) => session.repoId === repo.id && session.key === key,
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
      this.deps.editing.recordChange(id, change);
    } catch (error) {
      this.deps.say(id, {
        kind: "note",
        text: `The change could not be marked on the panes: ${redact(
          error instanceof Error ? error.message : String(error),
        )}`.slice(0, 12_000),
      });
    }
  }
}
