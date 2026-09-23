import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { readCommandLine, resolveScope } from "../index.js";
import { decision, sentence } from "../test-support/pins.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A comment is text the shell runs none of. An unquoted `#` that starts a word
 * opens one and it runs to the end of the line, so the guard reads the line
 * without it: the words after the `#` are no command's operands, and a `<<`
 * inside one opens no heredoc.
 */

/** Lines whose comment, read as words, would hide a write outside the worktree. */
const HIDDEN_BY_THE_COMMENT = [
  // `-t out`, read as a target directory, would make `/etc/x` a source.
  "cp a /etc/x # -t out",
  "mv a /etc/x #-t out",
  "cp a /etc/x;# -t out",
  // A `<<`, read as a heredoc, would take the next line as its body.
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

/**
 * A `#` bash and zsh both read as a character: inside `${…}`, `$[…]` and
 * `((…))`, and straight after a process substitution's `)`. Nothing is taken
 * out, so the command after it is read.
 */
const A_CHARACTER_TO_BOTH_SHELLS = [
  "echo ${x:-a #}; cp a /etc/x",
  "echo ${x:-(#}; cp a /etc/x",
  "echo ${x:-\"}\" #}; cp a /etc/x",
  "echo $[1 #]; cp a /etc/x",
  "(( 1 #)); cp a /etc/x",
  "cat <(true)#x; cp a /etc/x",
  "cat >(true)#x; cp a /etc/x",
];

/** A `<<` inside `${…}` or `((…))` is text or a shift, so the next line is a command. */
const NOT_A_HEREDOC = ["echo ${x:-<<EOF}\nrm -rf /etc/x", "(( x << 2 ))\nrm -rf /etc/x"];

/** Comments both shells read as comments, straight after the places above end. */
const A_COMMENT_TO_BOTH_SHELLS = [
  "((1))#; cp a /etc/x",
  "(echo a)#; cp a /etc/x",
  "echo ${x:-a} # ; cp a /etc/x",
  "cat <(true) # ; cp a /etc/x",
  "[[ -n a ]] # ; cp a /etc/x",
  // A comment inside an array's parentheses hides the `)` written in it.
  "x=(a # ) ; cp a /etc/x\n)",
];

/**
 * A `#` that one shell reads as a comment and the other as a character, so the
 * line runs differently under each: refused, whatever the rest of it does.
 */
const DISPUTED = [
  // bash: part of the word; zsh: a comment.
  "x=(a)#b",
  // bash ends `${…}` after `{a}`, so ` #} -t sub` is a comment and `cp` writes
  // `/etc/x`; zsh reads `-t sub`, and `/etc/x` is a source.
  "cp a /etc/x ${x:+{a} #} -t sub",
  "echo ${x:-{a} #}; cp a sub/x",
  // A `(#)` in the pattern `=~` matches against is part of the pattern.
  "[[ a =~ (#) ]]; cp a sub/x",
  // A `case` inside a substitution leaves a `)` whose opening this does not see.
  "echo $(case a in a) true;; esac)#x; cp a sub/x",
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

  for (const command of A_CHARACTER_TO_BOTH_SHELLS) {
    it(`is not opened by the # both shells read as a character in ${JSON.stringify(command)}`, () => {
      expect(decision(command), command).toBe("refused");
    });
  }

  for (const command of NOT_A_HEREDOC) {
    it(`leaves the line after ${JSON.stringify(command)} a command`, () => {
      expect(decision(command), command).toBe("refused");
    });
  }

  for (const command of A_COMMENT_TO_BOTH_SHELLS) {
    it(`is opened by the # both shells read as a comment in ${JSON.stringify(command)}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }

  for (const command of DISPUTED) {
    it(`makes ${JSON.stringify(command)} unreadable, where bash and zsh disagree on it`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain(
        "is a comment to one shell and a character to another",
      );
    });
  }

  it("does not hide a rebinding of the scratch directory from the guard", () => {
    const root = scratch("perbo-comment-scratch-");
    const scope = resolveScope({ root, home: "/Users/nobody", tmpdir: `${root}/.scratch` });
    const command = "echo hi # <<EOF\nTMPDIR=/etc cp a $TMPDIR/b\nEOF";
    expect(readCommandLine(command, scope).findings, command).not.toEqual([]);
  });
});
