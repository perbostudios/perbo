import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { readCommandLine, resolveScope } from "../index.js";
import { decision } from "../test-support/pins.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A comment is text the shell runs none of. An unquoted `#` that starts a word
 * opens one and it runs to the end of the line, so the guard reads the line
 * without it: the words after the `#` are no command's operands, and a `<<`
 * inside one opens no heredoc.
 */

/** Lines whose comment, read as words, hid a write outside the worktree. */
const HIDDEN_BY_THE_COMMENT = [
  // `-t out` read as a target directory made `/etc/x` a source.
  "cp a /etc/x # -t out",
  "mv a /etc/x #-t out",
  "cp a /etc/x;# -t out",
  // A `<<` read as a heredoc took the next line as its body.
  "echo hi # <<EOF\nrm -rf /etc/x\nEOF",
  // The newline ends the comment, and a backslash before it continues nothing.
  "echo hi # note \\\nrm -rf /etc/x",
];

/** Lines whose comment, read as words, named a write the shell never makes. */
const ONLY_IN_THE_COMMENT = [
  "cp a b # /etc/x",
  // An apostrophe in a comment opens no quote.
  "rm -rf build # don't touch ~/x",
  // An operator ends a word, so a `#` straight after one opens a comment.
  "echo a;# ; rm -rf /etc/x",
  // A line continuation vanishes, and the `#` after it still starts a word.
  "cp a b \\\n#c /etc/x",
];

/** A `#` that does not start a word, or is quoted, is a character. */
const NOT_A_COMMENT = [
  "cp a b#c /etc/x",
  'cp a "#" /etc/x',
  "cp a '#'b /etc/x",
  "cp a \\# /etc/x",
  // An escaped `#` starts the word, so the one after it is inside it.
  "cp a \\## /etc/x",
  // A quote or a substitution before the `#` starts the word it stands in.
  "cp a ''#b /etc/x",
  "cp $(true)#b /etc/x",
  "echo $# > /etc/x",
  "echo ${#x} > /etc/x",
  // A line continuation joins `b` and `#c` into one word.
  "cp a b\\\n#c /etc/x",
];

describe("a shell comment", () => {
  for (const command of HIDDEN_BY_THE_COMMENT) {
    it(`does not hide the write in ${JSON.stringify(command)}`, () => {
      expect(decision(command), command).toBe("refused");
    });
  }

  for (const command of ONLY_IN_THE_COMMENT) {
    it(`writes nothing in ${JSON.stringify(command)}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }

  for (const command of NOT_A_COMMENT) {
    it(`is not opened by the # in ${JSON.stringify(command)}`, () => {
      expect(decision(command), command).toBe("refused");
    });
  }

  it("does not hide a rebinding of the scratch directory from the guard", () => {
    const root = scratch("perbo-comment-scratch-");
    const scope = resolveScope({ root, home: "/Users/nobody", tmpdir: `${root}/.scratch` });
    const command = "echo hi # <<EOF\nTMPDIR=/etc cp a $TMPDIR/b\nEOF";
    expect(readCommandLine(command, scope).findings, command).not.toEqual([]);
  });
});
