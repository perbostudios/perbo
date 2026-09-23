import { ReadGenerations } from "../shared/read-generations.js";

/**
 * Shares concurrent native reads; a mutation during a read requires a fresh
 * pass ({@link ReadGenerations}).
 *
 * Two surfaces asking for the same record while one read is in flight get that
 * read, and each gets its own copy of the result, so what one of them does with
 * it is not what the other sees.
 */
export class WorkspaceReads {
  private readonly generations = new ReadGenerations();
  private readonly pending = new Map<string, Promise<unknown>>();
  invalidate(scope: string): void {
    this.generations.invalidate(scope);
  }
  async read<T>(key: string, scope: string, load: () => Promise<T>): Promise<T> {
    let work = this.pending.get(key);
    if (!work) {
      work = this.generations.read(scope, load);
      this.pending.set(key, work);
      const clear = (): void => { if (this.pending.get(key) === work) this.pending.delete(key); };
      void work.then(clear, clear);
    }
    return structuredClone(await work) as T;
  }
}
