import type { GitProcess, ProcessOptions, RunResult } from "@perbo/workspace";
import type { runProcess } from "../process.js";

/**
 * The repository module's process port over this host's own child processes.
 *
 * Every command this app starts goes through one runner, which is what the
 * tests replace and what carries this host's environment and redaction, so
 * git runs there too rather than beside it.
 */
export function desktopGitProcess(execute: typeof runProcess): GitProcess {
  return {
    async run(argv: readonly string[], options: ProcessOptions): Promise<RunResult> {
      const started = Date.now();
      const result = await execute(argv[0]!, argv.slice(1), {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxOutputBytes,
      });
      return {
        argv: [...argv],
        code: result.code,
        signal: null,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: Date.now() - started,
        // The runner stops a child that has run out of time, and a stop is the
        // only thing that cancels one of these reads.
        timed_out: result.cancelled,
        // Output past the ceiling is refused rather than cut, so a result that
        // arrives is whole.
        truncated: false,
      };
    },
    runSync(): RunResult {
      throw new Error("the desktop host reads git asynchronously");
    },
  };
}
