import { statSync } from "node:fs";
import { carries, type Context } from "./command.js";
import { judgeTarget, pathFinding, type WriteFinding } from "./destination.js";
import type { Word } from "./lexer.js";

/**
 * The second write a writer makes beside its destination: the backup of what
 * was there.
 *
 * GNU `cp`, `mv`, `ln` and `install` given `-b`, `--backup` or a suffix rename
 * an existing destination to `<dest><suffix>` — `~` unless `-S`, `--suffix` or
 * the environment's `SIMPLE_BACKUP_SUFFIX` says otherwise — or to a numbered
 * `<dest>.~N~`. `rsync -b` does the same, and `sed -i<suffix>` keeps the file
 * it rewrites under that name. So `cp -b --suffix=.pem src/a.ts src/other/`
 * writes `src/other/a.ts.pem`, which a prohibited `*.pem` glob names and the
 * destination alone does not. Each is judged as a write, whether or not a destination
 * is on disk yet to be backed up.
 */
export interface BackupReading {
  /** The suffixes the line spells, each as the word it is. */
  suffixes: Word[];
  /** Where none is spelled, the suffixes to judge instead. */
  defaults: readonly string[];
  /**
   * True where the default comes from `SIMPLE_BACKUP_SUFFIX` and the line sets
   * it to something this guard cannot read.
   */
  unreadable: boolean;
  /** True where a numbered backup, `<dest>.~N~`, can be made as well. */
  numbered: boolean;
  /** True where a `*` in the suffix stands for the file's name, as `sed -i` reads it. */
  named?: boolean;
}

/** A numbered backup's suffix, judged for the first number GNU gives. */
const NUMBERED = ".~1~";

/**
 * The suffixes a coreutils backup takes where the line spells none: `~`, and
 * every value the line gives `SIMPLE_BACKUP_SUFFIX`.
 */
export function defaultSuffixes(context: Context): { defaults: string[]; unreadable: boolean } {
  const set = context.scope.simpleBackupSuffixes;
  if (set === null) return { defaults: ["~"], unreadable: true };
  return { defaults: ["~", ...(set ?? [])], unreadable: false };
}

/** Judge the backup each destination in `written` takes. */
export function backupFindings(
  verb: string,
  written: ReadonlyArray<Pick<Word, "raw" | "value">>,
  reading: BackupReading,
  context: Context,
): WriteFinding[] {
  const label = `the ${verb} backup`;
  const findings: WriteFinding[] = [];
  const unread = (reason: string): WriteFinding => ({
    detail: `${label} cannot be resolved — ${reason}: ${context.segment}`,
    target: null,
    resolved: null,
  });
  if (written.length === 0) return findings;
  const suffixes: string[] = [];
  const raws: string[] = [];
  if (reading.suffixes.length > 0) {
    for (const suffix of reading.suffixes) {
      if (suffix.variable || suffix.substitutions.length > 0 || carries(context.supplied, suffix.value)) {
        findings.push(unread(`its suffix ${suffix.raw} is built when the line runs`));
        continue;
      }
      suffixes.push(suffix.value);
      raws.push(suffix.raw);
    }
  } else {
    if (reading.unreadable) {
      findings.push(unread("the line sets SIMPLE_BACKUP_SUFFIX to a value this guard cannot read"));
    }
    suffixes.push(...reading.defaults);
    raws.push(...reading.defaults);
  }
  if (reading.numbered) {
    suffixes.push(NUMBERED);
    raws.push(NUMBERED);
  }
  for (const word of written) {
    if (carries(context.supplied, word.value)) continue;
    const value = word.value.replace(/\/+$/, "");
    const raw = word.raw.replace(/\/+$/, "");
    if (value.length === 0) continue;
    const incoming = directoryNow(value, context);
    for (const [index, suffix] of suffixes.entries()) {
      const paths =
        reading.named === true && suffix.includes("*")
          ? starred(value, raw, suffix, raws[index]!)
          : [{ value: `${value}${suffix}`, raw: `${raw}${raws[index]!}` }];
      for (const path of paths) {
        findings.push(
          ...pathFinding(
            label,
            path,
            judgeTarget(path.value, context.scope, context.cwd, true, "whole", incoming),
            context.segment,
          ),
        );
      }
    }
  }
  return findings;
}

/**
 * `sed -i` reads each `*` in its suffix as the file's own name, so `-i'bak/*'`
 * keeps `dir/f` as `dir/bak/f`. The name is judged both beside the file and
 * from where the command runs.
 */
function starred(value: string, raw: string, suffix: string, suffixRaw: string) {
  const at = value.lastIndexOf("/");
  const base = value.slice(at + 1);
  const directory = at === -1 ? "" : value.slice(0, at + 1);
  const rawAt = raw.lastIndexOf("/");
  const rawDirectory = rawAt === -1 ? "" : raw.slice(0, rawAt + 1);
  const name = suffix.split("*").join(base);
  const rawName = suffixRaw.split("*").join(base);
  return [
    { value: `${directory}${name}`, raw: `${rawDirectory}${rawName}` },
    { value: name, raw: rawName },
  ];
}

/**
 * What a backup renames where it is a directory now, so the backup is judged
 * as holding everything under it; a path that cannot be read is passed on, and
 * reading it refuses the more.
 */
function directoryNow(value: string, context: Context): string[] {
  const at = judgeTarget(value, context.scope, context.cwd, true, "place");
  if (at.kind === "unresolvable" || at.resolved === null) return [];
  try {
    return statSync(at.resolved, { throwIfNoEntry: false })?.isDirectory() === true ? [at.resolved] : [];
  } catch {
    return [at.resolved];
  }
}
