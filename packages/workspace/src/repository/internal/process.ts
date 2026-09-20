import { CommandFailedError, run, runSync, type RunResult } from "../../exec.js";

/**
 * Starting a process, as the repository module needs it.
 *
 * It is a port rather than a direct call because more than one runtime starts
 * git: this package, through `exec.ts`, and the desktop host, which starts
 * every child through a runner its tests record. A test injects a third.
 */
export interface ProcessOptions {
  cwd: string;
  /** The complete environment. Nothing is inherited implicitly. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface GitProcess {
  run(argv: readonly string[], options: ProcessOptions): Promise<RunResult>;
  runSync(argv: readonly string[], options: ProcessOptions): RunResult;
}

/** The adapter for a process that starts its own children. */
export const nodeProcess: GitProcess = {
  run: (argv, options) => run([...argv], options),
  runSync: (argv, options) => runSync([...argv], options),
};

/**
 * The result, or a refusal where git did not finish saying it.
 *
 * A timeout and an output larger than the buffer are both fragments, and a
 * fragment read as the whole answer is how a cut-off diff becomes a decision
 * nobody made: the bytes that were dropped are the ones nothing can account
 * for. A named question has one answer, so it refuses. The generic `run` forms
 * hand the flags to the caller instead, because there the exit status is
 * already data.
 */
export function answered(result: RunResult): RunResult {
  if (result.timed_out || result.truncated) throw new CommandFailedError(result);
  return result;
}
