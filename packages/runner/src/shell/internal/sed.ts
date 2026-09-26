import { carries, longOption, type Context } from "./command.js";
import { judgeTarget, pathFinding, type WriteFinding } from "./destination.js";
import type { Word } from "./lexer.js";

/**
 * Where one reading of a `sed` line finds the script it runs: the words that
 * hold it, a script the line does not spell, or a line `sed` refuses to run.
 */
type Reading =
  | { kind: "scripts"; words: Word[] }
  | { kind: "unreadable"; why: string }
  | { kind: "refused" };

/** GNU `sed`'s long options, which it reads by any unambiguous prefix. */
const GNU_LONGS = [
  "--expression", "--file", "--in-place", "--line-length", "--quiet", "--silent", "--debug",
  "--follow-symlinks", "--posix", "--regexp-extended", "--separate", "--sandbox", "--unbuffered",
  "--binary", "--null-data", "--zero-terminated", "--help", "--version",
];

/**
 * The script a line hands GNU `sed`, which reads options anywhere before `--`:
 * every `-e` and `--expression`, and the first operand where there is none.
 * `-i` and `--in-place` take a suffix only attached, and `-l` takes a value.
 */
function gnuReading(rest: readonly Word[], context: Context): Reading {
  const scripts: Word[] = [];
  const operands: Word[] = [];
  let fromFile = false;
  let ended = false;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (word.redirect === true) continue;
    const value = word.value;
    if (!ended && value === "--") {
      ended = true;
      continue;
    }
    if (!ended && value.startsWith("--")) {
      const eq = value.indexOf("=");
      const name = longOption(eq === -1 ? value : value.slice(0, eq), GNU_LONGS);
      if (name === null) return { kind: "refused" };
      if (name === "--help" || name === "--version") return { kind: "scripts", words: [] };
      if (name === "--expression" || name === "--file" || name === "--line-length") {
        const operand = eq === -1 ? rest[(i += 1)] : { ...word, raw: value.slice(eq + 1), value: value.slice(eq + 1) };
        if (operand === undefined) return { kind: "refused" };
        if (name === "--expression") scripts.push(operand);
        if (name === "--file") fromFile = true;
      }
      continue;
    }
    if (!ended && value.startsWith("-") && value !== "-") {
      for (let at = 1; at < value.length; at += 1) {
        const letter = value[at]!;
        if ("nrsuzEb".includes(letter)) continue;
        // The rest of the cluster is the suffix a backup takes.
        if (letter === "i") break;
        if (letter === "e" || letter === "f" || letter === "l") {
          const inline = value.slice(at + 1);
          const operand = inline.length > 0 ? { ...word, raw: inline, value: inline } : rest[(i += 1)];
          if (operand === undefined) return { kind: "refused" };
          if (letter === "e") scripts.push(operand);
          if (letter === "f") fromFile = true;
          break;
        }
        return { kind: "refused" };
      }
      continue;
    }
    operands.push(word);
  }
  return scriptsOf(scripts, operands, fromFile, context);
}

/**
 * The script a line hands BSD `sed`, which reads options only before its first
 * operand and knows no long ones: `-i` and `-I` always take the next word as
 * the suffix where none is attached, so `sed -i 's/a/b/' 'w /tmp/x'` runs
 * `w /tmp/x` there.
 */
function bsdReading(rest: readonly Word[], context: Context): Reading {
  const scripts: Word[] = [];
  let fromFile = false;
  let i = 0;
  for (; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (word.redirect === true) continue;
    const value = word.value;
    if (value === "--") {
      i += 1;
      break;
    }
    if (!value.startsWith("-") || value === "-") break;
    if (value.startsWith("--")) return { kind: "refused" };
    for (let at = 1; at < value.length; at += 1) {
      const letter = value[at]!;
      if ("Ealnru".includes(letter)) continue;
      if ("Iief".includes(letter)) {
        const inline = value.slice(at + 1);
        const operand = inline.length > 0 ? { ...word, raw: inline, value: inline } : rest[(i += 1)];
        if (operand === undefined) return { kind: "refused" };
        if (letter === "e") scripts.push(operand);
        if (letter === "f") fromFile = true;
        break;
      }
      return { kind: "refused" };
    }
  }
  const operands = rest.slice(i).filter((word) => word.redirect !== true);
  return scriptsOf(scripts, operands, fromFile, context);
}

/** The script words a reading found, or why they cannot be read. */
function scriptsOf(scripts: Word[], operands: readonly Word[], fromFile: boolean, context: Context): Reading {
  if (fromFile) return { kind: "unreadable", why: "sed -f reads its script from a file, which is not on the line" };
  if (scripts.length === 0) {
    const first = operands[0];
    // Nothing on the line: no script at all, or one a wrapper appends.
    if (first === undefined) return { kind: "refused" };
    scripts.push(first);
  }
  const built = scripts.find(
    (word) => word.variable || word.substitutions.length > 0 || carries(context.supplied, word.value),
  );
  if (built !== undefined) return { kind: "unreadable", why: `the script ${built.raw} is built at run time` };
  return { kind: "scripts", words: scripts };
}

/** What a `sed` script does beyond editing the text it reads. */
interface ScriptActs {
  /** The files a `w` or `W` command, or an `s` command's `w` flag, writes. */
  writes: Array<{ command: string; file: string }>;
  /** True where an `e` command or an `s` command's `e` flag runs a shell command. */
  runs: boolean;
  /** Null where the script reads through to its end, else where it stopped. */
  error: string | null;
}

const DIGIT = /[0-9]/;

/**
 * Read a `sed` script as GNU and BSD `sed` compile one, far enough to find
 * every command that writes a file or runs a program.
 *
 * `brackets` reads a delimiter inside a regex's bracket expression as part of
 * it, as BSD does; GNU ends the regex there. A file a `w` names runs to the end
 * of its line, `;` included, as both read it, and so does the text of `a`, `i`
 * and `c`. A label ends at `;`, a newline or `}`, which is where the earliest
 * of them ends it, so no command after one goes unread.
 */
export function readSedScript(text: string, brackets: boolean): ScriptActs {
  const writes: ScriptActs["writes"] = [];
  let runs = false;
  let i = 0;
  const stop = (error: string): ScriptActs => ({ writes, runs, error });
  const blanks = () => {
    while (text[i] === " " || text[i] === "\t") i += 1;
  };
  const toLineEnd = (): string => {
    const start = i;
    while (i < text.length && text[i] !== "\n") i += 1;
    return text.slice(start, i);
  };
  const digits = () => {
    while (DIGIT.test(text[i] ?? "")) i += 1;
  };
  /** Read to the unescaped `delimiter`, past it; false where there is none. */
  const delimited = (delimiter: string, regex: boolean): boolean => {
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === delimiter) {
        i += 1;
        return true;
      }
      if (ch === "\n") return false;
      if (regex && brackets && ch === "[") {
        i += 1;
        if (text[i] === "^") i += 1;
        if (text[i] === "]") i += 1;
        while (i < text.length && text[i] !== "]") {
          const open = text[i + 1];
          if (text[i] === "[" && (open === ":" || open === "." || open === "=")) {
            const close = text.indexOf(`${open}]`, i + 2);
            if (close === -1) return false;
            i = close + 2;
            continue;
          }
          i += 1;
        }
        if (i >= text.length) return false;
      }
      i += 1;
    }
    return false;
  };
  /** One address: true where one was read, false where none stands, null where it does not close. */
  const address = (): boolean | null => {
    const ch = text[i];
    if (ch === undefined) return false;
    if (DIGIT.test(ch)) {
      digits();
      if (text[i] === "~") {
        i += 1;
        digits();
      }
      return true;
    }
    if (ch === "$") {
      i += 1;
      return true;
    }
    if (ch === "/" || ch === "\\") {
      const delimiter = ch === "/" ? "/" : text[i + 1];
      if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") return null;
      i += ch === "/" ? 1 : 2;
      if (!delimited(delimiter, delimiter !== "[")) return null;
      while (text[i] === "I" || text[i] === "M") i += 1;
      return true;
    }
    return false;
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === ";" || ch === "}") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      toLineEnd();
      continue;
    }
    const first = address();
    if (first === null) return stop("an address that does not close");
    if (first) {
      blanks();
      if (text[i] === ",") {
        i += 1;
        blanks();
        if (text[i] === "+" || text[i] === "~") {
          i += 1;
          if (!DIGIT.test(text[i] ?? "")) return stop("a step with no count");
          digits();
        } else if (address() !== true) {
          return stop("a range with no second address");
        }
      }
    }
    blanks();
    while (text[i] === "!") {
      i += 1;
      blanks();
    }
    const command = text[i];
    if (command === undefined) return stop("an address with no command");
    i += 1;
    if ("{}=dDgGhHnNpPxzF".includes(command)) continue;
    if ("lLqQ".includes(command)) {
      blanks();
      digits();
      continue;
    }
    if (command === ":" || command === "b" || command === "t" || command === "T" || command === "v") {
      while (i < text.length && !"\n;}".includes(text[i]!)) i += 1;
      continue;
    }
    if (command === "a" || command === "i" || command === "c") {
      // The text runs to the end of the line, a backslash carrying it onto the next.
      while (i < text.length && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (command === "r" || command === "R" || command === "w" || command === "W") {
      blanks();
      const file = toLineEnd();
      if (command === "w" || command === "W") writes.push({ command, file });
      continue;
    }
    if (command === "e") {
      runs = true;
      toLineEnd();
      continue;
    }
    if (command === "s" || command === "y") {
      const delimiter = text[i];
      if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") {
        return stop(`an ${command} command with no delimiter`);
      }
      i += 1;
      if (!delimited(delimiter, command === "s" && delimiter !== "[")) return stop(`an ${command} command that does not close`);
      if (!delimited(delimiter, false)) return stop(`an ${command} command that does not close`);
      if (command === "y") continue;
      while (i < text.length) {
        const flag = text[i]!;
        if ("gpiImM".includes(flag) || DIGIT.test(flag)) {
          i += 1;
          continue;
        }
        if (flag === "e") {
          runs = true;
          i += 1;
          continue;
        }
        if (flag === "w") {
          i += 1;
          blanks();
          writes.push({ command: "s///w", file: toLineEnd() });
        }
        break;
      }
      continue;
    }
    return stop(`${command}, which is not a sed command`);
  }
  return { writes, runs, error: null };
}

/**
 * What a `sed` line's script writes and runs, read as GNU and as BSD `sed`
 * would read the line, with and without a regex's bracket expression holding
 * the delimiter.
 *
 * A file a `w` or `W` command or an `s///w` flag names is judged as a write to
 * that path, from where the command runs; `sed` opens it as it reads the
 * script, before a line of input and whatever the rest of the script turns
 * out to be. An `e` command and an `s///e` flag run a shell command the line
 * does not spell, and are refused as a program run. A script the line does not
 * spell — a variable, a substitution, a `-f` file, words a wrapper appends —
 * cannot be read, and neither can one no reading gets to the end of.
 */
export function sedFindings(rest: readonly Word[], context: Context): WriteFinding[] {
  const segment = context.segment.slice(0, 200);
  const unreadable = (why: string): WriteFinding => ({
    detail: `what this sed script writes or runs cannot be read — ${why}: ${segment}`,
    target: null,
    resolved: null,
    cause: "unreadable_program",
  });
  const readings = [gnuReading(rest, context), bsdReading(rest, context)];
  const acts: ScriptActs[] = [];
  for (const reading of readings) {
    if (reading.kind === "unreadable") return [unreadable(reading.why)];
    if (reading.kind === "refused") continue;
    const text = reading.words.map((word) => word.value).join("\n");
    acts.push(readSedScript(text, true), readSedScript(text, false));
  }
  const findings: WriteFinding[] = [];
  const judged = new Set<string>();
  for (const { writes } of acts) {
    for (const { command, file } of writes) {
      if (file.length === 0 || judged.has(file)) continue;
      judged.add(file);
      findings.push(
        ...pathFinding(
          `the file sed ${command} writes`,
          { raw: file, value: file },
          judgeTarget(file, context.scope, context.cwd, false),
          context.segment,
        ),
      );
    }
  }
  if (acts.some((act) => act.runs)) {
    findings.push({
      detail: `sed's e command runs a shell command this guard does not read: ${segment}`,
      target: null,
      resolved: null,
      cause: "unreadable_program",
    });
  }
  const failed = acts.find((act) => act.error !== null);
  if (acts.length > 0 && acts.every((act) => act.error !== null)) findings.push(unreadable(failed!.error!));
  if (acts.length === 0) findings.push(unreadable("no reading of its options runs a script"));
  return findings;
}
