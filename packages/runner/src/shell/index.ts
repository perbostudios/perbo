import {
  judgeTarget,
  landed,
  ruleOf,
  type WriteFinding,
} from "./internal/destination.js";
import { withoutHeredocBodies } from "./internal/lexer.js";
import { inspectSegments, type CommandReading } from "./internal/line.js";
import {
  allowedPathsSentence,
  prohibitedPathsSentence,
  type ResolvedScope,
} from "./internal/scope.js";

export {
  UNKNOWN_CWD,
  allowedPathsSentence,
  prohibitedPathsSentence,
  resolveScope,
  type Cwd,
  type ResolvedScope,
  type WorktreeScope,
} from "./internal/scope.js";
export type { WriteCause, WriteFinding, WriteRule } from "./internal/destination.js";
export type { CommandReading, CommandSegment } from "./internal/line.js";
export { everySegment } from "./internal/line.js";
export { splitCommandSegments } from "./internal/lexer.js";
export { WRITERS, type WriterSpec } from "./internal/writers.js";

/**
 * Where an attempt may write, and how a shell command line is read to find out.
 *
 * `write_outside_worktree` is a question about a destination rather than a
 * spelling: the absolute path into the attempt's own worktree and the relative
 * one beside it are the same write, and `/tmp` is outside however short it
 * looks. Answering it means parsing enough shell to know which words name a
 * path being written — through quotes, wrappers, substitutions and `cd`.
 *
 * The parser is partial by design. A segment it cannot account for is reported
 * as such, and the caller falls back to the spelling patterns in
 * `internal/line.ts` (`LEGACY_RULES`), which is the conservative reading.
 */

/**
 * A line that gives one of those names a different value, or takes its value
 * away. Expanding the variable to the runner's directory is only sound while
 * the runner's value is what the shell holds, and `TMPDIR=/tmp cp a $TMPDIR/b`
 * would otherwise be read as a write the runner sanctioned. Matched against the
 * whole line rather than a segment, because an assignment in one command is the
 * environment of the next.
 */
const SCRATCH_REBOUND = /\b(?:TMPDIR|TMP|TEMP)=|\bunset\b[^\n]*\b(?:TMPDIR|TMP|TEMP)\b/;

/**
 * Read a command line: what it writes, and the directory it leaves the shell
 * in.
 *
 * The second answers a question one line cannot. The executor's Bash tool keeps
 * one shell, so where a line leaves that shell is where the next line's
 * relative targets resolve. Only a move the calling shell keeps is reported —
 * not one made inside a subshell, a pipeline stage, a backgrounded command, or
 * a shell that `sh -c` spawned and let die.
 */
export function readCommandLine(command: string, scope: ResolvedScope): CommandReading {
  const text = command.trim();
  // Read as if the runner had named no scratch directory once the line rebinds
  // one of its variables: that is the reading this module had before it had one
  // to offer, so the narrowing can only refuse. The rebinding is looked for in
  // the line the shell runs, not in a heredoc body it hands to a command.
  const rebound: ResolvedScope =
    scope.tmpdir !== null && SCRATCH_REBOUND.test(withoutHeredocBodies(text).text)
      ? { ...scope, tmpdir: null }
      : scope;
  // A GNU backup takes the suffix `SIMPLE_BACKUP_SUFFIX` holds, so every value
  // the line gives it, heredoc bodies included, is judged as one.
  const suffixes = backupSuffixesSet(text);
  const effective: ResolvedScope =
    suffixes === undefined ? rebound : { ...rebound, simpleBackupSuffixes: suffixes };
  return inspectSegments(
    text,
    effective,
    { path: effective.base, unknown: effective.baseUnknown },
    0,
  );
}

/**
 * The values a line gives `SIMPLE_BACKUP_SUFFIX`: undefined where it never
 * names the variable, null where it names it anywhere but in a literal
 * assignment — `export`, `read`, a quoted expansion — which this does not read.
 */
function backupSuffixesSet(text: string): string[] | null | undefined {
  const name = "SIMPLE_BACKUP_SUFFIX";
  if (!text.includes(name)) return undefined;
  const values: string[] = [];
  const assignment = /(?:^|[\s;&|(])SIMPLE_BACKUP_SUFFIX=('[^']*'|"[^"$`\\]*"|[^\s;&|()<>'"$`\\]*)(?=$|[\s;&|)])/g;
  let found = 0;
  for (const match of text.matchAll(assignment)) {
    found += 1;
    const value = match[1]!;
    values.push(/^['"]/.test(value) ? value.slice(1, -1) : value);
  }
  return found === text.split(name).length - 1 ? values : null;
}

/**
 * A path from the sealed change set, which is text on disk rather than shell
 * text: a `~` or a `$` in it is a character in a filename, not an expansion.
 */
export function inspectWritePath(path: string, scope: ResolvedScope): WriteFinding | null {
  const destination = judgeTarget(path, scope, { path: scope.base, unknown: false }, false);
  if (destination.kind === "inside") return null;
  return {
    detail:
      destination.kind === "outside"
        ? `${path} resolves to ${destination.resolved}, outside the worktree root`
        : destination.kind === "outside_scope"
          ? `${path} resolves to ${destination.at}, which this ticket's contract does not ` +
            `admit — ${allowedPathsSentence(destination.allowed)}`
          : destination.kind === "prohibited_path"
            ? `${path} resolves to ${destination.at}, which this ticket's contract prohibits ` +
              `— ${prohibitedPathsSentence(destination.prohibited)}`
            : `${path} cannot be resolved — ${destination.reason}`,
    target: path,
    resolved: landed(destination),
    rule: ruleOf(destination),
  };
}

/**
 * The bodies of the here-documents `command` opens whose delimiter is not
 * quoted — the ones a shell expands `$(…)`, `` `…` `` and `$name` inside, so
 * what a command runs is not only what its line spells. Read by the runner's
 * own `withoutHeredocBodies`, which takes every `<<` on a line in order — two
 * on one line (`cat <<A <<B`) each take their body in turn — so a caller that
 * must judge what those bodies run reads them the way the shell feeds them,
 * not just the first. A quoted delimiter (`<<'E'`) makes its body literal and
 * is left out. Exposed for the interview's read-only guard, which holds a
 * here-document body to the read-only shapes the same as any other command
 * (SCP-355).
 */
export function expandableHeredocBodies(command: string): string[] {
  return withoutHeredocBodies(command)
    .bodies.filter((heredoc) => !heredoc.quoted)
    .map((heredoc) => heredoc.body);
}
