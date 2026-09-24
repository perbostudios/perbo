import type { Context } from "./command.js";
import { judgeTarget, pathFinding, type WriteFinding } from "./destination.js";
import type { Word } from "./lexer.js";
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

const GIT_DIFF_OUTPUT_OPTION = new Set(["--output"]);

/** `git format-patch`'s options that name the directory its patches land in. */
const GIT_FORMAT_PATCH_DIRECTORY = new Set(["-o", "--output-directory"]);

/** `git`'s global options that name a directory, and those that take a value. */
const GIT_GLOBAL_DIRECTORIES = new Set(["-C", "--git-dir", "--work-tree"]);
const GIT_GLOBAL_VALUES = new Set([
  "-c", "--exec-path", "--namespace", "--super-prefix", "--config-env", "--attr-source",
]);

/** Judge the directories a `git` command writes into. */
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
  const judge = (word: Word, label: string): WriteFinding[] =>
    pathFinding(
      label,
      word,
      judgeTarget(word.value, context.scope, context.cwd, true),
      context.segment,
    );

  // A path a verb writes through one of its options, wherever the verb's own
  // options stand, read from the directory `-C` moved git to. A long option
  // takes its value after `=` or as the next word, a short one attached
  // (`-odir`) or as the next word.
  const written = (names: ReadonlySet<string>, label: string): WriteFinding[] => {
    const found: WriteFinding[] = [];
    for (let j = i + 1; j < rest.length; j += 1) {
      const word = rest[j]!;
      if (word.value === "--") break;
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
      if (operand !== undefined) found.push(...judge(fromMoves(operand, moves, context), label));
    }
    return found;
  };

  if (GIT_DIFF_OUTPUT.has(verb)) {
    const output = written(GIT_DIFF_OUTPUT_OPTION, `the file git ${verb} --output writes`);
    if (output.length > 0) return output;
  }
  if (verb.length === 0 || GIT_READ_ONLY.has(verb)) return [];
  const operands = rest
    .slice(i + 1)
    .filter((word) => word.value.length > 0 && !word.value.startsWith("-"));

  const findings = directories.flatMap((directory) =>
    judge(directory, `the directory git ${verb} works in`),
  );
  // The verbs that name where a repository or a worktree lands. A `clone` with
  // one operand puts it under the directory the command runs in, which the
  // walk below has already judged.
  if (verb === "clone" && operands.length >= 2) {
    findings.push(...judge(operands[operands.length - 1]!, "the git clone destination"));
  }
  if (verb === "format-patch") {
    findings.push(...written(GIT_FORMAT_PATCH_DIRECTORY, "the directory git format-patch writes its patches to"));
  }
  if (verb === "init" && operands.length >= 1) {
    findings.push(...judge(operands[0]!, "the git init destination"));
  }
  if (verb === "worktree" && operands[0]?.value === "add" && operands[1] !== undefined) {
    findings.push(...judge(operands[1]!, "the git worktree destination"));
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
