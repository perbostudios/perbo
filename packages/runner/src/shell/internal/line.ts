import {
  basename,
  carries as carriesInto,
  isAssignment,
  optionSet,
  suppliedAsOption,
  suppliedDestination,
  type Context,
  type SuppliedOperands,
} from "./command.js";
import {
  destinationSentence,
  judgeTarget,
  pathFinding,
  type Destination,
  type WriteFinding,
} from "./destination.js";
import { findExpression } from "./find.js";
import { gitFindings } from "./git.js";
import { INTERPRETERS, interpreterFindings } from "./interpreter.js";
import {
  heredocQueue,
  scanSegments,
  SEQUENTIAL_OPERATORS,
  tokenize,
  type HeredocBody,
  type Item,
  type StdinSource,
  type Word,
} from "./lexer.js";
import { linkFindings } from "./link.js";
import { type Cwd, type ResolvedScope } from "./scope.js";
import { programSourceFindings, shellFromStdin } from "./stdin.js";
import {
  EXEC_SPEC,
  KEYWORDS,
  NPX_SPEC,
  PACKAGE_MANAGER_SPEC,
  PACKAGE_MANAGERS,
  SHELLS,
  WRAPPERS,
  type WrapperSpec,
} from "./wrappers.js";
import { WRITERS, writerFindings } from "./writers.js";

/** The directory a command runs in, as a word: `find`'s default starting point. */
const HERE: Word = { raw: ".", value: ".", substitutions: [], variable: false };

/** A word of a `find` body with the path the walk found standing where `{}` does. */
function placed(word: Word, found: Word): Word {
  if (!word.value.includes("{}")) return word;
  return {
    ...word,
    raw: word.raw.split("{}").join(found.raw),
    value: word.value.split("{}").join(found.value),
    substitutions: [...word.substitutions, ...found.substitutions],
    variable: word.variable || found.variable,
    found: true,
  };
}

/** One command of a line, as the reading of that line found it. */
export interface CommandSegment {
  /** The segment as written, trimmed. */
  text: string;
  /**
   * True where the segment runs a verb that writes to a path it names —
   * `mkdir`, `rm`, `cp`, `mv`, `touch`, `chmod` and the rest of the table —
   * wherever the wrappers, `sh -c` and `find -exec` around it put the word.
   * The findings say which of those writes left the worktree; this says the
   * command was one that writes at all, which is what lets an admission
   * decision turn on where the writes landed rather than on the verb's name.
   */
  mutating: boolean;
  /**
   * The programs the segment runs, by basename, with the wrappers stripped:
   * its own, the one a `find -exec` or an `rg --pre` runs, and those of the
   * nested shells in `nested`. Not those of its `substitutions`, which are
   * segments of their own.
   */
  programs: string[];
  /**
   * Each command the segment runs, normalised to the program's basename and the
   * words after it — the wrapper's own line, the line it wraps, and the line
   * inside a `sh -c` body, one entry each.
   *
   * A list entry matches a command by prefix, which reads only the front of the
   * line as typed: `Bash(sudo:*)` does not match `env sudo rm -r .scratch`, and
   * `Bash(git push:*)` does not match `sh -c 'git push'`. Deciding a mutating
   * command by where its writes land made that gap reachable — a refused verb
   * behind a wrapper is no longer stopped by the allow-list on its way past —
   * so the runner matches its lists against what the parser found the line runs
   * as well as against the line itself.
   */
  invocations: string[];
  /**
   * The segments a nested shell of this one runs: the body of a `sh -c`, an
   * `eval`, a `pnpm exec -c` or a `bash <<EOF`, each read as a command in its
   * own right.
   *
   * They are kept apart from the segment that wrapped them because the wrapper
   * inherits their `mutating` flag and their programs, and a caller deciding a
   * command by where its writes land needs the command that writes rather than
   * the one standing around it. The wrapper runs nothing of its own.
   */
  nested: CommandSegment[];
  /**
   * The segments of every `$(…)`, backtick pair and process substitution the
   * segment carries — in its words, its redirects, its here-strings and its
   * unquoted here-documents — each read as a command in its own right, which
   * the shell runs before the segment's own command.
   *
   * The segment's own command is still its own, so unlike a nested shell's
   * these hand it neither their programs nor their `mutating` flag: `echo
   * "$(mail …)"` runs `echo` and, as a segment of its own, `mail`, and a
   * caller judging the line by what it runs judges each. They do hand it their
   * findings, their invocations, their unreadable programs and whether they
   * could be accounted for, which are about the line rather than the verb.
   */
  substitutions: CommandSegment[];
  /**
   * What the parser could not read but did not refuse. A wrapper option its
   * table does not know, on a line that names no command for the wrapper to
   * run, is recorded here rather than as a finding: the option is still an
   * option, and the segment is the wrapper (SCP-186).
   */
  notes: string[];
  /** False where the parser could not account for the segment. */
  accounted: boolean;
  /**
   * The text of a program word the parser could not read at all — a
   * substitution, a backtick, or an unexpanded variable stood where the verb
   * should be — wherever a nested shell put it (SCP-201). Empty for every
   * segment whose verb the parser actually read, whatever it decided about it;
   * a caller refusing on this is refusing because there was no verb to judge,
   * not because of what one did.
   */
  unreadablePrograms: string[];
}

/**
 * Every command the segments run: each segment, the ones inside a nested shell
 * of it, and the ones a substitution on it runs before its own command, each
 * to be judged as itself.
 */
export function everySegment(segments: readonly CommandSegment[]): CommandSegment[] {
  return segments.flatMap((segment) => [segment, ...everySegment(segment.nested), ...everySegment(segment.substitutions)]);
}

/** What reading a command line yields: what it writes, where it stands, what it runs. */
export interface CommandReading {
  findings: WriteFinding[];
  /**
   * Where this line leaves the shell. A caller running its lines in one shell
   * hands this back as the next line's `scope.cwd`.
   */
  cwd: Cwd;
  segments: CommandSegment[];
}

/**
 * The spelling patterns this module replaced. They are the reading applied to a
 * segment the parser could not account for.
 */
const LEGACY_RULES: Array<{ pattern: RegExp; detail: string }> = [
  {
    pattern: /(^|\s)(>|>>)\s*(~|\/(etc|usr|var|opt|Users|home)\/)/,
    detail: "a redirect outside the worktree",
  },
  { pattern: /\b(cp|mv|rm|chmod|chown)\b[^\n]*\s~\//, detail: "touching a path under $HOME" },
];

/** True where `command`'s leading options include `-v` or `-V`, which look a name up. */
function looksUp(words: readonly Word[]): boolean {
  for (const { value } of words) {
    if (value === "--" || !value.startsWith("-") || value === "-") return false;
    if (/^-[pvV]+$/.test(value) && /[vV]/.test(value)) return true;
  }
  return false;
}

/** `rg`'s options that take a value, as a separate word or attached. */
const RG_VALUES = new Set([
  "-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "-t", "--type", "-T",
  "--type-not", "--type-add", "--type-clear", "-A", "--after-context", "-B", "--before-context",
  "-C", "--context", "-m", "--max-count", "-j", "--threads", "-M", "--max-columns",
  "-d", "--max-depth", "--max-filesize", "-E", "--encoding", "-r", "--replace", "--pre",
  "--pre-glob", "--sort", "--sortr", "--color", "--colors", "--path-separator",
  "--context-separator", "--field-context-separator", "--field-match-separator", "--engine",
  "--dfa-size-limit", "--regex-size-limit", "--ignore-file", "--hostname-bin",
  "--hyperlink-format", "--generate",
]);

/**
 * The command an `rg --pre <program>` runs, as words: the program, then the
 * paths the search reads (`.` where it names none), each of which the program
 * is handed a file under. Null where there is no `--pre`. An option not in
 * `RG_VALUES` is read as a flag, which every other `rg` option is.
 */
function rgPreprocessor(rest: readonly Word[]): Word[] | null {
  let program: Word | null = null;
  let patternGiven = false;
  const positionals: Word[] = [];
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at]!;
    const value = word.value;
    if (word.redirect === true) continue;
    if (value === "--") {
      positionals.push(...rest.slice(at + 1).filter((after) => after.redirect !== true));
      break;
    }
    if (!value.startsWith("-") || value === "-") {
      positionals.push(word);
      continue;
    }
    let name: string;
    let attached: string | null;
    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      name = eq === -1 ? value : value.slice(0, eq);
      attached = eq === -1 ? null : value.slice(eq + 1);
    } else {
      // A short cluster: flags until one that takes a value, which is the rest
      // of the cluster or the next word.
      let letter = 1;
      while (letter < value.length && !RG_VALUES.has(`-${value[letter]}`)) letter += 1;
      if (letter === value.length) continue;
      name = `-${value[letter]}`;
      attached = letter + 1 < value.length ? value.slice(letter + 1) : null;
    }
    if (!RG_VALUES.has(name)) continue;
    const operand = attached !== null ? { ...word, raw: attached, value: attached } : rest[at + 1];
    if (attached === null) at += 1;
    if (name === "-e" || name === "--regexp" || name === "-f" || name === "--file") patternGiven = true;
    if (name === "--pre" && operand !== undefined) program = operand;
  }
  if (program === null) return null;
  const paths = patternGiven ? positionals : positionals.slice(1);
  return [program, ...(paths.length > 0 ? paths : [{ raw: ".", value: ".", substitutions: [], variable: false }])];
}

interface Analysis {
  findings: WriteFinding[];
  /** Set when the command moves the shell, so the rest of the line moves with it. */
  cd?: Cwd;
  /** False when the parser could not account for the segment. */
  accounted: boolean;
  /**
   * True where the command runs one of the write verbs, wherever the wrappers
   * and nested shells around it put the word. What the caller needs to decide a
   * mutating command by where its writes land rather than by its name: the
   * findings above say which of those writes escaped the worktree, and this
   * says the command was one of the ones that writes at all.
   */
  mutating: boolean;
  /** The programs this command ran, by basename, with the wrappers stripped. */
  programs: string[];
  /** Every command this one runs, as `CommandSegment.invocations` describes. */
  invocations: string[];
  /** The segments a nested shell of this command ran, as `CommandSegment.nested`. */
  nested: CommandSegment[];
  /** The segments its substitutions ran, as `CommandSegment.substitutions`. */
  substitutions: CommandSegment[];
  /** What the parser could not read but did not refuse, as `CommandSegment.notes`. */
  notes: string[];
  /** A program word this command could not read, as `CommandSegment.unreadablePrograms`. */
  unreadablePrograms: string[];
}

/**
 * Judge one command, given as its words.
 *
 * Wrappers are stripped until the word that names the program is reached: shell
 * keywords, `env`, `sudo`, `xargs`, `timeout`, `pnpm exec`, `npx` and the rest.
 * A `-c` operand, an `eval` argument and a `find … -exec` body are commands in
 * their own right and are judged as such.
 */
function analyzeWords(words: Word[], context: Context): Analysis {
  const findings: WriteFinding[] = [];
  const nested: string[] = [];
  const programs: string[] = [];
  const invocations: string[] = [];
  const nestedSegments: CommandSegment[] = [];
  const notes: string[] = [];
  const unreadablePrograms: string[] = [];
  let accounted = true;
  let mutating = false;
  let cd: Cwd | undefined;
  let i = 0;
  // A wrapper's `-C <dir>` moves the command it runs, not the shell, so this
  // stays local to the command being read.
  let cwd = context.cwd;
  /** True when the nested command runs in this shell rather than a new one. */
  let nestedRunsHere = false;
  /**
   * The wrapper standing in front that supplies the command its operands — the
   * one on these words, or the one in front of the `find` whose body they are.
   */
  let supplied: SuppliedOperands | undefined = context.supplied;
  /**
   * The placeholder that wrapper substitutes the words it reads for, where one
   * of its options names one. It is read as that option's value is read, so a
   * value attached to a short option — the `list.txt` of `xargs -alist.txt` —
   * is never taken for a cluster of option letters.
   */
  let placeholder: string | null;
  /** Whether that placeholder is replaced only as a whole operand. */
  let placeholderWholeWord: boolean;
  /**
   * The characters of a word the shell reads unquoted: outside single and
   * double quotes and not escaped. Only those can expand.
   */
  const unquoted = (raw: string): string => {
    let out = "";
    let quote: "'" | '"' | null = null;
    for (let at = 0; at < raw.length; at += 1) {
      const char = raw[at]!;
      if (quote === "'") {
        if (char === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (char === "\\") at += 1;
        else if (char === '"') quote = null;
        continue;
      }
      if (char === "\\") {
        at += 1;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      out += char;
    }
    return out;
  };
  /**
   * A word the shell may turn into other words — a glob, whose result depends
   * on the files present, or a brace expansion. Where such a word stands in a
   * command a wrapper substitutes into, the placeholder can end up anywhere or
   * nowhere, and the line cannot be read.
   */
  const expands = (word: Word): boolean => {
    const bare = unquoted(word.raw);
    return /[*?[]/.test(bare) || /\{[^{}]*(,|\.\.)[^{}]*\}/.test(bare);
  };
  /**
   * A word the shell hands the wrapper as written, so the wrapper sees the
   * placeholder: not a redirect's, nothing substituted into it, and no tilde
   * for the shell to expand at its start.
   */
  const literal = (word: Word): boolean =>
    word.redirect !== true &&
    !word.variable &&
    word.substitutions.length === 0 &&
    !unquoted(word.raw).startsWith("~");

  const stopHere = (): Analysis => ({
    findings,
    accounted,
    mutating,
    programs,
    invocations,
    nested: nestedSegments,
    substitutions: [],
    notes,
    unreadablePrograms,
  });

  const unreadable = (operand: Word, by: string): Analysis => {
    findings.push({
      detail:
        `the command ${operand.raw} passed to ${by} cannot be read — it is built at ` +
        `run time: ${context.segment.slice(0, 200)}`,
      target: null,
      resolved: null,
    });
    return stopHere();
  };

  /**
   * True where a word from `from` on could be the command the wrapper runs:
   * anything not written as an option. `--` ends the options and names nothing;
   * a lone `-` is an operand.
   */
  const namesACommand = (from: number): boolean =>
    words
      .slice(from)
      .some(
        ({ value, redirect }) =>
          redirect !== true && value.length > 0 && (!value.startsWith("-") || value === "-"),
      );

  /**
   * An option the wrapper's table does not know.
   *
   * It is still an option, and what it costs the guard depends on whether the
   * line has a command word to lose. With one present the guard cannot tell the
   * program from the option's value — the word after `--frobnicate` may be
   * either — so the segment is refused, which is the reading SCP-156 shipped.
   * With nothing but options the wrapper runs no command of the agent's at all,
   * so the segment is judged on the wrapper: a listed program that writes to no
   * path it names. The unread option is then a note rather than a finding
   * (SCP-186), because `write_outside_worktree` is a verdict about a
   * destination and `pnpm -v` names none.
   */
  const unknownOption = (option: string, wrapper: string): Analysis => {
    const reason = `${option} is not an option this guard knows for ${wrapper}`;
    if (!namesACommand(i + 1)) {
      notes.push(`${reason}, and the line names no command for it to run`);
      return stopHere();
    }
    findings.push({
      detail:
        `${reason}, so the word naming the command it runs cannot be told from the ` +
        `option's own value: ${context.segment.slice(0, 200)}`,
      target: null,
      resolved: null,
    });
    return stopHere();
  };

  const refusedOption = (option: string, wrapper: string): Analysis => {
    findings.push({
      detail:
        `${option} builds the command ${wrapper} runs out of a string this guard does ` +
        `not read: ${context.segment.slice(0, 200)}`,
      target: null,
      resolved: null,
    });
    return stopHere();
  };

  const rootedOption = (option: string, wrapper: string): Analysis => {
    findings.push({
      detail:
        `${wrapper} ${option} runs the command under another root directory, so every path it ` +
        `names resolves somewhere this guard does not read: ${context.segment.slice(0, 200)}`,
      target: null,
      resolved: null,
    });
    return stopHere();
  };

  /** Whether the wrapper in front substitutes its input into this word. */
  const carries = (word: Word): boolean => carriesInto(supplied, word.value);

  /**
   * A command line a nested shell runs, with words the line does not spell put
   * into it: the input of the wrapper in front, or the paths a `find` finds.
   * They land inside a line this guard reads as written, and a file's name is
   * read there as shell code, so what runs cannot be read.
   */
  const substitutedInto = (operand: Word, by: string): Analysis | null => {
    const how =
      operand.found === true
        ? "find puts each path it finds where {} stands in it"
        : supplied !== undefined && carries(operand)
          ? `${supplied.wrapper} substitutes the words it reads from standard input for ` +
            `${supplied.placeholder} in it`
          : null;
    if (how === null) return null;
    findings.push({
      detail:
        `the command ${operand.raw} passed to ${by} cannot be read — ${how}: ` +
        `${context.segment.slice(0, 200)}`,
      target: null,
      resolved: null,
    });
    return stopHere();
  };

  /**
   * Where a move leaves the shell.
   *
   * A move is not a write. `cd /tmp` names where the relative targets after it
   * resolve and refuses nothing on its own; a write that lands outside the
   * worktree from there is refused as any other write is, and an absolute
   * target back inside it is allowed. Only a move this guard cannot resolve
   * refuses, because after one no relative target can be judged at all.
   */
  const moved = (destination: Destination, raw: string, label: string): Cwd => {
    if (destination.kind === "unresolvable") {
      findings.push({
        detail: `${destinationSentence(label, raw, destination)}: ${context.segment.slice(0, 200)}`,
        target: raw,
        resolved: null,
      });
      return { path: cwd.path, unknown: true };
    }
    return { path: destination.resolved ?? cwd.path, unknown: false };
  };

  /** A `-C <dir>`: the directory the wrapped command runs in. */
  const moveInto = (operand: Word | undefined, option: string, wrapper: string): Analysis | null => {
    if (operand === undefined) return unknownOption(option, wrapper);
    // A directory the wrapper in front supplies from its standard input is a
    // destination the line never spelled, as an operand carrying it would be.
    if (supplied !== undefined && carries(operand)) {
      findings.push({
        detail:
          `the directory ${wrapper} ${option} runs in cannot be resolved — ${supplied.wrapper} ` +
          `substitutes the words it reads from standard input for ${supplied.placeholder}, and ` +
          `they are not on the line: ${context.segment.slice(0, 200)}`,
        target: operand.raw,
        resolved: null,
      });
      return stopHere();
    }
    const destination = judgeTarget(operand.value, context.scope, cwd, true);
    cwd = moved(destination, operand.raw, `the directory ${wrapper} ${option} runs in`);
    return null;
  };

  /** The directory a `find` starting point names, as a body run in it stands. */
  const directoryOf = (start: Word): Cwd => {
    const at = judgeTarget(start.value, context.scope, cwd, true);
    return at.kind === "unresolvable"
      ? { path: cwd.path, unknown: true }
      : { path: at.resolved ?? cwd.path, unknown: false };
  };

  /**
   * Where an `-execdir` body runs on what a walk from `start` finds, and what
   * `{}` is there. A path under the start runs it in the directory holding
   * that path, the shallowest being the start itself, with `{}` a name inside
   * it. The start itself runs it a level up, as `./<name>`: GNU in the
   * directory the path names it from — `sub` for `sub/deep` and for `sub/..`,
   * the directory above home for `~` — and BSD in the command's own
   * directory. A relative destination in the body is judged from each.
   */
  const execdirReadings = (start: Word): Array<{ found: Word; at: Cwd }> => {
    const as = (value: string): Word => ({ ...start, raw: value, value });
    const value = start.value.replace(/(?<=[^/])\/+$/, "");
    const slash = value.lastIndexOf("/");
    const name = value.slice(slash + 1);
    const parent =
      name === "." || name === ".."
        ? directoryOf(as(slash === -1 ? "." : slash === 0 ? "/" : value.slice(0, slash)))
        : directoryOf(as(`${value}/..`));
    const self = as(name.length === 0 ? "." : `./${name}`);
    const readings = [
      { found: HERE, at: directoryOf(start) },
      { found: self, at: parent },
    ];
    if (parent.path !== cwd.path || parent.unknown !== cwd.unknown) {
      readings.push({ found: self, at: cwd });
    }
    return readings;
  };

  /** A file the wrapper itself writes — `time -o` — judged as any destination is. */
  const wrote = (operand: Word, option: string, wrapper: string): void => {
    const label = `the file ${wrapper} ${option} writes`;
    if (supplied !== undefined && carries(operand)) {
      findings.push(suppliedDestination(label, supplied, context.segment));
      return;
    }
    const destination = judgeTarget(operand.value, context.scope, cwd, true);
    findings.push(...pathFinding(label, operand, destination, context.segment));
  };

  /**
   * Consume a wrapper's leading options. Returns an Analysis when the wrapper
   * cannot be seen through, and null when the next word names the program.
   */
  const consumeOptions = (wrapper: string, spec: WrapperSpec): Analysis | null => {
    const flags = optionSet(spec.flags);
    const values = optionSet(spec.values);
    const commands = optionSet(spec.commands);
    const dirs = optionSet(spec.dirs);
    const destinations = optionSet(spec.destinations);
    const refused = optionSet(spec.refuse);
    const roots = optionSet(spec.roots);
    const substitutes = optionSet(spec.substitutes);
    const wholeWord = optionSet(spec.substitutesWholeWord);
    const attachedValues = optionSet(spec.attachedValues);
    /** The placeholder a substituting option names, or the wrapper's default. */
    const substituted = (option: string, value: string | null) => {
      if (!substitutes.has(option)) return;
      placeholder = value ?? spec.defaultPlaceholder ?? null;
      placeholderWholeWord = wholeWord.has(option);
    };
    while (i < words.length) {
      const word = words[i]!;
      const raw = word.value;
      if (!raw.startsWith("-") || raw === "-") break;
      if (raw === "--") {
        i += 1;
        break;
      }
      if (raw.startsWith("--")) {
        const eq = raw.indexOf("=");
        const name = eq === -1 ? raw : raw.slice(0, eq);
        const attached = eq === -1 ? null : raw.slice(eq + 1);
        if (refused.has(name)) return refusedOption(raw, wrapper);
        if (roots.has(name)) return rootedOption(raw, wrapper);
        if (dirs.has(name)) {
          const operand = attached === null ? words[i + 1] : { ...word, raw: attached, value: attached };
          const stop = moveInto(operand, name, wrapper);
          if (stop !== null) return stop;
          i += attached === null ? 2 : 1;
          continue;
        }
        if (destinations.has(name)) {
          const operand = attached === null ? words[i + 1] : { ...word, raw: attached, value: attached };
          if (operand === undefined) return unknownOption(raw, wrapper);
          wrote(operand, name, wrapper);
          i += attached === null ? 2 : 1;
          continue;
        }
        if (commands.has(name)) {
          const operand = attached === null ? words[i + 1] : { ...word, raw: attached, value: attached };
          if (operand === undefined) return unknownOption(raw, wrapper);
          if (operand.variable || operand.substitutions.length > 0) {
            return unreadable(operand, `${wrapper} ${name}`);
          }
          const into = substitutedInto(operand, `${wrapper} ${name}`);
          if (into !== null) return into;
          nested.push(operand.value);
          i += attached === null ? 2 : 1;
          continue;
        }
        if (attachedValues.has(name)) {
          substituted(name, attached);
          i += 1;
          continue;
        }
        if (values.has(name)) {
          substituted(name, attached ?? words[i + 1]?.value ?? null);
          i += attached === null ? 2 : 1;
          continue;
        }
        if (flags.has(name)) {
          i += 1;
          continue;
        }
        return unknownOption(raw, wrapper);
      }
      if (refused.has(raw)) return refusedOption(raw, wrapper);
      if (dirs.has(raw)) {
        const stop = moveInto(words[i + 1], raw, wrapper);
        if (stop !== null) return stop;
        i += 2;
        continue;
      }
      if (commands.has(raw)) {
        const operand = words[i + 1];
        if (operand === undefined) return unknownOption(raw, wrapper);
        if (operand.variable || operand.substitutions.length > 0) {
          return unreadable(operand, `${wrapper} ${raw}`);
        }
        const into = substitutedInto(operand, `${wrapper} ${raw}`);
        if (into !== null) return into;
        nested.push(operand.value);
        i += 2;
        continue;
      }
      if (spec.numeric === true && /^-\d+$/.test(raw)) {
        i += 1;
        continue;
      }
      // A short cluster: every letter is a flag until one takes a value, which
      // is either the rest of the cluster or the word after it.
      let at = 1;
      let separate = false;
      let unknown: string | null = null;
      while (at < raw.length) {
        const option = `-${raw[at]}`;
        const inline = raw.slice(at + 1);
        if (flags.has(option)) {
          at += 1;
          continue;
        }
        if (refused.has(option)) return refusedOption(option, wrapper);
        if (roots.has(option)) return rootedOption(option, wrapper);
        if (dirs.has(option)) {
          const operand = inline.length > 0 ? { ...word, raw: inline, value: inline } : words[i + 1];
          const stop = moveInto(operand, option, wrapper);
          if (stop !== null) return stop;
          separate = inline.length === 0;
          break;
        }
        if (destinations.has(option)) {
          const operand = inline.length > 0 ? { ...word, raw: inline, value: inline } : words[i + 1];
          if (operand === undefined) return unknownOption(option, wrapper);
          wrote(operand, option, wrapper);
          separate = inline.length === 0;
          break;
        }
        if (attachedValues.has(option)) {
          substituted(option, inline.length > 0 ? inline : null);
          break;
        }
        if (values.has(option)) {
          separate = inline.length === 0;
          substituted(option, separate ? (words[i + 1]?.value ?? null) : inline);
          break;
        }
        unknown = option;
        break;
      }
      if (unknown !== null) return unknownOption(unknown, wrapper);
      i += separate ? 2 : 1;
    }
    return null;
  };

  /**
   * A refusal for a placeholder standing where the wrapper's input would be
   * read as something other than a source: the program, a keyword, an
   * assignment, or a wrapper's own option or operand.
   */
  const placeholderStands = (word: Word, where: string): Analysis | null => {
    if (
      supplied === undefined ||
      !supplied.wholeWord ||
      supplied.placeholder === null ||
      !literal(word) ||
      word.value !== supplied.placeholder
    ) {
      return null;
    }
    findings.push({
      detail:
        `${word.raw} is what ${supplied.wrapper} substitutes its input for, and it stands as ${where}, ` +
        `so what runs cannot be read: ${context.segment.slice(0, 200)}`,
      target: null,
      resolved: null,
    });
    return stopHere();
  };

  while (i < words.length) {
    const value = words[i]!.value;
    if (value === "" || value === "--" || isAssignment(value) || KEYWORDS.has(value)) {
      const stands = placeholderStands(words[i]!, "a word the shell reads before the command");
      if (stands !== null) return stands;
      i += 1;
      continue;
    }
    if (value === "for" || value === "select") {
      // `for f in *` runs nothing; its body arrives as the segment after `do`.
      return stopHere();
    }
    // The line from this word on, with the program's directory dropped, is one
    // command the segment runs — `env sudo rm -r x` is `env …`, then `sudo …`,
    // then `rm …`, and a list entry is matched against each of them.
    invocations.push(
      [basename(value), ...words.slice(i + 1).map((word) => word.raw)].join(" ").trim(),
    );
    const program = basename(value);
    if (PACKAGE_MANAGERS.has(program)) {
      i += 1;
      const stop = consumeOptions(program, PACKAGE_MANAGER_SPEC);
      if (stop !== null) return stop;
      const subcommand = words[i]?.value;
      if (subcommand === "exec" || subcommand === "dlx" || subcommand === "x") {
        i += 1;
        const after = consumeOptions(`${program} ${subcommand}`, EXEC_SPEC);
        if (after !== null) return after;
        if (nested.length > 0) break;
        continue;
      }
      if (subcommand === "workspace" || subcommand === "workspaces") {
        i += 2;
        continue;
      }
      break;
    }
    if (program === "npx" || program === "bunx" || program === "pnpx") {
      i += 1;
      const stop = consumeOptions(program, NPX_SPEC);
      if (stop !== null) return stop;
      if (nested.length > 0) break;
      continue;
    }
    const wrapper = WRAPPERS.get(program);
    if (program === "command" && looksUp(words.slice(i + 1))) {
      // `command -v gh` and `command -V gh` say what `gh` would be, and run
      // nothing at all.
      return stopHere();
    }
    if (wrapper !== undefined) {
      const from = i;
      i += 1;
      placeholder = null;
      placeholderWholeWord = false;
      const stop = consumeOptions(program, wrapper);
      if (stop !== null) return stop;
      for (const word of words.slice(from, i + (wrapper.operands ?? 0))) {
        const stands = placeholderStands(word, `a word of ${program}, which runs the command`);
        if (stands !== null) return stands;
      }
      // Set inside the option consumer, which the narrowing above cannot see.
      const named = placeholder as string | null;
      if (named !== null && named.startsWith("-")) {
        // The placeholder stands where a writer reads its options, so whatever
        // the input holds is read as one, and the line cannot be read at all.
        findings.push({
          detail:
            `the placeholder ${named} ${program} substitutes its input for is shaped like an ` +
            `option, so the command it runs cannot be read: ${context.segment.slice(0, 200)}`,
          target: null,
          resolved: null,
        });
        return stopHere();
      }
      if (wrapper.appendsOperands === true) {
        // A second wrapper that puts its input into the command, behind one
        // whose input reaches it — appended to its words, or substituted into
        // one of them — builds that command out of two inputs, and this guard
        // reads one.
        if (
          supplied !== undefined &&
          (supplied.placeholder === null || words.slice(from + 1).some((word) => carries(word)))
        ) {
          findings.push({
            detail:
              `${program} stands behind ${supplied.wrapper}, which puts the words it reads from ` +
              `standard input into the command ${program} runs, so what runs cannot be read: ` +
              `${context.segment.slice(0, 200)}`,
            target: null,
            resolved: null,
          });
          return stopHere();
        }
        const rest = words.slice(i + (wrapper.operands ?? 0));
        const expanded =
          named !== null && placeholderWholeWord
            ? rest.find((word) => word.redirect !== true && expands(word))
            : undefined;
        if (expanded !== undefined) {
          findings.push({
            detail:
              `${expanded.raw} is a word the shell expands, so where ${program} finds ${named} ` +
              `in the command it runs — or whether it does — cannot be read here: ` +
              `${context.segment.slice(0, 200)}`,
            target: null,
            resolved: null,
          });
          return stopHere();
        }
        // A whole-word placeholder that stands nowhere in the wrapped command
        // — not as an operand, not as an option's value — is not substituted,
        // and the wrapper appends its input as it does with no placeholder.
        const substituted =
          named !== null &&
          (!placeholderWholeWord || rest.some((word) => literal(word) && word.value === named));
        supplied = {
          wrapper: program,
          placeholder: substituted ? named : null,
          wholeWord: placeholderWholeWord,
        };
      }
      i += wrapper.operands ?? 0;
      continue;
    }
    if (SHELLS.has(basename(value))) {
      // `sh -c <command>` runs its operand; any other form runs a script this
      // guard cannot see, which is a segment it cannot account for — unless the
      // script is the standard input the line itself spells out.
      let flag = i + 1;
      while (flag < words.length && !/^-[a-z]*c$/.test(words[flag]!.value)) flag += 1;
      const operand = words[flag + 1];
      if (operand === undefined) {
        const script = words.slice(i + 1).find((word) => !word.value.startsWith("-"));
        if (script !== undefined || context.stdin === undefined) {
          programs.push(basename(value));
          accounted = false;
          return stopHere();
        }
        const read = shellFromStdin(basename(value), context.stdin, { ...context, cwd });
        findings.push(...read.findings);
        nested.push(...read.script);
        if (!read.accounted) accounted = false;
        break;
      }
      if (operand.variable || operand.substitutions.length > 0) {
        return unreadable(operand, `${value} -c`);
      }
      const into = substitutedInto(operand, `${value} -c`);
      if (into !== null) return into;
      nested.push(operand.value);
      break;
    }
    if (value === "eval") {
      // The shell joins the operands with a space and runs the result, so the
      // join is the command, not each operand on its own.
      const operands = words.slice(i + 1);
      for (const operand of operands) {
        if (operand.variable || operand.substitutions.length > 0) {
          // `eval` of a variable is one of the shapes SCP-201's admission rule
          // is named for: the guard cannot read what the join will run.
          unreadablePrograms.push(operand.raw);
          // The evaluated line may have moved the shell anywhere, so nothing
          // relative after it can be judged.
          return { ...unreadable(operand, "eval"), cd: { path: cwd.path, unknown: true } };
        }
      }
      nested.push(operands.map((operand) => operand.value).join(" "));
      nestedRunsHere = true;
      break;
    }
    break;
  }

  const command = nested.length > 0 ? undefined : words[i];
  if (command !== undefined) {
    const verb = basename(command.value);
    const rest = words.slice(i + 1);
    const stands = placeholderStands(command, "the program itself");
    if (stands !== null) return stands;
    if (command.variable || command.substitutions.length > 0) {
      // `$(…)`, a backtick, or a bare `$name` stands where the verb should —
      // `exec`'s own leading flags are already consumed by the time this word
      // is reached, so `exec $(…)` and `exec $VAR` land here too. There is no
      // way to know what will actually run, so this is refused by name rather
      // than left silently unaccounted (SCP-201).
      unreadablePrograms.push(command.raw);
      findings.push({
        detail:
          `the program ${command.raw} cannot be read — it is built at run time: ` +
          `${context.segment.slice(0, 200)}`,
        target: null,
        resolved: null,
      });
      accounted = false;
    } else if (WRITERS.has(verb)) {
      const spec = WRITERS.get(verb)!;
      programs.push(verb);
      // A writer that also reaches the network or unpacks an archive has
      // written more than the destinations this table names, so a caller
      // deciding the line by where those landed has not seen the whole act.
      if (spec.beyondNamedPaths !== true) mutating = true;
      findings.push(...writerFindings(verb, spec, rest, { ...context, cwd, supplied }));
    } else if (verb === "ln") {
      programs.push(verb);
      mutating = true;
      findings.push(...linkFindings(rest, { ...context, cwd, supplied }));
    } else if (verb === "git") {
      programs.push(verb);
      findings.push(...gitFindings(rest, { ...context, cwd, supplied }));
    } else if (INTERPRETERS.has(verb)) {
      programs.push(verb);
      const inner = { ...context, cwd };
      const inline = interpreterFindings(verb, INTERPRETERS.get(verb)!, rest, inner);
      findings.push(...inline.findings);
      // The command line named no program, so what runs comes from a file, or
      // from standard input, or from nowhere this guard can read.
      if (!inline.program) {
        findings.push(...programSourceFindings(verb, inline.operands, inner, cwd));
      }
    } else if (verb === "cd" || verb === "pushd") {
      programs.push(verb);
      // A lone `-` is `cd`'s operand, not one of its flags.
      const operand = rest.find((word) => word.value === "-" || !word.value.startsWith("-"));
      const target = operand?.value ?? (verb === "cd" ? "~" : null);
      const destination: Destination =
        target === null
          ? {
              kind: "unresolvable",
              reason: "`pushd` with no directory swaps two this guard did not see",
            }
          : target === "-"
            ? { kind: "unresolvable", reason: "`cd -` returns to a directory this guard did not see" }
            : judgeTarget(target, context.scope, cwd, true);
      cd = moved(destination, operand?.raw ?? verb, "the working directory");
    } else if (verb === "popd") {
      programs.push(verb);
      const reason = "`popd` returns to a directory this guard did not see";
      findings.push({
        detail: `the working directory cannot be resolved — ${reason}: ${context.segment.slice(0, 200)}`,
        target: null,
        resolved: null,
      });
      cd = { path: cwd.path, unknown: true };
    } else if (verb === "find") {
      programs.push(verb);
      const expression = findExpression(rest);
      // Words a wrapper in front puts where `find` reads a starting point or
      // an action can be an action themselves: `-delete`, or `-fprint` taking
      // the word after it as its file. An appending wrapper puts them after
      // the whole expression, BSD's `-J` puts every word it reads wherever its
      // placeholder stands, and a placeholder standing as a head is one.
      const fed =
        supplied === undefined
          ? null
          : supplied.placeholder === null
            ? `${supplied.wrapper} appends the words it reads from standard input to its expression`
            : supplied.wholeWord && rest.some((word) => carries(word))
              ? `${supplied.wrapper} substitutes every word it reads from standard input for ` +
                `${supplied.placeholder} in it`
              : expression.heads.some((word) => carries(word))
                ? `${supplied.wrapper} substitutes the words it reads from standard input for ` +
                  `${supplied.placeholder} where it reads a starting point or an action`
                : null;
      if (fed !== null) {
        findings.push({
          detail:
            `what find walks and what it does there cannot be read — ${fed}: ` +
            `${context.segment.slice(0, 200)}`,
          target: null,
          resolved: null,
        });
        return stopHere();
      }
      if (expression.startsFrom !== null && (expression.deletes || expression.bodies.length > 0)) {
        findings.push({
          detail:
            `the starting points find -files0-from reads from ${expression.startsFrom.raw} are ` +
            `not on the line, so where its -delete or -exec body writes cannot be resolved: ` +
            `${context.segment.slice(0, 200)}`,
          target: null,
          resolved: null,
        });
      }
      const starts = expression.starts.length > 0 ? expression.starts : [HERE];
      /** A path under which the walk writes, or a file an action writes. */
      const judgeWritten = (word: Word, label: string): WriteFinding[] =>
        supplied !== undefined && carries(word)
          ? [suppliedDestination(label, supplied, context.segment)]
          : pathFinding(label, word, judgeTarget(word.value, context.scope, cwd, true), context.segment);
      if (expression.deletes) {
        for (const start of starts) {
          findings.push(...judgeWritten(start, "the find -delete starting point"));
        }
      }
      for (const { action, word } of expression.files) {
        findings.push(...judgeWritten(word, `the find ${action} destination`));
      }
      for (const body of expression.bodies) {
        // A body runs on each path the walk finds, which `find` puts where `{}`
        // stands, and every one is under a starting point: so the body is read
        // once per starting point with that point in its place. `-execdir`
        // runs it in the directory holding each found path, which for the
        // starting point itself is the one above it (`execdirReadings`).
        // A body the wrapper in front substitutes its own input into is read
        // as written, because that input is what stands there.
        const readings =
          supplied !== undefined && body.words.some((word) => carries(word))
            ? [{ words: body.words, at: cwd }]
            : starts.flatMap((start) =>
                body.inFoundDirectory
                  ? execdirReadings(start).map(({ found, at }) => ({
                      words: body.words.map((word) => placed(word, found)),
                      at,
                    }))
                  : [{ words: body.words.map((word) => placed(word, start)), at: cwd }],
              );
        readings.forEach((reading, index) => {
          // The body is a command of its own: it inherits the directory, not
          // the standard input the line gave the `find`.
          const inner = analyzeWords(reading.words, {
            ...context,
            cwd: reading.at,
            stdin: undefined,
            supplied,
          });
          findings.push(...inner.findings);
          if (!inner.accounted) accounted = false;
          // `find … -exec rm {} ;` runs `rm`: what the line writes is the
          // body's, and the admission decision is about the same act.
          if (inner.mutating) mutating = true;
          if (index > 0) return;
          programs.push(...inner.programs);
          invocations.push(...inner.invocations);
          unreadablePrograms.push(...inner.unreadablePrograms);
        });
      }
    } else if (verb === "rg") {
      programs.push(verb);
      // Words a wrapper in front hands `rg` where it still reads options can be
      // an option themselves, and `--pre <program>` runs a program.
      const option = suppliedAsOption(verb, rest, { ...context, cwd, supplied });
      if (option !== null) {
        findings.push(option);
        return stopHere();
      }
      // The command `<program> <paths…>` an `rg --pre <program>` runs on each
      // file the search reads is a command of its own: it inherits the
      // directory, not the standard input the line gave the search.
      const body = rgPreprocessor(rest);
      if (body !== null) {
        const into = substitutedInto(body[0]!, "rg --pre");
        if (into !== null) return into;
        const inner = analyzeWords(body, { ...context, cwd, stdin: undefined, supplied });
        findings.push(...inner.findings);
        if (!inner.accounted) accounted = false;
        if (inner.mutating) mutating = true;
        programs.push(...inner.programs);
        invocations.push(...inner.invocations);
        unreadablePrograms.push(...inner.unreadablePrograms);
      }
    } else {
      programs.push(verb);
    }
  }

  for (const text of nested) {
    const inner = inspectSegments(text, context.scope, cwd, context.depth + 1);
    findings.push(...inner.findings);
    // The wrapper is not the act. `sh -c 'cp a b'` and `eval cp a b` write what
    // the inner line writes, so the decision the outer command gets is the one
    // the inner command earned.
    if (inner.segments.some((segment) => segment.mutating)) mutating = true;
    nestedSegments.push(...inner.segments);
    for (const segment of inner.segments) {
      programs.push(...segment.programs);
      invocations.push(...segment.invocations);
      unreadablePrograms.push(...segment.unreadablePrograms);
    }
    // `sh -c` and `npx -c` spawn a shell and their `cd` dies with it; `eval`
    // runs in this one, so where it ends is where the rest of the line runs.
    if (nestedRunsHere) {
      cwd = inner.cwd;
      cd = inner.cwd;
    }
  }
  return {
    findings,
    ...(cd === undefined ? {} : { cd }),
    accounted,
    mutating,
    programs,
    invocations,
    nested: nestedSegments,
    substitutions: [],
    notes,
    unreadablePrograms,
  };
}

/**
 * One segment, as the commands between its own operators.
 *
 * A subshell keeps its operators, because splitting stops at the parenthesis.
 * Each run of items between them is a command, judged with the directory the
 * runs before it left the shell in — and a `cd` in a run that the shell puts in
 * a subshell (`… | …`, `… &`) moves nothing after it.
 */
function analyzeSegment(
  segment: string,
  context: Context,
  heredocs: Map<string, HeredocBody[]> = new Map(),
): Analysis {
  const { items, balanced } = tokenize(segment, heredocs);
  const findings: WriteFinding[] = [];
  const programs: string[] = [];
  const invocations: string[] = [];
  const nestedSegments: CommandSegment[] = [];
  const substitutionSegments: CommandSegment[] = [];
  const notes: string[] = [];
  const unreadablePrograms: string[] = [];
  let cwd = context.cwd;
  let accounted = balanced;
  let mutating = false;
  let cd: Cwd | undefined;
  let group: Item[] = [];
  /**
   * What the next command reads: the redirect it was written with, or the
   * stage before it where a pipe stands between the two. A pipe inside a
   * subshell is the only one that reaches here — splitting takes the rest —
   * and the caller supplies that one on the context.
   */
  let stdin: StdinSource | undefined = context.stdin;

  // A `( … )` runs in a subshell: a `cd` inside it is undone at the closing
  // parenthesis, and a redirect after that one is opened in the parent's
  // directory. The stack holds the directory each open parenthesis left.
  let depth = 0;
  const enclosing: Cwd[] = [];

  const run = (following: string) => {
    if (group.length === 0) {
      return;
    }
    const words: Word[] = [];
    const bodies: string[] = [];
    for (const item of group) {
      if (item.kind === "word") {
        words.push(item.word);
        continue;
      }
      if (item.kind === "operator") continue;
      if (item.kind === "stdin") {
        // The last one wins, as it does in the shell.
        stdin = item.source;
        bodies.push(...item.substitutions);
        continue;
      }
      const { target, reason } = item.redirect;
      const destination: Destination =
        reason !== null
          ? { kind: "unresolvable", reason }
          : judgeTarget(target!.value, context.scope, cwd, true);
      findings.push(
        ...pathFinding(
          "the redirect target",
          target ?? { raw: "(nothing)", value: "" },
          destination,
          segment,
        ),
      );
      if (target !== null) words.push({ ...target, redirect: true });
    }
    // Every `$(…)`, backtick and process-substitution body is a command in its
    // own right, run before this one, and kept as a segment of its own
    // (`CommandSegment.substitutions` says what it hands this one).
    for (const word of words) bodies.push(...word.substitutions);
    for (const body of bodies) {
      const inner = inspectSegments(body, context.scope, cwd, context.depth + 1);
      findings.push(...inner.findings);
      substitutionSegments.push(...inner.segments);
      for (const segment of inner.segments) {
        invocations.push(...segment.invocations);
        unreadablePrograms.push(...segment.unreadablePrograms);
        if (!segment.accounted) accounted = false;
      }
    }
    const analysis = analyzeWords(words, { ...context, cwd, stdin });
    findings.push(...analysis.findings);
    if (!analysis.accounted) accounted = false;
    if (analysis.mutating) mutating = true;
    programs.push(...analysis.programs);
    invocations.push(...analysis.invocations);
    nestedSegments.push(...analysis.nested);
    notes.push(...analysis.notes);
    unreadablePrograms.push(...analysis.unreadablePrograms);
    if (analysis.cd !== undefined && SEQUENTIAL_OPERATORS.has(following)) {
      cwd = analysis.cd;
      // Only a move the enclosing shell made outlives this segment.
      if (depth === 0) cd = analysis.cd;
    }
    // What the next command reads is this command's output, and only where a
    // pipe joins the two.
    stdin =
      following === "|" || following === "|&" ? { kind: "pipe", producer: words } : undefined;
    group = [];
  };

  for (const item of items) {
    if (item.kind === "operator") {
      run(item.text);
      continue;
    }
    // Only an unquoted parenthesis opens or closes a subshell; `'('` is a word.
    if (item.kind === "word" && (item.word.raw === "(" || item.word.raw === ")")) {
      run("");
      if (item.word.value === "(") {
        enclosing.push(cwd);
        depth += 1;
      } else {
        cwd = enclosing.pop() ?? cwd;
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    group.push(item);
  }
  run("");

  return {
    findings,
    ...(cd === undefined ? {} : { cd }),
    accounted,
    mutating,
    programs,
    invocations,
    nested: nestedSegments,
    substitutions: substitutionSegments,
    notes,
    unreadablePrograms,
  };
}

/**
 * The stage a segment feeds, where the operator after it is a pipe. Its words
 * are read again from the text rather than kept from the analysis, because the
 * analysis is about what the segment *did*, and this is about what it wrote to
 * the pipe.
 */
function pipeInto(separator: string, segment: string): StdinSource | undefined {
  if (separator !== "|" && separator !== "|&") return undefined;
  const producer = tokenize(segment).items.flatMap((item) =>
    item.kind === "word" ? [item.word] : [],
  );
  return { kind: "pipe", producer };
}

function legacyFindings(segment: string): WriteFinding[] {
  return LEGACY_RULES.filter((rule) => rule.pattern.test(segment)).map((rule) => ({
    detail: `${rule.detail}: ${segment.slice(0, 200)}`,
    target: null,
    resolved: null,
  }));
}

/**
 * Read a command line, reporting both what it writes and the directory it
 * leaves the shell in. The directory matters to one caller: `eval` runs its
 * operand in the current shell, so a `cd` inside it moves the rest of the line.
 */
export function inspectSegments(
  command: string,
  scope: ResolvedScope,
  start: Cwd,
  depth: number,
): CommandReading {
  if (depth > 8) {
    return {
      findings: [
        {
          detail: "a command nested too deeply for this guard to read",
          target: null,
          resolved: null,
        },
      ],
      cwd: { path: start.path, unknown: true },
      segments: [],
    };
  }
  const { texts, separators, balanced, bodies, unreadable } = scanSegments(command);
  const heredocs = heredocQueue(bodies);
  const findings: WriteFinding[] = [];
  if (unreadable !== null) {
    findings.push({
      detail: `this line cannot be read — ${unreadable}: ${command.slice(0, 200)}`,
      target: null,
      resolved: null,
    });
  }
  const segments: CommandSegment[] = [];
  let cwd = start;
  /** The stage a pipe put before this one, which is where its input comes from. */
  let piped: StdinSource | undefined;
  for (let i = 0; i < texts.length; i += 1) {
    const segment = texts[i]!.trim();
    const separator = separators[i] ?? "";
    if (segment.length === 0) {
      piped = undefined;
      continue;
    }
    const analysis = analyzeSegment(
      segment,
      { scope, cwd, segment, depth, stdin: piped },
      heredocs,
    );
    piped = pipeInto(separator, segment);
    findings.push(...analysis.findings);
    if (!analysis.accounted || !balanced) findings.push(...legacyFindings(segment));
    segments.push({
      text: segment,
      mutating: analysis.mutating,
      programs: analysis.programs,
      invocations: analysis.invocations,
      nested: analysis.nested,
      substitutions: analysis.substitutions,
      notes: analysis.notes,
      accounted: analysis.accounted && balanced,
      unreadablePrograms: analysis.unreadablePrograms,
    });
    // A `cd` the shell runs in a subshell — a pipeline stage, a backgrounded
    // command — moves nothing after it.
    if (analysis.cd !== undefined && SEQUENTIAL_OPERATORS.has(separator)) {
      cwd = analysis.cd;
    }
  }
  return { findings, cwd, segments };
}
