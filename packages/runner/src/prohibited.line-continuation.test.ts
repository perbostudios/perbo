import { describe, expect, it } from "vitest";
import { inspectCommand } from "./prohibited.js";

/**
 * The command rules read each segment with its line continuations taken out,
 * as the shell takes them out, so a continuation inside a word hides no verb
 * or flag: `git bra\<newline>nch -D main` deletes a branch. The segments are
 * found in the line they were read from, heredoc bodies and all.
 */

const branchDeletions = (command: string) =>
  inspectCommand(command).filter((hit) => hit.action === "destructive_git" && hit.detail.startsWith("branch deletion"));

describe("a line continuation inside a command the rules read", () => {
  it("hides no verb a continuation splits", () => {
    expect(branchDeletions("git bra\\\nnch -D main")).toHaveLength(1);
  });

  it("hides none after a heredoc whose body keeps its own", () => {
    expect(branchDeletions("cat <<'EOF' > notes.txt\nx\\\nEOF\ngit bra\\\nnch -D main")).toHaveLength(1);
  });
});
