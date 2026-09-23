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
