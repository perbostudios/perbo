import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { readCommandLine, resolveScope } from "../index.js";
import { decision, sentence } from "../test-support/pins.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A comment is text the shell runs none of, and its words, read as a
 * command's, can hide a write: `cp a /etc/x # -t out` writes `/etc/x`, and read
 * with `-t out` it names `/etc/x` as a source. Where a comment starts is not
 * something the guard can read with certainty, so it takes nothing out: a `#`
 * that may start one makes the line unreadable, and a `#` it can prove is a
 * character is read as one.
 */
const COMMENT = "a comment cannot be told from an argument here";

/**
 * The shells a line is run under below: `bash 3.2` is the bash macOS ships,
 * which reads a process substitution's end before its comments.
 */
type Shell = "bash" | "bash 3.2" | "zsh";

/**
 * Lines a shell runs a write outside the worktree in, which the guard would
 * miss with the comment taken out or with its words read as operands. `shells`
 * names the shells that run the write, and `hands` what they hand the writer.
 */
const HIDDEN_WRITES: Array<{ line: string; shells: Shell[]; hands?: string }> = [
  // `-t out`, read as a target directory, would make `/etc/x` a source.
  { line: "cp a /etc/x # -t out", shells: ["bash", "zsh"] },
  { line: "mv a /etc/x #-t out", shells: ["bash", "zsh"] },
  { line: "cp a /etc/x;# -t out", shells: ["bash", "zsh"] },
  // A `<<`, read as a heredoc, would take the next line as its body.
  { line: "echo hi # <<EOF\nrm -rf /etc/x\nEOF", shells: ["bash", "zsh"], hands: "<-rf></etc/x>" },
  // The newline ends the comment, and a backslash before it continues nothing.
  { line: "echo hi # note \\\nrm -rf /etc/x", shells: ["bash", "zsh"], hands: "<-rf></etc/x>" },
  // A `"` inside an expansion inside double quotes closes neither: the `#`
  // after it is quoted, and the `cp` runs.
  { line: 'echo "$(echo " #")"; cp a /etc/x', shells: ["bash", "zsh"] },
  { line: 'echo "${x:-" #"}"; cp a /etc/x', shells: ["bash", "zsh"] },
  { line: 'echo "$[ " #" ]"; cp a /etc/x', shells: ["zsh"] },
  { line: 'echo "`echo " #"`"; cp a /etc/x', shells: ["bash", "zsh"] },
  { line: 'echo "${x:-{a} #}"; cp a /etc/x', shells: ["bash", "zsh"] },
  // What such a quote holds, read as closed early, hides the destination the
  // shell hands `cp`: the `#' b'` after it is a comment, not an operand.
  {
    line: `cp a "$(echo '"')/../../etc" #' b'`,
    shells: ["bash", "zsh"],
    hands: '<a><"/../../etc>',
  },
  // In an ANSI-C quote `\'` is a quote character, not the quote's end.
  { line: "cp a $'\\'' /etc/x #' -t sub'", shells: ["bash", "zsh"], hands: "<a><'></etc/x>" },
  // A `#` after a list's `)` inside a process substitution.
  { line: "cat <((echo a)#x); cp a /etc/x", shells: ["bash 3.2"] },
  { line: "cat <((echo a)#x\n); cp a /etc/x", shells: ["bash", "zsh"] },
  // zsh's `(a)#x` is a pattern, which the file `a#x` matches.
  { line: "echo (a)#x; cp a /etc/x", shells: ["zsh"] },
  // A `#` both shells read as a character, taken for a comment, hides the `cp`.
  { line: "echo ${x:-a #}; cp a /etc/x", shells: ["bash", "zsh"] },
  { line: 'echo ${x:-"}" #}; cp a /etc/x', shells: ["bash", "zsh"] },
  { line: "echo ${x:-(#}; cp a /etc/x", shells: ["bash"] },
  { line: "(( 1 #)); cp a /etc/x", shells: ["bash", "zsh"] },
  { line: "cat <(true)#x; cp a /etc/x", shells: ["bash", "zsh"] },
  { line: "cat >(true)#x; cp a /etc/x", shells: ["bash", "zsh"] },
  // bash reads `#` as part of the array's word, zsh as a comment.
  { line: "x=(a)#; cp a /etc/x", shells: ["bash"] },
  // bash ends `${…}` after `{a}`, so ` #} -t sub` is a comment and `cp` writes
  // `/etc/x`; zsh reads `-t sub`, and `/etc/x` is a source.
  { line: "cp a /etc/x ${x:+{a} #} -t sub", shells: ["bash"] },
];

/** Lines whose comment names nothing a shell writes outside the worktree. */
const COMMENT_ONLY = [
  "cp a b # /etc/x",
  // An apostrophe in a comment opens no quote.
  "rm -rf build # don't touch ~/x",
  // An operator ends a word, so a `#` straight after one opens a comment.
  "echo a;# ; rm -rf /etc/x",
  // A line continuation vanishes, and the `#` after it still starts a word.
  "cp a b \\\n#c /etc/x",
  "git status # check",
  "# run the tests\npnpm test",
  // No shell runs the `cp` after `$[1 #]`: both stop at the arithmetic.
  "echo $[1 #]; cp a /etc/x",
  "((1))#; cp a /etc/x",
  "(echo a)#; cp a /etc/x",
  "echo ${x:-a} # ; cp a /etc/x",
  "cat <(true) # ; cp a /etc/x",
  "[[ -n a ]] # ; cp a /etc/x",
  // A comment inside an array's parentheses hides the `)` written in it.
  "x=(a # ) ; cp a /etc/x\n)",
  // A `#` bash reads as a character and zsh as a comment, or the reverse.
  "x=(a)#b",
  "echo ${x:-{a} #}; cp a sub/x",
  // A `(#)` in the pattern `=~` matches against is part of the pattern.
  "[[ a =~ (#) ]]; cp a sub/x",
  // A `case` inside a substitution leaves a `)` whose opening this does not see.
  "echo $(case a in a) true;; esac)#x; cp a sub/x",
];

/**
 * A `#` the guard proves is a character — inside a word, quoted, escaped, a
 * parameter, inside an expansion — read as one: the write it stands in is
 * judged, and the line is not refused for the `#`.
 */
const A_CHARACTER_OUTSIDE = [
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

/** The same, writing inside the worktree: allowed. */
const A_CHARACTER_INSIDE = [
  "cp a b#c sub/x",
  'cp a "#" sub/x',
  "cp a '#'b sub/x",
  "cp a \\# sub/x",
  "cp a ''#b sub/x",
  "cp $(true)#b sub/x",
  "echo $# > sub/x",
  "echo ${#x} ${x#a} ${x##*/} > sub/x",
  "cp a b\\\n#c sub/x",
  'git commit -m "Fix #12"',
  'echo "$(pwd) #1" "${HOME} #2" "$((1 + 2)) #3" > sub/x',
  // A single quote inside an expansion is read as the shells read it.
  `echo "$(printf '%s' a) #1" $(printf '%s)' b) \\#2 > sub/x`,
  "grep -n ' #' src/a.ts",
  "sed -i 's/ #.*//' src/a.ts",
  "cat > src/a.py <<'EOF'\n# a comment in a heredoc body is data\nEOF",
];

/** A `<<` inside `${…}` or `((…))` is text or a shift, so the next line is a command. */
const NOT_A_HEREDOC = ["echo ${x:-<<EOF}\nrm -rf /etc/x", "(( x << 2 ))\nrm -rf /etc/x"];

/**
 * A `<<` after an expansion whose end is uncertain, which may be text inside a
 * quote the shells read as still open: the lines after it are commands they
 * run, not a body.
 */
const HEREDOC_AFTER_AN_UNSURE_END: Array<{ line: string; shells: Shell[] }> = [
  { line: 'echo "$(echo " <<EOF")"\ncp a /etc/x', shells: ["bash", "zsh"] },
  { line: "echo $'\\' <<EOF'\ncp a /etc/x", shells: ["bash", "zsh"] },
];

/** The bash on this machine, by major and minor version, or null. */
function bashVersion(): string | null {
  if (!existsSync("/bin/bash")) return null;
  const run = spawnSync("/bin/bash", ["-c", 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], {
    encoding: "utf8",
  });
  return run.status === 0 ? run.stdout.trim() : null;
}

const BASH = bashVersion();

/** How to run `shell` without its startup files, where it is installed as the table names it. */
function installed(shell: Shell): string[] | null {
  if (shell === "zsh") return existsSync("/bin/zsh") ? ["/bin/zsh", "-f"] : null;
  if (shell === "bash 3.2") return BASH === "3.2" ? ["/bin/bash", "--norc"] : null;
  return BASH === null ? null : ["/bin/bash", "--norc"];
}

describe("a shell comment", () => {
  for (const { line } of HIDDEN_WRITES) {
    it(`does not hide the write in ${JSON.stringify(line)}`, () => {
      expect(decision(line), line).toBe("refused");
      expect(sentence(line), line).toContain(COMMENT);
    });
  }

  // Each write above is one a shell runs: the line is run with the writer
  // swapped for `printf`, which prints the operands it is handed.
  const lab = scratch("perbo-comment-shells-");
  writeFileSync(join(lab, "a#x"), "");
  for (const { line, shells, hands = "<a></etc/x>" } of HIDDEN_WRITES) {
    for (const shell of shells) {
      const argv = installed(shell);
      it.skipIf(argv === null)(`is run by ${shell} as ${hands} in ${JSON.stringify(line)}`, () => {
        const probe = line.replace(/\b(?:cp|mv|rm)(?= )/, "printf '<%s>'");
        const [program, ...options] = argv!;
        const run = spawnSync(program!, [...options, "-c", probe], {
          cwd: lab,
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
          timeout: 10_000,
        });
        expect(run.stdout, `${shell}: ${probe}`).toContain(hands);
      });
    }
  }

  for (const command of COMMENT_ONLY) {
    it(`makes ${JSON.stringify(command)} unreadable`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain(COMMENT);
    });
  }

  for (const command of A_CHARACTER_OUTSIDE) {
    it(`is not opened by the # in ${JSON.stringify(command)}`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).not.toContain(COMMENT);
    });
  }

  for (const command of A_CHARACTER_INSIDE) {
    it(`is not opened by the # in ${JSON.stringify(command)}, which writes inside`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }

  for (const command of NOT_A_HEREDOC) {
    it(`leaves the line after ${JSON.stringify(command)} a command`, () => {
      expect(decision(command), command).toBe("refused");
    });
  }

  for (const { line, shells } of HEREDOC_AFTER_AN_UNSURE_END) {
    it(`does not take the line after ${JSON.stringify(line)} as a body`, () => {
      expect(decision(line), line).toBe("refused");
    });
    for (const shell of shells) {
      const argv = installed(shell);
      it.skipIf(argv === null)(`is run by ${shell} in ${JSON.stringify(line)}`, () => {
        const [program, ...options] = argv!;
        const probe = line.replace("cp a /etc/x", "printf '<%s>' a /etc/x");
        const run = spawnSync(program!, [...options, "-c", probe], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
          timeout: 10_000,
        });
        expect(run.stdout, `${shell}: ${probe}`).toContain("<a></etc/x>");
      });
    }
  }

  it("does not hide a rebinding of the scratch directory from the guard", () => {
    const root = scratch("perbo-comment-scratch-");
    const scope = resolveScope({ root, home: "/Users/nobody", tmpdir: `${root}/.scratch` });
    const command = "echo hi # <<EOF\nTMPDIR=/etc cp a $TMPDIR/b\nEOF";
    expect(readCommandLine(command, scope).findings, command).not.toEqual([]);
  });
});
