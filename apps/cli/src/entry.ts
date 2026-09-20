import { EXIT_CODES } from "@perbo/contracts";
import { UsageError } from "./usage-error.js";
import { describeFailure } from "./failure.js";
import { StoreError } from "./store.js";
import type { Streams } from "./streams.js";

/**
 * The shell the entry point runs inside: help, version, an unknown command,
 * and what a thrown error exits as.
 */

/**
 * What `perbo` can be asked to do.
 *
 * Named by their union rather than as strings, so a table that lists a command
 * its dispatch does not answer fails to compile instead of at the user.
 */
export interface EntryPoint<Command extends string = string> {
  /** The help, which names the commands and nothing else. */
  usage: string;
  /** The commands it carries. */
  commands: readonly Command[];
  /** The version reported by `--version`. */
  version: string;
  /** Run one of {@link EntryPoint.commands}. */
  dispatch(command: Command, rest: string[], streams: Streams): Promise<number> | number;
}

/** The three writes a command is given, over this process's own streams. */
export function processStreams(): Streams {
  return {
    stdout: (chunk: string) => process.stdout.write(chunk),
    stderr: (chunk: string) => process.stderr.write(chunk),
    isTTY: Boolean(process.stdout.isTTY),
  };
}

/**
 * `perbo <argv>`: the exit code, with everything a person reads on stderr.
 *
 * stdout carries the command's record — the ReviewArtifact as JSON whenever it
 * is piped and a human rendering when it is a terminal; progress, warnings and
 * diagnostics always go to stderr. `perbo review … > review.json` therefore
 * yields a valid artifact under every outcome, including `error`.
 */
export async function runEntryPoint(argv: string[], entry: EntryPoint): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stderr.write(entry.usage);
    return command === undefined ? EXIT_CODES.usage_or_input_error : 0;
  }
  if (command === "--version" || command === "-v") {
    process.stderr.write(`perbo ${entry.version}\n`);
    return 0;
  }
  if (!entry.commands.includes(command)) {
    process.stderr.write(`error: unknown command '${command}'\n\n${entry.usage}`);
    return EXIT_CODES.usage_or_input_error;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stderr.write(entry.usage);
    return 0;
  }
  return entry.dispatch(command, rest, processStreams());
}

/**
 * What a command that threw exits as, and what it says on stderr.
 *
 * Exported so a test can ask this question of a refusal without spawning the
 * binary: the mapping from a thrown error to an exit code is this function and
 * nowhere else, so a test that reads it is reading what the program does.
 */
export function exitForThrown(command: string, error: unknown): { message: string; code: number } {
  // Something the store could not give back is bad input, not a review that
  // fell over.
  if (error instanceof UsageError || error instanceof StoreError) {
    return { message: error.message, code: EXIT_CODES.usage_or_input_error };
  }
  // A failure is not a passing review and not a passing run. Exit 3, not 0 and
  // not 1 — as one sentence naming the fix where there is one, and a stack only
  // for what nothing recognises.
  return describeFailure(command, error);
}

/**
 * Run the entry point as the program: set the exit code, and say what went
 * wrong in the words a person can act on.
 */
export function startEntryPoint(argv: string[], entry: EntryPoint): void {
  runEntryPoint(argv, entry)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const failure = exitForThrown(argv[0] ?? "", error);
      process.stderr.write(`error: ${failure.message}\n`);
      process.exitCode = failure.code;
    });
}
