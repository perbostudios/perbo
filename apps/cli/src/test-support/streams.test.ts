import { describe, expect, it } from "vitest";

import { painter, type Style } from "../text.js";
import { recordStreams } from "./streams.js";

/**
 * Every style `text.ts` paints with, less `reset`, which is the sequence the
 * others close with rather than one a caller asks for.
 *
 * A style added there and not listed here makes `Uncovered` a string union and
 * the line below a type error, so the table cannot fall behind the palette.
 */
const STYLES = ["dim", "mid", "hi", "ok", "bad", "warn", "sect"] as const;
type Uncovered = Exclude<Style, "reset" | (typeof STYLES)[number]>;
const allStylesCovered: [Uncovered] extends [never] ? true : Uncovered = true;

describe("what the streams recorded", () => {
  it("keeps stdout and stderr apart and each in write order", () => {
    const streams = recordStreams();
    streams.stdout("one ");
    streams.stderr("first ");
    streams.stdout("two");
    streams.stderr("second");
    expect(streams.out()).toBe("one two");
    expect(streams.err()).toBe("first second");
  });

  it("is not a terminal unless the caller says so", () => {
    expect(recordStreams().isTTY).toBe(false);
    expect(recordStreams({ isTTY: true }).isTTY).toBe(true);
  });
});

describe("stdout read as JSON", () => {
  it("parses a document written in chunks", () => {
    const streams = recordStreams();
    streams.stdout('{"ticket"');
    streams.stdout(': "PRB-1", "state"');
    streams.stdout(': "open"}');
    expect(streams.json()).toEqual({ ticket: "PRB-1", state: "open" });
  });

  it("quotes what it could not parse", () => {
    const streams = recordStreams();
    streams.stdout("not json");
    expect(() => streams.json()).toThrow(/not json/);
  });

  it("reads one event per line and skips the blank ones", () => {
    const streams = recordStreams();
    streams.stdout('{"event":"start"}\n\n{"event":"done"}\n');
    expect(streams.jsonLines()).toEqual([{ event: "start" }, { event: "done" }]);
  });
});

/**
 * What a reader sees when the command thought it was writing to a terminal.
 *
 * Each painted style has to come back exactly as the unpainted painter would
 * have written it: that is the whole claim the `.plain()` reader makes, and
 * the one the six hand-written escape regexes used to make a file at a time.
 */
describe("stdout with the colour taken back out", () => {
  const text = "a line the command printed";

  for (const style of STYLES) {
    it(`reads ${style} as the uncoloured painter wrote it`, () => {
      const streams = recordStreams({ isTTY: true });
      streams.stdout(painter(true)(text, style));
      expect(streams.plain()).toBe(painter(false)(text, style));
    });
  }

  it("leaves text that was never painted alone", () => {
    const streams = recordStreams({ isTTY: true });
    streams.stdout("plain text\n");
    expect(streams.plain()).toBe("plain text\n");
  });
});

it("covers every style the palette has", () => {
  expect(allStylesCovered).toBe(true);
});
