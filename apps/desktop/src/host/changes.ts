import type { WorkspaceReads } from "./workspace-reads.js";
import type { ProfileState } from "./profile/store.js";
import type { Change, ChangeInput, PowerState } from "../shared/protocol.js";

/**
 * What the renderer is told, and what a change means for what has been read.
 *
 * Every change carries the next sequence number, so a renderer can tell a
 * reply it asked for from a change it was pushed. A change to a repository's
 * records invalidates what was read of that repository; a change to the
 * connected repositories or to the person's preferences invalidates every
 * read, because a listing crosses repositories.
 */
export interface ChangesDeps {
  reads: WorkspaceReads;
  save(): void;
  emit(change: Change): void;
}

export class Changes {
  private count = 0;

  private readonly deps: ChangesDeps;

  constructor(deps: ChangesDeps) {
    this.deps = deps;
  }

  /** The number of the last change told. */
  get sequence(): number {
    return this.count;
  }

  changed(
    persist = true,
    change: ChangeInput = { kind: "records", repoId: null, key: null },
  ): void {
    if (change.kind === "records") this.deps.reads.invalidate(change.repoId ?? "all");
    if (change.kind === "repositories" || change.kind === "preferences")
      this.deps.reads.invalidate("all");
    if (persist) this.deps.save();
    this.deps.emit({ ...change, sequence: ++this.count });
  }

  /** The preferences as they now stand, which every surface reading a title or a mark needs. */
  preferences(state: ProfileState, persist = true): void {
    this.changed(persist, {
      kind: "preferences",
      settings: state.settings,
      titles: state.titles,
      taskModels: state.taskModels,
      archived: state.archived,
      asks: state.asks,
    });
  }

  /**
   * Whether the machine is being held awake (S6F). Nothing is persisted and
   * nothing is invalidated: it is a fact about this moment rather than about
   * anything that was read.
   */
  power(power: PowerState): void {
    this.deps.emit({ kind: "power", power, sequence: ++this.count });
  }
}
