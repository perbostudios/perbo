import type { CommandContext, CommandOutput, CommandReport } from "../command.js";
import type { Grammar } from "./grammar.js";
import type { CommandName } from "./names.js";

/**
 * What a command is, as the table holds it: a name, the grammars it reads a
 * line by, and the two kinds of answer one can give.
 *
 * Separate from `terminal.js` because a command declares itself here and the
 * adapter that *runs* one from a line is the entry point's alone — which is
 * what lets the queue and the interview, both of which call other commands in
 * this process, declare their own line without reaching that adapter
 * (ADR-0023 §4).
 */

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
  /** Throws a `UsageError` for a line this command cannot act on. */
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
