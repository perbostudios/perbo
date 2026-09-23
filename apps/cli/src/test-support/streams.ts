import { stripVTControlCharacters } from "node:util";

import type { Streams } from "../streams.js";

/**
 * The three writes a command is given, with what was written to them kept.
 *
 * The readers are functions rather than arrays because a caller wants the text
 * a command produced, not the chunks it happened to arrive in: a rendering
 * split across two `stdout` calls is one line to whoever reads it, and an
 * assertion on chunk boundaries would fail the first time a command buffered
 * differently without anything a reader sees having changed.
 */
export interface RecordedStreams extends Streams {
  /** Everything written to stdout, joined in write order. */
  out(): string;
  /** Everything written to stderr, joined in write order. */
  err(): string;
  /**
   * stdout as a reader sees it, with every terminal control sequence removed.
   *
   * For a command run with `isTTY: true`, which is the only way to see what it
   * paints and still assert on the words.
   */
  plain(): string;
  /** stdout parsed as one JSON document. */
  json<T = unknown>(): T;
  /** stdout as one JSON document per line, blank lines skipped. */
  jsonLines(): unknown[];
}

/**
 * Streams a test can read back.
 *
 * `isTTY` decides whether the command paints, so it is the one thing a caller
 * sets; it is off by default, because a test that does not care about colour
 * gets the plainer output to assert on.
 */
export function recordStreams(options: { isTTY?: boolean } = {}): RecordedStreams {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = (): string => out.join("");
  return {
    stdout: (chunk) => {
      out.push(chunk);
    },
    stderr: (chunk) => {
      err.push(chunk);
    },
    isTTY: options.isTTY ?? false,
    out: stdout,
    err: () => err.join(""),
    plain: () => stripVTControlCharacters(stdout()),
    json: <T = unknown,>(): T => {
      const text = stdout();
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new Error(`stdout is not one JSON document: ${text}`, { cause: error });
      }
    },
    jsonLines: () =>
      stdout()
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown),
  };
}
