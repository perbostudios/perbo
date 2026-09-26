import type { Assigned } from "./assigned.js";
import {
  anyPresent,
  building,
  builtOption,
  expansionLed,
  optionSet,
  optionsPresent,
  type Building,
  type BuiltWords,
  type Context,
  type OptionReading,
} from "./command.js";
import type { WriteFinding } from "./destination.js";
import { inlineCodeFindings } from "./inline-code.js";
import { expandedPrefix, type Word } from "./lexer.js";

/**
 * An interpreter, and the options that hand it code on the command line.
 *
 * `python3 -c "…"` and `node -e "…"` are a program this guard cannot run and
 * cannot resolve: the code decides at run time where it writes, and no amount of
 * parsing the shell reaches it. What is read here is the code as text — the
 * paths written in it, and whether it writes at all — and either answer refuses,
 * naming the interpreter so the record says which one it was.
 *
 * A script **file** is not this: `node scripts/build.js` runs a file in the
 * worktree that the review reads like any other, and it stays allowed.
 */
interface InterpreterSpec {
  /** Options whose operand is the code to run. */
  code: readonly string[];
  /** A subcommand whose operand is the code, as `deno eval` takes one. */
  subcommand?: string;
  /** True where the first operand is the program, as `awk`'s is. */
  firstOperand?: boolean;
  /** Options that consume the next word, so an operand is not read as code. */
  values?: readonly string[];
  /** Options that supply the program from a file rather than the command line. */
  fromFile?: readonly string[];
}

export const INTERPRETERS = new Map<string, InterpreterSpec>([
  ["node", { code: ["-e", "--eval", "-p", "--print"] }],
  ["nodejs", { code: ["-e", "--eval", "-p", "--print"] }],
  ["deno", { code: ["-e", "--eval"], subcommand: "eval" }],
  ["python", { code: ["-c"] }],
  ["python2", { code: ["-c"] }],
  ["python3", { code: ["-c"] }],
  ["pypy", { code: ["-c"] }],
  ["pypy3", { code: ["-c"] }],
  ["ruby", { code: ["-e"] }],
  ["perl", { code: ["-e", "-E"] }],
  ["php", { code: ["-r"] }],
  ["osascript", { code: ["-e"] }],
  ["awk", {
    code: ["-e", "--source"],
    firstOperand: true,
    values: ["-F", "-v", "--field-separator", "--assign"],
    fromFile: ["-f", "--file", "--exec"],
  }],
  ["gawk", {
    code: ["-e", "--source"],
    firstOperand: true,
    values: ["-F", "-v", "--field-separator", "--assign"],
    fromFile: ["-f", "--file", "--exec"],
  }],
  ["mawk", { code: ["-e"], firstOperand: true, values: ["-F", "-v"], fromFile: ["-f"] }],
  ["nawk", { code: ["-e"], firstOperand: true, values: ["-F", "-v"], fromFile: ["-f"] }],
]);

/** Find the inline code one interpreter invocation carries, and judge it. */
export function interpreterFindings(
  verb: string,
  spec: InterpreterSpec,
  rest: Word[],
  context: Context,
): { findings: WriteFinding[]; program: boolean; operands: Word[] } {
  const code = optionSet(spec.code);
  const values = optionSet(spec.values);
  const findings: WriteFinding[] = [];
  const operands: Word[] = [];
  let optionsEnded = false;
  let subcommand = false;
  /** True once the command line has said what the interpreter runs. */
  let program = anyPresent(spec.fromFile, optionsPresent(rest));
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    const value = word.value;
    if (value === ";" || value === "+" || value === "(" || value === ")") break;
    if (!optionsEnded) {
      if (value === "--") {
        optionsEnded = true;
        continue;
      }
      if (value.startsWith("-") && value !== "-") {
        const eq = value.indexOf("=");
        const name = eq === -1 ? value : value.slice(0, eq);
        const attached = eq === -1 ? null : value.slice(eq + 1);
        const take = (): Word | undefined => {
          if (attached !== null) {
            // The raw carries the quoting the code was written with, which is
            // what `inlineCodeFindings` reads; the `=` is found in it too.
            const at = word.raw.indexOf("=");
            return { ...word, raw: at === -1 ? attached : word.raw.slice(at + 1), value: attached };
          }
          i += 1;
          return rest[i];
        };
        if (code.has(name)) {
          program = true;
          const operand = take();
          if (operand !== undefined) {
            findings.push(...inlineCodeFindings(verb, `${verb} ${name}`, operand, context, context.cwd));
          }
          continue;
        }
        // A short option carrying its code with no space: `python3 -c'…'` is
        // one word by the time the lexer has removed the quotes.
        const short = code.has(value.slice(0, 2)) ? value.slice(0, 2) : null;
        if (short !== null && value.length > 2) {
          program = true;
          const inline = value.slice(2);
          findings.push(
            ...inlineCodeFindings(
              verb,
              `${verb} ${short}`,
              { ...word, raw: word.raw.slice(2), value: inline },
              context,
              context.cwd,
            ),
          );
          continue;
        }
        if (values.has(name)) take();
        continue;
      }
      if (spec.subcommand !== undefined && !subcommand && value === spec.subcommand) {
        subcommand = true;
        program = true;
        const operand = rest[i + 1];
        if (operand !== undefined) {
          i += 1;
          findings.push(
            ...inlineCodeFindings(verb, `${verb} ${spec.subcommand}`, operand, context, context.cwd),
          );
        }
        continue;
      }
    }
    operands.push(word);
  }
  // `awk 'program' file…`: the program is the first operand, unless an option
  // already supplied one or named a file to read it from.
  if (
    spec.firstOperand === true &&
    findings.length === 0 &&
    !anyPresent(spec.fromFile, optionsPresent(rest)) &&
    !anyPresent(spec.code, optionsPresent(rest)) &&
    operands.length > 0
  ) {
    program = true;
    findings.push(...inlineCodeFindings(verb, `${verb}`, operands.shift()!, context, context.cwd));
  }
  return { findings, program, operands };
}

/** The Pythons, which read their own options as CPython does. */
const PYTHONS = new Set(["python", "python2", "python3", "pypy", "pypy3"]);
/** CPython's option letters that are flags, that take a value, and that name the program and end its options. */
const PYTHON_FLAGS = new Set([..."bBdEhiIOqsSuvVxPR"]);
const PYTHON_VALUES = new Set([..."WX"]);
const PYTHON_PROGRAM = new Set([..."cm"]);
const PYTHON_LONG_FLAGS = new Set(["--help", "--help-env", "--help-xoptions", "--help-all", "--version"]);
const PYTHON_LONG_VALUES = new Set(["--check-hash-based-pycs"]);

/** node's options that take the next word as their value, their code among them, and those that are flags. */
const NODE_CODE = new Set(["-e", "--eval", "-p", "--print", "-pe"]);
const NODE_VALUES = new Set([
  "-r", "--require", "--import", "-C", "--conditions", "--title", "--env-file", "--test-name-pattern",
  "--test-skip-pattern", "--test-reporter", "--test-reporter-destination", "--disable-warning",
  "--input-type", "--inspect-port",
]);
const NODE_FLAGS = new Set([
  "--test", "--watch", "-c", "--check", "-i", "--interactive", "-v", "--version", "-h", "--help",
  "--no-warnings", "--no-deprecation", "--trace-warnings", "--trace-deprecation", "--throw-deprecation",
  "--enable-source-maps", "--expose-gc", "--experimental-vm-modules", "--experimental-strip-types",
  "--experimental-test-coverage", "--test-only", "--test-update-snapshots", "--preserve-symlinks",
  "--abort-on-uncaught-exception",
]);

/**
 * How an interpreter reads one of its own options: how many words after it
 * are its value, whether that value names the program it runs (`-m`), and
 * whether the interpreter reads no options after it (Python's `-c` and `-m`).
 * Null for one this does not know, which may take the next word.
 */
function ownOption(python: boolean, value: string): { takes: number; names: boolean; ends: boolean } | null {
  if (!python) {
    if (value.startsWith("--") && value.includes("=")) return { takes: 0, names: false, ends: false };
    if (NODE_CODE.has(value) || NODE_VALUES.has(value)) return { takes: 1, names: false, ends: false };
    return NODE_FLAGS.has(value) ? { takes: 0, names: false, ends: false } : null;
  }
  if (value.startsWith("--")) {
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
    if (PYTHON_LONG_FLAGS.has(name)) return { takes: 0, names: false, ends: false };
    if (PYTHON_LONG_VALUES.has(name)) return { takes: value.includes("=") ? 0 : 1, names: false, ends: false };
    return null;
  }
  for (let at = 1; at < value.length; at += 1) {
    const letter = value[at]!;
    if (PYTHON_FLAGS.has(letter)) continue;
    const takes = at === value.length - 1 ? 1 : 0;
    if (PYTHON_VALUES.has(letter)) return { takes, names: false, ends: false };
    if (PYTHON_PROGRAM.has(letter)) return { takes, names: letter === "m", ends: true };
    return null;
  }
  return { takes: 0, names: false, ends: false };
}

/** Every word, wherever it stands, as an option the interpreter may read. */
const EVERY_WORD: OptionReading = { ends: "never", operands: false, named: false };

/**
 * The words the line builds where an interpreter still reads them as its own
 * options or as the program it runs, and how to write one so it does not.
 *
 * node and the Pythons stop reading options at the program: the script, the
 * word after `--`, Python's `-c` code or `-m` module. After it every word is
 * the program's own — `node scripts/build.js "$(git rev-parse HEAD)"`,
 * `python3 -m pytest $(git ls-files test)`. Before it, what a word built at
 * run time prints can be `-e` and code the inline reader never sees, and one
 * standing where the program does names at run time what runs, save one that
 * begins as an object name or an absolute path (`building`'s `prints`), which
 * is the program: `node "$(git rev-parse --show-toplevel)/scripts/build.js"`.
 * node's `--test` makes every word after `--` a test file, but before `--`
 * node still reads options, and `--no-test -e …` runs code. Where the program
 * or an option's value would stand, a word that begins with an expansion —
 * `$Y`, `"$Y"`, `$1`, `$@`, or a variable the line assigns, which a subshell
 * or a command in front of it can keep from reaching this one — can be empty,
 * an option or several words, so where the program stands cannot be told;
 * so too after an option this does not know, which may take the next word.
 * From there every word built after it is read as one the interpreter may
 * take as an option. The other interpreters read every word as an option
 * wherever it stands.
 */
export function interpreterBuiltWords(
  verb: string,
  rest: readonly Word[],
  assigned: Assigned | undefined,
): { built: BuiltWords; keep: string } {
  const python = PYTHONS.has(verb);
  if (!python && verb !== "node" && verb !== "nodejs") {
    return {
      built: builtOption(rest, EVERY_WORD, assigned),
      keep: `${verb} reads a word there as more than an operand wherever it stands, so write it on the line`,
    };
  }
  const keep =
    `${verb} reads a word there as its own option or as the program it runs — write it after the ` +
    (python ? "script or the -m module" : "script, or after -- under --test");
  const found: number[] = [];
  const result = (unreadable?: Word) => ({
    built: unreadable === undefined ? { assigned: found } : { unreadable, assigned: found },
    keep,
  });
  /** Every word from `from` on, read as one the interpreter may take as an option. */
  const everyWord = (from: number) => {
    const after = builtOption(rest.slice(from), EVERY_WORD, assigned, from);
    found.push(...after.assigned);
    return result(after.unreadable);
  };
  /** The program a word built at run time names: one that begins as an object name or a path, or none. */
  const program = (how: Building & { kind: "built" }, word: Word) =>
    result(how.prints !== null && !how.splits ? undefined : word);
  let testing = false;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (word.redirect === true) continue;
    const how = building(word, assigned);
    if (how.kind === "assigned") {
      found.push(i);
      return everyWord(i + 1);
    }
    if (how.kind === "built") return program(how, word);
    if (expansionLed(word)) return everyWord(i + 1);
    const value = word.value;
    if (value === "--") {
      if (testing) return result();
      // After `--` nothing is an option, and the first word that is there
      // when the line runs is the program.
      for (let at = i + 1; at < rest.length; at += 1) {
        const named = rest[at]!;
        if (named.redirect === true) continue;
        const shape = building(named, assigned);
        if (shape.kind === "assigned") found.push(at);
        else if (shape.kind === "built") return program(shape, named);
        else if (!expansionLed(named)) return result();
      }
      return result();
    }
    if (!value.startsWith("-") || value === "-") return result();
    const own = ownOption(python, value);
    if (own === null) return everyWord(i + 1);
    if (!python && value === "--test") testing = true;
    for (let k = 0; k < own.takes && i + 1 < rest.length; k += 1) {
      i += 1;
      const operand = building(rest[i]!, assigned);
      if (operand.kind === "assigned") found.push(i);
      else if (operand.kind === "built" && (own.names || operand.splits)) return result(rest[i]!);
      // A value the shell can drop or split moves every word after it.
      if (operand.kind !== "built" && expandedPrefix(rest[i]!.raw)?.splits === true) return everyWord(i + 1);
    }
    if (own.ends) return result();
  }
  return result();
}
