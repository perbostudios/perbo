import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/** A source of temporary directories that also knows how to take them back. */
export interface Scratch {
  /**
   * A new directory under the temporary directory, named from `prefix`.
   *
   * `tmpdir()` is read on every call, so `TMPDIR` — which turbo drops and the
   * runner points inside a checkout — decides where this one lands rather than
   * wherever the process started.
   */
  (prefix?: string): string;
  /**
   * Remove every directory made so far and forget them.
   *
   * `maxRetries` is what `rm` offers for the race this hits on a loaded
   * machine: a process the test spawned is still writing into the tree as it is
   * removed, and the first pass fails with ENOTEMPTY. Beyond that it is best
   * effort — a directory that will not go is a leak, not a failure, and is left
   * rather than thrown.
   */
  removeAll(): void;
}

/**
 * Temporary directories whose lifetime the caller decides.
 *
 * `mkdtempSync` hands a directory to the caller and never takes it back, so a
 * suite that only ever makes them fills the temporary directory with
 * repositories, worktrees and bundle stores. Use this where removal happens on
 * some other event than the end of a test file; `scratchDirectories` is the
 * common case.
 */
export function createScratch(defaultPrefix = "perbo-test-"): Scratch {
  const made: string[] = [];
  const scratch = (prefix = defaultPrefix): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
  scratch.removeAll = (): void => {
    for (const dir of made.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Left behind; the next `git status` is where it will be noticed.
      }
    }
  };
  return scratch;
}

/**
 * Temporary directories that live as long as the test file that made them.
 *
 * Call it once, at the top level of a test file: the `afterAll` belongs to the
 * file that calls it, which is the lifetime a `beforeAll` fixture needs.
 * Nothing in this package registers a hook on import, so a file that imports it
 * and never calls it gets no hook at all.
 */
export function scratchDirectories(defaultPrefix?: string): Scratch {
  const scratch = createScratch(defaultPrefix);
  afterAll(() => {
    scratch.removeAll();
  });
  return scratch;
}
