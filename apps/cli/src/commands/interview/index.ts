import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  EXIT_CODES,
  GraphEditSchema,
  onePieceOfWork,
  planNodes,
  planSizeCounts,
  sizeEstimate,
} from "@perbo/contracts";
import {
  InterviewQuestionGroupSchema,
  MAX_QUESTION_GROUPS,
  answersGroup,
  decodeInterviewTurn,
  encodeInterviewEvent,
  type InterviewEvent,
  type InterviewQuestionGroup,
} from "@perbo/contracts/interview-protocol";
import {
  ADMISSION_RULES,
  DEFAULT_COMMAND_DENY_LIST,
  SUBAGENT_TOOL_NAMES,
  UNKNOWN_CWD,
  expandableHeredocBodies,
  gitGlobalOptions,
  inspectCommandWithCwd,
  judgeCommand,
  judgePreToolCall,
  matchesListEntry,
  withExecutorSkills,
  type AdmissionRule,
  type CommandSegment,
  type PreToolGuardState,
  type WorktreeScope,
} from "@perbo/runner";
import { collectOutput } from "../../diagnostics.js";
import {
  admitDraft,
  admitDraftReport,
  defaultAdmission,
  type AdmissionReport,
} from "../admit.js";
import { UsageError } from "../../usage-error.js";
import {
  parseArgv,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../../command-line/grammar.js";
import { edit, type EditInput } from "../edit/index.js";
import { withoutNextStep } from "../../next-step.js";
import { adrFolder, specFolder, storeDir, trackedFiles } from "../../store/index.js";
import type { Streams } from "../../streams.js";
import type { NarratedCommand } from "../../command-line/table.js";
import { narratedStreams } from "../../streams.js";
import type { CommandContext } from "../../command.js";
import {
  listTickets,
  readApproachRecord,
  readContract,
  readDraftSnapshot,
  readTicket,
} from "../../store/tickets.js";
import type { Model } from "@perbo/model";

/**
 * `perbo interview` — the person's own session, which writes the spec
 * (D-102). Claude Code runs through the Claude Agent SDK and Codex through
 * `codex app-server`, each behind {@link InterviewTransport}.
 *
 * `perbo agent`'s idea without the person's own configuration: the same
 * person's own session, in the primary checkout, oriented by an appended
 * prompt. What differs is what it may do. It reads anything and runs the
 * read-only commands, writes the spec folder, `CONTEXT.md` and the ADR folder
 * and nothing else, changes a drafted plan only through the validated edit
 * path, and cannot approve, publish or merge — there is no tool for any of the
 * three, and nothing a model returns becomes a flag (ADR-0023 §4): every tool
 * builds its arguments as values.
 *
 * Anything outside that is **refused, not asked**. Every call a transport can
 * decide reaches {@link judgeInterviewCall} through one seam, which consults
 * the runner's own write guard with the interview's allowed paths and answers
 * `deny` with the guard's reason — read by the person on stderr and by a host
 * on the stream. A transport's own way of asking is where that seam sits: the
 * SDK's permission callback on one, the app server's approval requests on the
 * other, and neither ever puts a question to anybody.
 */

/** The name the interview's own tools are served under, and are prefixed by. */
export const INTERVIEW_SERVER_NAME = "perbo_interview";

/** Where a spec folder records the session that is writing it, so it is found again. */
export const INTERVIEW_SESSION_FILE = ".interview.json";

/** The edit author every plan change from this session is recorded under (D-100). */
export const INTERVIEW_AUTHOR = "interview";

/**
 * The skills the session is oriented with: the interview is a grilling that
 * leaves the repository's terms and decisions behind it (D-102).
 */
export const INTERVIEW_SKILLS = ["grilling", "domain-modeling"] as const;

/**
 * What the session may do, in the names the rules judge: the reads, a shell,
 * and the three writers.
 *
 * The Claude Agent SDK's own tool names, because that is where they came from
 * and one vocabulary is better than two. Codex's native acts are named into
 * them — a command is a `Bash`, a file change is a `Write` — so a refusal
 * reads the same on either transport and there is one list to widen.
 */
export const INTERVIEW_AGENT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
] as const;

/**
 * What the session's `disallowedTools` carries: the runner's deny list, and
 * every name the tool that starts a subagent answers to (D-102).
 *
 * Named here rather than on the runner's list because the two sessions differ
 * on it: the executor may start subagents from the roles Perbo defines
 * ([D-106](../../../../../docs/11-open-decisions.md)) and the interview may not —
 * it writes one spec, and the roles are the executor's. The session is
 * offered no way to start one either, so this is the second of two.
 */
export const INTERVIEW_DENIED_TOOLS = [...DEFAULT_COMMAND_DENY_LIST, ...SUBAGENT_TOOL_NAMES] as const;

/** The interview's own tools. Nothing here approves, publishes, runs or merges. */
export const INTERVIEW_TOOL_NAMES = [
  "generate_plan",
  "edit_plan",
  "undo_edit",
  "read_plan",
  "ask_options",
] as const;

/**
 * The shapes a command may take.
 *
 * Read-only by construction: every verb here answers a question and writes
 * nothing on its own, so the interview never has to ask whether a command's
 * output was worth its effect. A few of these programs admit a flag that
 * turns them into a writer or into a way to run another program without
 * naming a verb this list excludes; {@link READ_ONLY_FLAG_BANS} holds those
 * flags, read against every command this list would otherwise admit and
 * refused by the flag's own name (SCP-355). `cd` and `pwd` are here because
 * the guard tracks the shell's directory itself and a session that cannot
 * move cannot read a subdirectory relatively.
 *
 * A command is read through the runner's own construct-aware reader — a
 * wrapper, a subshell, a brace group, a pipeline, a list, an assignment
 * prefix — and through every command-substitution, process-substitution and
 * unquoted here-document body it carries, at whatever depth one nests
 * inside another, not only its own top-level text. Every command that
 * reading finds must be one of the shapes above, or it is refused: the list
 * bounds what runs, not merely what a line's first word looks like, so a
 * function body or an assignment prefix that names a second program past the
 * first (`cat () { evil.sh; }`, `cat=1 program`) is refused for the program
 * it hides, a body that runs an unlisted program is refused for that
 * program, and a bare environment assignment (`PATH=…; ls`) is refused for
 * setting what a later shape resolves and runs in. A flag that would turn one
 * of those shapes into a writer or into a way to run another program is
 * refused by its own name ({@link READ_ONLY_FLAG_BANS}). And what the reading
 * cannot resolve is refused rather than admitted: a quoting it cannot read, a
 * command it cannot read, a variable's value it cannot know, or — for a
 * construct none of the above specifically models — a ban-eligible program's
 * name standing somewhere this reading never invocation-judged. None of this
 * promises that every way to disguise a write is named; it promises that
 * nothing but the listed read-only shapes runs, and that what this reading
 * cannot vouch for does not run.
 *
 * The runner's own list is wider — it belongs to an executor that has to build
 * and test what it wrote — and the deny-list below is shared with it, because
 * the acts it refuses are refused here for the same reasons.
 */
export const INTERVIEW_READ_ONLY_COMMANDS = [
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(rg:*)",
  "Bash(grep:*)",
  "Bash(find:*)",
  "Bash(file:*)",
  "Bash(cd:*)",
  "Bash(pwd)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git ls-files:*)",
  "Bash(git blame:*)",
] as const;

/**
 * A flag that turns one of the shapes above into a writer or into a way to
 * run another program, so a command this session would otherwise admit is
 * refused by the flag's own name instead: `git log`, `git diff` and `git
 * show --output=<path>` write the ref they would otherwise print; `rg --pre
 * <program>` and `rg --hostname-bin=<program>` each run that program once
 * per file searched; `file -C`, or any unique abbreviation of `--compile`
 * getopt would take, writes a compiled magic file.
 *
 * `find` carries the most of these, because one program admits the most
 * shapes of the same two outcomes, not because it is read differently:
 * `-delete`, `-fprint`, `-fprint0`, `-fls` and `-fprintf` each write or
 * delete on their own, with no nested command for this guard to see; `-exec`,
 * `-execdir`, `-ok` and `-okdir` run a program directly, so they are refused
 * here rather than left to what this session's own read-only list makes of
 * the program named — `find … -exec cat {} \;` still runs a program, even
 * where `cat` is one this session may otherwise run on its own.
 *
 * Matched by word against the command as a shell would hand it to the
 * program — see {@link shellWords} — attached with `=`, or combined into a
 * short cluster the way `file`'s single-letter flags allow, wherever it
 * stands, including after a `--` or inside a `$(…)`, `` `…` ``, `<(…)` or
 * `>(…)` this session's own command carries, at whatever depth one nests
 * inside another (see {@link substitutionBodies}), or inside an unquoted
 * here-document body reached the same way (see {@link hereDocBodies}). A
 * word of a ban-eligible program that carries a variable, parameter or
 * positional expansion this reading cannot resolve is refused outright,
 * its value being exactly what a ban here would have to see to clear it
 * (see {@link unresolvedExpansion}) — a single-quoted one stays literal and
 * is read as written. And a program name this table binds an entry to,
 * standing somewhere none of the above specifically invocation-judged, is
 * refused by a closure backstop rather than trusted on the strength of a
 * construct this file does not name (see {@link firstWordOccurrences}).
 * This session never asks, so a spelling nothing here has proven inert is
 * refused rather than trusted.
 */
const READ_ONLY_FLAG_BANS: ReadonlyArray<{
  readonly program: string;
  /** Only for `git`, whose subcommand decides which flags write. */
  readonly subcommand?: string;
  /** A long flag, matched bare or as `word=value`. */
  readonly word?: string;
  /** A short flag's letter, matched bare or combined with other short flags (`file`'s `-Cm`). */
  readonly short?: string;
  /**
   * A long flag matched by any getopt-unique abbreviation of it, three
   * characters or more (`file`'s own `--comp`) — getopt takes the shortest
   * prefix that names exactly one of a program's long options, so a flag
   * this table bans is not escaped by shortening its spelling.
   */
  readonly prefixOf?: string;
}> = [
  { program: "git", subcommand: "log", word: "--output" },
  { program: "git", subcommand: "diff", word: "--output" },
  { program: "git", subcommand: "show", word: "--output" },
  // git and rg refuse their own `--outp=`/`--pr=` abbreviations outright
  // (git 2.50.1, ripgrep 14.1.1 exit nonzero and write nothing), so unlike
  // file's getopt they need no prefix ban here.
  { program: "rg", word: "--pre" },
  { program: "rg", word: "--hostname-bin" },
  { program: "find", word: "-delete" },
  { program: "find", word: "-fprint" },
  { program: "find", word: "-fprint0" },
  { program: "find", word: "-fls" },
  { program: "find", word: "-fprintf" },
  { program: "find", word: "-exec" },
  { program: "find", word: "-execdir" },
  { program: "find", word: "-ok" },
  { program: "find", word: "-okdir" },
  { program: "file", short: "C" },
  { program: "file", prefixOf: "--compile" },
];

/** Every program {@link READ_ONLY_FLAG_BANS} names an entry for, once each. */
const banEligiblePrograms: readonly string[] = [...new Set(READ_ONLY_FLAG_BANS.map((ban) => ban.program))];

/**
 * One word of a command, as a shell would hand it to the program.
 *
 * `raw` is the word exactly as written, so a refusal can name it. `value` is
 * `raw` with its quotes and backslash-escapes resolved — or `null` where
 * this reading does not resolve them: an ANSI-C `$'…'` quote, an
 * unterminated quote, or a backslash before the `-` that would open a flag,
 * none of which this guesses at.
 */
interface ShellWord {
  readonly raw: string;
  readonly value: string | null;
}

/**
 * `text` split into the words a shell would hand to the program it names —
 * quotes removed, a backslash-escaped character taken literally, a quote
 * spanning a mid-word boundary joined (`--output='x'` reads as one word,
 * `--output=x`) — so {@link bannedReadOnlyFlag} matches a flag however it is
 * spelled rather than only bare. A word whose quoting this does not resolve
 * carries `value: null` instead of a guess.
 */
function shellWords(text: string): ShellWord[] {
  const words: ShellWord[] = [];
  let raw = "";
  let value = "";
  let started = false;
  let unreadable = false;
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    if (started) words.push({ raw, value: unreadable ? null : value });
    raw = "";
    value = "";
    started = false;
    unreadable = false;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote === "'") {
      raw += ch;
      if (ch === "'") quote = null;
      else value += ch;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "-") unreadable = true;
      raw += ch + (next ?? "");
      value += next ?? "";
      started = true;
      i += 2;
      continue;
    }
    if (quote === null && (ch === "'" || ch === '"')) {
      quote = ch;
      raw += ch;
      started = true;
      i += 1;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      raw += ch;
      i += 1;
      continue;
    }
    if (quote === null && ch === "$" && text[i + 1] === "'") {
      unreadable = true;
      raw += ch;
      value += ch;
      started = true;
      i += 1;
      continue;
    }
    if (quote === null && /\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }
    raw += ch;
    value += ch;
    started = true;
    i += 1;
  }
  if (quote !== null) unreadable = true;
  flush();
  return words;
}

/**
 * What {@link bannedReadOnlyFlag} or {@link bannedInSegment} found on an
 * invocation's own words, or null for neither. `unreadable` is a word whose
 * quoting `shellWords` could not resolve; `unreadable_command` is a program
 * word the runner's own reader could not read at all — a substitution, a
 * backtick or an unexpanded variable stood where a verb should be;
 * `unresolved_expansion` is a variable, parameter or positional expansion a
 * ban-eligible program's own word carries, its value unknowable from here.
 */
type ReadOnlyFlagFinding =
  | { readonly kind: "banned"; readonly flag: string }
  | { readonly kind: "unreadable"; readonly raw: string }
  | { readonly kind: "unreadable_command"; readonly raw: string }
  | { readonly kind: "unresolved_expansion"; readonly raw: string };

/**
 * The first expansion `raw` — one word exactly as {@link shellWords} read
 * it — carries that this reading cannot resolve: a variable (`$name`), a
 * parameter expansion (`${…}`, any form — a default, a length, a pattern
 * strip, all the same), a positional parameter (`$1`, `$2`, …) or a special
 * one (`$@`, `$*`, `$#`, `$?`, `$$`, `$!`, `$-`), wherever it stands outside
 * a single-quoted span — inside double quotes as much as bare, since only
 * single quotes suppress a shell's own expansion of one. A `$` with nothing
 * after it that would open an expansion is literal, the same as a shell
 * reads it, and is not one; null where `raw` carries no live expansion.
 */
function unresolvedExpansion(raw: string): string | null {
  let quote: "'" | '"' | null = null;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === null && (ch === "'" || ch === '"')) {
      quote = ch;
      i += 1;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      i += 1;
      continue;
    }
    if (ch === "$") {
      const next = raw[i + 1];
      if (next === "{") {
        let end = i + 2;
        while (end < raw.length && raw[end] !== "}") end += 1;
        if (end < raw.length) end += 1;
        return raw.slice(i, end);
      }
      if (next !== undefined && /[A-Za-z_]/.test(next)) {
        let end = i + 1;
        while (end < raw.length && /[A-Za-z0-9_]/.test(raw[end]!)) end += 1;
        return raw.slice(i, end);
      }
      if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
        return raw.slice(i, i + 2);
      }
      // Nothing after `$` opens an expansion — a shell reads it as a plain
      // character, so this does too, and keeps scanning past it.
    }
    i += 1;
  }
  return null;
}

/**
 * The flag {@link READ_ONLY_FLAG_BANS} refuses on `text`, or the first word
 * {@link shellWords} could not resolve, or null where neither applies.
 *
 * An unresolved word refuses the whole command before any flag is matched:
 * nothing here can say it is not one of the flags this table bans, so it is
 * not admitted on the strength of a spelling nothing here can read.
 *
 * `text` is one invocation's own argv — the program and the words after it,
 * with any wrapper, subshell, brace group or assignment prefix already
 * stripped by whatever read `text` out of a segment or a substitution body —
 * never a whole line a wrapper or a nested shell could still be standing in
 * front of.
 */
function bannedReadOnlyFlag(text: string): ReadOnlyFlagFinding | null {
  const words = shellWords(text);
  const unclear = words.find((word) => word.value === null);
  if (unclear !== undefined) return { kind: "unreadable", raw: unclear.raw };
  const program = words[0]?.value;
  if (program === null || program === undefined) return null;
  // A ban-eligible program's own words are read for an expansion nothing
  // here can resolve before any flag is matched — `f=--output=x; git log
  // $f` writes the same as `git log --output=x` does, and no static
  // reading says what `$f` holds — the same refuse-what-is-not-proven-
  // inert rule the flags themselves are held to. A program this table has
  // no entry for (`cat $f`) is left to the runner's own reading, as it is
  // today: this check is this table's own, not a general one.
  if (READ_ONLY_FLAG_BANS.some((ban) => ban.program === program)) {
    for (const word of words) {
      const expansion = unresolvedExpansion(word.raw);
      if (expansion !== null) return { kind: "unresolved_expansion", raw: expansion };
    }
  }
  // git's subcommand stands past its own global options — `-C`, `-c`,
  // `--git-dir` and the rest {@link gitGlobalOptions} reads — never at a
  // fixed word index: `git -C . log --output=x` is `log`, not `.`.
  const subcommand =
    program === "git"
      ? words[gitGlobalOptions(words.map((word) => word.value!)).verbIndex]?.value
      : words[1]?.value;
  for (const ban of READ_ONLY_FLAG_BANS) {
    if (ban.program !== program) continue;
    if (ban.subcommand !== undefined && ban.subcommand !== subcommand) continue;
    for (const word of words) {
      const value = word.value;
      if (value === null) continue;
      if (ban.word !== undefined && (value === ban.word || value.startsWith(`${ban.word}=`))) {
        return { kind: "banned", flag: ban.word };
      }
      if (
        ban.short !== undefined &&
        value.startsWith("-") &&
        !value.startsWith("--") &&
        value.slice(1).includes(ban.short)
      ) {
        return { kind: "banned", flag: `-${ban.short}` };
      }
      if (
        ban.prefixOf !== undefined &&
        value.length >= 3 &&
        value.startsWith("--") &&
        ban.prefixOf.startsWith(value)
      ) {
        return { kind: "banned", flag: ban.prefixOf };
      }
    }
  }
  return null;
}

/**
 * {@link bannedReadOnlyFlag} over `segment`'s own text and over every
 * invocation the runner's command reader found it runs — the wrapper's own
 * line and the line it wraps, a subshell or a brace group already resolved
 * to the line inside it, an assignment prefix already stripped — so `env
 * git log --output=x`, `(git log --output=x)`, `{ git log --output=x; }`
 * and `VAR=1 git log --output=x` are read as `git log --output=x`, the same
 * as the unwrapped form, rather than by `words[0]` of the line as typed,
 * which none of them spell as `git`. A verb the reader itself could not
 * read at all is refused the same way an unresolved quote is, before any
 * invocation is read for a flag: nothing here can say it is not one of the
 * shapes this table bans, so a command nothing here can read is not
 * admitted on the strength of a verb nothing here can see.
 */
function bannedInSegment(segment: CommandSegment): ReadOnlyFlagFinding | null {
  if (segment.unreadablePrograms.length > 0) {
    return { kind: "unreadable_command", raw: segment.unreadablePrograms[0]! };
  }
  // `coproc` runs what follows it — a simple command, a group, or a named
  // group — as a coprocess: a command position the reader's invocations do
  // not carry and the closure count does not reach, since the program is
  // never the segment's own first word. No read-only shape needs one, so
  // the keyword itself is refused wherever a segment leads with it.
  if (shellWords(segment.text)[0]?.value === "coproc") {
    return { kind: "unreadable_command", raw: "coproc" };
  }
  for (const text of [segment.text, ...segment.invocations]) {
    const found = bannedReadOnlyFlag(text);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The body of every `$(…)` and `` `…` `` command substitution in `text`, at
 * every depth a shell would nest one, so each is read the same way a
 * segment itself is — through the runner's own command reader, in
 * {@link bannedInSegment} — over what each of them runs, not only over the
 * command wrapping them:
 * `cat $(git log --output=x)` writes through `git log`, whatever `cat`
 * itself may do with the result — and `cat $(echo $(git log --output=x))`
 * writes through it too, one level further in than the command `cat` wraps.
 * `<(…)` and `>(…)` — process substitution — are read the same way: `cat
 * <(git log --output=x)` writes through `git log` whatever `cat` reads from
 * the file the shell hands it in place of `<(…)`, and `tee >(git log
 * --output=x)` writes through it whatever `tee` copies there. A
 * single-quoted span suppresses every one of these the same as every other
 * expansion, so nothing inside `'…'` is read, at any depth; a double-quoted
 * span does not — only word-splitting and globbing are suppressed there —
 * so `cat "$(git log --output=x)"` is read the same as the unquoted form. A
 * backslash immediately before the `$`, the `<`, the `>` or the backtick
 * that would open one is read, with the character it escapes, as a literal
 * pair by the backslash handling below, so `\$(`, `\<(`, `\>(` and `` \` ``
 * never open one, quoted or not.
 *
 * Each body found is read again for bodies nested inside it, to a fixpoint
 * — `git log --output=x` is read the same in `cat $(git log --output=x)`,
 * `cat $(echo $(git log --output=x))`, or nested ten deep, rather than only
 * at whichever depth a single pass over `text` itself would reach. This
 * terminates on its own, without a depth cap: a body a pass extracts is
 * always strictly shorter than the text that pass read, since it excludes
 * at least the opener that started it and whatever closed it, so recursing
 * into what a pass finds cannot recurse forever.
 *
 * `$(…)`, `<(…)` and `>(…)` are each read by paren depth, tracking the quotes
 * and the backslash escapes inside them exactly as the runner's own
 * `readSubstitution` and bash do: a `)` inside `'…'` or `"…"`, or one written
 * `\)`, is literal and does not close the body, so what this extracts is the
 * body bash runs, not the shorter prefix a bare `)` would end early — the
 * gap that let `cat $(cat \) ; evil.sh)` run `evil.sh` while a reader blind
 * to the `\)` inspected only `cat \` and admitted it (SCP-355). A backtick
 * pair is read to the next backtick, since backticks do not nest. Either
 * left unclosed at the end of `text` is read to the end of `text`, which is
 * conservative rather than a guess at where it meant to close.
 */
function substitutionBodies(text: string): string[] {
  const bodies: string[] = [];
  let quote: "'" | '"' | null = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === null && (ch === "'" || ch === '"')) {
      quote = ch;
      i += 1;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      i += 1;
      continue;
    }
    // `quote` cannot be `'` here: the branch above consumes every character
    // read while it is and loops back before falling through, so an opener
    // reached below is already outside a single-quoted span, open, or
    // inside a double-quoted one.
    if ((ch === "$" || ch === "<" || ch === ">") && text[i + 1] === "(") {
      let depth = 1;
      let inner: "'" | '"' | null = null;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        const cj = text[j]!;
        if (inner !== null) {
          if (cj === "\\" && inner === '"') j += 1;
          else if (cj === inner) inner = null;
        } else if (cj === "\\") {
          // A `\)` is a literal paren, not a close — the same rule bash and the
          // runner's `readSubstitution` follow, and the one a bare paren count
          // misses (SCP-355). Skip the escaped character so it decrements
          // nothing and stands in no quote.
          j += 1;
        } else if (cj === "'" || cj === '"') {
          inner = cj;
        } else if (cj === "(") {
          depth += 1;
        } else if (cj === ")") {
          depth -= 1;
        }
        if (depth > 0) j += 1;
      }
      bodies.push(text.slice(i + 2, j));
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      // The close is the next backtick that is not itself escaped. Inside a
      // backtick substitution bash reads `\`` as an escaped backtick opening a
      // nested one, not as the close, so a bare `indexOf` ends the body at the
      // first `\`` and never sees the nested command — the gap that let
      // `` cat `cat \`evil.sh\`` `` run `evil.sh` while the guard read only
      // `` `cat \` `` (SCP-355, the adversarial round). One level of that
      // escaping is undone here — `\``, `\\` and `\$` lose their backslash, as
      // bash does descending a level — so the body pushed is the one bash runs,
      // and the fixpoint below reads the now-unescaped nested backtick as a body
      // of its own, where the nested command stands as its own segment.
      let j = i + 1;
      while (j < text.length && text[j] !== "`") {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      bodies.push(text.slice(i + 1, j).replace(/\\([`\\$])/g, "$1"));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  for (const body of [...bodies]) bodies.push(...substitutionBodies(body));
  return bodies;
}

/**
 * The body of every unquoted `<<WORD`/`<<-WORD` here-document `text`
 * redirects into a command's stdin — a shell expands `$(…)`, `` `…` `` and
 * `$var` in one of these exactly as it would anywhere else on the line, so a
 * substitution written inside one still runs.
 *
 * Read by the runner's own {@link expandableHeredocBodies}, not a reader of
 * this file's own: the runner takes every `<<` a line opens in order, so two
 * on one line (`cat <<A <<B`) each take their body in turn and the second is
 * read as well as the first — the gap a reader that stopped at the first here-
 * document left, where a substitution in the second body ran unseen (SCP-355,
 * the adversarial round). A quoted delimiter (`<<'E'`, `<<"E"`, `<<\E`) makes
 * its body literal and is left out there. `commandSegments`/
 * `inspectCommandWithCwd` drop a here-document's body entirely once they read
 * it — it is stdin content for whichever command the redirect names, never
 * part of any segment's own text — so this reads `text`, the same raw string
 * {@link judgeInterviewCall} was handed, before that segmentation runs.
 */
function hereDocBodies(text: string): string[] {
  return expandableHeredocBodies(text);
}

/**
 * Every command-substitution body reachable from `text` by way of an
 * unquoted here-document — one written directly in `text`, or one written
 * inside a substitution body `text` itself carries, since a substitution's
 * raw text keeps whatever a here-document inside it read, unlike `text`
 * itself, which the runner's own segmentation may already have dropped it
 * from by the time this is called. A here-document's own body is never
 * judged directly — it is stdin content for whichever command the redirect
 * names, not a command line this session runs — only what it expands into
 * is read for what it runs, recursively: that substitution's own command
 * may carry a further here-document, and that here-document's body may
 * carry a further substitution.
 *
 * Ends on its own, without a depth cap: a here-document body
 * {@link hereDocBodies} finds is always strictly shorter than the text it
 * read — it excludes at least the `<<WORD` line and the terminator line —
 * so each recursive call has strictly less text left to search.
 */
function hereDocReachableBodies(text: string): string[] {
  const found: string[] = [];
  for (const candidate of [text, ...substitutionBodies(text)]) {
    for (const doc of hereDocBodies(candidate)) {
      found.push(...substitutionBodies(doc), ...hereDocReachableBodies(doc));
    }
  }
  return found;
}

/**
 * Every text this guard reads a command's words out of, reachable from
 * `text` — `text` itself, every command-substitution and process-
 * substitution body {@link substitutionBodies} finds at every depth, and
 * every unquoted here-document body {@link hereDocBodies} finds, at
 * whatever depth either can carry the other to. What
 * {@link firstWordOccurrences} and {@link judgedInvocations} each count
 * over, for a backstop that does not need its own model of a construct —
 * `until`, `eval`, a function call, `!`, `time`, a keyword this file names
 * nowhere else — to say a program's name stood somewhere this reading
 * never invocation-judged.
 */
function everyReadText(text: string): string[] {
  const subs = substitutionBodies(text);
  const docs: string[] = [];
  for (const candidate of [text, ...subs]) {
    for (const doc of hereDocBodies(candidate)) {
      docs.push(doc, ...everyReadText(doc));
    }
  }
  return [text, ...subs, ...docs];
}

/**
 * How many times `name` — one of {@link READ_ONLY_FLAG_BANS}'s own programs
 * — stands as the first shell word of a text {@link everyReadText} reaches
 * from `command`, counted once per text it heads.
 *
 * Only the first word, never an argument elsewhere on the same line: that
 * is the one place {@link bannedReadOnlyFlag} itself reads a program from,
 * so counting only there is what keeps `grep 'git' file`'s `file` and
 * `echo "$file"`'s variable from counting as one — this backstop does not
 * need its own idea of a program's own argument shape to leave those alone,
 * because it never looks at an argument position at all. A bare here-
 * document body counts the same as any other text: nothing elsewhere
 * invocation-judges it directly (SCP-355, round five), so a program name
 * heading one — `cat`'s stdin, never executed — reads as unaccounted here
 * and is refused, over-refusal accepted the same as everywhere else in this
 * file, rather than this backstop trusting that a here-document only ever
 * feeds a command that does not run what it reads.
 */
function firstWordOccurrences(command: string, name: string): number {
  let count = 0;
  for (const text of everyReadText(command)) {
    if (shellWords(text)[0]?.value === name) count += 1;
  }
  return count;
}

/**
 * Every text `bannedInSegment` is actually called over, reachable from
 * `text` — `text` itself, every command-substitution and process-
 * substitution body, and every substitution reached through an unquoted
 * here-document. Not a here-document's own body: nothing calls
 * `bannedInSegment` on that directly (SCP-355, round five — it is stdin
 * content, not a command line this session runs, so only what it expands
 * into is judged), which is exactly the gap {@link firstWordOccurrences}
 * counting it anyway, against nothing judging it, is meant to catch.
 */
function everyJudgedText(text: string): string[] {
  return [text, ...substitutionBodies(text), ...hereDocReachableBodies(text)];
}

/**
 * How many invocations of `name` the runner's own reader found across every
 * text {@link everyJudgedText} reaches from `command` — the same texts
 * {@link bannedInSegment} is actually called over, counted so
 * {@link firstWordOccurrences} — which counts a wider set, including a
 * here-document's own body — has something meaningful to be checked
 * against.
 */
function judgedInvocations(command: string, name: string, scope: WorktreeScope): number {
  let count = 0;
  for (const text of everyJudgedText(command)) {
    for (const segment of inspectCommandWithCwd(text, scope).segments) {
      count += segment.programs.filter((program) => program === name).length;
    }
  }
  return count;
}

/**
 * The two sessions the interview runs on, spelled as `perbo agent` spells
 * them: the person's own Claude Code through the Claude Agent SDK, and their
 * own Codex through `codex app-server` (D-102).
 */
export const INTERVIEW_PROVIDERS = ["claude", "codex"] as const;
export type InterviewProvider = (typeof INTERVIEW_PROVIDERS)[number];

export interface InterviewArgs {
  repo: string;
  store: string | null;
  /** The spec folder this interview writes, repository-relative. */
  spec: string | null;
  /** A session to continue. */
  session: string | null;
  model: string | null;
  provider: InterviewProvider;
}

const INTERVIEW_FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--spec": valueFlag(),
  "--session": valueFlag(),
  "--model": valueFlag(),
  "--provider": valueFlag(),
} satisfies FlagTable;

const INTERVIEW_GRAMMAR: Grammar<typeof INTERVIEW_FLAGS> = {
  command: "interview",
  flags: INTERVIEW_FLAGS,
  positionals: {
    min: 0,
    max: 0,
    refusal:
      "interview takes no positional argument: the spec folder it writes is --spec, " +
      "e.g. perbo interview --spec specs/<slug>",
  },
  afterDoubleDash: "positionals",
};

/**
 * The three places this session may write, as globs relative to the repository.
 *
 * The spec folder here is this interview's own piece of work, not the folder
 * every spec sits in: a session about one piece of work has no business
 * rewriting the statement of another, and the ticket drafted from that other
 * spec is judged against it.
 */
export function interviewWritePaths(input: { workFolder: string; adrFolder: string }): string[] {
  return [`${input.workFolder}/**`, "CONTEXT.md", `${input.adrFolder}/**`];
}

/**
 * The guard state the interview judges its own calls against.
 *
 * The runner's guard, with the interview's boundary in place of an attempt's:
 * the root is the primary checkout rather than a worktree, the allowed globs
 * are the three places D-102 names, the store is prohibited so a write to the
 * ticket record is refused as the prohibition it is rather than as an
 * unadmitted path, and the spec folders are writable because writing one is
 * what this session is for — bounded to this piece of work's own folder by the
 * allowed globs.
 */
export function interviewGuardState(input: {
  repositoryRoot: string;
  /** The store, repository-relative: the ticket record this session may not write. */
  storeFolder: string;
  /** Where every spec lives, which the standing prohibition is stated over. */
  specFolder: string;
  /** This interview's own spec folder, the only one it writes. */
  workFolder: string;
  adrFolder: string;
}): PreToolGuardState {
  return {
    root: resolve(input.repositoryRoot),
    tmpdir: null,
    cwd: resolve(input.repositoryRoot),
    paths_allowed: interviewWritePaths(input),
    paths_prohibited: [`${input.storeFolder}/**`],
    spec_folder: input.specFolder,
    spec_folder_writable: true,
    allow_list: [...INTERVIEW_READ_ONLY_COMMANDS],
    // The command deny-list, which is about shell lines. The subagent tool is
    // not on it: the guard refuses that call on the role it names, and a
    // deny-list entry no branch consults would describe a judgement that does
    // not happen.
    deny_list: [...DEFAULT_COMMAND_DENY_LIST],
  };
}

/** What the interview decided about one call, and where it leaves the shell. */
export interface InterviewJudgement {
  allow: boolean;
  /** The rule that refused it, or null on an admitted call. */
  rule: AdmissionRule | null;
  target: string | null;
  reason: string | null;
  next_cwd: string;
}

const ALLOWED = (cwd: string): InterviewJudgement => ({
  allow: true,
  rule: null,
  target: null,
  reason: null,
  next_cwd: cwd,
});

/**
 * Whether the session may make this call (D-102).
 *
 * Pure: it reads the state and answers, and the caller is what writes anything
 * down. Three kinds of call reach it.
 *
 * A **read** — `Read`, `Glob`, `Grep` — is admitted anywhere, which is what
 * "may read anything" means.
 *
 * A **write** goes through the runner's own guard, which resolves the path the
 * way the kernel does and refuses one outside the three allowed globs, one
 * inside the store, and one that leaves the checkout.
 *
 * A **command** goes through the same guard for the deny-list and for where its
 * writes land, and then through this session's own read-only list. The runner
 * stops short of refusing a command for being absent from a list, because in an
 * attempt the agent's own permission layer decides those. Here there is no such
 * layer — the session never prompts — so the interview is that layer, and a
 * command outside the read-only shapes is refused under the same rule the
 * runner records when an agent's layer refuses one.
 */
export function judgeInterviewCall(
  call: { tool_name: string; tool_input?: Record<string, unknown> },
  state: PreToolGuardState,
  at: Date = new Date(),
): InterviewJudgement {
  const tool = call.tool_name;
  if (tool.startsWith(`mcp__${INTERVIEW_SERVER_NAME}__`)) {
    const name = tool.slice(`mcp__${INTERVIEW_SERVER_NAME}__`.length);
    return (INTERVIEW_TOOL_NAMES as readonly string[]).includes(name)
      ? ALLOWED(state.cwd)
      : refusal(tool, `the interview holds no ${name} tool`, state.cwd);
  }
  if (!(INTERVIEW_AGENT_TOOLS as readonly string[]).includes(tool)) {
    return refusal(
      tool,
      `the interview holds no ${tool}: it reads, runs read-only commands, and writes the spec ` +
        "folder, CONTEXT.md and the ADR folder",
      state.cwd,
    );
  }
  if (tool === "Read" || tool === "Glob" || tool === "Grep") return ALLOWED(state.cwd);

  if (tool === "Bash") {
    const command = typeof call.tool_input?.command === "string" ? call.tool_input.command : "";
    // A call carrying no command is refused rather than admitted, for the same
    // reason a file tool naming no path is: there is nothing to inspect, so
    // nothing that could have been admitted. An empty line has no segment
    // carrying a program, so the allow-list below would find none to object to
    // and let it through — and on a transport that asks before it acts, the
    // approval it is asking about is a command this client never saw.
    if (command.trim().length === 0) {
      return refusal(tool, `${tool} named no command to run`, state.cwd);
    }
    // The same scope a substitution body is read against below: a body runs
    // in the shell this command's own segments do, so it is read against the
    // same worktree, directory and paths.
    const scope = {
      root: state.root,
      cwd: state.cwd,
      paths_allowed: state.paths_allowed,
      paths_prohibited: state.paths_prohibited,
      spec_folder: state.spec_folder ?? null,
      spec_folder_writable: state.spec_folder_writable === true,
    };
    const { admission, inspection } = judgeCommand({
      tool,
      detail: command,
      allow_list: state.allow_list,
      deny_list: state.deny_list,
      scope,
    });
    if (admission.decision === "denied") {
      return {
        allow: false,
        rule: admission.rule,
        target: admission.target,
        reason: admission.reason,
        next_cwd: state.cwd,
      };
    }
    // One gate for every command this line runs, wherever it stands: a
    // segment of the line itself, or a segment of a body the line carries.
    //
    // A segment stands as a read-only shape only where the line as written
    // matches the allow-list *and* every command the runner found it runs
    // does too. The line's own text is not enough on its own: a function body
    // (`cat () { evil.sh; }; cat`) or an assignment-prefixed command
    // (`cat=1 program`) matches the list on its first word while naming a
    // second program past it that the list never admits, and the runner
    // surfaces that program as one of the segment's `invocations` — so each of
    // those is held to the list too, the same reading the runner's own
    // list-matching gives them. A segment that runs no program of its own but
    // is a bare environment assignment (`PATH=/tmp/evil; ls`, `IFS=…`) is
    // refused as well: setting the environment the commands after it resolve
    // and run in is not a read-only shape, and a listed command downstream of
    // one is no longer only what its own words say.
    const listed = (text: string): boolean =>
      state.allow_list.some((entry) => matchesListEntry(entry, "Bash", text));
    const leadingAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
    const unlistedAmong = (segments: readonly CommandSegment[]): CommandSegment | undefined =>
      segments.find((segment) => {
        if (segment.programs.length === 0) {
          const first = shellWords(segment.text)[0]?.value;
          return first != null && leadingAssignment.test(first);
        }
        return !listed(segment.text) || segment.invocations.some((invocation) => !listed(invocation));
      });
    const refuseUnlisted = (unlisted: CommandSegment): InterviewJudgement => ({
      allow: false,
      rule: ADMISSION_RULES.allow_list,
      target: unlisted.text.slice(0, 200),
      reason:
        `${unlisted.text.slice(0, 200)} is not one of the read-only shapes this session may run: ` +
        INTERVIEW_READ_ONLY_COMMANDS.join(", "),
      next_cwd: state.cwd,
    });
    const unlisted = unlistedAmong(inspection.segments);
    if (unlisted !== undefined) return refuseUnlisted(unlisted);
    // A finding refused the same way wherever it came from, named against
    // `target` — the shape a person reads back is the command line the
    // finding is about (a segment's own text, or the whole raw command for
    // one reached only through a here-document), not whichever invocation
    // or nested body actually carried it.
    const refuseOn = (target: string, found: ReadOnlyFlagFinding): InterviewJudgement => {
      const named = found.kind === "banned" ? found.flag : found.raw;
      const why =
        found.kind === "banned"
          ? "it writes, or it runs a program"
          : found.kind === "unreadable"
            ? "its quoting is not one this reading resolves"
            : found.kind === "unreadable_command"
              ? "its command is not one this reading resolves"
              : "its value is not one this reading resolves";
      return {
        allow: false,
        rule: ADMISSION_RULES.allow_list,
        target: target.slice(0, 200),
        reason:
          `\`${named}\` on ${target.slice(0, 200)} is not one of the read-only shapes ` +
          `this session may run: ${why}`,
        next_cwd: state.cwd,
      };
    };
    for (const segment of inspection.segments) {
      const found = bannedInSegment(segment);
      if (found !== null) return refuseOn(segment.text, found);
      // Every substitution this segment carries, at every depth a shell
      // would nest one, read the same way the segment itself was: through
      // the runner's own command reader, invocation by invocation — `cat
      // "$(env git log --output=x)"` writes through `git log` whatever
      // `cat` and `env` do with the answer, and neither the read-only
      // list's own prefix match nor a check keyed on the body's first word
      // sees past either of them to it. A body is held to the read-only
      // shapes exactly as the line is: what a shell runs inside `$(…)`, a
      // backtick pair or `<(…)` is a command like any other, and the
      // runner's own reading of what a line writes is a list of writers it
      // knows, never a bound on which programs may run — `cat "$(evil.sh)"`
      // and `cat "$(git rm -f x)"` name no writer it knows.
      for (const body of substitutionBodies(segment.text)) {
        const bodySegments = inspectCommandWithCwd(body, scope).segments;
        const unlistedInBody = unlistedAmong(bodySegments);
        if (unlistedInBody !== undefined) return refuseUnlisted(unlistedInBody);
        for (const bodySegment of bodySegments) {
          const foundInBody = bannedInSegment(bodySegment);
          if (foundInBody !== null) return refuseOn(segment.text, foundInBody);
        }
      }
    }
    // A here-document's body is stdin content, never part of any segment's
    // own text — the runner's own reader drops it entirely once it reads a
    // line, whether the here-document stands on the command directly or
    // inside a substitution some segment carries — so it is read from
    // `command` itself, before that reading ever ran: an unquoted
    // delimiter's own expansion carries a substitution the same way one
    // written anywhere else on the line does.
    for (const body of hereDocReachableBodies(command)) {
      const docSegments = inspectCommandWithCwd(body, scope).segments;
      const unlistedInDoc = unlistedAmong(docSegments);
      if (unlistedInDoc !== undefined) return refuseUnlisted(unlistedInDoc);
      for (const bodySegment of docSegments) {
        const foundInDoc = bannedInSegment(bodySegment);
        if (foundInDoc !== null) return refuseOn(command, foundInDoc);
      }
    }
    // A closure backstop for what no construct above specifically models —
    // an eval argument, a keyword the runner's reader does not resolve, a
    // function named after a program, `!` or `time` in a shape it does not
    // account for. Every invocation already judged said which programs
    // this reading found; if one of this table's own programs stands as
    // the first word of some text this reading reached more times than it
    // was ever counted among those invocations, something ran a shape
    // nothing here modelled, and the line is refused as unreadable rather
    // than trusted on the strength of a construct this file does not name.
    for (const name of banEligiblePrograms) {
      if (firstWordOccurrences(command, name) > judgedInvocations(command, name, scope)) {
        return {
          allow: false,
          rule: ADMISSION_RULES.allow_list,
          target: command.slice(0, 200),
          reason:
            `\`${name}\` on ${command.slice(0, 200)} is not one of the read-only shapes this ` +
            "session may run: this reading did not resolve where it runs",
          next_cwd: state.cwd,
        };
      }
    }
    return {
      ...ALLOWED(state.cwd),
      next_cwd: inspection.cwd.unknown ? UNKNOWN_CWD : (inspection.cwd.path ?? state.root),
    };
  }

  // A file tool: the runner's guard resolves the path it names and refuses one
  // the three globs do not admit. Its third answer, `defer`, means it found
  // nothing to refuse — in an attempt the agent's own layer then decides, and
  // here that is an admission, because the path is inside what D-102 allows.
  // A call naming no path at all is refused rather than deferred: there is
  // nothing for the guard to resolve, so nothing it could have admitted.
  if (filePathOf(call.tool_input ?? {}) === null) {
    return refusal(tool, `${tool} named no file to write`, state.cwd);
  }
  const judged = judgePreToolCall(
    { tool_name: tool, tool_input: call.tool_input ?? {} },
    state,
    at,
  );
  if (judged.decision.answer !== "deny") return ALLOWED(state.cwd);
  return {
    allow: false,
    rule: judged.decision.rule,
    target: judged.decision.target,
    reason: judged.decision.reason,
    next_cwd: state.cwd,
  };
}

const refusal = (tool: string, reason: string, cwd: string): InterviewJudgement => ({
  allow: false,
  rule: ADMISSION_RULES.allow_list,
  target: tool,
  reason,
  next_cwd: cwd,
});

/** What the interview answers one call with. Allow or deny, never a question. */
export type InterviewPermission =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/**
 * The permission seam, with the state one session accumulates behind it: where
 * the shell stands, and what the spec said when this session started.
 *
 * The folder a `Write` lands in is created here, once the write is admitted,
 * so the first write to the ADR folder or the spec folder lands (SCP-311
 * criterion 7); a read makes nothing, wherever it looks.
 *
 * Whether the spec has been brought up to date is read from the file rather
 * than from the calls: this runs *before* a tool does, so a call admitted here
 * is one that was allowed to write, not one that wrote — an `Edit` whose
 * `old_string` is absent is admitted and then fails. What the drafter needs to
 * know is that the spec moved, which only the bytes can say.
 */
export function interviewPermission(input: {
  state: PreToolGuardState;
  /** The spec this interview writes, absolute. */
  specPath: string;
  emit: (event: InterviewEvent) => void;
  /** Where a refusal is said to the person, beside the event a host reads. */
  say: (line: string) => void;
}): {
  canUseTool: (
    tool: string,
    toolInput: Record<string, unknown>,
    /** Where the call runs, from a transport that carries it on the call. */
    cwd?: string,
  ) => Promise<InterviewPermission>;
  /** Whether the spec has changed since this session last took it: at its start, or at the last draft. */
  specWritten: () => boolean;
  /** Take the spec as it now stands, once a draft has been made from it. */
  specTaken: () => void;
} {
  const state = { ...input.state };
  /** The spec's bytes as this session found them, or null where it has none. */
  const read = (): string | null => {
    try {
      return createHash("sha256").update(readFileSync(input.specPath)).digest("hex");
    } catch {
      return null;
    }
  };
  let taken = read();
  return {
    specWritten: () => read() !== taken,
    specTaken: () => {
      taken = read();
    },
    canUseTool: async (tool, toolInput, cwd) => {
      // A transport whose calls carry the directory they run in is the
      // authority on it; the state kept here is for the one whose calls do
      // not, where a shell that moves has to be followed from call to call.
      const judged = judgeInterviewCall(
        { tool_name: tool, tool_input: toolInput },
        cwd === undefined ? state : { ...state, cwd: resolve(state.root, cwd) },
        new Date(),
      );
      if (cwd === undefined) state.cwd = judged.next_cwd;
      if (!judged.allow) {
        const reason = judged.reason ?? "refused by the interview's write guard";
        input.emit({
          type: "refused",
          tool,
          rule: judged.rule ?? ADMISSION_RULES.allow_list,
          target: judged.target,
          reason,
        });
        input.say(`refused: ${tool} — ${reason}\n`);
        return { behavior: "deny", message: judged.reason ?? "refused" };
      }
      // Only a `Write` may land in a folder that is not there; `Edit` and
      // `MultiEdit` change a file that already is, and a read makes nothing.
      const path = tool === "Write" ? filePathOf(toolInput) : null;
      if (path !== null) {
        mkdirSync(dirname(isAbsolute(path) ? path : resolve(state.root, path)), { recursive: true });
      }
      return { behavior: "allow", updatedInput: toolInput };
    },
  };
}

/** The path a file tool names, under whichever key that tool uses. */
function filePathOf(toolInput: Record<string, unknown>): string | null {
  for (const name of ["file_path", "notebook_path"]) {
    const value = toolInput[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** One result, in the shape an MCP tool returns. */
export interface InterviewToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /**
   * Questions to put to the person, emitted as their own line beside the
   * tool's card. A tool returns to the model rather than waiting on a person,
   * so this says them and the answers arrive as an ordinary turn.
   */
  asks?: readonly InterviewQuestionGroup[];
}

const said = (text: string, isError = false): InterviewToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/** What the interview's tools are given: the checkout, the store and the spec. */
export interface InterviewContext {
  cwd: string;
  repo: string;
  store: string | null;
  repositoryRoot: string;
  storeDirectory: string;
  /** The spec this interview writes, repository-relative with forward slashes. */
  spec: string;
  /** Whether the session has written the spec since the last draft. */
  specWritten: () => boolean;
  specTaken: () => void;
  /**
   * How many groups of questions stand in front of the person unanswered.
   *
   * Set when `ask_options` puts them and cleared by the person's next turn,
   * which is how an answer arrives (D-117). Nothing waits on it — the tool
   * asks and returns — so without this a session can ask and draft in the one
   * breath, which is drafting around its own guess at the answer.
   */
  asking: () => number;
  /** The drafting model, injected by a test. Otherwise `admit`'s own. */
  model?: Model | undefined;
}

export interface InterviewTool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /**
   * The fields, as each transport advertises them to the model. What
   * checks a call is `input` below, which also carries the rules a shape
   * cannot state.
   */
  shape: z.ZodRawShape;
  input: Input;
  run(input: z.infer<Input>, context: InterviewContext): Promise<InterviewToolResult>;
}

const tool = <Input extends z.ZodType>(definition: InterviewTool<Input>): InterviewTool =>
  definition as unknown as InterviewTool;

/** Run one command with its writes collected, and say what it wrote. */
async function captured(
  command: (streams: Streams) => number | Promise<number>,
): Promise<{ code: number; text: string }> {
  const collected = collectOutput();
  try {
    const code = await command(collected.streams);
    return { code, text: wrote(collected.stdout(), collected.stderr()) };
  } catch (error) {
    return {
      code: EXIT_CODES.did_not_complete,
      text: error instanceof Error ? error.message : String(error),
    };
  }
}

/** What a command wrote, as a session reads it: the record, then what was said beside it. */
const wrote = (stdout: string, stderr: string): string =>
  [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");

/** The ticket this spec was last drafted into, if one is still open to re-drafting. */
function ticketFromSpec(context: InterviewContext): string | null {
  return draftedFromSpec(context)?.open ?? null;
}

/**
 * The ticket this spec was drafted into, and whether it is still open to a
 * change, or null where the spec has never been drafted.
 *
 * The two are separated because they read differently to a person: a plan that
 * does not exist yet is written by generating one, and a plan that has been
 * approved is immutable (ADR-0016) and saying nothing was drafted would be
 * false. Where two tickets record one spec and neither is open — which nothing
 * admits any more, `admit --from-spec` refusing a second beside a live one, but
 * which a store written before it did may hold — the oldest is taken,
 * `listTickets` being in admission order.
 */
function draftedFromSpec(
  context: InterviewContext,
): { key: string; state: string; open: string | null } | null {
  if (!existsSync(join(context.storeDirectory, "tickets"))) return null;
  const found = listTickets(context.storeDirectory).filter(
    (ticket) => ticket.admission.spec?.path === context.spec,
  );
  const open = found.find((ticket) => ticket.state === "plan_review");
  if (open) return { key: open.key, state: open.state, open: open.key };
  const first = found[0];
  return first ? { key: first.key, state: first.state, open: null } : null;
}

/** What to say where this spec has never been drafted into a plan. */
function noPlanToChange(context: InterviewContext, verb: string): string {
  return (
    `no ticket has been drafted from ${context.spec} yet, so there is no plan to ${verb}. ` +
    "Write the spec and call generate_plan first"
  );
}

const generatePlan = tool({
  name: "generate_plan",
  description:
    "Draft the plan from the spec. Write spec.md first, bringing it up to date with this " +
    "conversation; this then drafts one ticket from it in plan_review, re-drafting the ticket " +
    "already drafted from this spec while that ticket is still in plan_review and refusing, " +
    "rather than admitting a second from one spec, once it is not. Refused while a group of " +
    "questions stands unanswered, since their answer may change the spec. It cannot approve.",
  shape: {},
  input: z.strictObject({}),
  run: async (_input, context) => {
    // A group still in front of them is a question this plan would be drafted
    // around the guess at. Their answer is their next turn, so this is refused
    // until one arrives — the answer may change the spec this drafts from.
    const open = context.asking();
    if (open > 0) {
      return said(
        `${open === 1 ? "A group of questions is" : `${String(open)} groups of questions are`} ` +
          "in front of the person and unanswered. Wait for their turn: what they say may change " +
          "the spec this would draft from, and a plan drafted first is drafted around your own " +
          "guess at their answer. Say nothing further until they have answered",
        true,
      );
    }
    if (!context.specWritten()) {
      return said(
        `${context.spec} is as this session last saw it. Bring the spec up to date with the ` +
          "conversation first — its Outcome, Requirements, No-Gos, Rabbit holes and Notes — then " +
          "generate the plan from it. A tool that was refused, or that failed, or that wrote what " +
          "was already there, changed nothing",
        true,
      );
    }
    const drafted = draftedFromSpec(context);
    if (drafted !== null && drafted.open === null) {
      return said(
        `${drafted.key} was drafted from ${context.spec} and is ${drafted.state}, and only a ` +
          "ticket in plan_review may be re-drafted from its spec, so drafting again would admit " +
          "a second ticket from one spec. read_plan reads the plan it has, and an order between " +
          "its nodes may still change",
        true,
      );
    }
    const startOver = drafted?.open ?? null;
    // Built as values: nothing a model returned is parsed as a flag (ADR-0023
    // §4). A draft has no `approve` among its fields, so there is no approving
    // to reach from here — this session prepares, the person approves (D-072).
    const collected = collectOutput();
    let report: AdmissionReport;
    try {
      report = await admitDraft(
        {
          ...defaultAdmission({ repo: context.repo, store: context.store }),
          fromSpec: join(context.repositoryRoot, context.spec),
          startOver,
        },
        {
          cwd: context.cwd,
          now: new Date(),
          diagnostics: collected.streams,
          ...(context.model === undefined ? {} : { model: context.model }),
        },
      );
    } catch (error) {
      return said(withoutNextStep(error instanceof Error ? error.message : String(error)), true);
    }
    const rendered = admitDraftReport.render(
      report,
      { json: false },
      { isTTY: false, color: false, json: false },
    );
    const text = wrote(
      collected.stdout() + rendered.stdout,
      collected.stderr() + rendered.stderr,
    );
    context.specTaken();
    const key = startOver ?? ticketFromSpec(context) ?? "the ticket";
    return said(
      `${startOver === null ? "admitted" : "re-drafted"} ${key} in plan_review from ${context.spec}. ` +
        `A person reads and approves it; this session cannot.\n${withoutNextStep(text)}`,
    );
  },
});

/**
 * One graph edit, or one whole-field edit. Both go through `perbo edit`'s own
 * path, which validates the result whole and records what it changed so it can
 * be undone (D-100).
 */
const EditPlanShape = {
  graph_edit: GraphEditSchema.optional().describe("One graph edit: add_node, add_edge, and the rest."),
  outcome: z.string().min(1).optional(),
  criteria: z
    .array(z.string().min(1))
    .optional()
    .describe('Replaces the criteria: "what must be proven :: the assertion that proves it".'),
  paths: z.array(z.string().min(1)).optional().describe("Replaces the globs the change may touch."),
};

const EditPlanInputSchema = z
  .strictObject(EditPlanShape)
  .refine(
    (input) =>
      (input.graph_edit === undefined) !==
      (input.outcome === undefined && (input.criteria?.length ?? 0) === 0 && (input.paths?.length ?? 0) === 0),
    "name either one graph_edit or one of outcome, criteria and paths: edit applies one edit at a time",
  );

const editPlan = tool({
  name: "edit_plan",
  description:
    "Change the plan drafted from this spec, through the one validated edit path, recorded as the " +
    "interview's and undoable. One edit at a time: a graph edit, or new outcome, criteria or " +
    "scope. Once the plan is approved the order between its nodes may still change and its " +
    "contract may not, and the edit path is what says so.",
  shape: EditPlanShape,
  input: EditPlanInputSchema,
  run: (input, context) =>
    applyEdit(context, {
      graphEdit: input.graph_edit === undefined ? null : JSON.stringify(input.graph_edit),
      outcome: input.outcome ?? null,
      criteria: [...(input.criteria ?? [])],
      paths: [...(input.paths ?? [])],
      undo: null,
    }),
});

const undoEdit = tool({
  name: "undo_edit",
  description:
    "Undo one recorded edit by its number. Refused where a later edit still in force changed the " +
    "same node, edge or criterion (D-100).",
  shape: { edit: z.number().int().min(1) },
  input: z.strictObject({ edit: z.number().int().min(1) }),
  run: (input, context) =>
    applyEdit(context, {
      graphEdit: null,
      outcome: null,
      criteria: [],
      paths: [],
      undo: input.edit,
    }),
});

/**
 * One edit through `perbo edit`, on the plan drafted from this interview's own
 * spec, with the before and after it recorded.
 *
 * The ticket is derived rather than named: a key is a value a model returns,
 * and a tool that took one would let a session about one piece of work edit
 * another's plan (ADR-0023, D-102). There is one plan an interview may change
 * and it is the one its spec was drafted into.
 */
async function applyEdit(
  context: InterviewContext,
  change: Partial<Pick<EditInput, "graphEdit" | "outcome" | "criteria" | "paths" | "undo">>,
): Promise<InterviewToolResult> {
  // Whatever state it is in: an approved plan's order may still change and its
  // contract may not, and `perbo edit` is what holds that line (ADR-0016).
  // Deciding it here as well would make this session stricter than the command
  // it runs, and would answer with a second account of the same rule.
  const key = draftedFromSpec(context)?.key ?? null;
  if (key === null) return said(noPlanToChange(context, "change"), true);
  const input: EditInput = {
    target: { repo: context.repo, store: context.store },
    key,
    outcome: change.outcome ?? null,
    criteria: change.criteria ?? [],
    paths: change.paths ?? [],
    graphEdit: change.graphEdit ?? null,
    undo: change.undo ?? null,
    // A prohibited path is the person's own mark in the explorer (D-105), and
    // a manual reviewer is their own choice: neither is a field this sets.
    prohibited: [],
    clearProhibited: false,
    manualReviewer: null,
    manualReason: null,
    author: INTERVIEW_AUTHOR,
  };
  // No editor can be reached: every field the interactive path needs is given,
  // and the environment handed in names none.
  const ran = await captured((streams) =>
    edit(
      input,
      { json: false },
      {
        cwd: context.cwd,
        now: new Date(),
        diagnostics: streams,
        stdout: streams.stdout,
        isTTY: streams.isTTY,
        env: {},
      },
    ),
  );
  if (ran.code !== EXIT_CODES.approve) return said(withoutNextStep(ran.text), true);
  const snapshot = readDraftSnapshot(context.storeDirectory, key);
  const entry = snapshot?.edits.at(-1);
  return said(
    `${key}: edit ${snapshot?.edits.length ?? 0}${entry?.summary ? ` — ${entry.summary}` : ""}\n` +
      JSON.stringify({ before: entry?.before ?? {}, after: entry?.after ?? {} }, null, 2) +
      `\n${withoutNextStep(ran.text)}`,
  );
}

const readPlan = tool({
  name: "read_plan",
  description:
    "The plan drafted from this spec as it stands: its contract, its graph and the order between " +
    "its nodes, its size, and every edit made to it with its author.",
  shape: {},
  input: z.strictObject({}),
  run: async (_input, context) => {
    // Read whatever this spec was drafted into, approved or not: an approved
    // contract is immutable, not secret, and a session asking what it says is
    // asking the right question.
    const key = draftedFromSpec(context)?.key ?? null;
    if (key === null) return said(noPlanToChange(context, "read"), true);
    const ticket = readTicket(context.storeDirectory, key);
    const contract = readContract(context.storeDirectory, key);
    const nodes = planNodes(contract);
    const approach = readApproachRecord(context.storeDirectory, key, contract);
    const snapshot = readDraftSnapshot(context.storeDirectory, key);
    const size = sizeEstimate(
      planSizeCounts({
        nodes,
        criteria: contract.level === "P0" ? 0 : contract.acceptance_criteria.length,
        paths_allowed: contract.scope.paths_allowed,
        paths_prohibited: contract.scope.paths_prohibited,
        trackedFiles: trackedFiles(context.repositoryRoot),
      }),
    );
    return said(
      JSON.stringify(
        {
          state: ticket.state,
          approved_at: ticket.approved_at,
          contract,
          edges: approach?.edges ?? [],
          no_gos: approach?.no_gos ?? [],
          size,
          edits: (snapshot?.edits ?? []).map((each, index) => ({
            number: index + 1,
            author: each.author,
            summary: each.summary,
            undone: each.undone,
          })),
        },
        null,
        2,
      ),
    );
  },
});

const askOptions = tool({
  name: "ask_options",
  description:
    "Put a question to the person with the answers they can pick from, rather than writing it out in " +
    "prose. Ask what the evidence cannot settle: a question the repository, the spec or what they " +
    "have already said answers is not one to put to them, but one that turns on what they want is " +
    "theirs however obvious your own answer seems, and recording the call you made instead is not " +
    "asking. Being able to ask cheaply is not a reason to ask more. What you do ask, ask in one call: questions whose answers depend on each " +
    "other go in one group as its parts, independent groups go separately, and the person is put one " +
    "group at a time. Every part needs at least two options, and one of them may be marked as your " +
    "recommendation. They can always answer in their own words instead, or leave the choice to you. " +
    "Their answers come back as their next turn, in the options' own words. This asks and returns: " +
    "it does not wait.",
  // The bound belongs in the shape as well as in `input`: on Codex the shape is
  // the whole of what the model is told, and a schema saying the array is
  // unbounded asks it to spend a turn being refused.
  shape: { groups: z.array(InterviewQuestionGroupSchema).min(1).max(MAX_QUESTION_GROUPS) },
  input: z.strictObject({
    groups: z.array(InterviewQuestionGroupSchema).min(1).max(MAX_QUESTION_GROUPS),
  }),
  run: async (input) => {
    const parts = input.groups.reduce((count, group) => count + group.parts.length, 0);
    return {
      ...said(
        `Asked ${parts === 1 ? "one question" : `${parts} questions`} in ` +
          `${input.groups.length === 1 ? "one group" : `${input.groups.length} groups`}. ` +
          "The person is put one group at a time and answers in their own turn; nothing is waited " +
          "for here, so say nothing further until they have answered.",
      ),
      asks: input.groups,
    };
  },
});

/** Every tool the session holds. There is no approve, publish, run or merge. */
export const INTERVIEW_TOOLS: readonly InterviewTool[] = [
  generatePlan,
  editPlan,
  undoEdit,
  readPlan,
  askOptions,
];

/**
 * What the session is told before its first turn, appended to Claude Code's own
 * system prompt as `perbo agent` appends its orientation.
 *
 * The two bundled skills travel in it as text, through the same function the
 * executor's selected skills travel in: fixed, user-selected content that
 * installs no tool and grants no authority.
 */
export function interviewOrientation(input: {
  repositoryRoot: string;
  /** The spec, repository-relative. */
  spec: string;
  /** The ADR folder, repository-relative. */
  adr: string;
}): string {
  const base = `You are interviewing a person about a piece of work in ${input.repositoryRoot}, a repository run by
Perbo (the \`perbo\` command). Your job is to question them until the intent is sharp, and to write it
down: the spec at ${input.spec}, under the headings Outcome, Requirements, No-Gos, Rabbit holes and
Notes, with any terms in CONTEXT.md and any decision that crosses components as an ADR in ${input.adr}.

You may read anything here and run read-only commands. You may write ${input.spec}'s folder, CONTEXT.md
and ${input.adr}, and nothing else: a write anywhere else is refused, not offered to the person, and so is
a command that is not one of the read-only shapes. You will not be asked to confirm anything, so a
refusal is an answer, not a prompt — say what you were refused and carry on.

When the spec states the work, write it and then call generate_plan, which drafts one ticket from it in
plan_review. After that the plan changes only through edit_plan and undo_edit, each change recorded as
yours and undoable, and the spec is brought back into step with it in the same turn. read_plan reads it
back. You cannot approve, publish or merge, and there is no tool for any of the three: prepare the plan
and say what is ready for the person to approve. Never tell them to run a command to do it, and do
not repeat one a tool's report names: you cannot see whether they are at a terminal or in the app,
where approving, editing and running are buttons and nothing is typed. State names, keys and numbers come from the tools,
never from memory.

Write the spec to be read at a glance, because it is read far more often than it is written. One
idea to a line, in the fewest words that still say it: a fragment is a line, and a full sentence is
not required. Where Requirements has enough lines to need grouping, group them under \`###\` headings
— three hashes at least, and only in that section, where they stay headings and the requirements
keep their own ids under them. Mark what matters and
nothing else: \`**bold**\` for the thing a reader must not miss, backticks for a literal, and
@Symbol for code in this repository. The pane draws exactly those, so a mark on an ordinary word
spends a reader's attention on nothing. Say a thing once — a line that repeats its heading, or a
requirement already stated in the Outcome, is a line to cut.

Ask through ask_options rather than writing questions out in prose, and ask only what you cannot
settle from the repository, the spec or what they have already told you: they see only what needs
them. What you do ask goes in the one call — parts whose answers depend on each other in one group,
independent groups separately — and the person is put one group at a time. Their answers come back as
their next turn in the options' own words.

Never settle an open question by drafting your way past it and saying afterwards which way you went.
If the repository, the spec and what they have said do not answer it, it is theirs to answer: put it
through ask_options before you draft, with the answer you would have picked marked as your
recommendation and the one you weighed against it beside it. A line in the spec's Notes recording the
call you made is not asking — they cannot act on it without reading the whole file, and by then the
plan is drafted around it. This is what ask_options is for, and a question asked before drafting
costs a turn where one found afterwards costs the draft.

What you say in the chat is what needs them: a question, or something that needs their word. Not an
account of what you wrote. The spec is on the screen beside this conversation and the plan is a pane
away, both of them better read there than described here, and a summary of them buries the one line
that did need reading. When the spec is written, say so in a sentence. When a plan is drafted, say
that, and what is ready for them to approve, in a sentence.`;
  return withExecutorSkills(base, [...INTERVIEW_SKILLS]).prompt;
}

/** What a session records beside its spec, so planning mode finds it again. */
interface InterviewSessionRecord {
  session_id: string;
  spec: string;
  started_at: string;
  model: string | null;
  /** The provider whose id this is: the two keep separate namespaces. */
  provider: InterviewProvider;
}

/**
 * What a record has to carry for a resumed run to find it: the session it is
 * for, and the provider whose id that is. The folder it sits in says which
 * spec it is about, and the rest of the file is for a reader.
 *
 * The provider is optional because a record written before the interview ran
 * on two of them names no provider, and the only one that could have written
 * it is Claude.
 *
 * Read through a schema rather than cast, because the file is a file: one a
 * person has edited leaves a usage error behind it rather than a stack.
 */
const FoundSessionSchema = z.looseObject({
  session_id: z.string().min(1),
  provider: z.enum(INTERVIEW_PROVIDERS).optional(),
});

/**
 * One tool the session holds, bound to the run that serves it.
 *
 * The binding is the command's: it parses the call against the tool's own
 * schema, runs it over this interview's context and reports what it did on the
 * stream, so a transport hands the arguments over and passes the answer back
 * without reading either.
 */
export interface InterviewBoundTool {
  name: string;
  description: string;
  /** The fields, as each transport advertises them to the model. */
  shape: z.ZodRawShape;
  run(raw: unknown): Promise<InterviewToolResult>;
}

/**
 * One interview, as the transport behind it is asked to run it.
 *
 * The interview's rules are not in here: {@link InterviewSession.decide} is
 * the one seam they are behind, and a transport's own approval question is
 * answered through it rather than put to anybody (D-102).
 */
export interface InterviewSession {
  /** The checkout the session runs in, reads and writes. */
  cwd: string;
  model: string | null;
  /** The session to continue through the transport's own resume, or null. */
  resume: string | null;
  /** What the session is told before its first turn. */
  orientation: string;
  tools: readonly InterviewBoundTool[];
  /**
   * The interview's judgement of one call. Every call a transport can decide
   * goes through this and nothing else, and the answer is allow or deny — never
   * a question.
   */
  decide: (
    tool: string,
    input: Record<string, unknown>,
    /** Where the call runs, where the transport carries it on the call. */
    cwd?: string,
  ) => Promise<InterviewPermission>;
  /** The person's turns, one line of text each. */
  turns: AsyncIterable<string>;
  /** The id this session is running under, once it has one. */
  sessionId: () => string;
  /** Where the transport's own noise goes. */
  stderr: (data: string) => void;
}

/** One thing a transport streamed back. */
export interface InterviewStreamed {
  /** The id the transport gives this session, on every event that carries one. */
  session_id?: string;
  /** A message to pass through on the stream. */
  message?: Record<string, unknown>;
  /** Why the session ended, on the last one. */
  reason?: string;
  /**
   * The provider has finished this turn and the next word is the person's.
   * Each transport knows this in its own terms and says it in this one.
   */
  idle?: boolean;
}

/**
 * The session boundary the two transports sit behind (D-102, SCP-312).
 *
 * What a transport owns is how one provider is asked and what it streams back.
 * What it does not own is what the interview may do: the rules are
 * {@link judgeInterviewCall}'s, the tools are {@link INTERVIEW_TOOLS}, the
 * orientation is {@link interviewOrientation}'s, and the record beside the spec
 * is the command's. So a transport that reports a different id, or refuses a
 * call the rules admit, is the only thing that can differ between them.
 */
export interface InterviewTransport {
  run(session: InterviewSession): AsyncIterable<InterviewStreamed>;
}

/** The three parts of a session a test replaces; production uses the real thing. */
export interface InterviewDeps {
  /** The transport. Otherwise the one `--provider` names. */
  transport: InterviewTransport;
  /** The drafting model `generate_plan` runs the drafter with. */
  model: Model;
  /** The person's turns, one JSON line each. Defaults to stdin. */
  turns: AsyncIterable<string>;
}

/** What a session is given: where it runs, what it says as it goes, and its three parts. */
export type InterviewContextForRun = CommandContext & {
  stdout(chunk: string): void;
  isTTY: boolean;
} & Partial<InterviewDeps>;

/**
 * `perbo interview`, over typed input.
 *
 * It answers while it works — one JSON event a line on stdout, the card and
 * the warnings on stderr — and ends when the person's turns do, so there is no
 * record to hand back.
 */
export async function interview(
  args: InterviewArgs,
  context: InterviewContextForRun,
): Promise<number> {
  const streams = narratedStreams(context);
  const repositoryRoot = resolve(context.cwd, args.repo);
  const storeDirectory = storeDir(repositoryRoot, args.store);
  const specs = specFolder(storeDirectory);
  const adr = adrFolder(storeDirectory);
  const spec = resolveSpec(repositoryRoot, specs, args);
  const emit = (event: InterviewEvent): void => streams.stdout(encodeInterviewEvent(event));

  const permission = interviewPermission({
    state: interviewGuardState({
      repositoryRoot,
      storeFolder: relative(repositoryRoot, storeDirectory).split(sep).join("/"),
      specFolder: specs,
      workFolder: dirname(spec),
      adrFolder: adr,
    }),
    specPath: join(repositoryRoot, spec),
    emit,
    say: (line) => streams.stderr(line),
  });

  // The groups put to the person and not yet answered, in the order they are
  // put. Moved on by the same rule the planning record uses (D-117): a turn
  // that answers the group in front of them drops that one, and a turn that
  // does not — they said something of their own — ends the asking whole, which
  // is what the dock does with the card. Counting turns instead would let the
  // two disagree on every asking that carries more than one group, and a plan
  // would be drafted around a question still on screen.
  let pending: InterviewQuestionGroup[] = [];
  const toolContext: InterviewContext = {
    cwd: context.cwd,
    repo: args.repo,
    store: args.store,
    repositoryRoot,
    storeDirectory,
    spec,
    specWritten: permission.specWritten,
    specTaken: permission.specTaken,
    asking: () => pending.length,
    model: context.model,
  };

  const tools: InterviewBoundTool[] = INTERVIEW_TOOLS.map((each) => ({
    name: each.name,
    description: each.description,
    shape: each.shape,
    run: async (raw: unknown) => {
      const parsed = each.input.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `  ${issue.path.join(".") || "(input)"}: ${issue.message}`)
          .join("\n");
        emit({ type: "tool", tool: each.name, ok: false, detail });
        return said(`${each.name} was called with input it does not take:\n${detail}`, true);
      }
      const result = await each.run(parsed.data, toolContext);
      const detail = result.content.map((part) => part.text).join("\n");
      emit({ type: "tool", tool: each.name, ok: result.isError !== true, detail });
      // The questions are their own line: the card says a tool ran, and what
      // the person answers is put to them beside it.
      if (result.asks !== undefined && result.asks.length > 0) {
        pending = [...pending, ...result.asks];
        emit({ type: "asked", groups: [...result.asks] });
      }
      return result;
    },
  }));

  let sessionId = args.session ?? "";
  let started = false;
  const announce = (id: string): void => {
    if (started) return;
    started = true;
    sessionId = id;
    emit({
      type: "started",
      session_id: id,
      spec,
      adr,
      model: args.model,
      tools: [...INTERVIEW_TOOL_NAMES],
    });
    streams.stderr(
      `interview ${id} in ${repositoryRoot}, writing ${spec}, CONTEXT.md and ${adr}; anything else ` +
        "is refused rather than asked, and it cannot approve, publish or merge\n",
    );
    const unrecorded = recordSession(repositoryRoot, join(repositoryRoot, dirname(spec)), {
      session_id: id,
      spec,
      started_at: context.now.toISOString(),
      model: args.model,
      provider: args.provider,
    });
    if (unrecorded !== null) {
      streams.stderr(
        `this session was not recorded beside its spec, so --session ${id} will not find it: ${unrecorded}\n`,
      );
    }
  };

  const transport =
    context.transport ?? (await loadInterviewTransport(args.provider, repositoryRoot));
  const session: InterviewSession = {
    cwd: repositoryRoot,
    model: args.model,
    resume: args.session,
    orientation: interviewOrientation({ repositoryRoot, spec, adr }),
    tools,
    decide: (tool, toolInput, where) => permission.canUseTool(tool, toolInput, where),
    turns: answering(turnsAsText(context.turns), (turn) => {
      pending = pending.length > 0 && answersGroup(pending[0]!, turn) ? pending.slice(1) : [];
    }),
    sessionId: () => sessionId,
    stderr: (data) => streams.stderr(data),
  };

  let reason = "the session ended";
  for await (const streamed of transport.run(session)) {
    if (streamed.session_id !== undefined) announce(streamed.session_id);
    if (streamed.message !== undefined) emit({ type: "message", message: streamed.message });
    if (streamed.idle === true) emit({ type: "idle" });
    if (streamed.reason !== undefined) reason = streamed.reason;
  }
  if (!started) announce(sessionId.length > 0 ? sessionId : "unknown");
  emit({ type: "ended", session_id: sessionId, reason });
  return EXIT_CODES.approve;
}

/**
 * The transport `--provider` names, loaded when a session is actually started.
 *
 * Imported here rather than at the top of the file so that neither provider's
 * cost is paid by a run of the other, and so that a build without the Claude
 * Agent SDK says so rather than failing on import.
 */
async function loadInterviewTransport(
  provider: InterviewProvider,
  repositoryRoot: string,
): Promise<InterviewTransport> {
  if (provider === "codex") {
    const { codexInterviewTransport } = await import("./codex.js");
    return codexInterviewTransport({ binary: "codex" });
  }
  const { claudeInterviewTransport, loadInterviewSdk, resolveClaudeExecutable } = await import(
    "./claude.js"
  );
  return claudeInterviewTransport(await loadInterviewSdk(), resolveClaudeExecutable(repositoryRoot));
}

/**
 * The spec this interview writes, repository-relative.
 *
 * `--spec` names its folder, or its `spec.md` directly. With no `--spec` the
 * only thing that can name one is a session being resumed, whose folder
 * recorded it; a run with neither is refused rather than given a folder nobody
 * chose, because a spec is one piece of work and guessing which would put this
 * conversation into somebody else's.
 */
function resolveSpec(repositoryRoot: string, specs: string, args: InterviewArgs): string {
  // A session named on the command line is judged before the spec is, and
  // whichever way the spec was named: each provider keeps its own ids, and a
  // Claude session sent to Codex's thread resume, or a Codex thread to the
  // SDK's, is a conversation nothing holds. Planning mode names both on every
  // interview it starts, so a check that only ran without `--spec` would never
  // run where it is needed.
  const recorded =
    args.session === null ? null : sessionSpec(specs, join(repositoryRoot, specs), args.session);
  if (recorded !== null && recorded.provider !== args.provider) {
    throw new UsageError(
      `the session ${args.session!} is ${recorded.provider}'s and this run is ${args.provider}'s. ` +
        `Run it on ${recorded.provider}, or start a session on ${args.provider} without --session`,
    );
  }
  if (args.spec !== null) {
    const named = relative(repositoryRoot, resolve(repositoryRoot, args.spec)).split(sep).join("/");
    if (named.startsWith("..") || isAbsolute(named)) {
      throw new UsageError(`--spec names ${args.spec}, which is outside ${repositoryRoot}`);
    }
    return assertOnePieceOfWork(
      named.endsWith("/spec.md") ? named : `${named}/spec.md`,
      specs,
      `--spec names ${args.spec}`,
    );
  }
  if (args.session !== null) {
    if (recorded !== null) {
      return assertOnePieceOfWork(
        recorded.spec,
        specs,
        `the session ${args.session} records ${recorded.spec} as its spec`,
      );
    }
    throw new UsageError(
      `no spec folder under ${specs} records the session ${args.session}. Name the spec: ` +
        `perbo interview --spec ${specs}/<slug> --session ${args.session}`,
    );
  }
  throw new UsageError(
    `interview needs the spec it is writing: perbo interview --spec ${specs}/<slug>. The folder ` +
      "is created on the first write to it",
  );
}

/**
 * One spec, under the folder this repository keeps its specs in, or a refusal
 * naming what was asked for.
 *
 * The rule is {@link onePieceOfWork}'s, which `perbo admit --from-spec` reads
 * too; this says it in the interview's own words, because the way out of it is
 * to name a folder rather than to move a file.
 */
function assertOnePieceOfWork(spec: string, specs: string, where: string): string {
  const landed = onePieceOfWork(spec, specs);
  if (landed === null) {
    throw new UsageError(
      `${where}, and an interview is about one piece of work under ${specs}: ` +
        `perbo interview --spec ${specs}/<slug>`,
    );
  }
  return landed;
}

/**
 * The spec whose folder records this session, or null where none does.
 *
 * The spec is the one in the folder the record was found in rather than the
 * path the record names: the two agree when the record was written here, and
 * where they do not, the folder is the fact and the field is a claim.
 */
function sessionSpec(
  specs: string,
  specsRoot: string,
  session: string,
): { spec: string; provider: InterviewProvider } | null {
  let entries: string[];
  try {
    entries = readdirSync(specsRoot);
  } catch {
    return null;
  }
  for (const name of entries) {
    const path = join(specsRoot, name, INTERVIEW_SESSION_FILE);
    let record: z.infer<typeof FoundSessionSchema>;
    try {
      record = FoundSessionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // Not a record this session is in; the next folder may hold one.
      continue;
    }
    if (record.session_id === session) {
      return { spec: `${specs}/${name}/spec.md`, provider: record.provider ?? "claude" };
    }
  }
  return null;
}

/**
 * Record the session beside its spec, so planning mode can continue it
 * (SCP-313), or say why it was not recorded.
 *
 * This is the command's own bookkeeping rather than a call the guard judges,
 * so it checks for itself where the folder actually is: a spec folder that is
 * a symlink resolves outside the checkout, and a command that writes the
 * repository's own files does not write there.
 */
function recordSession(
  root: string,
  folder: string,
  record: InterviewSessionRecord,
): string | null {
  try {
    mkdirSync(folder, { recursive: true });
    const landed = realpathSync(folder);
    const inside = realpathSync(root);
    if (landed !== inside && !landed.startsWith(inside + sep)) {
      return `${folder} resolves to ${landed}, which is outside ${inside}`;
    }
    // The folder is inside, and the file is the other half: a record that is
    // itself a symlink would be written through to wherever it points. Asked
    // with `lstat` rather than `existsSync`, which follows the link and so
    // says no for one whose target is not there — the case that would create
    // the target.
    const file = join(landed, INTERVIEW_SESSION_FILE);
    if (isSymlink(file)) {
      return `${file} is a symlink, and this is the repository's own record`;
    }
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Whether a path is a symlink, without following it and without throwing. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The person's turns, each read against the group it may be answering.
 *
 * A group is put to them and nothing waits for it; what comes back is an
 * ordinary turn, and only its own words say whether it answered the question
 * or changed the subject (D-117). `answered` is given the turn so it can tell
 * the two apart, and runs before the turn is handed on, so a tool called in
 * the turn it releases sees it released.
 */
async function* answering(
  turns: AsyncGenerator<string>,
  answered: (turn: string) => void,
): AsyncGenerator<string> {
  for await (const turn of turns) {
    answered(turn);
    yield turn;
  }
}

/** The person's turns, as text, one line of stdin each. */
async function* turnsAsText(turns: AsyncIterable<string> | undefined): AsyncGenerator<string> {
  for await (const line of turns ?? linesOfStdin()) {
    const turn = decodeInterviewTurn(line);
    if (turn === null) continue;
    yield turn.text;
  }
}

/** stdin, one line at a time. */
async function* linesOfStdin(): AsyncGenerator<string> {
  for await (const line of createInterface({ input: process.stdin })) yield line;
}

/** `perbo interview`, over its own line. */
export const interviewCommandLine: NarratedCommand<
  InterviewArgs,
  Record<string, never>,
  InterviewDeps
> = {
  kind: "narrated",
  name: "interview",
  grammars: [INTERVIEW_GRAMMAR],
  grammarFor: () => INTERVIEW_GRAMMAR,
  read(argv) {
    const line = parseArgv(INTERVIEW_GRAMMAR, argv);
    const provider = line.flags["--provider"] ?? "claude";
    if (!(INTERVIEW_PROVIDERS as readonly string[]).includes(provider)) {
      throw new UsageError(
        `--provider takes ${INTERVIEW_PROVIDERS.join(" or ")} (got '${provider}')`,
      );
    }
    return {
      input: {
        repo: line.flags["--repo"] ?? ".",
        store: line.flags["--store"] ?? null,
        spec: line.flags["--spec"] ?? null,
        session: line.flags["--session"] ?? null,
        model: line.flags["--model"] ?? null,
        provider: provider as InterviewProvider,
      },
      output: {},
    };
  },
  run: (input, _output, context) => interview(input, context),
};
