import { describe, expect, it } from "vitest";
import { spokenLine } from "./spoken.js";
import { readTally, tallyLine, type Tally } from "./tally.js";

const TALLY: Tally = {
  commands: 12,
  files: 3,
  input_tokens: 120_400,
  output_tokens: 3_400,
  micros: 512_345,
  unpriced: 1,
  partial: 0,
};

describe("the tally line", () => {
  it("carries every figure and reads back as it was printed", () => {
    const line = tallyLine(TALLY);
    expect(line).toBe(
      "tally: 12 commands, 3 files, 120400 input tokens, 3400 output tokens, 512345 micro-dollars priced, 1 unpriced, 0 partial",
    );
    expect(readTally(line)).toEqual(TALLY);
  });

  it("reads nothing from an agent's words, a line that only starts like one, or one that says more", () => {
    const line = tallyLine(TALLY);
    for (const other of [
      spokenLine("executor", line)!,
      spokenLine("reviewer", line)!,
      `${line} and more`,
      `  ${line}`,
      line.replace("12 commands", "twelve commands"),
      "tally: 12 commands",
    ])
      expect(readTally(other)).toBeNull();
  });
});
