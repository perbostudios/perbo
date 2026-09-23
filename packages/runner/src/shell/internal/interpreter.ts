import { anyPresent, optionSet, optionsPresent, type Context } from "./command.js";
import type { WriteFinding } from "./destination.js";
import { inlineCodeFindings } from "./inline-code.js";
import type { Word } from "./lexer.js";

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
