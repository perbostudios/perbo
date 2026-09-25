import { backupFindings, defaultSuffixes } from "./backup.js";
import {
  anyPresent,
  longCandidates,
  longOption,
  optionSet,
  optionsPresent,
  suppliedAsOption,
  type Context,
} from "./command.js";
import { judgeInto, judgeTarget, pathFinding, type Destination, type WriteFinding } from "./destination.js";
import type { Word } from "./lexer.js";

/**
 * A command that writes where its own operands say, and how to find the operand
 * that says it.
 *
 * One loop reads the words after the verb: the sets below consume the options,
 * and what is left are the operands. What is judged is the **destination** — the
 * last operand of a `cp`, every operand of an `rm`, the value of `dd of=`, the
 * directory a `-t` names, each source of an `mv` — resolved against the
 * worktree exactly as a redirect target is, so `tee ~/x` and `> ~/x` get the
 * same answer for the same reason.
 *
 * An option the table does not know is read as a flag. That can misread a value
 * as an operand, which for a `last` destination is only reachable when the value
 * is the final word — and then it is judged as a path, which is the conservative
 * direction. It can never hide the program being run, because none of these
 * commands runs one; the wrapper table above is where that risk lives.
 *
 * GNU accepts any unambiguous prefix of a long option, so a long spelling is
 * resolved against every long name the entry holds, `longs` included:
 * `cp --t=/tmp` is `cp --target-directory=/tmp`. An ambiguous prefix, or one
 * the entry does not know, is read as a flag, and a line that abbreviates is
 * judged on both readings — the whole name's and the unknown flag's — so no
 * abbreviation is admitted that its unknown reading refused.
 */
export interface WriterSpec {
  /** Which operands name a destination once the options are consumed. */
  operands: "last" | "all" | "none";
  /** Operands consumed before the destinations: `chmod`'s mode, `sed`'s script. */
  skip?: number;
  /** Where given, `skip` applies only while none of these options is present. */
  skipUnless?: readonly string[];
  /** How many operands `last` needs before the final one is a destination. */
  least?: number;
  /**
   * True where the operands that are not the destination are written as well:
   * `mv` removes each one from where it was, so a source is judged as a write
   * to its own path, a directory by everything under it.
   */
  sources?: boolean;
  /** Options whose value is a directory the operands are written into. */
  targetDirectory?: readonly string[];
  /**
   * Where given, a destination that is a directory on disk receives each source
   * under its own name, and only that is judged there, unless one of these
   * options makes the destination the thing written (`cp -T`). GNU accepts any
   * unambiguous prefix of a long option, so a prefix counts as the option.
   */
  into?: readonly string[];
  /**
   * The program's other long options, which name nothing this reads but make a
   * prefix ambiguous as GNU finds it: `--s` is not `--suffix` to a `cp` that
   * also takes `--sparse`.
   */
  longs?: readonly string[];
  /** Long options whose value only an `=` attaches: `--backup[=CONTROL]`. */
  optional?: readonly string[];
  /** Where given, how the command backs up what a destination replaces. */
  backup?: BackupSpec;
  /**
   * Options whose attached value is the suffix a backup of each operand takes,
   * as `sed -i<suffix>` and `--in-place=<suffix>` do. A bare short one also
   * reads the next word as BSD's suffix where it is a plain name.
   */
  inPlace?: readonly string[];
  /** Options whose value is itself a destination. */
  destination?: readonly string[];
  /** Where given, `destination` counts only while one of these is present. */
  destinationWith?: readonly string[];
  /** Options that consume the next word and name nothing written. */
  values?: readonly string[];
  /** Options after which every operand is a destination, as `install -d`. */
  everyOperand?: readonly string[];
  /** `name=value` operands whose value is a destination, as `dd of=`. */
  assignments?: readonly string[];
  /** Where given, the command writes only while one of these is present. */
  onlyWith?: readonly string[];
  /** True where a destination may name another host, as `rsync` and `scp` do. */
  remote?: boolean;
  /**
   * True where the verb does more than write the destinations above: it reaches
   * the network, unpacks an archive whose members it never names, or shares its
   * name with a package-manager subcommand. Such a line is still judged on the
   * paths it does name, but it is not `CommandSegment.mutating` — a caller
   * deciding a command by where its writes landed has not seen all of them.
   */
  beyondNamedPaths?: boolean;
}

/** How a writer backs up a destination it replaces (see `backup.ts`). */
export interface BackupSpec {
  /** Options that make a backup. */
  flags: readonly string[];
  /** Options whose value is the suffix, and which make a backup too. */
  suffix: readonly string[];
  /** Options whose value is a directory the backups are written under, as `rsync --backup-dir`. */
  directory?: readonly string[];
  /** True where a backup can be numbered, `<dest>.~N~`. */
  numbered: boolean;
  /** True where `SIMPLE_BACKUP_SUFFIX` sets the default suffix. */
  environment: boolean;
}

/** GNU coreutils' backup options, shared by `cp`, `mv`, `ln` and `install`. */
const COREUTILS_BACKUP: BackupSpec = {
  flags: ["-b", "--backup"],
  suffix: ["-S", "--suffix"],
  numbered: true,
  environment: true,
};

/**
 * Exported so a test can assert which entries carry `beyondNamedPaths`, and
 * therefore which lines the pre-execution hook must never vouch for.
 */
export const WRITERS = new Map<string, WriterSpec>([
  ["cp", {
    operands: "last",
    targetDirectory: ["-t", "--target-directory"],
    into: ["-T", "--no-target-directory"],
    backup: COREUTILS_BACKUP,
    optional: ["--backup", "--context", "--preserve", "--reflink", "--update"],
    longs: [
      "--archive", "--attributes-only", "--copy-contents", "--debug", "--dereference", "--force",
      "--interactive", "--link", "--no-clobber", "--no-dereference", "--no-preserve", "--one-file-system",
      "--parents", "--recursive", "--remove-destination", "--sparse", "--strip-trailing-slashes",
      "--symbolic-link", "--keep-directory-symlink", "--verbose", "--help", "--version",
    ],
  }],
  ["mv", {
    operands: "last",
    sources: true,
    targetDirectory: ["-t", "--target-directory"],
    into: ["-T", "--no-target-directory"],
    backup: COREUTILS_BACKUP,
    optional: ["--backup", "--update"],
    longs: [
      "--context", "--debug", "--exchange", "--force", "--interactive", "--no-clobber", "--no-copy",
      "--strip-trailing-slashes", "--verbose", "--help", "--version",
    ],
  }],
  ["rm", { operands: "all" }],
  // With `--reference` the mode or owner comes from that file, so no operand is
  // skipped as one.
  ["chmod", {
    operands: "all",
    skip: 1,
    skipUnless: ["--reference"],
    values: ["--reference"],
    longs: ["--changes", "--no-preserve-root", "--preserve-root", "--quiet", "--silent", "--recursive", "--verbose"],
  }],
  ["chown", {
    operands: "all",
    skip: 1,
    skipUnless: ["--reference"],
    values: ["--reference", "--from"],
    longs: [
      "--changes", "--dereference", "--no-dereference", "--no-preserve-root", "--preserve-root", "--quiet",
      "--silent", "--recursive", "--verbose",
    ],
  }],
  ["chgrp", {
    operands: "all",
    skip: 1,
    skipUnless: ["--reference"],
    values: ["--reference"],
    longs: [
      "--changes", "--dereference", "--no-dereference", "--no-preserve-root", "--preserve-root", "--quiet",
      "--silent", "--recursive", "--verbose",
    ],
  }],
  // `tee` reads its input from the pipe and writes every operand, so a
  // `… | tee <path>` is a write to `<path>` however the pipeline was built.
  // `--output-error`'s mode is attached or absent, never the next word.
  ["tee", { operands: "all", optional: ["--output-error"], longs: ["--append", "--ignore-interrupts"] }],
  // `dd` takes no options at all: its operands are `name=value`, and `of=` is
  // the one that names an output file.
  ["dd", { operands: "none", assignments: ["of"] }],
  // `install` earns its entry from `install -m 755 run.sh /usr/local/bin/run`
  // and pays for it with `pnpm install`, where the word is the package
  // manager's subcommand rather than this program: the paths it names are still
  // judged, and the line is not counted as one whose writes have all been seen.
  ["install", {
    operands: "last",
    beyondNamedPaths: true,
    targetDirectory: ["-t", "--target-directory"],
    into: ["-T", "--no-target-directory"],
    everyOperand: ["-d", "--directory"],
    backup: COREUTILS_BACKUP,
    optional: ["--backup", "--context"],
    values: ["-m", "--mode", "-o", "--owner", "-g", "--group"],
    longs: [
      "--compare", "--debug", "--preserve-context", "--preserve-timestamps", "--strip", "--strip-program",
      "--verbose", "--help", "--version",
    ],
  }],
  ["rsync", {
    operands: "last",
    remote: true,
    beyondNamedPaths: true,
    backup: { flags: ["-b", "--backup"], suffix: ["--suffix"], directory: ["--backup-dir"], numbered: false, environment: false },
    values: ["-e", "--rsh", "--exclude", "--include", "--files-from", "--filter", "-f", "--log-file", "--temp-dir", "-T", "--chmod", "--chown", "--compare-dest", "--copy-dest", "--link-dest", "--out-format", "--password-file", "--bwlimit", "--timeout", "--port", "--info", "--debug", "--max-size", "--min-size", "--block-size", "-B", "--modify-window"],
  }],
  ["scp", { operands: "last", remote: true, beyondNamedPaths: true, values: ["-i", "-l", "-o", "-P", "-S", "-c", "-F", "-J"] }],
  ["touch", {
    operands: "all",
    values: ["-d", "--date", "-r", "--reference", "-t", "--time"],
    longs: ["--no-create", "--no-dereference"],
  }],
  // `-Z` takes no value; `--context[=CTX]` takes one only attached.
  ["mkdir", { operands: "all", values: ["-m", "--mode"], optional: ["--context"], longs: ["--parents", "--verbose"] }],
  ["mkfifo", { operands: "all", values: ["-m", "--mode"], optional: ["--context"] }],
  ["rmdir", { operands: "all" }],
  ["unlink", { operands: "all" }],
  ["truncate", {
    operands: "all",
    values: ["-s", "--size", "-r", "--reference"],
    longs: ["--no-create", "--io-blocks"],
  }],
  // In place, and only in place: `sed 's/x/y/' f` writes nothing. The script is
  // the first operand unless `-e` or `-f` supplied one, and then every operand
  // is a file the edit rewrites. A suffix given to `-i` keeps each file's old
  // text under that name.
  ["sed", {
    operands: "all",
    onlyWith: ["-i", "--in-place"],
    inPlace: ["-i", "--in-place"],
    skip: 1,
    skipUnless: ["-e", "--expression", "-f", "--file"],
    values: ["-e", "--expression", "-f", "--file", "-l", "--line-length"],
    longs: [
      "--quiet", "--silent", "--debug", "--follow-symlinks", "--posix", "--regexp-extended", "--separate",
      "--sandbox", "--unbuffered", "--null-data", "--zero-terminated", "--help", "--version",
    ],
  }],
  ["curl", { operands: "none", beyondNamedPaths: true, destination: ["-o", "--output"], values: ["-H", "--header", "-d", "--data", "-u", "--user", "-X", "--request", "-A", "--user-agent", "-b", "--cookie", "-c", "--cookie-jar", "-w", "--write-out", "--url", "--max-time", "--connect-timeout", "--retry"] }],
  ["wget", { operands: "none", beyondNamedPaths: true, destination: ["-O", "--output-document"], targetDirectory: ["-P", "--directory-prefix"], values: ["--header", "--user", "--password", "--post-data", "--timeout", "--tries", "-o", "--output-file"] }],
  // Extraction writes into `-C`; creation writes the archive `-f` names. The
  // archive of an extraction is read, so `-f` counts only alongside `-c`.
  ["tar", {
    operands: "none",
    beyondNamedPaths: true,
    targetDirectory: ["-C", "--directory"],
    destination: ["-f", "--file"],
    destinationWith: ["-c", "--create"],
    values: ["--exclude", "--exclude-from", "-X", "-T", "--files-from", "--transform", "--strip-components"],
  }],
  ["unzip", { operands: "none", beyondNamedPaths: true, targetDirectory: ["-d"], values: ["-x", "-P"] }],
]);

/**
 * A destination on another host: `host:path`, `user@host:path`. It is not a path
 * this guard can resolve and it is not inside the worktree, so it is reported as
 * unresolvable rather than walked as a relative name.
 */
const REMOTE_DESTINATION = /^[^/~.][^/]*:/;

/** Judge the destinations of one writer, given the words after its verb. */
export function writerFindings(
  verb: string,
  spec: WriterSpec,
  rest: Word[],
  context: Context,
): WriteFinding[] {
  // Read before the options are: a supplied word can be the option that makes
  // the command a writer at all, as `-i` makes `sed` one.
  const option = suppliedAsOption(verb, rest, context, spec.assignments !== undefined);
  const names = longNames(spec);
  const named = destinationFindings(verb, spec, rest, context, names);
  // An abbreviation is also read as the flag this would take it for unresolved,
  // so a line is refused wherever either reading refuses it.
  const unresolved = abbreviates(rest, names)
    ? destinationFindings(verb, spec, rest, context, [])
    : [];
  const findings = option === null ? [...named, ...unresolved] : [option, ...named, ...unresolved];
  return distinct(findings);
}

/** Every long option an entry names, which is what a prefix is resolved against. */
export function longNames(spec: WriterSpec): string[] {
  const all = [
    spec.skipUnless,
    spec.targetDirectory,
    spec.into,
    spec.destination,
    spec.destinationWith,
    spec.values,
    spec.everyOperand,
    spec.onlyWith,
    spec.longs,
    spec.optional,
    spec.inPlace,
    spec.backup?.flags,
    spec.backup?.suffix,
    spec.backup?.directory,
  ].flatMap((options) => options ?? []);
  return [...new Set(all.filter((option) => option.startsWith("--")))];
}

/** Whether a long option on the line is spelled as a prefix of one of `names`. */
export function abbreviates(rest: readonly Word[], names: readonly string[]): boolean {
  for (const word of rest) {
    const value = word.value;
    if (value === "--") return false;
    if (!value.startsWith("--")) continue;
    const eq = value.indexOf("=");
    const spelled = eq === -1 ? value : value.slice(0, eq);
    if (!names.includes(spelled) && longCandidates(spelled, names).length > 0) return true;
  }
  return false;
}

/** The findings once each, in the order they were first made. */
function distinct(findings: WriteFinding[]): WriteFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule ?? ""}\u0000${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The destinations the words after `verb` name, read through its `spec`, with
 * each long option resolved against `names` as GNU resolves a prefix — or,
 * with `names` empty, only where it is spelled whole.
 */
function destinationFindings(
  verb: string,
  spec: WriterSpec,
  rest: Word[],
  context: Context,
  names: readonly string[],
): WriteFinding[] {
  const present = optionsPresent(rest, names);
  if (spec.onlyWith !== undefined && !anyPresent(spec.onlyWith, present)) return [];
  const takesDestination =
    spec.destinationWith === undefined || anyPresent(spec.destinationWith, present);

  const targetDirectories = optionSet(spec.targetDirectory);
  const destinations = takesDestination ? optionSet(spec.destination) : new Set<string>();
  const values = new Set([...optionSet(spec.values), ...(takesDestination ? [] : (spec.destination ?? []))]);
  const everyOperandOptions = optionSet(spec.everyOperand);
  const assignments = optionSet(spec.assignments);
  const optional = optionSet(spec.optional);
  const inPlace = optionSet(spec.inPlace);
  const suffixOptions = optionSet(spec.backup?.suffix);
  const backupDirectoryOptions = optionSet(spec.backup?.directory);

  const written: Array<{ word: Word; label: string }> = [];
  const operands: Word[] = [];
  /** The suffixes a backup takes, as the line spells them. */
  const suffixes: Word[] = [];
  /** `rsync --backup-dir`: where the backups go. */
  const backupDirectories: Word[] = [];
  /** A word after a bare `sed -i` that BSD would read as the suffix. */
  const bsdSuffixes: Word[] = [];
  let targetDirectory: Word | null = null;
  let everyOperand = false;
  let optionsEnded = false;
  /** True once an option that supplies what `skip` would skip has been read. */
  let skipSupplied = false;
  const skipUnless = optionSet(spec.skipUnless);

  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    const value = word.value;
    if (!optionsEnded) {
      if (value === "--") {
        optionsEnded = true;
        continue;
      }
      const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(value);
      if (assignments.size > 0 && assigned !== null) {
        const name = assigned[1]!;
        const path = assigned[2]!;
        if (assignments.has(name)) {
          written.push({
            word: { ...word, raw: path, value: path },
            label: `the ${verb} ${name}= destination`,
          });
        }
        continue;
      }
      if (value.startsWith("--")) {
        const eq = value.indexOf("=");
        const spelled = eq === -1 ? value : value.slice(0, eq);
        const name = longOption(spelled, names) ?? spelled;
        const attached = eq === -1 ? null : value.slice(eq + 1);
        const attachedWord = (): Word | null => {
          if (attached === null) return null;
          const at = word.raw.indexOf("=");
          return { ...word, raw: at === -1 ? attached : word.raw.slice(at + 1), value: attached };
        };
        const take = (): Word | undefined => {
          if (attached !== null) return attachedWord()!;
          i += 1;
          return rest[i];
        };
        if (everyOperandOptions.has(name)) everyOperand = true;
        else if (targetDirectories.has(name)) targetDirectory = take() ?? targetDirectory;
        else if (destinations.has(name)) {
          const operand = take();
          if (operand !== undefined) {
            written.push({ word: operand, label: `the ${verb} ${name} destination` });
          }
        } else if (suffixOptions.has(name)) {
          const suffix = take();
          if (suffix !== undefined) suffixes.push(suffix);
        } else if (backupDirectoryOptions.has(name)) {
          const directory = take();
          if (directory !== undefined) backupDirectories.push(directory);
        } else if (inPlace.has(name)) {
          const suffix = attachedWord();
          if (suffix !== null && suffix.value.length > 0) suffixes.push(suffix);
        } else if (optional.has(name)) {
          // Its value, where it has one, is attached: nothing more to consume.
        } else if (values.has(name)) {
          take();
          if (skipUnless.has(name)) skipSupplied = true;
        }
        continue;
      }
      if (value.startsWith("-") && value !== "-") {
        // A short cluster: every letter is a flag until one takes a value,
        // which is either the rest of the cluster or the word after it.
        let at = 1;
        while (at < value.length) {
          const short = `-${value[at]}`;
          const inline = value.slice(at + 1);
          const take = (): Word | undefined => {
            if (inline.length > 0) return { ...word, raw: inline, value: inline };
            i += 1;
            return rest[i];
          };
          if (everyOperandOptions.has(short)) {
            everyOperand = true;
            at += 1;
            continue;
          }
          if (inPlace.has(short)) {
            // GNU's suffix is the rest of the cluster; BSD's is the next word.
            if (inline.length > 0) suffixes.push({ ...word, raw: inline, value: inline });
            else {
              const next = rest[i + 1];
              if (next !== undefined && /^[A-Za-z0-9._~+][A-Za-z0-9._~+-]*$/.test(next.value)) {
                bsdSuffixes.push(next);
              }
            }
            break;
          }
          if (targetDirectories.has(short)) {
            targetDirectory = take() ?? targetDirectory;
            break;
          }
          if (destinations.has(short)) {
            const operand = take();
            if (operand !== undefined) {
              written.push({ word: operand, label: `the ${verb} ${short} destination` });
            }
            break;
          }
          if (suffixOptions.has(short)) {
            const suffix = take();
            if (suffix !== undefined) suffixes.push(suffix);
            break;
          }
          if (values.has(short)) {
            take();
            if (skipUnless.has(short)) skipSupplied = true;
            break;
          }
          at += 1;
        }
        continue;
      }
    }
    // An empty operand is `sed -i ''`, the suffix BSD requires: it is not a path.
    if (value.length > 0) operands.push(word);
  }

  const supplied = context.supplied;
  const placeholder = supplied?.placeholder ?? null;
  /** Whether this word is where the wrapper's input lands. */
  const carries = (value: string): boolean =>
    placeholder !== null &&
    (supplied?.wholeWord === true ? value === placeholder : value.includes(placeholder));

  /** A destination the wrapper supplies rather than the line: not a path at all. */
  const unread = (label: string, how: string): WriteFinding => ({
    detail:
      `${label} cannot be resolved — ${how}, and they are not on the line: ` +
      `${context.segment.slice(0, 200)}`,
    target: null,
    resolved: null,
  });

  const judge = (word: Word, label: string): WriteFinding[] => {
    // The placeholder stands where this destination goes, so what is written is
    // whatever the wrapper reads, not the word on the line.
    if (supplied !== undefined && carries(word.value)) {
      return [
        unread(
          label,
          `${supplied.wrapper} substitutes the words it reads from standard input ` +
            `for ${placeholder}`,
        ),
      ];
    }
    const destination: Destination =
      spec.remote === true && REMOTE_DESTINATION.test(word.value)
        ? { kind: "unresolvable", reason: "it names a destination on another host" }
        : judgeTarget(word.value, context.scope, context.cwd, true);
    return pathFinding(label, word, destination, context.segment);
  };

  /** The destinations a backup is made beside, where the command makes one. */
  const replaced: Array<Pick<Word, "raw" | "value">> = [];
  const backup = spec.backup;
  const backingUp =
    backup !== undefined &&
    (anyPresent([...backup.flags, ...backup.suffix, ...(backup.directory ?? [])], present) ||
      suffixes.length > 0 ||
      backupDirectories.length > 0);
  /** Judge the backups of what `replaced` holds, and where `rsync` puts them. */
  const backups = (): WriteFinding[] => {
    if (!backingUp || backup === undefined) return [];
    const defaults = backup.environment ? defaultSuffixes(context) : { defaults: ["~"], unreadable: false };
    return [
      ...backupFindings(verb, replaced, { suffixes, ...defaults, numbered: backup.numbered }, context),
      ...backupDirectories.flatMap((directory) => [
        ...judge(directory, `the ${verb} backup directory`),
        // A relative one is read from the destination too, as `rsync` reads it.
        ...(directory.value.startsWith("/") || directory.value.startsWith("~")
          ? []
          : replaced.flatMap((destination) =>
              [destination.value, destination.value.replace(/\/?[^/]*\/*$/, "")].map((base) => {
                const joined = base.length === 0 ? directory.value : `${base}/${directory.value}`;
                return judge({ ...directory, raw: joined, value: joined }, `the ${verb} backup directory`);
              }).flat(),
            )),
      ]),
    ];
  };

  const findings = written.flatMap(({ word, label }) => judge(word, label));
  // Read from what the loop consumed rather than from `present`, whose surplus
  // letters would count the `e` of `sed -ie`, a suffix, as `-e`.
  const skip = spec.skip !== undefined && !skipSupplied ? spec.skip : 0;
  const remaining = operands.slice(skip);
  // Under BSD `xargs -J` the placeholder is every word the wrapper reads, so it
  // is readable in one place only: among the sources of a writer whose
  // destination the line spells — a literal last operand, or a literal target
  // directory. Anywhere else — an option's value, an operand the writer skips
  // such as a mode or a script, the last or the lone operand — what the input
  // holds reaches something this cannot read.
  if (supplied !== undefined && supplied.wholeWord && placeholder !== null) {
    const sources =
      targetDirectory !== null && !carries(targetDirectory.value)
        ? operands
        : spec.operands === "last" &&
            remaining.length >= 2 &&
            !carries(remaining[remaining.length - 1]!.value)
          ? remaining.slice(0, -1)
          : [];
    const safe = new Set(sources);
    const astray = rest.find((word) => carries(word.value) && !safe.has(word));
    if (astray !== undefined) {
      return [
        ...findings,
        unread(
          `the ${verb} destination`,
          `${supplied.wrapper} substitutes every word it reads from standard input for ` +
            `${placeholder}, and ${astray.raw} stands where more than a source is read`,
        ),
      ];
    }
  }
  const moved = (sources: Word[]): WriteFinding[] =>
    spec.sources === true ? sources.flatMap((source) => judge(source, `the ${verb} source`)) : [];
  /**
   * The destination that receives `sources`: each under its own name where it
   * is a directory on disk and the line names every source, else the
   * destination whole.
   */
  const receiving = (directory: Word, sources: Word[], known: boolean): WriteFinding[] => {
    const label = `the ${verb} destination`;
    const readable =
      known &&
      spec.into !== undefined &&
      !anyPresent(spec.into, present) &&
      !(supplied !== undefined && (carries(directory.value) || sources.some((source) => carries(source.value))));
    const entries = readable ? judgeInto(directory, sources, context.scope, context.cwd) : null;
    if (entries === null) {
      replaced.push(directory);
      return judge(directory, label);
    }
    replaced.push(...entries.slice(1).map(({ word }) => word));
    return entries.flatMap(({ word, destination }) => pathFinding(label, word, destination, context.segment));
  };
  if (targetDirectory !== null) {
    // The operands are written into the directory this option names, so what a
    // wrapper supplies from its standard input is a source — which `mv` writes.
    const appendedSources =
      spec.sources === true && supplied !== undefined && placeholder === null
        ? [
            unread(
              `the ${verb} source`,
              `${supplied.wrapper} appends the words it reads from standard input to this command`,
            ),
          ]
        : [];
    const known = !(supplied !== undefined && placeholder === null);
    return [
      ...findings,
      ...receiving(targetDirectory, remaining, known),
      ...backups(),
      ...moved(remaining),
      ...appendedSources,
    ];
  }
  // Where the operands are destinations and a wrapper appends more of them from
  // its standard input, the write lands somewhere the line never spelled.
  const appended: WriteFinding[] =
    supplied !== undefined && placeholder === null && (everyOperand || spec.operands !== "none")
      ? [
          unread(
            `the ${verb} destination`,
            `${supplied.wrapper} appends the words it reads from standard input to this command`,
          ),
        ]
      : [];
  if (everyOperand || spec.operands === "all") {
    // `sed -i<suffix>` keeps each file it rewrites under that suffix too.
    const kept =
      spec.inPlace !== undefined && (suffixes.length > 0 || bsdSuffixes.length > 0)
        ? backupFindings(
            verb,
            remaining,
            { suffixes: [...suffixes, ...bsdSuffixes], defaults: [], unreadable: false, numbered: false, named: true },
            context,
          )
        : [];
    return [
      ...findings,
      ...appended,
      ...remaining.flatMap((operand) => judge(operand, `the ${verb} target`)),
      ...kept,
    ];
  }
  if (spec.operands === "last" && remaining.length >= (spec.least ?? 2)) {
    return [
      ...findings,
      ...appended,
      ...receiving(remaining[remaining.length - 1]!, remaining.slice(0, -1), appended.length === 0),
      ...backups(),
      ...moved(remaining.slice(0, -1)),
    ];
  }
  return [...findings, ...appended];
}
