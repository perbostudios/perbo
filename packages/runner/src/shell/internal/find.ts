import type { Assigned } from "./assigned.js";
import { building, type BuiltWords } from "./command.js";
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
  /** The file GNU's `-files0-from` reads the starting points from, where one does. */
  startsFrom: Word | null;
  /**
   * Every word `find` reads as a starting point, an operator, or the name of a
   * test or an action — every word but an argument and a body's words. A word
   * standing here can be an action: `-delete`, or `-fprint` taking the word
   * after it as the file it writes.
   */
  heads: Word[];
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
   * True for `-execdir` and `-okdir`, which run the body in the directory
   * holding each found path, where `{}` is `./<name>`.
   */
  inFoundDirectory: boolean;
}

/** GNU's and BSD's options before the starting points that take no value. */
const LEADING_FLAGS = new Set(["-H", "-L", "-P", "-E", "-X", "-d", "-s", "-x"]);
const RUNS_A_COMMAND = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const IN_FOUND_DIRECTORY = new Set(["-execdir", "-okdir"]);
/** Actions whose operand is a file they write. */
const WRITES_A_FILE = new Set(["-fprint", "-fprint0", "-fls", "-fprintf"]);
/**
 * GNU's and BSD's tests and actions that take one argument, and `-fprintf`,
 * which takes two. A primary missing here has its argument read as a head,
 * which can only refuse more.
 */
const ARGUMENTS = new Map<string, number>([
  ...[
    "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex",
    "-lname", "-ilname", "-newer", "-anewer", "-cnewer", "-mnewer", "-Bnewer", "-samefile",
    "-user", "-group", "-uid", "-gid", "-type", "-xtype", "-perm", "-size", "-links", "-inum",
    "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-Btime", "-Bmin", "-used",
    "-maxdepth", "-mindepth", "-fstype", "-context", "-flags", "-printf", "-regextype",
    "-fprint", "-fprint0", "-fls", "-files0-from",
  ].map((name): [string, number] => [name, 1]),
  ["-fprintf", 2],
]);
/** GNU's `-newerXY`, one argument each. */
const NEWER = /^-newer[aBcmt][aBcmt]$/;

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
    // Both end their options at `--`; the starting points follow it.
    if (value === "--") i += 1;
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

  const expression = i;
  const bodies: FindBody[] = [];
  const files: FindExpression["files"] = [];
  let startsFrom: Word | null = null;
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
    if (value === "-files0-from" && rest[i] !== undefined) startsFrom = rest[i]!;
    if (WRITES_A_FILE.has(value) && rest[i] !== undefined) {
      files.push({ action: value, word: rest[i]! });
      i += 1;
    }
  }
  return { starts, startsFrom, heads: heads(rest, expression, starts), bodies, deletes, files };
}

/**
 * The heads of an expression that starts at `from`, as `find` reads it: each
 * primary's arguments and each body are skipped, and every other word is one.
 * The scan above reads actions wherever a word could name one; this reads
 * only where `find` does.
 */
function heads(rest: readonly Word[], from: number, starts: readonly Word[]): Word[] {
  const read: Word[] = [...starts];
  let i = from;
  while (i < rest.length) {
    const word = rest[i]!;
    i += 1;
    if (word.redirect === true) continue;
    read.push(word);
    if (RUNS_A_COMMAND.has(word.value)) {
      let last: string | undefined;
      while (i < rest.length) {
        const part = rest[i]!.value;
        i += 1;
        if (part === ";" || (part === "+" && last === "{}")) break;
        last = part;
      }
      continue;
    }
    i += ARGUMENTS.get(word.value) ?? (NEWER.test(word.value) ? 1 : 0);
  }
  return read;
}

/**
 * What `find` reads each of its words as: a head — an option before the
 * starting points, a starting point, an operator, or the name of a test or an
 * action — an argument a primary or `-D` takes, or a word of a body it runs.
 */
function findRoles(rest: readonly Word[]): Array<"head" | "argument" | "body"> {
  const roles = rest.map((): "head" | "argument" | "body" => "head");
  let i = 0;
  while (i < rest.length) {
    const value = rest[i]!.value;
    if (LEADING_FLAGS.has(value) || /^-O\d*$/.test(value)) {
      i += 1;
      continue;
    }
    if (value === "-D") {
      if (i + 1 < rest.length) roles[i + 1] = "argument";
      i += 2;
      continue;
    }
    if (value === "-f" && rest[i + 1] !== undefined) {
      i += 2;
      continue;
    }
    if (value === "--") i += 1;
    break;
  }
  for (; i < rest.length; i += 1) {
    const value = rest[i]!.value;
    if (rest[i]!.redirect === true) continue;
    if ((value.startsWith("-") && value !== "-") || value === "(" || value === "!" || value === ",") break;
  }
  while (i < rest.length) {
    const value = rest[i]!.value;
    i += 1;
    if (RUNS_A_COMMAND.has(value)) {
      let last: string | undefined;
      while (i < rest.length) {
        const part = rest[i]!.value;
        roles[i] = "body";
        i += 1;
        if (part === ";" || (part === "+" && last === "{}")) break;
        last = part;
      }
      continue;
    }
    const takes = ARGUMENTS.get(value) ?? (NEWER.test(value) ? 1 : 0);
    for (let k = 0; k < takes && i < rest.length; k += 1) {
      roles[i] = "argument";
      i += 1;
    }
  }
  return roles;
}

/**
 * The words the line builds where `find` reads them as heads, which it does
 * wherever they stand, `--` or not: what one prints can be `-delete`, or
 * `-fprint` and a file. One that expands to one word beginning with a literal
 * other than `-` is a starting point. A primary's argument is a value,
 * `-name "$(cat pat)"`, so long as the shell does not split it into more
 * words; a body's words are read with the command they are.
 */
export function findBuiltWords(rest: readonly Word[], assigned: Assigned | undefined): BuiltWords {
  const roles = findRoles(rest);
  const found: number[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (word.redirect === true || roles[i] === "body") continue;
    const how = building(word, assigned);
    if (how.kind === "assigned") found.push(i);
    if (how.kind !== "built") continue;
    if (roles[i] === "argument" ? how.splits : how.splits || !/^[^-]/.test(how.prefix)) {
      return { unreadable: word, assigned: found };
    }
  }
  return { assigned: found };
}
