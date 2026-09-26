import type { WriteFinding } from "./destination.js";
import type { StdinSource, Word } from "./lexer.js";
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
    detail: `${label} cannot be resolved — ${how}, and they are not on the line: ${segment}`,
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
    detail: `${how}, ${read}: ${context.segment}`,
    target: null,
    resolved: null,
  };
}

export const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
export const isAssignment = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);

export const optionSet = (values: readonly string[] | undefined) => new Set(values ?? []);

/**
 * Every option a command was given, long names and short letters alike, read
 * before the operands are. A `sed` is only an edit while `-i` is present and a
 * `tar -f` is only a write while `-c` is, and neither question can be answered
 * from the word that stands in front of the option.
 *
 * A value attached to a short cluster contributes its characters as though they
 * were option letters. The set is only ever asked whether an option is present,
 * so the surplus can widen a judgement and never narrow one.
 */
export function optionsPresent(rest: readonly Word[]): Set<string> {
  const present = new Set<string>();
  for (const word of rest) {
    const value = word.value;
    if (value === "--") break;
    if (!value.startsWith("-") || value === "-") continue;
    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      present.add(eq === -1 ? value : value.slice(0, eq));
      continue;
    }
    for (const letter of value.slice(1)) present.add(`-${letter}`);
  }
  return present;
}

export const anyPresent = (options: readonly string[] | undefined, present: Set<string>) =>
  options !== undefined && options.some((option) => present.has(option));
