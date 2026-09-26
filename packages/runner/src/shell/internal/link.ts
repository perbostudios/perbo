import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { backupFindings, defaultSuffixes } from "./backup.js";
import {
  anyPresent,
  carries,
  longCandidates,
  longOption,
  optionsPresent,
  suppliedAsOption,
  suppliedDestination,
  valuesOf,
  type Context,
} from "./command.js";
import { judgeInto, judgeTarget, pathFinding, type WriteFinding } from "./destination.js";
import type { Word } from "./lexer.js";
import type { Cwd } from "./scope.js";

/**
 * `ln`, whose two operands are two different questions.
 *
 * The link name is a file this command creates, judged like any other
 * destination. The target of a symbolic link is where a write **through** that
 * link lands, so a link inside the worktree pointing out of it is an escape
 * hatch the seal would follow — the resolver already follows one met part way
 * along a path, and this refuses the line that plants it. A relative target
 * resolves against the directory the link itself sits in, which is how the
 * kernel reads it.
 *
 * Behind a wrapper that supplies words from its standard input, a link name or
 * a symbolic link's target that those words fill is a path the line does not
 * spell, and is refused as one; a hard link's target is only read.
 */
export function linkFindings(rest: Word[], context: Context): WriteFinding[] {
  const read = linkReading(rest, context, LN_LONGS);
  // An abbreviated long option is also read as the flag it is to a reading
  // that does not resolve it, and the line is refused wherever either reading
  // refuses it, as a writer's is.
  const abbreviated = rest.some((word, index) => {
    if (rest.slice(0, index).some((before) => before.value === "--")) return false;
    const spelled = word.value.split("=")[0]!;
    return spelled.startsWith("--") && !LN_LONGS.includes(spelled) && longCandidates(spelled, LN_LONGS).length > 0;
  });
  if (!abbreviated) return read;
  const seen = new Set(read.map((finding) => finding.detail));
  return [...read, ...linkReading(rest, context, []).filter((finding) => !seen.has(finding.detail))];
}

/** Every long option GNU `ln` takes, which is what a prefix is resolved against. */
const LN_LONGS = [
  "--backup", "--directory", "--force", "--interactive", "--logical", "--no-dereference",
  "--no-target-directory", "--physical", "--relative", "--suffix", "--symbolic", "--target-directory",
  "--verbose", "--help", "--version",
];

/** How many words after one of `ln`'s options are its value, for `builtOption`. */
export const LINK_VALUES = valuesOf(["-t", "--target-directory", "-S", "--suffix"], LN_LONGS);

/** `ln`'s findings, with each long option resolved against `names`. */
function linkReading(rest: Word[], context: Context, names: readonly string[]): WriteFinding[] {
  const present = optionsPresent(rest, names);
  const symbolic = present.has("-s") || present.has("--symbolic");
  const operands: Word[] = [];
  const suffixes: Word[] = [];
  let targetDirectory: Word | null = null;
  let optionsEnded = false;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    const value = word.value;
    if (!optionsEnded) {
      if (value === "--") {
        optionsEnded = true;
        continue;
      }
      if (value.startsWith("--")) {
        const eq = value.indexOf("=");
        const name = longOption(eq === -1 ? value : value.slice(0, eq), names) ?? value.slice(0, eq === -1 ? undefined : eq);
        const inline = eq === -1 ? null : value.slice(eq + 1);
        const take = (): Word | null =>
          inline !== null ? { ...word, raw: inline, value: inline } : (rest[(i += 1)] ?? null);
        if (name === "--target-directory") targetDirectory = take() ?? targetDirectory;
        else if (name === "--suffix") {
          const suffix = take();
          if (suffix !== null) suffixes.push(suffix);
        }
        continue;
      }
      if (value.startsWith("-") && value !== "-") {
        // `-t` and `-S` take the rest of the cluster or the next word; every
        // other letter is a flag.
        for (let at = 1; at < value.length; at += 1) {
          const letter = value[at]!;
          if (letter !== "t" && letter !== "S") continue;
          const remainder = value.slice(at + 1);
          const taken = remainder.length > 0 ? { ...word, raw: remainder, value: remainder } : (rest[(i += 1)] ?? null);
          if (letter === "t") targetDirectory = taken ?? targetDirectory;
          else if (taken !== null) suffixes.push(taken);
          break;
        }
        continue;
      }
    }
    if (value.length > 0) operands.push(word);
  }

  const supplied = context.supplied;
  const judge = (word: Word, label: string, cwd: Cwd): WriteFinding[] =>
    supplied !== undefined && carries(supplied, word.value)
      ? [suppliedDestination(label, supplied, context.segment)]
      : pathFinding(label, word, judgeTarget(word.value, context.scope, cwd, true), context.segment);

  const option = suppliedAsOption("ln", rest, context);
  const findings: WriteFinding[] = option === null ? [] : [option];
  // Where the link is made: the `-t` directory, the last operand of a two-part
  // form, or — for a lone target — the directory the command runs in.
  const link = targetDirectory ?? (operands.length >= 2 ? operands[operands.length - 1]! : null);
  const targets =
    link === null || link === targetDirectory ? operands : operands.slice(0, -1);
  // A link made in a directory on disk is each target's name there, unless an
  // option makes the destination itself the link: `-n`, BSD's `-h` and `-T`
  // replace a link to a directory rather than follow it.
  const into =
    link !== null &&
    supplied === undefined &&
    ![...present].some(
      (spelled) =>
        ["-n", "-h", "-T"].includes(spelled) ||
        (spelled.length > 2 &&
          ["--no-dereference", "--no-target-directory"].some((long) => long.startsWith(spelled))),
    )
      ? judgeInto(link, targets, context.scope, context.cwd, true)
      : null;
  if (into !== null) {
    findings.push(
      ...into.flatMap(({ word, destination }) =>
        pathFinding("the ln destination", word, destination, context.segment),
      ),
    );
  } else if (link !== null) findings.push(...judge(link, "the ln destination", context.cwd));
  // A link that replaces a name with `-b`, `--backup` or a suffix keeps what
  // was there under `<name><suffix>`: a second path it writes.
  if (anyPresent(["-b", "--backup", "-S", "--suffix"], present) || suffixes.length > 0) {
    const replaced = into !== null ? into.slice(1).map(({ word }) => word) : link !== null ? [link] : targets;
    findings.push(
      ...backupFindings(
        "ln",
        replaced.map((word) => (link === null ? { ...word, value: basenameOf(word.value), raw: basenameOf(word.raw) } : word)),
        { suffixes, ...defaultSuffixes(context), numbered: true },
        context,
      ),
    );
  }
  // Words a wrapper appends come last: the link itself, unless a `-t`
  // directory holds it, and then more targets.
  if (supplied !== undefined && supplied.placeholder === null) {
    if (targetDirectory === null) {
      findings.push(suppliedDestination("the ln destination", supplied, context.segment));
    } else if (symbolic) {
      findings.push(suppliedDestination("the ln -s target", supplied, context.segment));
    }
  }

  if (!symbolic) return findings;
  // A relative target resolves against the directory holding the link, which is
  // where the link operand lands — or the link operand itself where it names a
  // directory to make the link in.
  let directory = context.cwd;
  if (link !== null) {
    const at = judgeTarget(link.value, context.scope, context.cwd, true);
    if (at.kind === "unresolvable") directory = { path: context.cwd.path, unknown: true };
    else if (at.resolved !== null) directory = { path: linkDirectory(at.resolved), unknown: false };
  }
  return [
    ...findings,
    ...targets.flatMap((target) => judge(target, "the ln -s target", directory)),
  ];
}

/** The last part of a path: where a lone `ln` target's link lands. */
const basenameOf = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** The directory a link sits in: the link itself where it names one. */
function linkDirectory(path: string): string {
  let entry;
  try {
    entry = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return dirname(path);
  }
  return entry !== undefined && entry.isDirectory() ? path : dirname(path);
}
