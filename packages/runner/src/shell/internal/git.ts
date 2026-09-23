import { carries, suppliedDestination, type Context } from "./command.js";
import { judgeTarget, pathFinding, type WriteFinding } from "./destination.js";
import type { Word } from "./lexer.js";

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

/** `git`'s global options that name a directory, and those that take a value. */
const GIT_GLOBAL_DIRECTORIES = new Set(["-C", "--git-dir", "--work-tree"]);
const GIT_GLOBAL_VALUES = new Set([
  "-c", "--exec-path", "--namespace", "--super-prefix", "--config-env", "--attr-source",
]);

/**
 * Judge the directories a `git` command writes into.
 *
 * Behind a wrapper that supplies words from its standard input, a directory
 * those words fill — a `-C` its placeholder stands in, or the destination of a
 * `clone`, an `init` or a `worktree add` the line leaves for appended words —
 * is a path the line does not spell, and is refused as one.
 */
export function gitFindings(rest: Word[], context: Context): WriteFinding[] {
  const directories: Word[] = [];
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
      if (operand !== undefined) directories.push(operand);
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
  if (verb.length === 0 || GIT_READ_ONLY.has(verb)) return [];
  const operands = rest
    .slice(i + 1)
    .filter((word) => word.value.length > 0 && !word.value.startsWith("-"));

  const supplied = context.supplied;
  const judge = (word: Word, label: string): WriteFinding[] =>
    supplied !== undefined && carries(supplied, word.value)
      ? [suppliedDestination(label, supplied, context.segment)]
      : pathFinding(
          label,
          word,
          judgeTarget(word.value, context.scope, context.cwd, true),
          context.segment,
        );
  /** Where the line leaves the destination to words a wrapper appends. */
  const appended = (label: string): WriteFinding[] =>
    supplied !== undefined && supplied.placeholder === null
      ? [suppliedDestination(label, supplied, context.segment)]
      : [];

  const findings = directories.flatMap((directory) =>
    judge(directory, `the directory git ${verb} works in`),
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
