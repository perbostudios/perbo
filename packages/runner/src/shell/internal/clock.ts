import type { Word } from "./lexer.js";

/**
 * `date`'s long options, each with whether it takes a value in the next word
 * when none is attached. GNU accepts any unambiguous prefix of one, so `--se`
 * is `--set`; the aliases of `--utc` share its letter and are one option.
 */
const LONG: ReadonlyArray<[name: string, value: "required" | "none" | "optional"]> = [
  ["date", "required"],
  ["debug", "none"],
  ["file", "required"],
  ["iso-8601", "optional"],
  ["reference", "required"],
  ["resolution", "none"],
  ["rfc-2822", "none"],
  ["rfc-3339", "required"],
  ["rfc-822", "none"],
  ["rfc-email", "none"],
  ["set", "required"],
  ["uct", "none"],
  ["universal", "none"],
  ["utc", "none"],
  ["help", "none"],
  ["version", "none"],
];

/** The short options that take a value: the rest of the cluster, or the next word. */
const SHORT_VALUES = new Set(["d", "f", "r", "s"]);

/**
 * The options after which an operand is not a time to set: GNU's `-d`, `-f`
 * and `-r` read a time from somewhere else, and BSD's `-j` never sets one.
 */
const READS_ELSEWHERE = new Set(["-d", "-f", "-r", "-j", "--date", "--file", "--reference"]);

/**
 * Whether `date`, given the words after it, sets the system clock — or null
 * where it does not, else the spelling that does: `-s` in any cluster (`-us`,
 * `-su`), any prefix of `--set` GNU accepts (`--s`, `--se=…`), or an operand
 * that is not a `+FORMAT`, which is the `MMDDhhmm[[CC]YY][.ss]` form.
 *
 * Read the way `date` reads its words rather than by prefix, because the deny
 * list's `Bash(date -s:*)` and `Bash(date --set:*)` see only the front of the
 * line. A word built at run time could be any of these, so it counts as one
 * unless it is a `+FORMAT` or the value of an option.
 */
export function clockSetting(words: readonly Word[]): string | null {
  const present = new Set<string>();
  const operands: Word[] = [];
  let optionsEnded = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const value = word.value;
    if ((word.variable || word.substitutions.length > 0) && !value.startsWith("+")) return word.raw;
    if (optionsEnded || !value.startsWith("-") || value === "-") {
      operands.push(word);
      continue;
    }
    if (value === "--") {
      optionsEnded = true;
      continue;
    }
    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      const name = value.slice(2, eq === -1 ? undefined : eq);
      const matches = LONG.filter(([long]) => long.startsWith(name));
      const exact = matches.find(([long]) => long === name);
      // An ambiguous prefix is an error to `date`, unless every option it could
      // be is one of `--utc`'s spellings.
      const utc = matches.every(([long]) => ["uct", "universal", "utc"].includes(long));
      const chosen = exact ?? (matches.length === 1 || utc ? matches[0] : undefined);
      if (chosen === undefined) continue;
      const [long, takes] = chosen;
      if (long === "set") return word.raw;
      present.add(`--${long}`);
      if (takes === "required" && eq === -1) i += 1;
      continue;
    }
    for (let at = 1; at < value.length; at += 1) {
      const letter = value[at]!;
      if (letter === "s") return word.raw;
      present.add(`-${letter}`);
      // `-I` takes the rest of its cluster as its optional value, `-Iseconds`.
      if (letter === "I") break;
      if (SHORT_VALUES.has(letter)) {
        if (at === value.length - 1) i += 1;
        break;
      }
    }
  }
  if ([...READS_ELSEWHERE].some((option) => present.has(option))) return null;
  return operands.find((word) => !word.value.startsWith("+"))?.raw ?? null;
}
