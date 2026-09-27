import { describe, expect, it } from "vitest";
import { readSpoken, spokenLine } from "./spoken.js";

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

  it("keeps a turn on one physical line, so no part of it can pass for a line of the runner's own", () => {
    const line = spokenLine("executor", "Done.\n  worktree /tmp/elsewhere on main at abc\r\nexecuting\u001b[2J\u2028review round 2");
    expect(line).toBe(
      "executor says: Done.\\n  worktree /tmp/elsewhere on main at abc\\r\\nexecuting\\u001b[2J\\u2028review round 2",
    );
    expect(line!.split(/[\n\r\u2028\u2029]/)).toHaveLength(1);
  });

  it("carries a long turn of many lines whole, and reads it back exactly as it was said", () => {
    const paragraph = (at: number) =>
      `Paragraph ${at}: the retry waits \\n, not a break, then\tretries in C:\\temp\\new at \\u2028.\r\n  - a list item\n`;
    let words = "";
    for (let at = 0; words.length < 3_000; at += 1) words += paragraph(at) + "\n";
    words = words.trim() + " Done: é, 𝄞, and the end.";
    expect(words.length).toBeGreaterThan(3_000);
    const line = spokenLine("executor", words)!;
    expect(line.split(/[\n\r\u2028\u2029]/)).toHaveLength(1);
    expect(readSpoken(line)).toEqual({ speaker: "executor", words });
  });

  it("says nothing for a turn with no words, and reads no mark into a line without one", () => {
    expect(spokenLine("executor", " \n\t ")).toBeNull();
    expect(readSpoken("executing")).toBeNull();
    expect(readSpoken("check lint: pnpm lint")).toBeNull();
    expect(readSpoken("  executor says: indented, so not the mark")).toBeNull();
  });
});
