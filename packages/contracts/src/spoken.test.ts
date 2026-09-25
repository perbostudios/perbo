import { describe, expect, it } from "vitest";
import { readSpoken, SPOKEN_LINE_CAP, spokenLine } from "./spoken.js";

describe("an agent's words as a progress line", () => {
  it("marks whose words they are, and reads the mark back", () => {
    const line = spokenLine("executor", "I will add the retry to the mailer.");
    expect(line).toBe("executor says: I will add the retry to the mailer.");
    expect(readSpoken(line!)).toEqual({ speaker: "executor", words: "I will add the retry to the mailer." });
    expect(readSpoken(spokenLine("reviewer", "The retry is untested.")!)).toEqual({
      speaker: "reviewer",
      words: "The retry is untested.",
    });
  });

  it("folds a turn onto one line, so no part of it can pass for a line of the runner's own", () => {
    const line = spokenLine("executor", "Done.\n  worktree /tmp/elsewhere on main at abc\r\nexecuting\u001b[2J");
    expect(line).toBe("executor says: Done. worktree /tmp/elsewhere on main at abc executing [2J");
    expect(line!.split("\n")).toHaveLength(1);
  });

  it("cuts a long turn at the cap, whole characters only", () => {
    const line = spokenLine("executor", "é".repeat(SPOKEN_LINE_CAP * 2))!;
    const words = readSpoken(line)!.words;
    expect([...words]).toHaveLength(SPOKEN_LINE_CAP);
    expect(words.endsWith("…")).toBe(true);
    expect(readSpoken(spokenLine("executor", "a".repeat(SPOKEN_LINE_CAP))!)!.words).toHaveLength(SPOKEN_LINE_CAP);
  });

  it("says nothing for a turn with no words, and reads no mark into a line without one", () => {
    expect(spokenLine("executor", " \n\t ")).toBeNull();
    expect(readSpoken("executing")).toBeNull();
    expect(readSpoken("check lint: pnpm lint")).toBeNull();
    expect(readSpoken("  executor says: indented, so not the mark")).toBeNull();
  });
});
