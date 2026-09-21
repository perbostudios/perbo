import { EXIT_CODES } from "@perbo/contracts";
import { UsageError } from "../usage-error.js";
import { describeFailure } from "../failure.js";
import { StoreError } from "../store/index.js";
import type {
  CommandContext,
  CommandOutput,
  CommandReport,
  RenderTarget,
} from "../command.js";
import type { Streams } from "../streams.js";
import { asksForHelp, type Grammar } from "./grammar.js";
import type { CommandName } from "./names.js";
import { USAGE } from "./usage.js";

/**
 * The shell the entry point runs inside: help, version, an unknown command,
 * and what a thrown error exits as — and the adapter that turns a command
 * line into one command's typed input and its answer back into bytes.
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

/* ------------------------------------------------------------------ *
 * One command, and the terminal adapter that runs it.
 * ------------------------------------------------------------------ */

/**
 * A command whose answer is a record, with the line it is asked for by: read,
 * run, render once.
 *
 * The run and the rendering are {@link CommandReport}, which a caller in this
 * process reaches without a line; what is here is the reading of argv, which
 * is the terminal's alone.
 */
export interface ReportCommand<
  Input,
  Output extends CommandOutput,
  Report,
  Deps extends object = object,
> extends CommandReport<Input, Output, Report, Deps> {
  readonly kind: "report";
  readonly name: CommandName;
  /** Every grammar it reads a line by, for the usage-consistency test. */
  readonly grammars: readonly Grammar[];
  /** Whether a piped stdout carries the record without `--json`, per command. */
  readonly jsonWhenPiped: boolean;
  /** The grammar this line is read by: the verb's, where the command has verbs. */
  grammarFor(argv: readonly string[]): Grammar;
  /** Throws {@link UsageError} for a line this command cannot act on. */
  read(argv: readonly string[]): { input: Input; output: Output };
}

/**
 * A command whose answer is what it says while it works: a sync, a run, a
 * review's progress, the queue, an interview, a session.
 */
export interface NarratedCommand<Input, Output, Deps extends object = object> {
  readonly kind: "narrated";
  readonly name: CommandName;
  readonly grammars: readonly Grammar[];
  grammarFor(argv: readonly string[]): Grammar;
  read(argv: readonly string[]): { input: Input; output: Output };
  run(
    input: Input,
    output: Output,
    context: CommandContext & { stdout(chunk: string): void; isTTY: boolean } & Partial<Deps>,
  ): Promise<number> | number;
}

/** A command as the table holds it, with its own types behind it. */
export type TerminalCommand =
  | ReportCommand<unknown, CommandOutput, unknown>
  | NarratedCommand<unknown, unknown>;

/**
 * The three writes a narrated command's context holds, as one object.
 *
 * Everything below a command reads {@link Streams}; a narrated command is
 * handed its diagnostics and its stdout separately, because an in-process
 * caller collects the two apart.
 */
export const narratedStreams = (context: {
  stdout(chunk: string): void;
  isTTY: boolean;
  diagnostics: { stderr(chunk: string): void };
}): Streams => ({
  stdout: context.stdout,
  stderr: (chunk) => context.diagnostics.stderr(chunk),
  isTTY: context.isTTY,
});

/** What the terminal hands one command: its line, its streams and its injected parts. */
export interface Invocation<Deps extends object = object> {
  argv: readonly string[];
  streams: Streams;
  cwd: string;
  now?: Date;
  deps?: Partial<Deps>;
}

/**
 * One command line, run and written out.
 *
 * Not `async`: a command that answers synchronously returns a number, so a
 * caller that reads an exit code without waiting still reads one.
 */
export function runCommandLine<Input, Output extends CommandOutput, Report, Deps extends object>(
  command: ReportCommand<Input, Output, Report, Deps>,
  invocation: Invocation<Deps>,
): number | Promise<number>;
export function runCommandLine<Input, Output, Deps extends object>(
  command: NarratedCommand<Input, Output, Deps>,
  invocation: Invocation<Deps>,
): number | Promise<number>;
/** A command the table holds, whose own types are behind it. */
export function runCommandLine(
  command: TerminalCommand,
  invocation: Invocation<object>,
): number | Promise<number>;
export function runCommandLine(
  command: TerminalCommand,
  invocation: Invocation<object>,
): number | Promise<number> {
  const { argv, streams, cwd } = invocation;
  if (asksForHelp(command.grammarFor(argv), argv)) {
    streams.stderr(USAGE);
    return EXIT_CODES.approve;
  }
  const context = {
    cwd,
    now: invocation.now ?? new Date(),
    diagnostics: streams,
    ...invocation.deps,
  };

  if (command.kind === "narrated") {
    const { input, output } = command.read(argv);
    return command.run(input, output, {
      ...context,
      stdout: streams.stdout,
      isTTY: streams.isTTY,
    });
  }

  const { input, output } = command.read(argv);
  const target: RenderTarget = {
    isTTY: streams.isTTY,
    color: process.env["NO_COLOR"] === undefined,
    json: output.json || (command.jsonWhenPiped && !streams.isTTY),
  };
  const written = (report: unknown): number => {
    const rendered = command.render(report, output, target);
    if (rendered.stdout !== "") streams.stdout(rendered.stdout);
    if (rendered.stderr !== "") streams.stderr(rendered.stderr);
    return rendered.exitCode;
  };
  const report = command.run(input, context);
  return report instanceof Promise ? report.then(written) : written(report);
}
