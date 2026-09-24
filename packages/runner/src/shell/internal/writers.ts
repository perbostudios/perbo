import {
  anyPresent,
  optionSet,
  optionsPresent,
  suppliedAsOption,
  type Context,
} from "./command.js";
import { judgeTarget, pathFinding, type Destination, type WriteFinding } from "./destination.js";
import type { Word } from "./lexer.js";

/**
 * A command that writes where its own operands say, and how to find the operand
 * that says it.
 *
 * One loop reads the words after the verb: the sets below consume the options,
 * and what is left are the operands. What is judged is the **destination** — the
 * last operand of a `cp`, every operand of an `rm`, the value of `dd of=`, the
 * directory a `-t` names — resolved against the worktree exactly as a redirect
 * target is, so `tee ~/x` and `> ~/x` get the same answer for the same reason.
 *
 * An option the table does not know is read as a flag. That can misread a value
 * as an operand, which for a `last` destination is only reachable when the value
 * is the final word — and then it is judged as a path, which is the conservative
 * direction. It can never hide the program being run, because none of these
 * commands runs one; the wrapper table above is where that risk lives.
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
  /** Options whose value is a directory the operands are written into. */
  targetDirectory?: readonly string[];
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

/**
 * Exported so a test can assert which entries carry `beyondNamedPaths`, and
 * therefore which lines the pre-execution hook must never vouch for.
 */
export const WRITERS = new Map<string, WriterSpec>([
  ["cp", { operands: "last", targetDirectory: ["-t", "--target-directory"] }],
  ["mv", { operands: "last", targetDirectory: ["-t", "--target-directory"] }],
  ["rm", { operands: "all" }],
  ["chmod", { operands: "all", skip: 1, values: ["--reference"] }],
  ["chown", { operands: "all", skip: 1, values: ["--reference", "--from"] }],
  ["chgrp", { operands: "all", skip: 1, values: ["--reference"] }],
  // `tee` reads its input from the pipe and writes every operand, so a
  // `… | tee <path>` is a write to `<path>` however the pipeline was built.
  ["tee", { operands: "all", values: ["--output-error"] }],
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
    everyOperand: ["-d", "--directory"],
    values: ["-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix", "-Z", "--context", "--backup"],
  }],
  ["rsync", { operands: "last", remote: true, beyondNamedPaths: true, values: ["-e", "--rsh", "--exclude", "--include", "--files-from", "--filter", "-f", "--log-file", "--temp-dir", "-T", "--backup-dir", "--suffix", "--chmod", "--chown", "--compare-dest", "--copy-dest", "--link-dest", "--out-format", "--password-file", "--bwlimit", "--timeout", "--port", "--info", "--debug", "--max-size", "--min-size", "--block-size", "-B", "--modify-window"] }],
  ["scp", { operands: "last", remote: true, beyondNamedPaths: true, values: ["-i", "-l", "-o", "-P", "-S", "-c", "-F", "-J"] }],
  ["touch", { operands: "all", values: ["-d", "--date", "-r", "--reference", "-t", "--time"] }],
  ["mkdir", { operands: "all", values: ["-m", "--mode", "-Z", "--context"] }],
  ["mkfifo", { operands: "all", values: ["-m", "--mode", "-Z", "--context"] }],
  ["rmdir", { operands: "all" }],
  ["unlink", { operands: "all" }],
  ["truncate", { operands: "all", values: ["-s", "--size", "-r", "--reference", "--io-blocks"] }],
  // In place, and only in place: `sed 's/x/y/' f` writes nothing. The script is
  // the first operand unless `-e` or `-f` supplied one, and then every operand
  // is a file the edit rewrites.
  ["sed", {
    operands: "all",
    onlyWith: ["-i", "--in-place"],
    skip: 1,
    skipUnless: ["-e", "--expression", "-f", "--file"],
    values: ["-e", "--expression", "-f", "--file", "-l", "--line-length"],
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
  const named = destinationFindings(verb, spec, rest, context);
  return option === null ? named : [option, ...named];
}

/** The destinations the words after `verb` name, read through its `spec`. */
function destinationFindings(
  verb: string,
  spec: WriterSpec,
  rest: Word[],
  context: Context,
): WriteFinding[] {
  const present = optionsPresent(rest);
  if (spec.onlyWith !== undefined && !anyPresent(spec.onlyWith, present)) return [];
  const takesDestination =
    spec.destinationWith === undefined || anyPresent(spec.destinationWith, present);

  const targetDirectories = optionSet(spec.targetDirectory);
  const destinations = takesDestination ? optionSet(spec.destination) : new Set<string>();
  const values = new Set([...optionSet(spec.values), ...(takesDestination ? [] : (spec.destination ?? []))]);
  const everyOperandOptions = optionSet(spec.everyOperand);
  const assignments = optionSet(spec.assignments);

  const written: Array<{ word: Word; label: string }> = [];
  const operands: Word[] = [];
  let targetDirectory: Word | null = null;
  let everyOperand = false;
  let optionsEnded = false;

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
        const name = eq === -1 ? value : value.slice(0, eq);
        const attached = eq === -1 ? null : value.slice(eq + 1);
        const take = (): Word | undefined => {
          if (attached !== null) return { ...word, raw: attached, value: attached };
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
        } else if (values.has(name)) take();
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
          if (values.has(short)) {
            take();
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

  const findings = written.flatMap(({ word, label }) => judge(word, label));
  const skip = spec.skip !== undefined && !anyPresent(spec.skipUnless, present) ? spec.skip : 0;
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
  if (targetDirectory !== null) {
    // The operands are written into the directory this option names, so what a
    // wrapper supplies from its standard input is a source.
    return [...findings, ...judge(targetDirectory, `the ${verb} destination`)];
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
    return [
      ...findings,
      ...appended,
      ...remaining.flatMap((operand) => judge(operand, `the ${verb} target`)),
    ];
  }
  if (spec.operands === "last" && remaining.length >= (spec.least ?? 2)) {
    return [
      ...findings,
      ...appended,
      ...judge(remaining[remaining.length - 1]!, `the ${verb} destination`),
    ];
  }
  return [...findings, ...appended];
}
