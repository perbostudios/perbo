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
   * The wrapper that appends the words it reads from standard input to this
   * command, where one stands in front of it. Those words are operands, so a
   * writer reached this way names destinations the line does not carry.
   */
  appendsOperands?: string | undefined;
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
