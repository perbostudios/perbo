import type { Diagnostics } from "./diagnostics.js";

/**
 * What every command is given, and what its answer is made of.
 *
 * Here rather than in `command-line/` because none of it is about argv: a
 * command is a function over typed input, and the terminal is one caller of
 * it. The queue's endpoint runs commands in this process and reaches them
 * through {@link CommandReport}, which has no way to read a line — that is
 * `command-line/terminal.js`'s, and the endpoint imports nothing from there
 * (ADR-0023 §4).
 */

/** What every command is given, whichever kind it is. */
export interface CommandContext {
  readonly cwd: string;
  readonly now: Date;
  /** Progress and warnings, as they happen. */
  readonly diagnostics: Diagnostics;
}

/** The part of a command's own options the adapter reads: whether JSON was asked for. */
export interface CommandOutput {
  readonly json: boolean;
}

/** What the answer is being written to, read once at the edge. */
export interface RenderTarget {
  readonly isTTY: boolean;
  /** `NO_COLOR` is unset. Whether a rendering uses it is still the rendering's. */
  readonly color: boolean;
  /** This answer is the JSON record rather than a reading for a person. */
  readonly json: boolean;
}

/** What one command wrote, and what it exits as. */
export interface Rendered {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * One command as a caller in this process reaches it: run it over typed input,
 * read its record, and render the answer where the bytes are what is wanted.
 *
 * `run` takes the input itself, so nothing here is built from or read as a
 * command line. `toJson` is the documented record; `render` is what a person
 * reads, and it owns the exit code, because what a reading means — a gate
 * closed, a verification that failed — is the command's rather than its
 * caller's.
 */
export interface CommandReport<
  Input,
  Output extends CommandOutput,
  Report,
  Deps extends object = object,
> {
  run(input: Input, context: CommandContext & Partial<Deps>): Report | Promise<Report>;
  /** The documented JSON record. Absent where the command has no JSON form. */
  toJson?(report: Report): unknown;
  render(report: Report, output: Output, target: RenderTarget): Rendered;
}
