import { describe, expect, it } from "vitest";
import { parseReviewArgs } from "./args.js";

/**
 * The two spellings of one decision.
 *
 * `--color` and `--no-color` say the same thing in opposite directions, so a
 * line carrying both means whichever was written last — rule 8 for a repeated
 * flag, and what a wrapper appending `--no-color` to a line someone else built
 * relies on.
 */
const LINE = ["--contract", "c.json", "--diff", "change.diff"];

describe("perbo review's colour", () => {
  it("is whichever of the two spellings was written last", () => {
    expect(parseReviewArgs([...LINE, "--color", "--no-color"]).color).toBe(false);
    expect(parseReviewArgs([...LINE, "--no-color", "--color"]).color).toBe(true);
  });

  it("stays the last one through a repeat of that spelling", () => {
    expect(parseReviewArgs([...LINE, "--no-color", "--color", "--color"]).color).toBe(true);
    expect(parseReviewArgs([...LINE, "--color", "--no-color", "--no-color"]).color).toBe(false);
  });

  it("is undecided where neither was written, which leaves the terminal to say", () => {
    expect(parseReviewArgs(LINE).color).toBeNull();
    expect(parseReviewArgs([...LINE, "--color"]).color).toBe(true);
    expect(parseReviewArgs([...LINE, "--no-color"]).color).toBe(false);
  });
});
