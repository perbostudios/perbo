import {
  builtOption,
  carries,
  expansionLed,
  keepAsOperand,
  suppliedAsOption,
  suppliedDestination,
  type BuiltWords,
  type Context,
  type OptionReading,
} from "./command.js";
import { judgeTarget, pathFinding, type WriteFinding } from "./destination.js";
import { expandedPrefix, type Word } from "./lexer.js";
import { anchorOf, normalise } from "./path.js";

/**
 * The `git` subcommands that only read.
 *
 * `git -C <dir>`, `--git-dir` and `--work-tree` point the command at a
 * repository somewhere else, and every verb that is not on this list writes into
 * it — an index, a ref, a working tree, a config file. Reading one is not a
 * write and stays allowed, which is how an agent orients itself in a sibling
 * worktree; anything else at a directory outside this attempt's own is refused.
 * The list is what is known to read, so a verb this guard has not met is refused
 * rather than assumed harmless.
 */
const GIT_READ_ONLY = new Set([
  "annotate", "blame", "bugreport", "cat-file", "check-attr", "check-ignore", "check-mailmap",
  "check-ref-format", "count-objects", "describe", "diff", "diff-files", "diff-index",
  "diff-tree", "difftool", "for-each-ref", "get-tar-commit-id", "grep", "help", "log",
  "ls-files", "ls-remote", "ls-tree", "merge-base", "name-rev", "patch-id", "rev-list",
  "rev-parse", "shortlog", "show", "show-branch", "show-index", "show-ref", "status",
  "var", "verify-commit", "verify-pack", "verify-tag", "version", "whatchanged",
]);

/**
 * The read-only verbs that take the diff options, whose `--output <file>`
 * writes the command's output to that file instead of standard output. The
 * verb reads; the option is a write, judged by where it lands. Diff options
 * are not abbreviated (git keeps unknown options for the revision walk), so
 * `--output` is only ever spelled whole, and `--output-indicator-*` is not it.
 */
const GIT_DIFF_OUTPUT = new Set([
  "diff", "diff-files", "diff-index", "diff-tree", "log", "show", "whatchanged",
]);

/** `git format-patch`'s options that name the directory its patches land in. */
const GIT_FORMAT_PATCH_DIRECTORY = new Set(["-o", "--output-directory"]);

/** `git`'s global options that name a directory, and those that take a value. */
const GIT_GLOBAL_DIRECTORIES = new Set(["-C", "--git-dir", "--work-tree"]);
const GIT_GLOBAL_VALUES = new Set([
  "-c", "--exec-path", "--namespace", "--super-prefix", "--config-env", "--attr-source",
]);

/**
 * The read-only orientation verbs, whose options write nothing and run
 * nothing, so a word a substitution builds may stand anywhere after them.
 */
const GIT_OPTIONS_INERT = new Set(["rev-parse", "merge-base", "ls-files"]);

/**
 * The revision walk's options that take the next word as their value, for the
 * verbs that walk: `git log -n 5`, `--since <date>`, `--author <name>`.
 */
const GIT_REVISION_VERBS = new Set(["log", "show", "whatchanged"]);
const GIT_REVISION_VALUES = new Set([
  "-n", "--max-count", "--skip", "--since", "--after", "--until", "--before", "--author", "--committer",
  "--grep", "--min-age", "--max-age",
]);

/** The diff options that take the next word as their value: the pickaxe's string, and `--output`'s file. */
const GIT_DIFF_VALUES = new Set(["-S", "-G", "--output"]);

/**
 * The words the line builds where `git` still reads them as options: before
 * the verb, where every word is a global option, its value or the verb
 * itself, and after it until `--` — or `--end-of-options` for a verb that
 * reads revisions, which keeps what follows a revision. A value the verb's
 * option takes is a value, never an option: `git log --since "$(date +%F)"`.
 * The read-only orientation verbs' options write nothing and run nothing, so
 * nothing after one of them is read. Before the verb, a word that begins with
 * an expansion — `$Y`, `"$Y"`, `$1`, or a variable the line assigns, which a
 * subshell or a command in front of it can keep from reaching this one — can
 * be empty, a global option or the verb, and so can a value the shell splits,
 * so where the verb stands cannot be told: every word from there on is read
 * as a global option.
 */
export function gitBuiltWords(
  rest: readonly Word[],
  context: Context,
): { built: BuiltWords; label: string; keep: string } {
  const global: OptionReading = { ends: "never", operands: false, named: false };
  let i = 0;
  while (i < rest.length) {
    const value = rest[i]!.value;
    const option = value.startsWith("-") && value !== "-";
    const name = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
    const takesNext =
      option && !value.includes("=") && (GIT_GLOBAL_DIRECTORIES.has(name) || GIT_GLOBAL_VALUES.has(name));
    const words = rest.slice(i, takesNext ? i + 2 : i + 1);
    const built = builtOption(words, global, context.assigned, i);
    if (built.unreadable !== undefined) return { built, label: "git", keep: keepAsOperand("git", global) };
    const moves =
      built.assigned.length > 0 ||
      expansionLed(rest[i]!) ||
      (takesNext && rest[i + 1] !== undefined && expandedPrefix(rest[i + 1]!.raw)?.splits === true);
    if (moves) {
      return {
        built: builtOption(rest.slice(i), global, context.assigned, i),
        label: "git",
        keep: keepAsOperand("git", global),
      };
    }
    if (!option) break;
    i += words.length;
  }
  const verb = rest[i]?.value ?? "";
  if (GIT_OPTIONS_INERT.has(verb)) return { built: { assigned: [] }, label: `git ${verb}`, keep: "" };
  const reading: OptionReading = {
    ends: GIT_DIFF_OUTPUT.has(verb) || verb === "format-patch" ? "revisions" : "dashes",
    operands: true,
    named: true,
    values: (option) =>
      (GIT_REVISION_VERBS.has(verb) && GIT_REVISION_VALUES.has(option)) ||
      (GIT_DIFF_OUTPUT.has(verb) && GIT_DIFF_VALUES.has(option))
        ? 1
        : 0,
  };
  return {
    built: builtOption(rest.slice(i + 1), reading, context.assigned, i + 1),
    label: `git ${verb}`,
    keep: keepAsOperand(`git ${verb}`, reading),
  };
}

/**
 * Judge the directories a `git` command writes into.
 *
 * Behind a wrapper that supplies words from its standard input, a directory
 * those words fill — a `-C` its placeholder stands in, or the destination of a
 * `clone`, an `init` or a `worktree add` the line leaves for appended words —
 * is a path the line does not spell, and is refused as one. So is a word they
 * fill where a verb that writes through an option (`--output`, `-o`) still
 * reads its options, since the word can be that option.
 */
export function gitFindings(rest: Word[], context: Context): WriteFinding[] {
  const directories: Word[] = [];
  // The directories `-C` moves git to, in order: a relative path an option
  // names is read from where the last of them leaves it.
  const moves: Word[] = [];
  let i = 0;
  while (i < rest.length) {
    const word = rest[i]!;
    const value = word.value;
    if (!value.startsWith("-") || value === "-") break;
    const eq = value.indexOf("=");
    const name = eq === -1 ? value : value.slice(0, eq);
    const attached = eq === -1 ? null : value.slice(eq + 1);
    const take = (): Word | undefined =>
      attached === null ? rest[i + 1] : { ...word, raw: attached, value: attached };
    if (GIT_GLOBAL_DIRECTORIES.has(name)) {
      const operand = take();
      if (operand !== undefined) {
        directories.push(operand);
        if (name === "-C") moves.push(operand);
      }
      i += attached === null ? 2 : 1;
      continue;
    }
    if (GIT_GLOBAL_VALUES.has(name)) {
      i += attached === null ? 2 : 1;
      continue;
    }
    i += 1;
  }

  const verb = rest[i]?.value ?? "";
  const supplied = context.supplied;
  const judge = (word: Word, label: string, reading: "whole" | "place" = "whole"): WriteFinding[] =>
    supplied !== undefined && carries(supplied, word.value)
      ? [suppliedDestination(label, supplied, context.segment)]
      : pathFinding(
          label,
          word,
          judgeTarget(word.value, context.scope, context.cwd, true, reading),
          context.segment,
        );
  /** Where the line leaves the destination to words a wrapper appends. */
  const appended = (label: string): WriteFinding[] =>
    supplied !== undefined && supplied.placeholder === null
      ? [suppliedDestination(label, supplied, context.segment)]
      : [];

  // A path a verb writes through one of its options, wherever the verb's own
  // options stand, read from the directory `-C` moved git to. A long option
  // takes its value after `=` or as the next word, a short one attached
  // (`-odir`) or as the next word. Behind a wrapper, a relative path under a
  // `-C` its placeholder fills lands where the supplied words say.
  const written = (names: ReadonlySet<string>, label: string): WriteFinding[] => {
    const found: WriteFinding[] = [];
    for (let j = i + 1; j < rest.length; j += 1) {
      const word = rest[j]!;
      if (word.value === "--" || word.value === "--end-of-options") break;
      let operand: Word | undefined;
      if (names.has(word.value)) {
        operand = rest[j + 1];
        j += 1;
      } else {
        const name = [...names].find((option) =>
          option.startsWith("--") ? word.value.startsWith(`${option}=`) : word.value.startsWith(option) && !word.value.startsWith("--"),
        );
        if (name === undefined) continue;
        const value = word.value.slice(name.length + (name.startsWith("--") ? 1 : 0));
        operand = { ...word, raw: value, value };
      }
      if (operand === undefined) continue;
      const moved = fromMoves(operand, moves, context);
      found.push(
        ...(supplied !== undefined &&
        moved !== operand &&
        moves.some((move) => carries(supplied, move.value))
          ? [suppliedDestination(label, supplied, context.segment)]
          : judge(moved, label)),
      );
    }
    return found;
  };

  // Words a wrapper hands a verb that writes through an option are read as its
  // options too, so one of them can be that option.
  if (GIT_DIFF_OUTPUT.has(verb) || verb === "format-patch") {
    const option = suppliedAsOption(`git ${verb}`, rest.slice(i + 1), context, false, true);
    if (option !== null) return [option];
  }
  if (GIT_DIFF_OUTPUT.has(verb)) {
    const output = written(new Set(["--output"]), `the file git ${verb} --output writes`);
    if (output.length > 0) return output;
  }
  if (verb.length === 0 || GIT_READ_ONLY.has(verb)) return [];
  const operands = rest
    .slice(i + 1)
    .filter((word) => word.value.length > 0 && !word.value.startsWith("-"));

  const findings = directories.flatMap((directory) =>
    judge(directory, `the directory git ${verb} works in`, "place"),
  );
  // The verbs that name where a repository or a worktree lands. A `clone` with
  // one operand puts it under the directory the command runs in, which the
  // walk below has already judged.
  if (verb === "clone") {
    findings.push(
      ...(operands.length >= 2
        ? judge(operands[operands.length - 1]!, "the git clone destination")
        : appended("the git clone destination")),
    );
  }
  if (verb === "format-patch") {
    findings.push(...written(GIT_FORMAT_PATCH_DIRECTORY, "the directory git format-patch writes its patches to"));
  }
  if (verb === "init") {
    findings.push(
      ...(operands.length >= 1
        ? judge(operands[0]!, "the git init destination")
        : appended("the git init destination")),
    );
  }
  if (verb === "worktree" && operands[0]?.value === "add") {
    findings.push(
      ...(operands[1] !== undefined
        ? judge(operands[1], "the git worktree destination")
        : appended("the git worktree destination")),
    );
  }
  return findings;
}

/**
 * A path an option names, read from where `-C` left git: relative to the last
 * absolute `-C` and every relative one after it, as git itself reads it. With
 * no `-C`, or an absolute path, it is the word as written.
 */
function fromMoves(word: Word, moves: readonly Word[], context: Context): Word {
  const semantics = context.scope.semantics;
  const absolute = (value: string): boolean =>
    value.startsWith("~") || anchorOf(normalise(value, semantics), semantics) !== null;
  if (moves.length === 0 || absolute(word.value)) return word;
  let base = "";
  for (const move of moves) {
    base = absolute(move.value) || base === "" ? move.value : `${base}/${move.value}`;
  }
  return { ...word, value: `${base}/${word.value}` };
}
