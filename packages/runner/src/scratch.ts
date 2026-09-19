import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The executor's temporary directory, inside the boundary (SCP-166).
 *
 * The write guard refuses a write that lands outside the attempt's worktree,
 * `/tmp` included, and the refusal ends the attempt. Telling the executor so is
 * a request; pointing `TMPDIR` at a directory the boundary contains is the
 * control, and it is what an agent's `/tmp` habit follows without being asked.
 *
 * The path is the runner's, computed from the worktree it provisioned. Nothing
 * a model returned reaches it.
 *
 * It sits at the worktree root rather than beside the code being changed
 * because a package's own `vitest run` collects test files under a
 * `.perbo-tmp/` inside that package — measured on this repository, where a
 * `packages/runner/.perbo-tmp/probe.test.ts` was collected — and no package's
 * run reaches the root.
 *
 * Keeping it out of the change set is the seal's job, not a `.gitignore` entry
 * and not an exclude file: both of those are writes the runner would make
 * outside the attempt's worktree, which is the boundary this ticket exists to
 * hold. `SCRATCH_EXCLUDE_PATHSPEC` is how the seal does it.
 */

/** The directory's name inside the worktree. */
export const SCRATCH_DIR_NAME = ".perbo-tmp";

/**
 * The pathspec that keeps the directory out of every file list the seal builds.
 * A directory pathspec covers everything under it, so one entry is the tree.
 */
export const SCRATCH_EXCLUDE_PATHSPEC = [".", `:(exclude)${SCRATCH_DIR_NAME}`] as const;

/** Where `TMPDIR` points for an attempt in `worktree`. */
export function scratchPath(worktree: string): string {
  return join(resolve(worktree), SCRATCH_DIR_NAME);
}

/**
 * The three names a program reads to find a temporary directory.
 *
 * All three, because which one is consulted is the callee's choice: Node reads
 * `TMPDIR` first and falls back to `TMP` and `TEMP`, Python's `tempfile` reads
 * all three in that order, and a shell script may read whichever it was written
 * against. Setting one and leaving the others inherited leaves the host's `/tmp`
 * reachable through the other two.
 */
export const TEMPORARY_DIRECTORY_VARIABLES = ["TMPDIR", "TMP", "TEMP"] as const;

/** All three names pointing at the attempt's scratch directory. */
export function scratchEnvironment(scratch: string): Record<string, string> {
  return Object.fromEntries(TEMPORARY_DIRECTORY_VARIABLES.map((name) => [name, scratch] as const));
}

/**
 * The three names as the runner's own process received them, read at load.
 *
 * Read once, and before the runner composes any child environment, so what it
 * hands the checks is the host's own values and not a scratch path that some
 * later step put in `process.env`. A name this process was started without is
 * absent here, and stays absent downstream.
 */
export const HOST_TEMPORARY_DIRECTORY: Readonly<NodeJS.ProcessEnv> = Object.freeze(
  Object.fromEntries(
    TEMPORARY_DIRECTORY_VARIABLES.filter((name) => process.env[name] !== undefined).map(
      (name) => [name, process.env[name]] as const,
    ),
  ),
);

/**
 * `env` with the three names restored to the host's (SCP-168).
 *
 * The scratch directory is the executor's, and the pinned checks are not the
 * executor: a check runs the repository's own suite, which is written against
 * the temporary directory a developer's machine and CI give it. A suite that
 * lays a directory out under `os.tmpdir()` to mean "no repository above this"
 * is right there and wrong only under a `TMPDIR` inside the worktree.
 *
 * A name the runner has no value for is deleted rather than left as it was:
 * leaving it would keep the scratch directory reachable through whichever of
 * the three the callee happens to read.
 */
export function hostTemporaryEnvironment(
  env: NodeJS.ProcessEnv,
  host: Readonly<NodeJS.ProcessEnv> = HOST_TEMPORARY_DIRECTORY,
): NodeJS.ProcessEnv {
  const composed: NodeJS.ProcessEnv = { ...env };
  for (const name of TEMPORARY_DIRECTORY_VARIABLES) {
    const value = host[name];
    if (value === undefined) delete composed[name];
    else composed[name] = value;
  }
  return composed;
}

/** Create the attempt's scratch directory. Its exclusion from the seal is seal.ts's. */
export function prepareScratchDirectory(worktree: string): string {
  const path = scratchPath(worktree);
  mkdirSync(path, { recursive: true });
  return path;
}
