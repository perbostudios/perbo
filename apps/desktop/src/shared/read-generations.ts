/**
 * The dirty-generation rule, which is how a read stays an account of the
 * records as they are ([ADR-0034](../../../../docs/adr/0034-desktop-read-model.md)).
 *
 * A read walks a repository's records over many turns of the loop, and a
 * mutation that lands part way through leaves the result an account of neither
 * the records before it nor the records after. So each scope carries a
 * generation, a read takes the generation it started at, and a read whose
 * generation moved under it is taken again rather than returned.
 *
 * Here rather than beside either caller because two need it: the host guards
 * what it reads off the disk, and the renderer guards what it asks the host
 * for. A second copy would be a second answer to one question.
 */
/** The scope every other scope is read under: invalidating it dirties them all. */
export const ALL_SCOPE = "all";
/** The whole workspace, which every invalidation dirties. */
export const SNAPSHOT_SCOPE = "snapshot";

export class ReadGenerations {
  private readonly generations = new Map<string, number>();

  /** Dirties `scope`, and the snapshot, which every invalidation dirties. */
  invalidate(scope: string): void {
    this.bump(scope);
    if (scope !== SNAPSHOT_SCOPE) this.bump(SNAPSHOT_SCOPE);
  }

  /** Stable while no invalidation of `scope` or of {@link ALL_SCOPE} has happened. */
  token(scope: string): string {
    return `${this.generations.get(ALL_SCOPE) ?? 0}:${this.generations.get(scope) ?? 0}`;
  }

  /**
   * Runs `load` until no invalidation of `scope` overlapped it.
   *
   * A failure is thrown only where nothing overlapped it; one that raced a
   * mutation is a failure to read records that have since moved, and the read
   * that follows is the account of what is there now.
   */
  async read<T>(scope: string, load: () => Promise<T>): Promise<T> {
    for (;;) {
      const token = this.token(scope);
      try {
        const result = await load();
        if (token === this.token(scope)) return result;
      } catch (error) {
        if (token === this.token(scope)) throw error;
      }
    }
  }

  private bump(scope: string): void {
    this.generations.set(scope, (this.generations.get(scope) ?? 0) + 1);
  }
}
