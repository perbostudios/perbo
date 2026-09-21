import type { Streams } from "./streams.js";

/**
 * Where a command says what it is doing while it does it.
 *
 * Progress, warnings and anything else a person reads while waiting. At a
 * terminal it is stderr, so stdout carries the record alone; in this process
 * it is collected, so a caller that asked for a record gets what was said
 * beside it. {@link Streams} satisfies it, which is why nothing a command
 * already takes has to change to be given one.
 */
export interface Diagnostics {
  stderr(chunk: string): void;
}

/** A command's writes held in this process, and what it wrote. */
export interface CollectedOutput {
  streams: Streams;
  stdout(): string;
  stderr(): string;
}

/**
 * Streams that keep what a command writes instead of showing it.
 *
 * `isTTY` is false, which is what it is for every in-process caller: nothing
 * is looking at this, so a command that renders differently for a person
 * renders the record.
 */
export function collectOutput(): CollectedOutput {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: {
      stdout: (chunk: string) => out.push(chunk),
      stderr: (chunk: string) => err.push(chunk),
      isTTY: false,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}
