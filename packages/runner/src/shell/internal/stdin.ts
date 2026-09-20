import { basename, isAssignment, type Context } from "./command.js";
import type { WriteFinding } from "./destination.js";
import { inlineCodeFindings, unwrapped } from "./inline-code.js";
import type { StdinSource, Word } from "./lexer.js";
import type { Cwd } from "./scope.js";

/**
 * What an interpreter runs when its command line did not say — and what that
 * makes of the invocation.
 *
 * The `-c` reading above is one source of a program among several. Standard
 * input is the rest of them: a heredoc body, a here-string, the stage before it
 * in a pipeline. Each carries code on the line exactly as `-c` does, decides at
 * run time where it writes exactly as `-c` does, and so is read exactly as `-c`
 * is — and one this guard cannot read at all refuses, naming the interpreter,
 * because "some inline code wrote something" is not a record anyone can act on.
 *
 * A **file** is the exception, and the same exception `node scripts/build.js`
 * has always had: `python3 < setup.py` and `cat setup.py | python3` run a file,
 * and a file is read by whoever reads files — the review inside the worktree,
 * nobody outside it. That is the line docs/08 draws, and it is drawn there
 * rather than here.
 */
export function programSourceFindings(
  verb: string,
  operands: readonly Word[],
  context: Context,
  cwd: Cwd,
): WriteFinding[] {
  const tail = `: ${context.segment.slice(0, 200)}`;
  // `python3 script.py`, `node build.js`: a file, and files are not read here.
  // A lone `-` is the operand that says the program is on standard input.
  const script = operands[0];
  if (script !== undefined && script.value !== "-") return [];

  const source = context.stdin;
  if (source === undefined) {
    // Nothing on the line says the interpreter was given a program at all:
    // `python3 --version` runs none.
    return [];
  }
  const how = `${verb} on standard input`;
  switch (source.kind) {
    case "heredoc":
      return inlineCodeFindings(
        verb,
        how,
        {
          raw: source.body,
          value: source.body,
          substitutions: [],
          // An unquoted tag lets the shell build the body before the
          // interpreter sees it, and then the line does not say what runs.
          variable: source.expanded && /[$`]/.test(source.body),
        },
        context,
        cwd,
      );
    case "word":
      return inlineCodeFindings(verb, how, source.word, context, cwd);
    case "file":
      return [];
    case "pipe": {
      const piped = pipedProgram(source.producer);
      if (piped.kind === "unreadable") {
        return [
          {
            detail: `the code piped into ${verb} cannot be read — ${piped.reason}${tail}`,
            target: null,
            resolved: null,
            cause: "unreadable_program",
          },
        ];
      }
      if (piped.kind === "file") return [];
      return inlineCodeFindings(verb, how, piped.word, context, cwd);
    }
    case "opaque":
      return [
        {
          detail:
            `the code ${verb} reads from ${source.raw} cannot be read — nothing on ` +
            `the line says what it holds${tail}`,
          target: null,
          resolved: null,
          cause: "unreadable_program",
        },
      ];
  }
}

/**
 * The script a shell reads from its standard input.
 *
 * `bash <<'EOF' … EOF` and `echo '<script>' | sh` are the interpreter case with
 * one difference: the program is shell, which this module reads. So it is read
 * — as a command in its own right, from the directory the shell stands in —
 * rather than refused for being on the wrong side of a pipe. What cannot be
 * read is refused, and a script **file** is left unaccounted for exactly as a
 * `sh script.sh` operand always has been.
 */
export function shellFromStdin(
  verb: string,
  source: StdinSource,
  context: Context,
): { findings: WriteFinding[]; script: string[]; accounted: boolean } {
  const tail = `: ${context.segment.slice(0, 200)}`;
  const unreadable = (reason: string) => ({
    findings: [
      { detail: `the script ${verb} reads from ${reason}${tail}`, target: null, resolved: null },
    ],
    script: [],
    accounted: true,
  });
  switch (source.kind) {
    case "heredoc":
      return { findings: [], script: [source.body], accounted: true };
    case "word":
      return source.word.variable || source.word.substitutions.length > 0
        ? unreadable("a here-string cannot be read — it is built at run time")
        : { findings: [], script: [source.word.value], accounted: true };
    // A file: its contents are not read here, which is what `accounted: false`
    // says — the segment falls through to `LEGACY_RULES` in `line.ts`, as
    // `sh script.sh` does.
    case "file":
      return { findings: [], script: [], accounted: false };
    case "pipe": {
      const piped = pipedProgram(source.producer);
      if (piped.kind === "unreadable") {
        return unreadable(`a pipe cannot be read — ${piped.reason}`);
      }
      if (piped.kind === "file") return { findings: [], script: [], accounted: false };
      return { findings: [], script: [piped.word.value], accounted: true };
    }
    case "opaque":
      return unreadable(`${source.raw} cannot be read — nothing on the line says what it holds`);
  }
}

/**
 * What the stage before a pipe produces, where that is text this guard can
 * read: `echo '<code>' | python3` puts the program on the line as surely as
 * `-c` does, and `cat <file> | python3` names a file the review reads.
 * Anything else — a command's output, a substitution, a variable — is a
 * program computed at run time.
 */
function pipedProgram(
  producer: readonly Word[],
):
  | { kind: "text"; word: Word }
  | { kind: "file"; words: Word[] }
  | { kind: "unreadable"; reason: string } {
  const words = producer.filter((word) => !isAssignment(word.value));
  const first = words[0];
  if (first === undefined) return { kind: "unreadable", reason: "the stage before it is empty" };
  if (first.variable || first.substitutions.length > 0) {
    return { kind: "unreadable", reason: "the stage before it is built at run time" };
  }
  const verb = basename(first.value);
  const operands = words.slice(1).filter((word) => !word.value.startsWith("-"));
  if (verb === "cat") {
    if (operands.length === 0) {
      return { kind: "unreadable", reason: "`cat` was given no file to read" };
    }
    return { kind: "file", words: operands };
  }
  if (verb !== "echo" && verb !== "printf") {
    return { kind: "unreadable", reason: `it is the output of \`${verb}\`` };
  }
  const literal = words.slice(1).filter((word) => !/^-[neE]+$/.test(word.value));
  if (literal.some((word) => word.variable || word.substitutions.length > 0)) {
    return { kind: "unreadable", reason: `the text \`${verb}\` writes is built at run time` };
  }
  return {
    kind: "text",
    word: {
      // Unwrapped word by word rather than once at the end: `printf '%s' '<code>'`
      // is two words, and joining them with their quoting still on makes the
      // second one look like a string literal to whoever reads the result.
      raw: literal
        .map((word) => unwrapped(word.raw.length > 0 ? word.raw : word.value))
        .join(" "),
      value: literal.map((word) => word.value).join(" "),
      substitutions: [],
      variable: false,
    },
  };
}
