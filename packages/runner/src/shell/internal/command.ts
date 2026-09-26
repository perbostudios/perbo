import type { WriteFinding } from "./destination.js";
import { expandAssigned, type Assigned } from "./assigned.js";
import { substitutedShape, type StdinSource, type Word } from "./lexer.js";
import type { Cwd, ResolvedScope } from "./scope.js";

export interface Context {
  scope: ResolvedScope;
  cwd: Cwd;
  segment: string;
  depth: number;
  /** Where the command's standard input comes from, where the line says. */
  stdin?: StdinSource | undefined;
  /**
   * The operands a wrapper supplies to this command from its standard input,
   * where one stands in front of it. Those words are not on the line, so a
   * writer reached this way names destinations the line does not carry.
   */
  supplied?: SuppliedOperands | undefined;
  /** The variables the line assigns, and the value each holds where it spells it. */
  assigned?: Assigned | undefined;
  /**
   * True for the second reading of a command, with every word built from a
   * variable the line assigns a value it spells read as that value.
   */
  expanded?: boolean | undefined;
}

/**
 * How a wrapper hands a command the words it reads: `xargs` appends them as
 * further operands, or, where one of its options names a placeholder,
 * substitutes them for that placeholder in the operands the line spells.
 */
export interface SuppliedOperands {
  /** The wrapper's name, for the sentence a refusal writes. */
  wrapper: string;
  /** The placeholder the words replace, or null where they are appended. */
  placeholder: string | null;
  /**
   * The placeholder is replaced only where an operand is exactly it; where no
   * operand is, the words are appended after all (BSD `xargs -J`).
   */
  wholeWord: boolean;
}

/** Whether the wrapper in front substitutes the words it reads into this one. */
export const carries = (supplied: SuppliedOperands | undefined, value: string): boolean =>
  supplied !== undefined &&
  supplied.placeholder !== null &&
  (supplied.wholeWord ? value === supplied.placeholder : value.includes(supplied.placeholder));

/**
 * A destination the wrapper in front supplies rather than the line — appended
 * to the command or substituted for its placeholder — which is not a path this
 * guard can resolve.
 */
export function suppliedDestination(
  label: string,
  supplied: SuppliedOperands,
  segment: string,
): WriteFinding {
  const how =
    supplied.placeholder === null
      ? `${supplied.wrapper} appends the words it reads from standard input to this command`
      : `${supplied.wrapper} substitutes the words it reads from standard input for ${supplied.placeholder}`;
  return {
    detail: `${label} cannot be resolved — ${how}, and they are not on the line: ${segment.slice(0, 200)}`,
    target: null,
    resolved: null,
  };
}

/**
 * The words a wrapper supplies, where the command behind it still reads them
 * as options: a placeholder that begins a word before the command's `--`, or
 * words appended to a line with no `--`. A command that reads `revisions`
 * (`git diff`, `log`, `show`, `format-patch`) also ends its options at
 * `--end-of-options`, which keeps the words after it revisions where `--`
 * would make them paths. What the wrapper reads is not the
 * line's to vouch for — `touch -- 'sub/-t..'; ls sub | xargs -I{} cp {} out`
 * runs GNU `cp -t.. out` — so a word that begins with `-` there is an option,
 * which can move where the command writes. `dd` reads no options, but an
 * `of=` among its operands names where it writes, `--` or not, so for a
 * command that `takesAssignments` every supplied word is refused.
 */
export function suppliedAsOption(
  verb: string,
  rest: readonly Word[],
  context: Context,
  takesAssignments = false,
  revisions = false,
): WriteFinding | null {
  const supplied = context.supplied;
  if (supplied === undefined) return null;
  const ends = takesAssignments
    ? -1
    : rest.findIndex((word) => word.value === "--" || (revisions && word.value === "--end-of-options"));
  const placeholder = supplied.placeholder;
  const at =
    placeholder === null
      ? null
      : (ends === -1 ? rest : rest.slice(0, ends)).find((word) =>
          word.value.startsWith(placeholder),
        );
  if (placeholder === null ? ends !== -1 : at === undefined) return null;
  const how =
    placeholder === null
      ? `${supplied.wrapper} appends the words it reads from standard input to ${verb}'s`
      : `${supplied.wrapper} substitutes the words it reads from standard input for the ` +
        `${placeholder} that begins ${at!.raw}`;
  const read = takesAssignments
    ? `and ${verb} reads an of= among its operands as where it writes`
    : `where ${verb} still reads options, so one that begins with - is an option rather than a ` +
      `path — ${
        placeholder === null
          ? revisions
            ? "end the line with --end-of-options to keep them revisions, or with -- to make them paths"
            : "end the line with -- to keep them paths"
          : revisions
            ? "put --end-of-options before it to keep it a revision, or -- to make it a path"
            : `put -- before it, or a prefix such as ./${placeholder}`
      }`;
  return {
    detail: `${how}, ${read}: ${context.segment.slice(0, 200)}`,
    target: null,
    resolved: null,
  };
}

/**
 * How the shell builds one of a command's words: as the line spells it; from
 * variables the line assigns a value it spells, as the words that value
 * becomes; or when the line runs — by a `$(…)`, a backtick pair, or a
 * variable the line assigns a value built at run time — where only the text
 * ahead of the first expansion is known, and whether the shell splits the
 * rest into more words.
 */
export type Building =
  | { kind: "spelled" }
  | { kind: "assigned"; words: Word[] }
  | { kind: "built"; prefix: string; splits: boolean };

export function building(word: Word, assigned: Assigned | undefined): Building {
  if (word.substitutions.length === 0) {
    if (!word.variable || assigned === undefined) return { kind: "spelled" };
    const words = expandAssigned(word, assigned);
    if (words === null) return { kind: "spelled" };
    if (words !== "unreadable") return { kind: "assigned", words };
  }
  const shape = substitutedShape(word.raw, new Set(assigned?.keys() ?? []));
  return shape === null ? { kind: "spelled" } : { kind: "built", ...shape };
}

/**
 * How a command reads the words the line builds.
 *
 * `ends` is where it stops reading options: at `--`, at `--end-of-options` as
 * well, which keeps the words after it revisions for git's revision readers,
 * or nowhere — `find`'s expression and `dd`'s `of=`. `operands` says a word
 * that expands to one word beginning with a literal other than `-` is an
 * operand wherever it stands. `named` says `--name="$(…)"` is that option
 * with a value built at run time, judged as the command's reader judges a
 * value it can read: `git log --output="$(…)"` is refused as a path it cannot
 * place. `values` says how many words after an option the line spells are
 * that option's value, where the command's own table knows: a word built
 * there is the value, `rg -e "$(cat pat)"`, so long as the shell does not
 * split it into more words.
 */
export interface OptionReading {
  ends: "dashes" | "revisions" | "never";
  operands: boolean;
  named: boolean;
  values?: (option: string) => number;
}

/**
 * A command this guard does not read: it stops reading options at `--`, and
 * `--name="$(…)"` is that option's value; anywhere else a word built at run
 * time is one it cannot read.
 */
export const UNREAD_OPTIONS: OptionReading = { ends: "dashes", operands: false, named: true };

/**
 * What `builtOption` finds among a command's words: the first word built at
 * run time that the command can read as an option, and where each word built
 * from a variable the line assigns a value it spells stands, by its index in
 * the words read plus `offset`, for a second reading with the value in its
 * place.
 */
export interface BuiltWords {
  unreadable?: Word;
  assigned: number[];
}

/**
 * The words the line builds where the command still reads them as options.
 *
 * What a substitution prints is not on the line, so where it can begin with
 * `-` it can be any option at all — `git diff $(printf -- --output=/tmp/x)`
 * writes a file and `node $(printf -- -e) …` runs code — and the command's
 * reading of its own words says nothing about it. Outside double quotes the
 * shell splits what it prints into further words, any of which can be one. A
 * variable the line assigns such a value is the same word; one it assigns a
 * value it spells is read again as that value.
 */
export function builtOption(
  rest: readonly Word[],
  reading: OptionReading,
  assigned: Assigned | undefined,
  offset = 0,
): BuiltWords {
  const found: number[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (word.redirect === true) continue;
    const how = building(word, assigned);
    if (how.kind === "assigned") {
      found.push(offset + i);
      continue;
    }
    if (how.kind === "spelled") {
      if (reading.ends !== "never" && word.value === "--") break;
      if (reading.ends === "revisions" && word.value === "--end-of-options") break;
      const takes = reading.values?.(word.value) ?? 0;
      for (let k = 0; k < takes && i + 1 < rest.length; k += 1) {
        i += 1;
        const value = building(rest[i]!, assigned);
        if (value.kind === "assigned") found.push(offset + i);
        else if (value.kind === "built" && value.splits) return { unreadable: rest[i]!, assigned: found };
      }
      continue;
    }
    if (how.splits || how.prefix.length === 0) return { unreadable: word, assigned: found };
    if (!how.prefix.startsWith("-")) {
      if (reading.operands) continue;
      return { unreadable: word, assigned: found };
    }
    if (reading.named && how.prefix.startsWith("--") && how.prefix.includes("=")) continue;
    return { unreadable: word, assigned: found };
  }
  return { assigned: found };
}

/**
 * How many words after an option are its value, for a command whose table
 * names the options that take one: a long option whole, or by an unambiguous
 * prefix of `longs` where the command reads prefixes as GNU does, without an
 * attached `=`; a short one ending a cluster of flags, as `-bS` does.
 */
export function valuesOf(takes: Iterable<string>, longs?: Iterable<string>): (option: string) => number {
  const taking = new Set(takes);
  const names = longs === undefined ? [] : [...longs];
  return (option) => {
    if (option.startsWith("--")) {
      if (option.includes("=")) return 0;
      const name = longs === undefined ? option : longOption(option, names);
      return name !== null && taking.has(name) ? 1 : 0;
    }
    if (!option.startsWith("-") || option.length < 2) return 0;
    for (let at = 1; at < option.length; at += 1) {
      if (taking.has(`-${option[at]}`)) return at === option.length - 1 ? 1 : 0;
    }
    return 0;
  };
}

/** How to write a word `builtOption` found so the command reads it as an operand. */
export function keepAsOperand(verb: string, reading: OptionReading): string {
  return reading.ends === "never"
    ? `${verb} reads a word there as more than an operand wherever it stands, so write it on the line`
    : reading.ends === "revisions"
      ? "put --end-of-options before it to keep it a revision, or -- to make it a path"
      : "put -- before it to keep it an operand";
}

/** The refusal for a word `builtOption` found, ending on how to keep it an operand. */
export function builtOptionFinding(verb: string, word: Word, keep: string, context: Context): WriteFinding {
  return {
    detail:
      `${word.raw} is built when the line runs where ${verb} still reads options, so what it ` +
      `becomes can be an option that writes or runs a program — ${keep}: ${context.segment.slice(0, 200)}`,
    target: null,
    resolved: null,
  };
}

export const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
export const isAssignment = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);

export const optionSet = (values: readonly string[] | undefined) => new Set(values ?? []);

/**
 * The long options a spelling could be, as GNU's `getopt_long` reads it: the
 * whole name where `names` holds it, and otherwise every name it is a prefix
 * of — `--t` is `--target-directory` to `cp`, and `--s` is either `--suffix`
 * or `--sparse`, which GNU refuses as ambiguous.
 */
export function longCandidates(spelled: string, names: Iterable<string>): string[] {
  const all = [...names];
  if (all.includes(spelled)) return [spelled];
  if (spelled.length <= 2 || !spelled.startsWith("--")) return [];
  return all.filter((name) => name.startsWith(spelled));
}

/**
 * The one long option a spelling names: the whole name, or an unambiguous
 * prefix of one of `names`. Null where it is ambiguous or names none of them,
 * which the caller reads as it reads an option it does not know.
 */
export function longOption(spelled: string, names: Iterable<string>): string | null {
  const candidates = longCandidates(spelled, names);
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Every option a command was given, long names and short letters alike, read
 * before the operands are. A `sed` is only an edit while `-i` is present and a
 * `tar -f` is only a write while `-c` is, and neither question can be answered
 * from the word that stands in front of the option.
 *
 * A value attached to a short cluster contributes its characters as though they
 * were option letters, and where `longs` is given a long spelling contributes
 * every name it is a prefix of, ambiguous or not. The set is only ever asked
 * whether an option is present, so the surplus can widen a judgement and never
 * narrow one.
 */
export function optionsPresent(rest: readonly Word[], longs?: Iterable<string>): Set<string> {
  const present = new Set<string>();
  const names = longs === undefined ? [] : [...longs];
  for (const word of rest) {
    const value = word.value;
    if (value === "--") break;
    if (!value.startsWith("-") || value === "-") continue;
    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      const spelled = eq === -1 ? value : value.slice(0, eq);
      present.add(spelled);
      for (const name of longCandidates(spelled, names)) present.add(name);
      continue;
    }
    for (const letter of value.slice(1)) present.add(`-${letter}`);
  }
  return present;
}

export const anyPresent = (options: readonly string[] | undefined, present: Set<string>) =>
  options !== undefined && options.some((option) => present.has(option));
