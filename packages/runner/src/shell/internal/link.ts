import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { carries, optionsPresent, suppliedDestination, type Context } from "./command.js";
import { judgeTarget, pathFinding, type WriteFinding } from "./destination.js";
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
  const present = optionsPresent(rest);
  const symbolic = present.has("-s") || present.has("--symbolic");
  const operands: Word[] = [];
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
      const long = /^--target-directory(?:=(.*))?$/.exec(value);
      if (long !== null) {
        const inline = long[1];
        if (inline !== undefined) targetDirectory = { ...word, raw: inline, value: inline };
        else targetDirectory = rest[(i += 1)] ?? null;
        continue;
      }
      const cluster = /^-([A-Za-z]+)(.*)$/.exec(value);
      if (cluster !== null) {
        const at = cluster[1]!.indexOf("t");
        if (at !== -1) {
          const inline = cluster[1]!.slice(at + 1) + (cluster[2] ?? "");
          if (inline.length > 0) targetDirectory = { ...word, raw: inline, value: inline };
          else targetDirectory = rest[(i += 1)] ?? null;
        }
        continue;
      }
      if (value.startsWith("-") && value !== "-") continue;
    }
    if (value.length > 0) operands.push(word);
  }

  const supplied = context.supplied;
  const judge = (word: Word, label: string, cwd: Cwd): WriteFinding[] =>
    supplied !== undefined && carries(supplied, word.value)
      ? [suppliedDestination(label, supplied, context.segment)]
      : pathFinding(label, word, judgeTarget(word.value, context.scope, cwd, true), context.segment);

  const findings: WriteFinding[] = [];
  // Where the link is made: the `-t` directory, the last operand of a two-part
  // form, or — for a lone target — the directory the command runs in.
  const link = targetDirectory ?? (operands.length >= 2 ? operands[operands.length - 1]! : null);
  const targets =
    link === null || link === targetDirectory ? operands : operands.slice(0, -1);
  if (link !== null) findings.push(...judge(link, "the ln destination", context.cwd));
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
