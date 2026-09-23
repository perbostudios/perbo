import type { Word } from "./lexer.js";

/**
 * A `find` command line, as what it walks and what it does to what it finds.
 *
 * `find` writes in three ways: `-delete` removes what it finds, an `-exec`
 * body runs a command on each found path, and `-fprint` and its kin write a
 * file they name. What it finds is always under a starting point, so a
 * starting point is where those writes land.
 */
export interface FindExpression {
  /** Where the walk starts; empty where the line names none, which is `.`. */
  starts: Word[];
  /** Each command the expression runs on what it finds, in order. */
  bodies: FindBody[];
  /** True where the expression deletes what it finds. */
  deletes: boolean;
  /** The files the expression's own actions write, with the action. */
  files: Array<{ action: string; word: Word }>;
}

export interface FindBody {
  words: Word[];
  /**
   * True for `-execdir` and `-okdir`, which run the body in the directory of
   * each found path, where `{}` is `./<name>`.
   */
  inFoundDirectory: boolean;
}

/** GNU's and BSD's options before the starting points that take no value. */
const LEADING_FLAGS = new Set(["-H", "-L", "-P", "-E", "-X", "-d", "-s", "-x"]);
const RUNS_A_COMMAND = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const IN_FOUND_DIRECTORY = new Set(["-execdir", "-okdir"]);
/** Actions whose operand is a file they write. */
const WRITES_A_FILE = new Set(["-fprint", "-fprint0", "-fls", "-fprintf"]);

/** Read the words after `find`. */
export function findExpression(rest: readonly Word[]): FindExpression {
  const starts: Word[] = [];
  let i = 0;
  while (i < rest.length) {
    const value = rest[i]!.value;
    if (LEADING_FLAGS.has(value) || /^-O\d*$/.test(value)) {
      i += 1;
      continue;
    }
    // GNU's `-D` takes its debug options as the next word; BSD's `-f` names a
    // starting point, one that may begin with a dash.
    if (value === "-D") {
      i += 2;
      continue;
    }
    if (value === "-f" && rest[i + 1] !== undefined) {
      starts.push(rest[i + 1]!);
      i += 2;
      continue;
    }
    break;
  }
  // The starting points run up to the first word the expression starts with.
  for (; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (word.redirect === true) continue;
    const value = word.value;
    if ((value.startsWith("-") && value !== "-") || value === "(" || value === "!" || value === ",") {
      break;
    }
    starts.push(word);
  }

  const bodies: FindBody[] = [];
  const files: FindExpression["files"] = [];
  let deletes = false;
  while (i < rest.length) {
    const word = rest[i]!;
    const value = word.value;
    i += 1;
    if (word.redirect === true) continue;
    if (RUNS_A_COMMAND.has(value)) {
      // A `;` word ends the body, and so does a `+` straight after `{}`; any
      // other `+` is one of the body's own words, as `find` reads it.
      const body: Word[] = [];
      while (i < rest.length) {
        const part = rest[i]!;
        i += 1;
        if (part.value === ";") break;
        if (part.value === "+" && body[body.length - 1]?.value === "{}") break;
        body.push(part);
      }
      bodies.push({ words: body, inFoundDirectory: IN_FOUND_DIRECTORY.has(value) });
      continue;
    }
    if (value === "-delete") deletes = true;
    if (WRITES_A_FILE.has(value) && rest[i] !== undefined) {
      files.push({ action: value, word: rest[i]! });
      i += 1;
    }
  }
  return { starts, bodies, deletes, files };
}
