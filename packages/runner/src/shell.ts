import { lstatSync, readlinkSync } from "node:fs";
import { dirname, posix } from "node:path";
import { insideAllowedPaths, matchesAny, standingProhibitedPaths } from "@perbo/contracts";

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
 * as such, and the caller falls back to the spelling patterns kept at the
 * bottom of this file, which is the conservative reading.
 */

/**
 * The value `WorktreeScope.cwd` takes when the shell is somewhere this guard
 * cannot name, after a move it could not read. Every relative target is refused
 * by name while it holds. A real directory is always given absolutely, so the
 * word cannot collide with one.
 */
export const UNKNOWN_CWD = "unknown";

export interface WorktreeScope {
  /** The attempt's worktree root. */
  root: string;
  /**
   * The directory a relative target resolves against: where the shell running
   * this line stands. Absolute, and defaults to the root. `UNKNOWN_CWD` where
   * an earlier move left it unreadable.
   */
  cwd?: string;
  /** What `~` and `$HOME` expand to. Defaults to the process environment. */
  home?: string;
  /**
   * What `$TMPDIR`, `$TMP` and `$TEMP` expand to: the scratch directory the
   * runner created inside the worktree and set in the agent's environment
   * (SCP-166). Absent where no runner supplied one, and then those variables
   * are as unresolvable as any other.
   */
  tmpdir?: string;
  /**
   * The globs the approved contract admits a **write** under, relative to the
   * root (SCP-195). Absent, or containing `**`, admits everything inside the
   * root — which is what a ticketless run's `**` scope means and what every
   * caller with no contract to hand gets.
   *
   * Reads are never judged by them: the rule is about where an attempt may
   * leave bytes, not about what it may look at.
   */
  paths_allowed?: readonly string[];
  /**
   * The paths the approved contract prohibits a write to, relative to the root
   * (D-105). Judged before the globs above, so a path inside the allowed ones
   * is refused all the same. Absent or empty prohibits nothing.
   */
  paths_prohibited?: readonly string[];
  /**
   * Where this repository keeps its specs, from `.perbo/config.json` (D-103).
   * Its folder is prohibited whatever the contract says, together with the
   * default `specs/`, which {@link resolveScope} adds for every scope.
   */
  spec_folder?: string | null;
  /**
   * Whether this caller may write the spec folders above. False for an
   * attempt, whose contract was drafted from the spec it would be rewriting
   * (D-103). The interview writes them, and is the one caller that states
   * true (D-102); what bounds it there is `paths_allowed`.
   */
  spec_folder_writable?: boolean;
  /**
   * How to read a separator. Defaults to this host, and is named explicitly
   * only by a test, which has to be able to state the semantics it means
   * rather than inherit whichever machine it happens to run on.
   */
  semantics?: PathSemantics;
}

export interface ResolvedScope {
  /** How this scope reads a separator (see {@link PathSemantics}). */
  semantics: PathSemantics;
  /** Null when the caller named no root, which is the conservative mode below. */
  root: string | null;
  base: string | null;
  /** True when the caller named `UNKNOWN_CWD`: no relative target can be judged. */
  baseUnknown: boolean;
  home: string | undefined;
  /** Null when the caller named no scratch directory. */
  tmpdir: string | null;
  /**
   * The contract's write globs, normalised: empty where every path inside the
   * root is admitted, so one emptiness test answers "no contract", "no globs"
   * and `**` alike.
   */
  paths_allowed: readonly string[];
  /** The contract's prohibited paths. Empty where it named none (D-105). */
  paths_prohibited: readonly string[];
}

export interface WriteFinding {
  detail: string;
  /**
   * The target as the command spelled it — `~/b`, `$OUT/x`, `/tmp/evidence`.
   * What a refusal has to name for the agent to recognise the word it typed.
   * Null where the finding is about a command rather than a path: an operand
   * built at run time, a wrapper option this guard cannot see through.
   */
  target: string | null;
  /** Where the target lands, or null where the resolver could not say. */
  resolved: string | null;
  /**
   * Which refusal this is. Absent is `write_outside_worktree`, which is every
   * finding the resolver could not place and every one it placed outside the
   * root; `write_outside_scope` is a destination inside the root that the
   * contract's globs do not admit (SCP-195); `write_prohibited_path` is one the
   * contract prohibits by name, wherever the globs put it (D-105).
   */
  rule?: WriteRule;
  /**
   * What the finding shows, which is not the same question as which rule it
   * broke (SCP-234). Absent is `outside_target`.
   */
  cause?: WriteCause;
}

/** The three refusals a resolved destination can earn. */
export type WriteRule =
  | "write_outside_worktree"
  | "write_outside_scope"
  | "write_prohibited_path";

/**
 * What a write finding actually shows (SCP-234).
 *
 * `outside_target` is a write this reading placed: a resolved path, a redirect,
 * a writer verb's operand. `unreadable_program` is an interpreter's program the
 * guard could not classify — the code is on the line and no reading of it says
 * where it writes, which refuses that command but is not evidence that anything
 * was written. Ticket 4's round was ended for the second as though it were the
 * first, and the file it read never left the worktree.
 */
export type WriteCause = "outside_target" | "unreadable_program";

/**
 * The sentence the guard refuses in, and the sentence the executor's brief
 * states the scope in — one function, so they cannot say different things
 * (SCP-195).
 */
export function allowedPathsSentence(globs: readonly string[]): string {
  const quoted = globs.map((glob) => `\`${glob}\``).join(", ");
  return `writes are admitted only under: ${quoted} — anything else is refused before it happens`;
}

/**
 * The same pairing for the paths a write is prohibited under (D-105): one
 * sentence the guard refuses in and the executor's brief states the
 * prohibition in, so the two cannot describe different boundaries. The list is
 * what the contract named and the standing spec folder beside it (D-103), so
 * the sentence names the boundary rather than where each glob came from.
 */
export function prohibitedPathsSentence(globs: readonly string[]): string {
  const quoted = globs.map((glob) => `\`${glob}\``).join(", ");
  return (
    `writes are prohibited under: ${quoted} — refused before they happen, ` +
    "inside the admitted globs as much as outside them"
  );
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
  /** The programs the segment runs, by basename, with the wrappers stripped. */
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
   * `eval` or a `pnpm exec -c`, each read as a command in its own right.
   *
   * They are kept apart from the segment that wrapped them because the wrapper
   * inherits their `mutating` flag, and a caller deciding a command by where
   * its writes land needs the command that writes rather than the one standing
   * around it.
   */
  nested: CommandSegment[];
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

type Resolved = { ok: true; path: string } | { ok: false; reason: string };

type Destination =
  | { kind: "inside"; resolved: string | null }
  | { kind: "outside"; resolved: string }
  /**
   * Inside the worktree, outside the contract's globs (SCP-195). `at` is the
   * destination relative to the root, which is the spelling the contract, the
   * change set and the review all use — and the one the executor has to
   * recognise as a file it may not write.
   */
  | { kind: "outside_scope"; resolved: string; at: string; allowed: readonly string[] }
  /**
   * Inside the worktree and named by the contract's `paths_prohibited` (D-105).
   * Its own kind rather than a flavour of the one above because the two ask a
   * person for opposite things: one is a path the contract has to be revised to
   * reach, the other a path the contract already decided is not to be touched.
   */
  | { kind: "prohibited_path"; resolved: string; at: string; prohibited: readonly string[] }
  | { kind: "unresolvable"; reason: string };

/* ------------------------------------------------------------------ paths */

/**
 * Whether this resolver reads paths the way Windows does. Carried rather than
 * assumed, so the semantics are a property of the run and a test can state
 * which one it means on any host.
 */
export type PathSemantics = "windows" | "posix";

const HOST_SEMANTICS: PathSemantics = process.platform === "win32" ? "windows" : "posix";

/**
 * A backslash is a separator on Windows and an ordinary filename character on
 * POSIX, so which it is cannot be decided by looking at the path.
 *
 * Converting unconditionally is a hole rather than a convenience: on POSIX a
 * single-quoted `'tests\support\color.js'` is one top-level file whose name
 * contains backslashes, and normalising it to `tests/support/color.js` matches
 * `tests/**` and admits a write the shell then performs somewhere the contract
 * never admitted. The guard would be judging a destination that does not exist.
 * So the conversion happens only where the host actually spells paths that way.
 *
 * Under Windows semantics the resolver holds one alphabet — `/` — which is the
 * alphabet a contract glob is written in, so nothing downstream moves:
 * `globToRegExp`, the globs themselves and the seal are untouched.
 */
function normalise(path: string, semantics: PathSemantics): string {
  return semantics === "windows" ? path.replaceAll("\\", "/") : path;
}

/**
 * A path as a comparison under these semantics sees it.
 *
 * Windows resolves a name without its case: `c:/users/A` and `C:/Users/a` are
 * one directory there, so the root, the scratch directory and the contract's
 * globs are compared folded — a case-variant of a prohibited path is the
 * prohibited file, and must be refused as one. POSIX keeps case, so nothing is
 * folded there.
 *
 * Only A–Z are folded here. That keeps a path's length, so a prefix a
 * comparison finds is the prefix to slice off the original. A name that differs
 * from the root, the scratch directory or an allowed glob only in another
 * letter's case therefore does not match it, and is refused. The prohibited
 * globs are compared through {@link prohibitedComparable} instead, where the
 * same doubt also refuses.
 */
function comparable(path: string, semantics: PathSemantics): string {
  return semantics === "windows" ? path.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : path;
}

/**
 * A path as the prohibited comparison sees it. Windows compares names through
 * their uppercase, one character for one, in every script and not only A–Z, so
 * under Windows semantics each character becomes its uppercase here: `ſecrets`
 * compares as `SECRETS`, as `secrets` does, and a final `ς` as a `σ` does. A
 * character whose uppercase is longer than itself (`ß` is `SS`) stays as it is,
 * as Windows leaves it. One for one keeps a name's length, which a `?` counts,
 * and no character's fold depends on its neighbours, so — the globs having no
 * character classes — a path an exact match would refuse is refused here too.
 */
function prohibitedComparable(path: string, semantics: PathSemantics): string {
  if (semantics !== "windows") return path;
  let folded = "";
  for (const character of path) {
    const upper = character.toUpperCase();
    folded += upper.length === character.length ? upper : character;
  }
  return folded;
}

/**
 * Whether a path names a drive with no root after it — `C:foo`, `C:` — under
 * Windows semantics. Windows resolves one against that drive's own current
 * directory, which this guard does not follow, so it is refused rather than
 * read from the drive's root.
 */
function driveRelative(path: string, semantics: PathSemantics): boolean {
  return semantics === "windows" && /^[A-Za-z]:(?!\/)/.test(path);
}

const DRIVE_RELATIVE =
  "a drive with no root after it, which Windows resolves against that drive's own current directory";

/**
 * The first component of a repository-relative path that Windows may read as
 * another name, or null. Windows drops trailing dots and spaces from the last
 * name in a path and a trailing dot from a directory on the way, so `key.pem.`
 * is `key.pem` and `specs.\auth` is `specs\auth`; a colon names a stream, and
 * `key.pem::$DATA` is `key.pem` itself and `secrets::$INDEX_ALLOCATION` is the
 * directory `secrets`; and a short 8.3 name such as `CREDEN~1` can stand for
 * `credentials`. None of these can be matched against a glob as written, so
 * under Windows semantics a component ending in a dot or a space, carrying a
 * colon, or shaped like a short name is refused wherever it is. A name that
 * contains `~` and a digit but is too long for an 8.3 name is not one.
 */
function windowsAlias(at: string, semantics: PathSemantics): string | null {
  if (semantics !== "windows") return null;
  const shortName = (part: string) => {
    const [base = "", extension = "", ...rest] = part.split(".");
    return rest.length === 0 && base.length <= 8 && extension.length <= 3 && /~\d/.test(base);
  };
  return at.split("/").find((part) => /[. ]$/.test(part) || part.includes(":") || shortName(part)) ?? null;
}

/**
 * What a path is rooted at, or null where it is relative: `""` for a POSIX
 * absolute path and `"C:"` for a drive-qualified Windows one. A drive with no
 * root after it reads as anchored here, so where no root is named it is refused
 * as outside; the walk refuses it before any anchor is used ({@link driveRelative}).
 *
 * A drive letter is the part a separator test cannot see. `C:\worktree` begins
 * with no separator under either alphabet, so a test for one reads every
 * absolute Windows path as relative and joins it onto the base — which is a
 * destination that does not exist, judged against globs it cannot match.
 *
 * A drive is an anchor only under Windows semantics: on POSIX `C:` is a
 * perfectly ordinary directory name and a path starting with it is relative.
 */
function anchorOf(path: string, semantics: PathSemantics): string | null {
  if (semantics === "windows") {
    const drive = /^[A-Za-z]:/.exec(path);
    if (drive) return drive[0];
  }
  return path.startsWith("/") ? "" : null;
}

/**
 * Resolve a path the way the kernel does: component by component from the
 * start, with no lexical normalisation, following each symlink the moment the
 * walk reaches it — a relative link target re-walked from the link's own
 * directory — so a `..` after a link climbs from where the link landed. A
 * component that does not exist is kept verbatim, and a link whose target does
 * not exist resolves to that target, which is where the write would land.
 */
function walkPath(base: string, target: string, semantics: PathSemantics, depth = 0): Resolved {
  if (depth > 32) return { ok: false, reason: "a symlink chain too long to follow" };
  const path = normalise(target, semantics);
  if (driveRelative(path, semantics)) return { ok: false, reason: DRIVE_RELATIVE };
  const anchor = anchorOf(path, semantics);
  // Where a climb stops: the target's own root, or, for a relative target, the
  // root of the base it is walked from.
  const root = anchor ?? anchorOf(normalise(base, semantics), semantics) ?? "";
  // Held without its trailing separator, so joining a component is always
  // `current + "/" + part`: a base of `/` (which is what a relative symlink
  // target directly under the root is re-walked from) would otherwise join to
  // `//private`, and a drive base of `C:/` to `C://Users`.
  let current = (anchor ?? normalise(base, semantics)).replace(/\/$/, "");
  for (const part of path.slice(anchor?.length ?? 0).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // A root is its own parent: climbing out of `/` or out of `C:` leaves the
      // path where it was rather than inventing a segment above the anchor. The
      // path is held in `/` whatever the host, so POSIX's `dirname` reads it.
      const up = posix.dirname(current);
      current = up === "/" || up === "." || up === current ? root : up;
      continue;
    }
    const next = `${current}/${part}`;
    let entry;
    try {
      entry = lstatSync(next, { throwIfNoEntry: false });
    } catch {
      return { ok: false, reason: `${next} cannot be read` };
    }
    if (entry === undefined || !entry.isSymbolicLink()) {
      current = next;
      continue;
    }
    let link: string;
    try {
      link = readlinkSync(next);
    } catch {
      return { ok: false, reason: `the symlink ${next} cannot be read` };
    }
    const followed = walkPath(posix.dirname(next), link, semantics, depth + 1);
    if (!followed.ok) return followed;
    current = followed.path;
  }
  return { ok: true, path: current };
}

/**
 * The globs as the resolver holds them: empty where everything inside the root
 * is admitted. `**` admits everything by itself, so a list carrying it is the
 * same as no list at all and is flattened to one here rather than at each of
 * the places that ask.
 */
function allowedGlobs(globs: readonly string[] | undefined): readonly string[] {
  if (globs === undefined || globs.length === 0) return [];
  return globs.includes("**") ? [] : globs;
}

export function resolveScope(scope?: WorktreeScope): ResolvedScope {
  const semantics = scope?.semantics ?? HOST_SEMANTICS;
  if (scope === undefined) {
    return {
      semantics,
      root: null,
      base: null,
      baseUnknown: false,
      home: process.env.HOME,
      tmpdir: null,
      paths_allowed: [],
      paths_prohibited: standingProhibitedPaths(),
    };
  }
  const home = scope.home ?? process.env.HOME;
  const paths_allowed = allowedGlobs(scope.paths_allowed);
  // Not flattened the way the allowed globs are: `**` there means everything is
  // admitted and the list can be emptied, and `**` here means the opposite.
  //
  // The spec folder joins whatever the contract named (D-103): a spec is the
  // intent the contract was drafted from, so an attempt that edited one would
  // be rewriting the statement it is judged against. It is standing rather than
  // contractual so it holds for a ticket admitted before the folder existed and
  // for a run with no ticket behind it. The interview is the caller that writes
  // the spec, and the only one that states the folders writable (D-102).
  const standing = scope.spec_folder_writable === true ? [] : standingProhibitedPaths(scope.spec_folder);
  const paths_prohibited = [...new Set([...(scope.paths_prohibited ?? []), ...standing])];
  // Resolved the same way the root is, so a scratch directory reached through a
  // symlinked prefix is compared against the root in the same spelling.
  const scratch = scope.tmpdir === undefined ? null : walkPath("/", scope.tmpdir, semantics);
  const tmpdir = scratch !== null && scratch.ok ? scratch.path : null;
  const root = walkPath("/", scope.root, semantics);
  if (!root.ok) {
    return {
      semantics,
      root: null,
      base: null,
      baseUnknown: false,
      home,
      tmpdir,
      paths_allowed,
      paths_prohibited,
    };
  }
  // An unknown directory keeps the root as its path, which nothing reads: a
  // relative target is refused before the path is consulted, and an absolute
  // one does not need it.
  const unknown = scope.cwd === UNKNOWN_CWD;
  const base = scope.cwd === undefined || unknown ? root : walkPath("/", scope.cwd, semantics);
  return {
    semantics,
    root: root.path,
    base: base.ok ? base.path : root.path,
    baseUnknown: unknown,
    home,
    tmpdir,
    paths_allowed,
    paths_prohibited,
  };
}

/** The directory a segment runs in, which a `cd` earlier on the line may move. */
export interface Cwd {
  /** Absolute. Null only where the caller named no worktree root. */
  path: string | null;
  /** True after a move the resolver could not read. */
  unknown: boolean;
}

const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/**
 * The variables that name the scratch directory the runner made (SCP-166).
 *
 * All three, because they are the three the runner sets and a program reads
 * whichever it was written against. The longest spelling comes first so
 * `$TMPDIR` is not read as `$TMP` followed by `DIR`, and the lookahead keeps
 * `$TMPDIRX` — a different variable — out.
 */
const SCRATCH_PREFIX =
  /^(?:\$TMPDIR|\$\{TMPDIR\}|\$TEMP|\$\{TEMP\}|\$TMP|\$\{TMP\})(?=\/|$)/;

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
 * The device files a redirect names to discard its output or to re-enter the
 * process's own streams. They are outside every worktree and are not writes to
 * anything: `> /dev/null` is the commonest redirect there is. The list is exact
 * rather than a `/dev/**` prefix, because `> /dev/disk0` is a real write.
 */
const DEVICE_TARGET = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/;

function judgeTarget(target: string, scope: ResolvedScope, cwd: Cwd, shell: boolean): Destination {
  let path = target;
  if (shell) {
    if (path.includes("`") || path.includes("$(")) {
      return { kind: "unresolvable", reason: "a command substitution" };
    }
    if (HOME_PREFIX.test(path)) {
      if (scope.home === undefined) return { kind: "unresolvable", reason: "HOME is not set" };
      path = path.replace(HOME_PREFIX, scope.home);
    } else if (path.startsWith("~")) {
      return { kind: "unresolvable", reason: "a home directory this guard cannot expand" };
    }
    // The runner set these three itself and knows what they hold, so a write
    // through one is judged by where it lands. Where it set none they fall
    // through to the variable rule below and are refused by name.
    if (scope.tmpdir !== null && SCRATCH_PREFIX.test(path)) {
      path = path.replace(SCRATCH_PREFIX, scope.tmpdir);
    }
    if (path.includes("$")) return { kind: "unresolvable", reason: "an unquoted variable" };
  }
  if (path.length === 0) return { kind: "unresolvable", reason: "the operator has no target" };
  if (DEVICE_TARGET.test(path)) return { kind: "inside", resolved: path };

  const relative = anchorOf(normalise(path, scope.semantics), scope.semantics) === null;
  if (scope.root === null) {
    // With no root named, only a relative target that never climbs above its
    // own starting point can be shown to stay inside one.
    if (!relative) return { kind: "outside", resolved: path };
    let depth = 0;
    for (const part of normalise(path, scope.semantics).split("/")) {
      if (part === "" || part === ".") continue;
      depth += part === ".." ? -1 : 1;
      if (depth < 0) return { kind: "outside", resolved: path };
    }
    return { kind: "inside", resolved: null };
  }
  if (relative && cwd.unknown) {
    return {
      kind: "unresolvable",
      reason: "the working directory is unknown after an earlier `cd`",
    };
  }

  const walked = walkPath(cwd.path ?? scope.root, path, scope.semantics);
  if (!walked.ok) return { kind: "unresolvable", reason: walked.reason };
  // `/dev/stdout` is a symlink to `/dev/fd/1` on some hosts, so the resolved
  // spelling is checked as well as the written one.
  if (DEVICE_TARGET.test(walked.path)) return { kind: "inside", resolved: walked.path };
  const root = scope.root.endsWith("/") ? scope.root.slice(0, -1) : scope.root;
  const fold = (value: string) => comparable(value, scope.semantics);
  const inside = fold(walked.path) === fold(root) || fold(walked.path).startsWith(`${fold(root)}/`);
  if (!inside) return { kind: "outside", resolved: walked.path };
  const at = repositoryRelative(walked.path, root, scope);
  if (at === null) return { kind: "inside", resolved: walked.path };
  const alias = windowsAlias(at, scope.semantics);
  if (alias !== null) {
    return { kind: "unresolvable", reason: `Windows may read \`${alias}\` as another name` };
  }
  // Prohibited first, so a path that is both prohibited and unadmitted is
  // refused as prohibited (D-105). The other order would tell the reader to
  // widen the contract to reach a path the contract forbids.
  const prohibitedFold = (value: string) => prohibitedComparable(value, scope.semantics);
  if (matchesAny(prohibitedFold(at), scope.paths_prohibited.map(prohibitedFold))) {
    return {
      kind: "prohibited_path",
      resolved: walked.path,
      at,
      prohibited: scope.paths_prohibited,
    };
  }
  if (scope.paths_allowed.length === 0 || insideAllowedPaths(fold(at), scope.paths_allowed.map(fold))) {
    return { kind: "inside", resolved: walked.path };
  }
  return { kind: "outside_scope", resolved: walked.path, at, allowed: scope.paths_allowed };
}

/**
 * A destination inside the worktree as the path relative to the root — the
 * spelling the contract, the change set and the review all use — or null where
 * the contract's paths have nothing to say about it.
 *
 * Two things inside the root are never judged by them. The scratch directory is
 * the runner's own: it is excluded from every list the seal builds, so no
 * contract names it and nothing written there can be a scope escape or a
 * prohibited path. And the root itself is not a repository-relative path at
 * all; there is nothing for a glob to match.
 */
function repositoryRelative(resolved: string, root: string, scope: ResolvedScope): string | null {
  if (scope.tmpdir !== null) {
    const path = comparable(resolved, scope.semantics);
    const tmpdir = comparable(scope.tmpdir, scope.semantics);
    if (path === tmpdir || path.startsWith(`${tmpdir}/`)) return null;
  }
  const at = resolved.slice(root.length + 1);
  // Already in the contract's spelling: a glob is written with `/` whatever the
  // platform's separator, and the resolver holds that one alphabet on every
  // host, so the path it is matched against needs no further conversion.
  return at.length === 0 ? null : at;
}

/* ------------------------------------------------------------------ lexer */

interface Word {
  /** As written, so a refusal names what the agent typed. */
  raw: string;
  /** Quotes and escapes removed. */
  value: string;
  /** Command bodies found in `$(…)` or backticks outside single quotes. */
  substitutions: string[];
  /** True when an unexpanded `$name` or `${name}` survives in the value. */
  variable: boolean;
  /**
   * True for a word that belongs to a redirect rather than to the command: its
   * target, or the descriptor number written against its operator. Both join
   * the command's words so a write verb's operands are judged with them, and
   * neither can be the command word — a wrapper that lost its own is still
   * option-only with `> log.txt` or `2>&1` after it (SCP-186).
   */
  redirect?: boolean;
}

interface Redirect {
  target: Word | null;
  reason: string | null;
}

/**
 * Where a command's standard input comes from, as the line spells it.
 *
 * It matters for one class of command: an interpreter or a shell given no
 * program on its command line runs whatever arrives on standard input, so the
 * question "what is this process about to run" is answered here or not at all.
 */
type StdinSource =
  | { kind: "heredoc"; tag: string; expanded: boolean; body: string }
  /** A here-string, `<<< word`, whose text is on the line. */
  | { kind: "word"; word: Word }
  /** A file, `< path`, whose contents this guard does not read. */
  | { kind: "file"; word: Word }
  /** A descriptor or an input this guard cannot name at all. */
  | { kind: "opaque"; raw: string }
  /** The stage before it in a pipeline, as the words that stage was written as. */
  | { kind: "pipe"; producer: Word[] };

type Item =
  | { kind: "word"; word: Word }
  | { kind: "redirect"; redirect: Redirect }
  | { kind: "stdin"; source: StdinSource }
  | { kind: "operator"; text: string };

const WORD_BREAK = new Set([">", "<", "|", ";", "&", "(", ")"]);

/**
 * The operators that end one command and start the next.
 *
 * `&&`, `||` and `;` run the next command in the same shell, so a `cd` before
 * one moves it. `|`, `|&` and `&` run their command in a subshell, so a `cd`
 * inside it moves nothing after it.
 */
const SEQUENTIAL_OPERATORS = new Set(["&&", "||", ";", "\n", "\r\n", ""]);

/** Read the operator at `from`, longest form first, or null. */
function readOperator(text: string, from: number): string | null {
  const two = text.slice(from, from + 2);
  if (two === "&&" || two === "||" || two === "|&") return two;
  const newline = /^\r?\n/.exec(text.slice(from));
  if (newline !== null) return newline[0];
  const ch = text[from];
  return ch === ";" || ch === "|" || ch === "&" ? ch : null;
}

/** Read the body of a `$(…)` or a backtick pair, tracking nesting and quotes. */
function readSubstitution(text: string, from: number): { body: string; end: number } | null {
  if (text.startsWith("`", from)) {
    const close = text.indexOf("`", from + 1);
    return close === -1 ? null : { body: text.slice(from + 1, close), end: close + 1 };
  }
  let depth = 1;
  let quote: string | null = null;
  for (let i = from + 2; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(from + 2, i), end: i + 1 };
    }
  }
  return null;
}

/** What a backslash inside double quotes escapes, as bash reads it. */
const DOUBLE_QUOTED_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

function readWord(text: string, from: number): { word: Word; end: number; balanced: boolean } {
  let value = "";
  const substitutions: string[] = [];
  let variable = false;
  let balanced = true;
  let quote: string | null = null;
  let i = from;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      // Inside double quotes a backslash escapes only `$`, a backtick, `"`, `\`
      // and a newline, as bash reads it; before any other character it stays in
      // the word, which on Windows makes it a separator.
      const next = text[i + 1] ?? "";
      if (quote === '"' && !DOUBLE_QUOTED_ESCAPES.has(next)) value += ch;
      value += next;
      i += 2;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      i += 1;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      const read = readSubstitution(text, i);
      if (read === null) {
        balanced = false;
        value += text.slice(i);
        i = text.length;
        continue;
      }
      substitutions.push(read.body);
      value += text.slice(i, read.end);
      i = read.end;
      continue;
    }
    if (ch === "$") variable = true;
    if (quote === null && (/\s/.test(ch) || WORD_BREAK.has(ch))) break;
    value += ch;
    i += 1;
  }
  if (quote !== null) balanced = false;
  return { word: { raw: text.slice(from, i), value, substitutions, variable }, end: i, balanced };
}

/** A heredoc a line opened: the terminator to look for, and how to match it. */
interface Heredoc {
  tag: string;
  /** `<<-`, which strips leading tabs from the body lines and the terminator. */
  stripTabs: boolean;
  /**
   * True for `<<'EOF'` and `<<"EOF"`, whose body the shell hands over verbatim.
   * An unquoted tag lets the shell expand `$name` and `$(…)` inside the body,
   * so what the command receives is not what the line says.
   */
  quoted: boolean;
}

/** A heredoc's tag and the lines the shell feeds to the command's input. */
interface HeredocBody extends Heredoc {
  body: string;
}

/** Read the tag of a `<<`, `from` being the character after the operator. */
function readHeredocTag(text: string, from: number): { heredoc: Heredoc; end: number } | null {
  let i = from;
  const stripTabs = text[i] === "-";
  if (stripTabs) i += 1;
  while (text[i] === " " || text[i] === "\t") i += 1;
  const read = readWord(text, i);
  if (read.word.value.length === 0) return null;
  const quoted = read.word.raw !== read.word.value;
  return { heredoc: { tag: read.word.value, stripTabs, quoted }, end: read.end };
}

/**
 * Where the text after the bodies of `opened` starts, `from` being line one,
 * and the body each of them consumed.
 */
function skipHeredocBodies(
  text: string,
  from: number,
  opened: readonly Heredoc[],
  bodies: HeredocBody[],
): number {
  let at = from;
  for (const heredoc of opened) {
    const { tag, stripTabs } = heredoc;
    const lines: string[] = [];
    while (at < text.length) {
      const newline = text.indexOf("\n", at);
      const end = newline === -1 ? text.length : newline;
      const line = text.slice(at, end).replace(/\r$/, "");
      at = newline === -1 ? end : newline + 1;
      const stripped = stripTabs ? line.replace(/^\t+/, "") : line;
      if (stripped === tag) break;
      lines.push(stripped);
    }
    bodies.push({ ...heredoc, body: lines.join("\n") });
  }
  return at;
}

/**
 * The same line with every heredoc body removed.
 *
 * `cat >> file <<'EOF'` feeds the lines that follow to the command's standard
 * input. They are its data: a `>` or a `cd` written inside one redirects and
 * moves nothing, and a quote inside one opens nothing. The operator and its tag
 * stay, so the redirect standing before them is judged exactly as it was.
 *
 * A body starts after the newline that ends the line its operator stands on —
 * two operators on one line take their bodies in that order — and ends at the
 * first line equal to the tag. An unterminated body runs to the end of the
 * text. `<<<` is a here-string, whose word is on the line itself, and is left
 * alone.
 *
 * What the command does with the data is the command's own — with one
 * exception, and it is the reason the bodies are returned rather than dropped:
 * where the command is an interpreter or a shell, that data **is** its program,
 * and the guard reads it as such (SCP-177).
 */
export function withoutHeredocBodies(command: string): { text: string; bodies: HeredocBody[] } {
  const bodies: HeredocBody[] = [];
  if (!command.includes("<<")) return { text: command, bodies };
  let kept = "";
  let start = 0;
  let opened: Heredoc[] = [];
  let quote: string | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      // An escaped newline continues the line, so the body it opens still
      // begins after the next newline that ends one.
      i += 2;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
      // A heredoc inside a substitution belongs to the command the substitution
      // runs, which is read on its own.
      const read = readSubstitution(command, i);
      if (read === null) break;
      i = read.end;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        // A here-string. Its word is on this line, and the two characters it
        // ends with are not an operator of their own.
        i += 3;
        continue;
      }
      const read = readHeredocTag(command, i + 2);
      if (read === null) {
        i += 2;
        continue;
      }
      opened.push(read.heredoc);
      i = read.end;
      continue;
    }
    if (ch === "\n" && opened.length > 0) {
      kept += command.slice(start, i + 1);
      i = skipHeredocBodies(command, i + 1, opened, bodies);
      start = i;
      opened = [];
      continue;
    }
    i += 1;
  }
  return { text: kept + command.slice(start), bodies };
}

/**
 * The bodies a line opened, taken by tag as each `<<` is read.
 *
 * By tag rather than by position, because the collector walks the line and the
 * lexer walks the segments it was split into: a tag names its own body under
 * either walk, and a `<<` whose body is missing is left unreadable rather than
 * handed the next one along.
 */
function heredocQueue(bodies: readonly HeredocBody[]): Map<string, HeredocBody[]> {
  const queue = new Map<string, HeredocBody[]>();
  for (const body of bodies) {
    const held = queue.get(body.tag);
    if (held === undefined) queue.set(body.tag, [body]);
    else held.push(body);
  }
  return queue;
}

/**
 * One shell line, as the commands it runs and the separators between them.
 *
 * Splitting is quote-aware: a separator inside `"…"`, `'…'`, a `$(…)`, a
 * backtick pair or a subshell is part of a command, not a boundary. Heredoc
 * bodies come out before anything else is read, because they are input rather
 * than command text (SCP-174). Line continuations are joined next, because
 * `git branch \<newline> -D main` deletes a branch.
 */
function scanSegments(command: string): {
  texts: string[];
  separators: string[];
  balanced: boolean;
  bodies: HeredocBody[];
} {
  const read = withoutHeredocBodies(command);
  const bodies = read.bodies;
  const text = read.text.replace(/\\\r?\n/g, " ");
  const texts: string[] = [];
  const separators: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  let balanced = true;
  let i = 0;
  const push = (end: number, separator: string) => {
    texts.push(text.slice(start, end));
    separators.push(separator);
    start = end + separator.length;
  };
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
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      const read = readSubstitution(text, i);
      if (read === null) {
        balanced = false;
        break;
      }
      i = read.end;
      continue;
    }
    if (ch === "&" && text[i + 1] === ">") {
      // `&>` redirects both streams; the `&` is part of the operator.
      i += 1;
      continue;
    }
    if (ch === ">") {
      // `>|` is one operator, and the `&` of `2>&1` is part of this one: in
      // neither is the second character a separator.
      i += 1;
      if (text[i] === ">" || text[i] === "|") i += 1;
      if (text[i] === "&") i += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (depth === 0) {
      const operator = readOperator(text, i);
      if (operator !== null) {
        push(i, operator);
        i += operator.length;
        continue;
      }
    }
    i += 1;
  }
  if (quote !== null || depth !== 0) balanced = false;
  texts.push(text.slice(start));
  separators.push("");
  return { texts, separators, balanced, bodies };
}

/** The list `inspectCommand` evaluates its pattern rules against. */
export function splitCommandSegments(command: string): string[] {
  return scanSegments(command)
    .texts.map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Classify one input redirect, `opened` being how many `<` it was written with. */
function stdinSource(
  word: Word,
  opened: number,
  descriptor: boolean,
  raw: string,
  heredocs: Map<string, HeredocBody[]>,
): StdinSource {
  if (descriptor || word.value.length === 0) return { kind: "opaque", raw };
  if (opened === 3) return { kind: "word", word };
  if (opened === 2) {
    const held = heredocs.get(word.value);
    const body = held?.shift();
    if (body === undefined) return { kind: "opaque", raw };
    return { kind: "heredoc", tag: body.tag, expanded: !body.quoted, body: body.body };
  }
  return { kind: "file", word };
}

function tokenize(
  segment: string,
  heredocs: Map<string, HeredocBody[]> = new Map(),
): { items: Item[]; balanced: boolean } {
  const items: Item[] = [];
  let balanced = true;
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i]!;
    if (ch === "\n" || ch === "\r") {
      // A newline ends a command inside `( … )` as it does at the top level,
      // where splitting has already consumed it.
      const operator = readOperator(segment, i);
      items.push({ kind: "operator", text: operator ?? "\n" });
      i += operator?.length ?? 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "&" && segment[i + 1] === ">") {
      // `&>` redirects both streams; the redirect is read from the `>`.
      i += 1;
      continue;
    }
    if (ch === "<") {
      let opened = 1;
      i += 1;
      while (segment[i] === "<" && opened < 3) {
        opened += 1;
        i += 1;
      }
      if (opened === 1 && segment[i] === ">") {
        // `<>` opens the named file for writing as well as for reading.
        i += 1;
      } else {
        // An input redirect names where the command's standard input comes
        // from. Nothing is written through one — and for a command whose
        // program **is** its standard input, it is the only place the line
        // says what that program is.
        const start = i;
        if (opened === 2 && segment[i] === "-") i += 1;
        const descriptor = segment[i] === "&";
        if (descriptor) i += 1;
        while (segment[i] === " " || segment[i] === "\t") i += 1;
        const read = readWord(segment, i);
        if (!read.balanced) balanced = false;
        const raw = `${"<".repeat(opened)}${segment.slice(start, read.end)}`;
        items.push({
          kind: "stdin",
          source: stdinSource(read.word, opened, descriptor, raw, heredocs),
        });
        i = read.end === i ? i + 1 : read.end;
        continue;
      }
    } else if (ch === ">") {
      i += 1;
      if (segment[i] === ">" || segment[i] === "|") i += 1;
      // `2>&1` and `>&-` duplicate a descriptor; they open no file.
      const duplication = /^&\s*(?:\d+|-)(?![\w./-])/.exec(segment.slice(i));
      if (duplication !== null) {
        i += duplication[0].length;
        continue;
      }
      if (segment[i] === "&") i += 1;
    } else if (ch === "(" || ch === ")") {
      items.push({ kind: "word", word: { raw: ch, value: ch, substitutions: [], variable: false } });
      i += 1;
      continue;
    } else if (WORD_BREAK.has(ch)) {
      const operator = readOperator(segment, i);
      if (operator === null) {
        i += 1;
        continue;
      }
      items.push({ kind: "operator", text: operator });
      i += operator.length;
      continue;
    } else {
      const read = readWord(segment, i);
      if (!read.balanced) balanced = false;
      // A bare number written against a redirect operator is the descriptor
      // being redirected — the `2` of `2>&1` — not an operand of the command.
      const descriptor =
        /^\d+$/.test(read.word.value) && (segment[read.end] === ">" || segment[read.end] === "<");
      items.push({
        kind: "word",
        word: descriptor ? { ...read.word, redirect: true } : read.word,
      });
      i = read.end === i ? i + 1 : read.end;
      continue;
    }

    // A redirect operator; its target is the word that follows it.
    while (segment[i] === " " || segment[i] === "\t") i += 1;
    const substitution = /^>?\(/.exec(segment.slice(i));
    if (substitution !== null) {
      const close = segment.indexOf(")", i);
      const end = close === -1 ? segment.length : close + 1;
      items.push({
        kind: "redirect",
        redirect: {
          target: { raw: segment.slice(i, end), value: "", substitutions: [], variable: false },
          reason: "a process substitution",
        },
      });
      i = end;
      continue;
    }
    const read = readWord(segment, i);
    if (!read.balanced) balanced = false;
    items.push({
      kind: "redirect",
      redirect:
        read.word.value.length > 0
          ? { target: read.word, reason: null }
          : { target: null, reason: "the operator has no target" },
    });
    i = read.end === i ? i + 1 : read.end;
  }
  return { items, balanced };
}

/* --------------------------------------------------------------- analysis */

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "busybox"]);
/** Shell syntax that stands before a command and takes no options of its own. */
const KEYWORDS = new Set([
  "(", ")", "{", "}", "&", "!", "if", "then", "else", "elif", "fi", "while",
  "until", "do", "done", "case", "esac", "in",
]);
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
 * A program that runs another program, and the options it takes before naming
 * it. The options matter: without them the first `-flag` after the wrapper
 * reads as the program, and the command it actually runs is never judged.
 *
 * `commands` names an option whose operand is itself a command line. An option
 * in none of the three sets is refused rather than skipped, because skipping it
 * may skip the program name with it.
 */
interface WrapperSpec {
  flags?: readonly string[];
  values?: readonly string[];
  commands?: readonly string[];
  /** Options whose value is a directory the wrapped command runs in. */
  dirs?: readonly string[];
  /** Options refused by name, because their operand hides a command. */
  refuse?: readonly string[];
  /** True where a bare `-5` is an option, as it is for `nice`. */
  numeric?: boolean;
  /** Operands taken before the program, as `timeout` takes a duration. */
  operands?: number;
}

const set = (values: readonly string[] | undefined) => new Set(values ?? []);

const WRAPPERS = new Map<string, WrapperSpec>([
  ["env", {
    flags: ["-i", "-0", "-v", "--ignore-environment", "--null", "--debug", "--help", "--version"],
    values: ["-u", "-a", "--unset"],
    dirs: ["-C", "--chdir"],
    refuse: ["-S", "--split-string"],
  }],
  ["nice", { flags: ["--help", "--version"], values: ["-n", "--adjustment"], numeric: true }],
  ["ionice", { flags: ["-t", "-h", "--help"], values: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid"] }],
  ["stdbuf", { flags: ["--help", "--version"], values: ["-i", "-o", "-e", "--input", "--output", "--error"] }],
  ["time", { flags: ["-p", "-a", "-v", "-q", "--portability", "--append", "--verbose", "--quiet", "--help", "--version"], values: ["-o", "-f", "--output", "--format"] }],
  ["command", { flags: ["-p", "-v", "-V"] }],
  ["builtin", {}],
  ["exec", { flags: ["-c", "-l"], values: ["-a"] }],
  ["nohup", { flags: ["--help", "--version"] }],
  ["sudo", {
    flags: ["-b", "-E", "-e", "-H", "-i", "-K", "-k", "-l", "-n", "-P", "-S", "-s", "-V", "-v", "-A", "--background", "--edit", "--set-home", "--login", "--remove-timestamp", "--list", "--non-interactive", "--preserve-groups", "--stdin", "--shell", "--version", "--validate", "--askpass", "--reset-timestamp"],
    values: ["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u", "-c", "--close-from", "--chdir", "--group", "--host", "--prompt", "--chroot", "--role", "--command-timeout", "--type", "--other-user", "--user"],
  }],
  ["doas", { flags: ["-n", "-s", "-L"], values: ["-a", "-C", "-u"] }],
  ["timeout", {
    flags: ["-f", "-v", "--foreground", "--preserve-status", "--verbose", "--help", "--version"],
    values: ["-s", "-k", "--signal", "--kill-after"],
    operands: 1,
  }],
  ["xargs", {
    flags: ["-0", "-o", "-p", "-r", "-t", "-x", "--null", "--no-run-if-empty", "--interactive", "--open-tty", "--verbose", "--exit", "--help", "--version"],
    values: ["-a", "-d", "-E", "-e", "-I", "-i", "-J", "-L", "-l", "-n", "-P", "-R", "-s", "--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"],
  }],
]);

/**
 * `pnpm`, `npm`, `yarn` and `bun` wrap a command only through `exec`, `dlx` and
 * `x`; `run <script>` names a script this line does not contain, and every
 * other subcommand runs no command of the agent's.
 */
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

const PACKAGE_MANAGER_SPEC: WrapperSpec = {
  flags: [
    "-r", "-s", "-w", "--recursive", "--workspace-root", "--silent", "--stream", "--no-bail",
    "--if-present", "--parallel", "--sequential", "--aggregate-output", "--shell-mode",
    "--no-color", "--color", "--ignore-scripts", "--help", "--version",
  ],
  values: [
    "-F", "--filter", "--filter-prod", "--reporter", "--loglevel", "--use-node-version",
    "--workspace-concurrency", "--resume-from", "--sort", "--workspace",
  ],
  dirs: ["-C", "--dir", "--prefix"],
};

/**
 * The options `pnpm exec`, `npm exec`/`x`, `yarn dlx` and `bun x` take before
 * the program. `-c`, `--shell-mode` and `--call` are pnpm's and npm's shell
 * mode: the operand is a command line, read the way `sh -c`'s is.
 */
const EXEC_SPEC: WrapperSpec = {
  flags: [
    "-r", "-s", "-y", "--recursive", "--parallel", "--sequential", "--silent", "--stream",
    "--no-bail", "--if-present", "--aggregate-output", "--bun", "--yes", "--no-install",
    "--ignore-scripts", "--report-summary", "--reverse", "--sort", "--no-sort", "--color",
    "--no-color", "--shell-auto-fallback", "--help",
  ],
  values: [
    "-p", "-F", "--package", "--filter", "--filter-prod", "--reporter", "--loglevel",
    "--resume-from", "--use-node-version", "--workspace-concurrency", "--workspace", "-w",
  ],
  dirs: ["-C", "--dir", "--prefix"],
  commands: ["-c", "--shell-mode", "--call"],
};

const NPX_SPEC: WrapperSpec = {
  flags: [
    "-y", "-q", "--yes", "--no", "--no-install", "--ignore-existing", "--ignore-scripts",
    "--quiet", "--silent", "--prefer-offline", "--prefer-online", "--offline",
    "--always-spawn", "--shell-auto-fallback", "--help", "--version",
  ],
  values: [
    "-p", "-n", "-w", "--package", "--workspace", "--cache", "--userconfig", "--shell",
    "--node-arg", "--loglevel",
  ],
  dirs: ["--prefix"],
  commands: ["-c", "--call"],
};

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
  /** What the parser could not read but did not refuse, as `CommandSegment.notes`. */
  notes: string[];
  /** A program word this command could not read, as `CommandSegment.unreadablePrograms`. */
  unreadablePrograms: string[];
}

interface Context {
  scope: ResolvedScope;
  cwd: Cwd;
  segment: string;
  depth: number;
  /** Where the command's standard input comes from, where the line says. */
  stdin?: StdinSource | undefined;
}

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
const isAssignment = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);

function describe(label: string, raw: string, destination: Destination): string | null {
  if (destination.kind === "inside") return null;
  if (destination.kind === "outside") {
    return `${label} ${raw} resolves to ${destination.resolved}, outside the worktree`;
  }
  if (destination.kind === "outside_scope") {
    return (
      `${label} ${raw} resolves to ${destination.at}, which this ticket's contract does not ` +
      `admit — ${allowedPathsSentence(destination.allowed)}`
    );
  }
  if (destination.kind === "prohibited_path") {
    return (
      `${label} ${raw} resolves to ${destination.at}, which this ticket's contract prohibits ` +
      `— ${prohibitedPathsSentence(destination.prohibited)}`
    );
  }
  return `${label} ${raw} cannot be resolved — ${destination.reason}`;
}

/** Where a resolved destination landed, for a finding that can name one. */
function landed(destination: Destination): string | null {
  return destination.kind === "outside" ||
    destination.kind === "outside_scope" ||
    destination.kind === "prohibited_path"
    ? destination.resolved
    : null;
}

const ruleOf = (destination: Destination): WriteRule =>
  destination.kind === "prohibited_path"
    ? "write_prohibited_path"
    : destination.kind === "outside_scope"
      ? "write_outside_scope"
      : "write_outside_worktree";

/** A finding about a path, carrying the word it was written as and where it went. */
function pathFinding(
  label: string,
  word: { raw: string; value: string },
  destination: Destination,
  segment: string,
): WriteFinding[] {
  const detail = describe(label, word.raw, destination);
  if (detail === null) return [];
  return [
    {
      detail: `${detail}: ${segment.slice(0, 200)}`,
      target: word.raw,
      resolved: landed(destination),
      rule: ruleOf(destination),
    },
  ];
}

/**
 * Every option a command was given, long names and short letters alike, read
 * before the operands are. A `sed` is only an edit while `-i` is present and a
 * `tar -f` is only a write while `-c` is, and neither question can be answered
 * from the word that stands in front of the option.
 *
 * A value attached to a short cluster contributes its characters as though they
 * were option letters. The set is only ever asked whether an option is present,
 * so the surplus can widen a judgement and never narrow one.
 */
function optionsPresent(rest: readonly Word[]): Set<string> {
  const present = new Set<string>();
  for (const word of rest) {
    const value = word.value;
    if (value === "--") break;
    if (!value.startsWith("-") || value === "-") continue;
    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      present.add(eq === -1 ? value : value.slice(0, eq));
      continue;
    }
    for (const letter of value.slice(1)) present.add(`-${letter}`);
  }
  return present;
}

const any = (options: readonly string[] | undefined, present: Set<string>) =>
  options !== undefined && options.some((option) => present.has(option));

/**
 * A destination on another host: `host:path`, `user@host:path`. It is not a path
 * this guard can resolve and it is not inside the worktree, so it is reported as
 * unresolvable rather than walked as a relative name.
 */
const REMOTE_DESTINATION = /^[^/~.][^/]*:/;

/** Judge the destinations of one writer, given the words after its verb. */
function writerFindings(
  verb: string,
  spec: WriterSpec,
  rest: Word[],
  context: Context,
): WriteFinding[] {
  const present = optionsPresent(rest);
  if (spec.onlyWith !== undefined && !any(spec.onlyWith, present)) return [];
  const takesDestination =
    spec.destinationWith === undefined || any(spec.destinationWith, present);

  const targetDirectories = set(spec.targetDirectory);
  const destinations = takesDestination ? set(spec.destination) : new Set<string>();
  const values = new Set([...set(spec.values), ...(takesDestination ? [] : (spec.destination ?? []))]);
  const everyOperandOptions = set(spec.everyOperand);
  const assignments = set(spec.assignments);

  const written: Array<{ word: Word; label: string }> = [];
  const operands: Word[] = [];
  let targetDirectory: Word | null = null;
  let everyOperand = false;
  let optionsEnded = false;

  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    const value = word.value;
    // A `find … -exec` body ends here, and so does a `{ … }` group.
    if (value === ";" || value === "+" || value === "(" || value === ")") break;
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

  const judge = (word: Word, label: string): WriteFinding[] => {
    const destination: Destination =
      spec.remote === true && REMOTE_DESTINATION.test(word.value)
        ? { kind: "unresolvable", reason: "it names a destination on another host" }
        : judgeTarget(word.value, context.scope, context.cwd, true);
    return pathFinding(label, word, destination, context.segment);
  };

  const findings = written.flatMap(({ word, label }) => judge(word, label));
  if (targetDirectory !== null) {
    return [...findings, ...judge(targetDirectory, `the ${verb} destination`)];
  }
  const skip = spec.skip !== undefined && !any(spec.skipUnless, present) ? spec.skip : 0;
  const remaining = operands.slice(skip);
  if (everyOperand || spec.operands === "all") {
    return [...findings, ...remaining.flatMap((operand) => judge(operand, `the ${verb} target`))];
  }
  if (spec.operands === "last" && remaining.length >= (spec.least ?? 2)) {
    return [...findings, ...judge(remaining[remaining.length - 1]!, `the ${verb} destination`)];
  }
  return findings;
}

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
 */
function linkFindings(rest: Word[], context: Context): WriteFinding[] {
  const present = optionsPresent(rest);
  const symbolic = present.has("-s") || present.has("--symbolic");
  const operands: Word[] = [];
  let targetDirectory: Word | null = null;
  let optionsEnded = false;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    const value = word.value;
    if (value === ";" || value === "+" || value === "(" || value === ")") break;
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

  const judge = (word: Word, label: string, cwd: Cwd): WriteFinding[] =>
    pathFinding(label, word, judgeTarget(word.value, context.scope, cwd, true), context.segment);

  const findings: WriteFinding[] = [];
  // Where the link is made: the `-t` directory, the last operand of a two-part
  // form, or — for a lone target — the directory the command runs in.
  const link = targetDirectory ?? (operands.length >= 2 ? operands[operands.length - 1]! : null);
  const targets =
    link === null || link === targetDirectory ? operands : operands.slice(0, -1);
  if (link !== null) findings.push(...judge(link, "the ln destination", context.cwd));

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

/** Judge the directories a `git` command writes into. */
function gitFindings(rest: Word[], context: Context): WriteFinding[] {
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

  const judge = (word: Word, label: string): WriteFinding[] =>
    pathFinding(
      label,
      word,
      judgeTarget(word.value, context.scope, context.cwd, true),
      context.segment,
    );

  const findings = directories.flatMap((directory) =>
    judge(directory, `the directory git ${verb} works in`),
  );
  // The verbs that name where a repository or a worktree lands. A `clone` with
  // one operand puts it under the directory the command runs in, which the
  // walk below has already judged.
  if (verb === "clone" && operands.length >= 2) {
    findings.push(...judge(operands[operands.length - 1]!, "the git clone destination"));
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
 * An interpreter, and the options that hand it code on the command line.
 *
 * `python3 -c "…"` and `node -e "…"` are a program this guard cannot run and
 * cannot resolve: the code decides at run time where it writes, and no amount of
 * parsing the shell reaches it. What is read here is the code as text — the
 * paths written in it, and whether it writes at all — and either answer refuses,
 * naming the interpreter so the record says which one it was.
 *
 * A script **file** is not this: `node scripts/build.js` runs a file in the
 * worktree that the review reads like any other, and it stays allowed.
 */
interface InterpreterSpec {
  /** Options whose operand is the code to run. */
  code: readonly string[];
  /** A subcommand whose operand is the code, as `deno eval` takes one. */
  subcommand?: string;
  /** True where the first operand is the program, as `awk`'s is. */
  firstOperand?: boolean;
  /** Options that consume the next word, so an operand is not read as code. */
  values?: readonly string[];
  /** Options that supply the program from a file rather than the command line. */
  fromFile?: readonly string[];
}

export const INTERPRETERS = new Map<string, InterpreterSpec>([
  ["node", { code: ["-e", "--eval", "-p", "--print"] }],
  ["nodejs", { code: ["-e", "--eval", "-p", "--print"] }],
  ["deno", { code: ["-e", "--eval"], subcommand: "eval" }],
  ["python", { code: ["-c"] }],
  ["python2", { code: ["-c"] }],
  ["python3", { code: ["-c"] }],
  ["pypy", { code: ["-c"] }],
  ["pypy3", { code: ["-c"] }],
  ["ruby", { code: ["-e"] }],
  ["perl", { code: ["-e", "-E"] }],
  ["php", { code: ["-r"] }],
  ["osascript", { code: ["-e"] }],
  ["awk", {
    code: ["-e", "--source"],
    firstOperand: true,
    values: ["-F", "-v", "--field-separator", "--assign"],
    fromFile: ["-f", "--file", "--exec"],
  }],
  ["gawk", {
    code: ["-e", "--source"],
    firstOperand: true,
    values: ["-F", "-v", "--field-separator", "--assign"],
    fromFile: ["-f", "--file", "--exec"],
  }],
  ["mawk", { code: ["-e"], firstOperand: true, values: ["-F", "-v"], fromFile: ["-f"] }],
  ["nawk", { code: ["-e"], firstOperand: true, values: ["-F", "-v"], fromFile: ["-f"] }],
]);

/**
 * Why a piece of inline code was refused, where the shape is a common one.
 *
 * These no longer decide admission — the allow-list below does that, and it
 * refuses by default — but a refusal an agent can act on says which call earned
 * it. A rule that matches supplies the sentence for a refusal already made, so
 * `open('x','w')` reads as "opens a file for writing" rather than as an
 * unrecognised construct. Order matters only for which sentence is printed.
 *
 * Exported so a test can strip one entry and watch the sentence change.
 */
export const INLINE_WRITE_CALLS: Array<{ id: string; pattern: RegExp; detail: string }> = [
  {
    id: "write-file",
    pattern: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|writeSync|write_text|write_bytes|writeTextFile|writeFileAtomic)\b/,
    detail: "writes a file",
  },
  { id: "stream-write", pattern: /\.\s*write\s*\(/, detail: "writes to a stream it opened" },
  {
    id: "open-for-writing",
    pattern: /\bopen\s*\([^)]*['"][rbtU]*[wax+][rbtU+]*['"]/,
    detail: "opens a file for writing",
  },
  {
    id: "filesystem-call",
    pattern: /\b(?:mkdir|mkdirSync|makedirs|mkdtemp|mkstemp|rmdir|rmtree|copytree|copyfile|copyfileobj|copyFile|copyFileSync|unlink|unlinkSync|rename|renameSync|symlink|symlinkSync|truncate|ftruncate|chmod|chmodSync|chown|chownSync|utime|touch|rmSync|removedirs)\s*\(/,
    detail: "changes the filesystem",
  },
  {
    id: "spawn",
    pattern: /\b(?:system|popen|spawn|spawnSync|execSync|execFile|execFileSync|execvp|Popen|check_call|check_output|posix_spawn)\s*\(/,
    detail: "spawns a process of its own",
  },
  {
    id: "load-fs-module",
    pattern: /\b(?:require|import)\s*\(\s*['"](?:node:)?(?:fs|fs\/promises|child_process|os)['"]/,
    detail: "loads the filesystem or process library",
  },
  {
    id: "import-fs-module",
    pattern: /(?:^|[\n;])\s*(?:import\s+(?:shutil|subprocess|tempfile)\b|from\s+(?:shutil|subprocess|tempfile)\b)/,
    detail: "imports the filesystem or process library",
  },
  // `awk` writes by redirecting inside its own program text.
  { id: "awk-redirect", pattern: /\bprintf?\b[^\n;]*>>?\s*["'(]/, detail: "redirects its output to a file" },
];

/**
 * The file-writing calls this guard reads by their destination (SCP-234).
 *
 * A program that writes is not by itself a program that escapes: `open(p,'w')`
 * on a path inside the worktree leaves the same bytes a redirect into the
 * worktree leaves, and the rule is about where a write lands. So these calls
 * are judged the way a redirect target is — the destination goes through the
 * resolver — and only where the call spells that destination as a literal in
 * the code. A destination the program computes is refused, because there is
 * nothing to resolve; that is the whole scope of this table, and it is not the
 * beginning of a static analyser.
 *
 * `argument` names the operand that holds the path. Null is the shape whose
 * path is on the value the method is called on instead:
 * `Path('notes.md').write_text('x')`.
 *
 * `open` is here for its write modes only. A read mode is decided where it
 * always was, by the read-only table's `file-read` entry.
 *
 * Exported so a test can strip one entry and watch a line's decision flip.
 */
export interface PlainWriteCall {
  /** The entry's name, which the pin test reads. */
  id: string;
  /** The call's last dotted segment, which is how it is recognised. */
  name: string;
  /** The operand that names the path, or null where the receiver does. */
  argument: number | null;
  /** Why this call's destination is readable, in one line. */
  reason: string;
}

export const PLAIN_WRITE_CALLS: PlainWriteCall[] = [
  {
    id: "open-write",
    name: "open",
    argument: 0,
    reason: "`open` in a write mode names the file it opens in the call itself",
  },
  {
    id: "write-file-sync",
    name: "writeFileSync",
    argument: 0,
    reason: "Node's `writeFileSync` names the file it writes first",
  },
  {
    id: "path-write-text",
    name: "write_text",
    argument: null,
    reason: "`Path(<literal>).write_text` names its file on the path object it is called on",
  },
];

/** The receiver `write_text` is read on: a `Path` built from one literal. */
const PATH_RECEIVER = /(?:\bpathlib\s*\.\s*)?\bPath\s*\(\s*(§\d+§)\s*\)\s*\.$/;

/** The streams that are not files, removed before the sentences above are read. */
const INLINE_STREAM_WRITES =
  /\b(?:process\s*\.\s*std(?:out|err)|sys\s*\.\s*std(?:out|err)|console|STDOUT|STDERR|\$stdout|\$stderr)\s*\.\s*write\s*\(/g;

/**
 * A statement form the scan admits whole, once the expression inside it is read.
 *
 * Everything else is an expression statement, which is the ordinary case: the
 * scan reads the calls and the names in it and asks whether the table knows
 * every one.
 */
type InlineStatementForm = "import" | "binding" | "bare-print" | "control";

/**
 * A shape of inline code this guard can show writes nothing, and why.
 *
 * The reading is the other way round from a deny-list: code is refused unless
 * every statement in it matches one of these, because the set of ways a program
 * can write is not enumerable and the set of ways it can be *shown* not to is.
 * A construct no entry names is refused, and the refusal says which construct,
 * so the agent can rewrite the line rather than guess.
 *
 * This is a statement-level scan over the unwrapped source and nothing more. It
 * does not parse Python or JavaScript, it cannot follow a value through a
 * function, and it is not trying to: the question it answers is whether the
 * text stays inside a vocabulary that has no way to reach the filesystem.
 *
 * How a call is judged, which is where the vocabulary earns its keep:
 *
 * - a **dotted** call is allowed when its full name is in `calls`, so
 *   `json.dumps` is on the list and `json.dump` is not, and `os.environ.get`
 *   is on it while `os.remove` never was;
 * - a call on a receiver this scan cannot name — a literal, a subscript, the
 *   result of another call — is judged by its method name against `methods`,
 *   which is why that list carries no name that writes;
 * - a call on a name **bound by an assignment in this same code** falls back to
 *   `methods` too, because the binding's own statement was read; a name bound
 *   by an `import` does not, so a module's attributes always need the full
 *   name. That is the line that keeps `import os` from meaning `os.remove`.
 *
 * Exported so a test can strip one entry and watch a line's decision flip.
 */
export interface InlineReadOnlyRule {
  /** The entry's name, which the pin test reads. */
  id: string;
  /** Why this shape writes nothing, in one line. */
  reason: string;
  /** Callees allowed by their full dotted name, or as a bare function. */
  calls?: readonly string[];
  /** Method names allowed on a receiver this scan cannot name. */
  methods?: readonly string[];
  /** Bare names allowed as values, matched whole or as a dotted prefix. */
  names?: readonly string[];
  /** Modules an `import` or a `require` may name. */
  modules?: readonly string[];
  /** Statement forms this entry admits. */
  forms?: readonly InlineStatementForm[];
}

export const INLINE_READ_ONLY: InlineReadOnlyRule[] = [
  {
    id: "printing",
    reason: "printing sends bytes to a stream, and a stream is not a file",
    calls: [
      "print", "printf", "puts", "p", "pp", "pprint", "echo", "say", "var_dump", "print_r",
      "console.log", "console.info", "console.debug", "console.warn", "console.error",
      "console.dir", "console.table",
      "process.stdout.write", "process.stderr.write",
      "sys.stdout.write", "sys.stderr.write", "sys.stdout.flush", "sys.stderr.flush",
      "STDOUT.puts", "STDERR.puts", "$stdout.puts", "$stderr.puts",
    ],
    forms: ["bare-print"],
  },
  {
    id: "arithmetic-and-strings",
    reason: "arithmetic and string work happens in memory and names no path",
    calls: [
      "len", "str", "int", "float", "bool", "repr", "abs", "round", "min", "max", "sum",
      "sorted", "list", "dict", "set", "tuple", "range", "enumerate", "zip", "chr", "ord",
      "format", "String", "Number", "Boolean", "Array", "Array.from", "Array.isArray",
      "Object.keys", "Object.values", "Object.entries", "parseInt", "parseFloat",
      "Math.floor", "Math.ceil", "Math.round", "Math.abs", "Math.max", "Math.min",
      "Math.pow", "Math.sqrt", "re.match", "re.search", "re.findall", "re.sub", "re.split",
    ],
    // No name here writes. `replace` is absent on purpose: it is a string method
    // in one language and `Path.replace`, which renames a file, in another.
    methods: [
      "join", "split", "splitlines", "strip", "lstrip", "rstrip", "trim", "trimStart",
      "trimEnd", "upper", "lower", "toUpperCase", "toLowerCase", "title", "capitalize",
      "format", "startswith", "endswith", "startsWith", "endsWith", "includes", "indexOf",
      "lastIndexOf", "index", "count", "find", "slice", "substring", "padStart", "padEnd",
      "repeat", "toString", "toFixed", "charAt", "keys", "values", "items", "entries",
      "get", "sort", "reverse", "concat", "at", "encode", "decode", "toJSON", "valueOf",
    ],
    // `NF` and the rest are what an `awk` program reads; `$1` is handled as a
    // literal-like token, being a field reference rather than a name.
    names: ["NF", "NR", "FS", "OFS", "RS", "ORS", "FILENAME", "ARGV", "ARGC"],
  },
  {
    id: "json",
    reason: "parsing JSON reads text and builds a value; it opens nothing itself",
    // `json.dump` and `JSON` writers are absent: `dump` takes a file object.
    calls: ["JSON.parse", "JSON.stringify", "json.loads", "json.dumps", "json.load"],
  },
  {
    id: "file-read",
    reason:
      "reading a file names a path, and the pass above already resolved every path in " +
      "this code against the root; a mode that is not a read mode is refused here",
    calls: [
      "open", "readFileSync", "fs.readFileSync", "Path", "pathlib.Path",
      "sys.stdin.read", "sys.stdin.readlines", "sys.stdin.readline",
      "process.stdin.read", "$stdin.read", "STDIN.read",
    ],
    methods: [
      "read", "readline", "readlines", "read_text", "read_bytes", "exists", "is_file",
      "is_dir", "resolve", "glob", "iterdir", "stat",
    ],
  },
  {
    id: "environment",
    reason: "a version or an environment lookup answers a question and changes nothing",
    calls: [
      "os.environ.get", "os.getenv", "os.getcwd", "os.path.join", "os.path.exists",
      "os.path.basename", "os.path.dirname", "os.path.abspath", "os.path.isfile",
      // `platform.system` is absent though it only reports the OS name: a table
      // this one is read for safety should not carry a segment called `system`,
      // and `platform.python_version` answers the question that gets asked.
      "os.path.isdir", "platform.machine", "platform.python_version", "platform.release",
      "process.cwd", "process.memoryUsage", "process.uptime", "path.join", "path.resolve",
      "path.basename", "path.dirname", "util.inspect",
    ],
    names: [
      "process.version", "process.versions", "process.platform", "process.arch",
      "process.pid", "process.env", "process.argv", "process.execPath",
      "sys.version", "sys.version_info", "sys.platform", "sys.argv", "sys.executable",
      "sys.maxsize", "sys.path", "os.environ", "os.sep", "os.linesep", "os.name",
      "os.curdir", "RUBY_VERSION", "RUBY_PLATFORM", "PHP_VERSION", "ENV",
    ],
  },
  {
    id: "imports",
    reason:
      "importing a module on this list neither names a file nor writes one; what the " +
      "module then exposes is still judged call by call, which is why `os` can be here",
    calls: ["require"],
    modules: [
      "json", "sys", "re", "math", "pathlib", "platform", "os", "string", "textwrap",
      "decimal", "path", "node:path", "util", "node:util",
    ],
    forms: ["import"],
  },
  {
    id: "binding",
    reason: "binding a name to a read-only expression carries its answer, not a new power",
    forms: ["binding"],
  },
  {
    id: "control-flow",
    reason:
      "a `for`, an `if` or a `while` chooses which statements run and calls nothing of " +
      "its own; what it decides on is an expression read like any other, and each " +
      "statement it guards is read on its own",
    forms: ["control"],
  },
];

/**
 * A control-flow header, which is syntax rather than vocabulary.
 *
 * SCP-234's round was lost to a scan that read `for` as a name it had never
 * heard of and called the program unclassifiable for it. The keyword names
 * nothing and calls nothing; the expression after it is read like any other,
 * and the names a `for` binds are bound by `assignedNames` below.
 */
const INLINE_CONTROL = /^(for|while|if|elif|else)\b([\s\S]*)$/;

/**
 * The languages this guard tells apart, which is as far as its reading goes.
 *
 * One question turns on it and one only: a backtick. In JavaScript it opens a
 * template literal, which is a string. In Perl, Ruby and PHP it runs a shell
 * command, which is the thing this guard exists to refuse.
 */
type InlineLanguage = "js" | "python" | "shellish" | "other";

function inlineLanguage(verb: string): InlineLanguage {
  if (verb === "node" || verb === "nodejs" || verb === "deno" || verb === "bun") return "js";
  if (verb.startsWith("python") || verb.startsWith("pypy")) return "python";
  if (verb === "perl" || verb === "ruby" || verb === "php") return "shellish";
  return "other";
}

/**
 * The code as the agent typed it, with only the quoting that wrapped it removed.
 *
 * The lexer removes every quote, which is right for a path and wrong for a
 * program: `open('/etc/x','w')` arrives as `open(/etc/x,w)`, and the two string
 * literals that say what it opens and how are gone with them. Inline code is
 * read from the raw word for that reason, unwrapped once so the quoting the
 * shell used to carry it does not count as a literal of its own.
 */
function unwrapped(raw: string): string {
  let text = raw;
  while (text.length >= 2) {
    const first = text[0]!;
    // Quotes only. A backtick is not shell quoting — it is a command
    // substitution, which the lexer marks and this function never sees — and in
    // Perl, Ruby and PHP a backtick pair around the whole program is the spawn
    // this guard exists to refuse, not wrapping to be taken off.
    if ((first === '"' || first === "'") && text.endsWith(first)) {
      text = text.slice(1, -1);
      continue;
    }
    const second = text[1];
    if (first === "$" && (second === "'" || second === '"') && text.endsWith(second)) {
      text = text.slice(2, -1);
      continue;
    }
    break;
  }
  return text;
}

/** The quoted strings in a piece of source, whatever quote the language uses. */
function stringLiterals(code: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < code.length) {
    const quote = code[i]!;
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      i += 1;
      continue;
    }
    let value = "";
    let j = i + 1;
    while (j < code.length && code[j] !== quote) {
      if (code[j] === "\\") {
        value += code[j + 1] ?? "";
        j += 2;
        continue;
      }
      value += code[j];
      j += 1;
    }
    found.push(value);
    i = j + 1;
  }
  return found;
}

/**
 * The source with every string literal replaced by a token that stands for it.
 *
 * The scan below reads structure, and a literal is the one place where the
 * text is data rather than code: a `>` inside a string is not a redirect, and
 * `rm -rf /` inside one is not a command. Masking them first is what lets the
 * rest of the scan be a plain character-and-name check. The literals are kept
 * so the two places that need to see one — a file mode and a module name — can.
 */
function maskLiterals(
  code: string,
  language: InlineLanguage,
): { masked: string; literals: string[]; spawned: boolean } {
  const literals: string[] = [];
  let masked = "";
  let spawned = false;
  let i = 0;
  while (i < code.length) {
    const quote = code[i]!;
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      masked += quote;
      i += 1;
      continue;
    }
    let value = "";
    let j = i + 1;
    while (j < code.length && code[j] !== quote) {
      if (code[j] === "\\") {
        value += code[j + 1] ?? "";
        j += 2;
        continue;
      }
      value += code[j];
      j += 1;
    }
    if (quote === "`" && language !== "js") {
      // Perl, Ruby and PHP run what is between backticks. The backtick is kept
      // so the expression check trips on it, and named so the refusal says why.
      spawned = true;
      masked += "`";
    } else {
      masked += `§${literals.length}§`;
      literals.push(value);
    }
    i = j + 1;
  }
  return { masked, literals, spawned };
}

/** Everything after a comment marker on each line, which runs nothing. */
function withoutComments(masked: string, language: InlineLanguage): string {
  return masked
    .split("\n")
    .map((line) => {
      // `#` opens a comment everywhere but JavaScript; `//` only in JavaScript,
      // because in Python it is floor division.
      const cut = language === "js" ? line.indexOf("//") : line.indexOf("#");
      return cut === -1 ? line : line.slice(0, cut);
    })
    .join("\n");
}

/** The statements in a masked source: a `;` or a newline at nesting depth zero. */
function splitStatements(masked: string): string[] {
  const statements: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of masked) {
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (depth <= 0 && (character === ";" || character === "\n")) {
      statements.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== "");
}

/** The vocabulary the table adds up to, read once per piece of code. */
interface InlineVocabulary {
  calls: Set<string>;
  methods: Set<string>;
  names: string[];
  modules: Set<string>;
  forms: Set<InlineStatementForm>;
}

function inlineVocabulary(): InlineVocabulary {
  const vocabulary: InlineVocabulary = {
    calls: new Set(),
    methods: new Set(),
    names: [],
    modules: new Set(),
    forms: new Set(),
  };
  for (const rule of INLINE_READ_ONLY) {
    for (const name of rule.calls ?? []) vocabulary.calls.add(name);
    for (const name of rule.methods ?? []) vocabulary.methods.add(name);
    for (const name of rule.names ?? []) vocabulary.names.push(name);
    for (const name of rule.modules ?? []) vocabulary.modules.add(name);
    for (const form of rule.forms ?? []) vocabulary.forms.add(form);
  }
  return vocabulary;
}

/**
 * Syntax rather than vocabulary: words that are part of how an expression is
 * written and name nothing the code can call.
 */
const INLINE_KEYWORDS = new Set([
  "in", "not", "and", "or", "is", "if", "else", "of", "as", "from",
  // Declaration syntax: it introduces a name rather than reading one, and a
  // JavaScript `for (const x of y)` header carries it.
  "const", "let", "var",
  "true", "false", "null", "undefined", "True", "False", "None", "nil",
  "NaN", "Infinity", "self", "this",
]);

/**
 * The keywords that can stand immediately before a parenthesis, where the
 * parenthesis groups an expression rather than making the word a callee:
 * `i['id'] in ('a', 'b')`, `not (a or b)`. Nothing on this list can be called,
 * so a match in call position is syntax and is read as one.
 */
const INLINE_OPERATOR_KEYWORDS = new Set([
  "in", "not", "and", "or", "is", "if", "else", "of", "as", "from",
]);

/** What a read-only expression may be spelled with, once literals are masked. */
const INLINE_EXPRESSION_CHARACTERS = /^[A-Za-z0-9_$§.,()[\]{}+\-*/%:!=?\s]*$/;

/** A dotted name in call position, and a dotted name in value position. */
const INLINE_CALL = /([A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g;
const INLINE_NAME = /[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*/g;

/** The top-level arguments of the call whose name starts at `from`. */
function callArguments(masked: string, from: number): string[] {
  const start = masked.indexOf("(", from);
  if (start === -1) return [];
  let depth = 0;
  const args: string[] = [];
  let current = "";
  for (let i = start; i < masked.length; i += 1) {
    const character = masked[i]!;
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      if (depth === 1) continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args.map((argument) => argument.trim());
      }
    }
    if (depth === 1 && character === ",") {
      args.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  return args.map((argument) => argument.trim());
}

/** The literal an argument is, where it is one. */
function literalArgument(argument: string, literals: string[]): string | null {
  const match = /^§(\d+)§$/.exec(argument);
  if (match === null) return null;
  return literals[Number(match[1])] ?? null;
}

/** A read mode, which is every mode that is not a write: `r`, `rb`, `rt`, none. */
const READ_MODE = /^[rbtU]*$/;

/**
 * Whether a call the table admitted names something the table cannot admit
 * after all: an `open` in a write mode, a `require` of a module off the list.
 */
function guardedCall(
  name: string,
  masked: string,
  at: number,
  literals: string[],
  vocabulary: InlineVocabulary,
): string | null {
  const last = name.split(".").pop()!;
  if (last === "open") {
    const args = callArguments(masked, at);
    const mode = args[1];
    if (mode === undefined) return null;
    const literal = literalArgument(mode, literals);
    if (literal !== null && READ_MODE.test(literal)) return null;
    return `\`${name}\` is given a mode this guard cannot read as a read mode`;
  }
  if (last === "require") {
    const args = callArguments(masked, at);
    const module = args[0] === undefined ? null : literalArgument(args[0], literals);
    if (module !== null && vocabulary.modules.has(module)) return null;
    return "`require` names a module that is not on the read-only list";
  }
  return null;
}

/**
 * The destination a plain write call names, where the call is one (SCP-234).
 *
 * Three answers. `null` is "not a write this table reads", which is every call
 * the scan judges the way it always did — an `open` in a read mode included. A
 * `reason` is a write whose destination this guard cannot read as a literal
 * path, and that refuses. A `target` is a write to a literal, and where that
 * literal lands is the path pass's question rather than this one's.
 */
function plainWrite(
  name: string,
  masked: string,
  at: number,
  literals: string[],
): { target: string } | { reason: string } | null {
  const last = name.split(".").pop()!;
  const rule = PLAIN_WRITE_CALLS.find((entry) => entry.name === last);
  if (rule === undefined) return null;
  const args = callArguments(masked, at);
  if (rule.name === "open") {
    // A read mode, or a mode this scan cannot read at all, is not a write it
    // can place: `guardedCall` answers for both, in the sentence it always used.
    const mode = args[1];
    if (mode === undefined) return null;
    const literal = literalArgument(mode, literals);
    if (literal === null || READ_MODE.test(literal)) return null;
  }
  const spelled =
    rule.argument === null
      ? PATH_RECEIVER.exec(masked.slice(0, at).trimEnd())?.[1]
      : args[rule.argument];
  const target = spelled === undefined ? null : literalArgument(spelled, literals);
  if (target === null) {
    return {
      reason: `\`${name}\` writes to a destination this guard cannot read as a literal path`,
    };
  }
  return { target };
}

/**
 * Whether an expression stays inside the table's vocabulary, and what it was
 * that did not.
 *
 * `destinations` collects the literal path every plain write call names, for
 * the pass that resolves them. It is filled as the scan walks, so a scan that
 * stops at a construct it cannot read leaves behind only what it had read by
 * then — which is all the caller needs, the line being refused either way.
 */
function unreadableExpression(
  expression: string,
  vocabulary: InlineVocabulary,
  bound: Set<string>,
  literals: string[],
  destinations: string[],
): string | null {
  const text = expression.trim();
  if (text === "") return null;
  if (!INLINE_EXPRESSION_CHARACTERS.test(text)) {
    const offending = [...text].find(
      (character) => !INLINE_EXPRESSION_CHARACTERS.test(character),
    );
    return offending === "`"
      ? "a backtick runs a shell command"
      : `\`${offending}\` is not a character a read-only expression may contain`;
  }
  // The calls first, then the same text with each call's name blanked, so a
  // callee is never read a second time as a bare value.
  let remaining = text;
  const blank = (from: number, width: number) => {
    remaining = remaining.slice(0, from) + " ".repeat(width) + remaining.slice(from + width);
  };
  INLINE_CALL.lastIndex = 0;
  let match = INLINE_CALL.exec(text);
  while (match !== null) {
    const name = match[1]!.replace(/\s+/g, "");
    const segments = name.split(".");
    const before = text.slice(0, match.index).trimEnd();
    if (INLINE_OPERATOR_KEYWORDS.has(name)) {
      blank(match.index, match[1]!.length);
      match = INLINE_CALL.exec(text);
      continue;
    }
    // A plain write to a literal path is a shape this guard reads, whatever the
    // table makes of the name: the destination is what decides it, and the pass
    // that resolves paths answers that.
    const plain = plainWrite(name, text, match.index, literals);
    if (plain !== null) {
      if ("reason" in plain) return plain.reason;
      destinations.push(plain.target);
      blank(match.index, match[1]!.length);
      match = INLINE_CALL.exec(text);
      continue;
    }
    // A method on a receiver this scan cannot name — a literal, a subscript,
    // the result of another call — is judged by its method name alone.
    const onUnnamedReceiver = segments.length === 1 && before.endsWith(".");
    const onBoundName = segments.length > 1 && bound.has(segments[0]!);
    const known = vocabulary.calls.has(name)
      ? true
      : (onUnnamedReceiver || onBoundName) && vocabulary.methods.has(segments[segments.length - 1]!);
    if (!known) return `\`${name}\` is not a call the read-only table names`;
    const guard = guardedCall(name, text, match.index, literals, vocabulary);
    if (guard !== null) return guard;
    blank(match.index, match[1]!.length);
    match = INLINE_CALL.exec(text);
  }
  INLINE_NAME.lastIndex = 0;
  let name = INLINE_NAME.exec(remaining);
  while (name !== null) {
    const dotted = name[0].replace(/\s+/g, "");
    const segments = dotted.split(".");
    const allowed =
      INLINE_KEYWORDS.has(dotted) ||
      // A key in an object literal, or a label: a word in the position where a
      // value's name is written, naming nothing the code can reach.
      /^\s*:/.test(remaining.slice(name.index + name[0].length)) ||
      // A keyword argument's label — `json.dumps(x, indent=2)`. It names a
      // parameter of the call it sits in, not a value this code can reach; a
      // statement that is itself an assignment was read as a binding before it
      // reached here.
      /^\s*=(?![=>])/.test(remaining.slice(name.index + name[0].length)) ||
      bound.has(segments[0]!) ||
      // A field reference (`$1`) or a variable read (`$path`) is a value, and
      // reading a value writes nothing.
      dotted.startsWith("$") ||
      vocabulary.names.some(
        (known) => dotted === known || dotted.startsWith(`${known}.`),
      );
    if (!allowed) return `\`${dotted}\` is not a name the read-only table knows`;
    name = INLINE_NAME.exec(remaining);
  }
  return null;
}

/**
 * The names a `for` header introduces, in either language's spelling — `for i
 * in xs:` and `for (const x of xs) {`. A loop variable is a name this code
 * binds, so the scan reads it as its own rather than as a word off the table.
 */
function loopTargets(statement: string): string[] {
  const header = /^for\s*\(?\s*(?:const\s+|let\s+|var\s+)?([^()]*?)\s+(?:in|of)\s/.exec(
    statement.trim(),
  );
  if (header === null) return [];
  return header[1]!
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part));
}

/** The names this code binds by assignment or by a loop, read as its own. */
function assignedNames(statements: readonly string[]): Set<string> {
  const bound = new Set<string>();
  for (const statement of statements) {
    for (const target of loopTargets(statement)) bound.add(target);
    const declared = /^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(statement);
    if (declared !== null) {
      bound.add(declared[1]!);
      continue;
    }
    const assigned = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?![=>])/.exec(statement);
    if (assigned !== null) bound.add(assigned[1]!);
  }
  return bound;
}

/** The names an `import` statement introduces, whatever language wrote it. */
function importedNames(statement: string): string[] {
  const python = /^import\s+(.+)$/.exec(statement);
  if (python !== null) {
    return python[1]!.split(",").map((part) => {
      const words = part.trim().split(/\s+as\s+/);
      return (words[1] ?? words[0] ?? "").trim().split(".")[0] ?? "";
    });
  }
  const from = /^from\s+[\w.]+\s+import\s+(.+)$/.exec(statement);
  if (from !== null) {
    return from[1]!.split(",").map((part) => {
      const words = part.trim().split(/\s+as\s+/);
      return (words[1] ?? words[0] ?? "").trim();
    });
  }
  return [];
}

/**
 * Whether an `import`, a `from … import` or a `require` names only modules the
 * table calls read-only, and which one did not.
 */
function unreadableImport(
  statement: string,
  literals: string[],
  vocabulary: InlineVocabulary,
): string | null {
  const off = (module: string) => `\`${module}\` is not a module on the read-only list`;
  const python = /^import\s+(.+)$/.exec(statement);
  if (python !== null) {
    for (const part of python[1]!.split(",")) {
      const module = part.trim().split(/\s+as\s+/)[0]!.trim();
      // A masked literal here is a JavaScript `import '…'`, whose module is the
      // literal rather than the word.
      const literal = literalArgument(module, literals);
      const named = literal ?? module.split(".")[0]!;
      if (!vocabulary.modules.has(named)) return off(named);
    }
    return null;
  }
  const from = /^from\s+([\w.§]+)\s+import\s+/.exec(statement);
  if (from !== null) {
    const literal = literalArgument(from[1]!, literals);
    const named = literal ?? from[1]!.split(".")[0]!;
    return vocabulary.modules.has(named) ? null : off(named);
  }
  const required = /^(?:require|use)\s+(§\d+§|[\w:.]+)\s*$/.exec(statement);
  if (required !== null) {
    const named = literalArgument(required[1]!, literals) ?? required[1]!;
    return vocabulary.modules.has(named) ? null : off(named);
  }
  return `\`${statement.split(/\s+/)[0] ?? statement}\` is not an import shape this guard reads`;
}

/**
 * Whether one statement is a shape the table admits, and what it was that the
 * table did not know.
 *
 * An `awk` program arrives as `<pattern> { <statements> }`, so a statement that
 * is a braced block is unwrapped and its contents read the same way.
 */
function unreadableStatement(
  statement: string,
  vocabulary: InlineVocabulary,
  bound: Set<string>,
  literals: string[],
  destinations: string[],
  depth = 0,
): string | null {
  const text = statement.trim();
  if (text === "") return null;
  const block = /^([^{}]*)\{([\s\S]*)\}$/.exec(text);
  if (block !== null && depth < 4) {
    const pattern = unreadableHeader(block[1]!, vocabulary, bound, literals, destinations);
    if (pattern !== null) return pattern;
    for (const inner of splitStatements(block[2]!)) {
      const found = unreadableStatement(
        inner,
        vocabulary,
        bound,
        literals,
        destinations,
        depth + 1,
      );
      if (found !== null) return found;
    }
    return null;
  }
  if (INLINE_CONTROL.test(text)) {
    return unreadableHeader(text, vocabulary, bound, literals, destinations);
  }
  if (/^(?:import|from|require|use)\b/.test(text)) {
    if (!vocabulary.forms.has("import")) {
      return "an import is not a shape the read-only table admits";
    }
    return unreadableImport(text, literals, vocabulary);
  }
  const binding =
    /^(?:(?:const|let|var)\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?![=>])([\s\S]*)$/.exec(text);
  if (binding !== null) {
    if (!vocabulary.forms.has("binding")) {
      return "a binding is not a shape the read-only table admits";
    }
    return unreadableExpression(binding[2]!, vocabulary, bound, literals, destinations);
  }
  // `print $1`, `puts 1 + 1`, `print 1`: the languages that print without
  // parentheses. The rest of the line is an expression like any other.
  const printed = /^(print|printf|puts|say|echo|p|pp)\b([\s\S]*)$/.exec(text);
  if (printed !== null && !text.startsWith(`${printed[1]!}(`)) {
    if (!vocabulary.forms.has("bare-print")) {
      return `\`${printed[1]!}\` without parentheses is not a shape the read-only table admits`;
    }
    return unreadableExpression(printed[2]!, vocabulary, bound, literals, destinations);
  }
  return unreadableExpression(text, vocabulary, bound, literals, destinations);
}

/**
 * A control-flow header, or an `awk` pattern, read as the expression it decides
 * on. The keyword in front of it is syntax: it calls nothing and names nothing,
 * and the names a `for` binds were bound before the scan reached here.
 */
function unreadableHeader(
  header: string,
  vocabulary: InlineVocabulary,
  bound: Set<string>,
  literals: string[],
  destinations: string[],
): string | null {
  let text = header.trim();
  const control = INLINE_CONTROL.exec(text);
  if (control !== null) {
    if (!vocabulary.forms.has("control")) {
      return `\`${control[1]!}\` is not a shape the read-only table admits`;
    }
    text = control[2]!.trim();
  }
  if (text.endsWith(":")) text = text.slice(0, -1);
  return unreadableExpression(text, vocabulary, bound, literals, destinations);
}

/**
 * Read a piece of inline code: whether it is a shape this guard can account
 * for, and the literal destinations of the plain writes it makes.
 *
 * `construct` is what stopped the scan, or `null` where every statement was a
 * shape the table names. `destinations` are the paths the plain write calls
 * spelled; where each of them lands is the path pass's question.
 */
function readInlineCode(
  source: string,
  language: InlineLanguage,
): { construct: string | null; destinations: string[] } {
  const destinations: string[] = [];
  const { masked, literals, spawned } = maskLiterals(source, language);
  if (spawned) return { construct: "a backtick runs a shell command", destinations };
  const vocabulary = inlineVocabulary();
  const statements = splitStatements(withoutComments(masked, language));
  const bound = assignedNames(statements);
  for (const statement of statements) {
    for (const name of importedNames(statement)) {
      if (name !== "") bound.add(name);
    }
  }
  for (const statement of statements) {
    const found = unreadableStatement(statement, vocabulary, bound, literals, destinations);
    if (found !== null) return { construct: found, destinations };
  }
  return { construct: null, destinations };
}

/**
 * Judge one piece of inline code, given the interpreter and option that took it.
 *
 * Two passes, in this order. The first reads the paths written in the code and
 * refuses one that resolves outside the root, which is the same question a
 * redirect target is asked. The second asks whether the code is a shape the
 * table above can show writes nothing, and refuses it when it is not — which is
 * every shape the table does not name, that being the point. Only the sentence
 * a refusal carries is still drawn from the write-call list.
 */
function inlineCodeFindings(
  verb: string,
  how: string,
  code: Word,
  context: Context,
  cwd: Cwd,
): WriteFinding[] {
  const tail = `: ${context.segment.slice(0, 200)}`;
  if (code.variable || code.substitutions.length > 0) {
    return [
      {
        detail:
          `the code passed to ${how} cannot be read — it is built at run time${tail}`,
        target: null,
        resolved: null,
        cause: "unreadable_program",
      },
    ];
  }
  const findings: WriteFinding[] = [];
  const source = unwrapped(code.raw.length > 0 ? code.raw : code.value);
  const read = readInlineCode(source, inlineLanguage(verb));
  // Every path the code spells: the ones written like paths, and the
  // destination of every plain write call — which is a path however short it
  // looks, `notes.md` as much as `/etc/hosts` (SCP-234).
  const paths = stringLiterals(source).filter(
    (literal) => literal.includes("/") || literal.startsWith("~"),
  );
  const judged = new Set<string>();
  // A path in the code is a path on disk, not shell text: a `~` or a `$` in it
  // is a character the interpreter reads literally.
  for (const literal of [...paths, ...read.destinations]) {
    if (judged.has(literal)) continue;
    judged.add(literal);
    const destination = judgeTarget(literal, context.scope, cwd, false);
    if (destination.kind === "inside") continue;
    findings.push({
      detail:
        destination.kind === "outside"
          ? `the path ${literal} in the code passed to ${how} resolves to ` +
            `${destination.resolved}, outside the worktree${tail}`
          : destination.kind === "outside_scope"
            ? `the path ${literal} in the code passed to ${how} resolves to ${destination.at}, ` +
              `which this ticket's contract does not admit — ` +
              `${allowedPathsSentence(destination.allowed)}${tail}`
            : destination.kind === "prohibited_path"
              ? `the path ${literal} in the code passed to ${how} resolves to ${destination.at}, ` +
                `which this ticket's contract prohibits — ` +
                `${prohibitedPathsSentence(destination.prohibited)}${tail}`
              : `the path ${literal} in the code passed to ${how} cannot be resolved — ` +
                `${destination.reason}${tail}`,
      target: literal,
      resolved: landed(destination),
      rule: ruleOf(destination),
      cause: "outside_target",
    });
  }
  if (read.construct === null) return findings;
  const text = source.replace(INLINE_STREAM_WRITES, "");
  const named = INLINE_WRITE_CALLS.find((rule) => rule.pattern.test(text));
  findings.push({
    detail:
      named !== undefined
        ? `the code passed to ${how} ${named.detail}, which this guard cannot resolve ` +
          `to a destination${tail}`
        : `the code passed to ${how} is not a shape this guard can show writes nothing — ` +
          `${read.construct}${tail}`,
    target: null,
    resolved: null,
    cause: "unreadable_program",
  });
  return findings;
}

/** Find the inline code one interpreter invocation carries, and judge it. */
function interpreterFindings(
  verb: string,
  spec: InterpreterSpec,
  rest: Word[],
  context: Context,
): { findings: WriteFinding[]; program: boolean; operands: Word[] } {
  const code = set(spec.code);
  const values = set(spec.values);
  const findings: WriteFinding[] = [];
  const operands: Word[] = [];
  let optionsEnded = false;
  let subcommand = false;
  /** True once the command line has said what the interpreter runs. */
  let program = any(spec.fromFile, optionsPresent(rest));
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    const value = word.value;
    if (value === ";" || value === "+" || value === "(" || value === ")") break;
    if (!optionsEnded) {
      if (value === "--") {
        optionsEnded = true;
        continue;
      }
      if (value.startsWith("-") && value !== "-") {
        const eq = value.indexOf("=");
        const name = eq === -1 ? value : value.slice(0, eq);
        const attached = eq === -1 ? null : value.slice(eq + 1);
        const take = (): Word | undefined => {
          if (attached !== null) {
            // The raw carries the quoting the code was written with, which is
            // what `inlineCodeFindings` reads; the `=` is found in it too.
            const at = word.raw.indexOf("=");
            return { ...word, raw: at === -1 ? attached : word.raw.slice(at + 1), value: attached };
          }
          i += 1;
          return rest[i];
        };
        if (code.has(name)) {
          program = true;
          const operand = take();
          if (operand !== undefined) {
            findings.push(...inlineCodeFindings(verb, `${verb} ${name}`, operand, context, context.cwd));
          }
          continue;
        }
        // A short option carrying its code with no space: `python3 -c'…'` is
        // one word by the time the lexer has removed the quotes.
        const short = code.has(value.slice(0, 2)) ? value.slice(0, 2) : null;
        if (short !== null && value.length > 2) {
          program = true;
          const inline = value.slice(2);
          findings.push(
            ...inlineCodeFindings(
              verb,
              `${verb} ${short}`,
              { ...word, raw: word.raw.slice(2), value: inline },
              context,
              context.cwd,
            ),
          );
          continue;
        }
        if (values.has(name)) take();
        continue;
      }
      if (spec.subcommand !== undefined && !subcommand && value === spec.subcommand) {
        subcommand = true;
        program = true;
        const operand = rest[i + 1];
        if (operand !== undefined) {
          i += 1;
          findings.push(
            ...inlineCodeFindings(verb, `${verb} ${spec.subcommand}`, operand, context, context.cwd),
          );
        }
        continue;
      }
    }
    operands.push(word);
  }
  // `awk 'program' file…`: the program is the first operand, unless an option
  // already supplied one or named a file to read it from.
  if (
    spec.firstOperand === true &&
    findings.length === 0 &&
    !any(spec.fromFile, optionsPresent(rest)) &&
    !any(spec.code, optionsPresent(rest)) &&
    operands.length > 0
  ) {
    program = true;
    findings.push(...inlineCodeFindings(verb, `${verb}`, operands.shift()!, context, context.cwd));
  }
  return { findings, program, operands };
}

/**
 * What an interpreter runs when its command line did not say — and what that
 * makes of the invocation.
 *
 * The `-c` reading above is one source of a program among several. Standard
 * input is the rest of them: a heredoc body, a here-string, the stage before it
 * in a pipeline. Each carries code on the line exactly as `-c` does, decides at
 * run time where it writes exactly as `-c` does, and so is read exactly as `-c`
 * is — and one this guard cannot read at all refuses, naming the interpreter,
 * because "some inline code wrote something" is not a record anyone can act on.
 *
 * A **file** is the exception, and the same exception `node scripts/build.js`
 * has always had: `python3 < setup.py` and `cat setup.py | python3` run a file,
 * and a file is read by whoever reads files — the review inside the worktree,
 * nobody outside it. That is the line docs/08 draws, and it is drawn there
 * rather than here.
 */
function programSourceFindings(
  verb: string,
  operands: readonly Word[],
  context: Context,
  cwd: Cwd,
): WriteFinding[] {
  const tail = `: ${context.segment.slice(0, 200)}`;
  // `python3 script.py`, `node build.js`: a file, and files are not read here.
  // A lone `-` is the operand that says the program is on standard input.
  const script = operands[0];
  if (script !== undefined && script.value !== "-") return [];

  const source = context.stdin;
  if (source === undefined) {
    // Nothing on the line says the interpreter was given a program at all:
    // `python3 --version` runs none.
    return [];
  }
  const how = `${verb} on standard input`;
  switch (source.kind) {
    case "heredoc":
      return inlineCodeFindings(
        verb,
        how,
        {
          raw: source.body,
          value: source.body,
          substitutions: [],
          // An unquoted tag lets the shell build the body before the
          // interpreter sees it, and then the line does not say what runs.
          variable: source.expanded && /[$`]/.test(source.body),
        },
        context,
        cwd,
      );
    case "word":
      return inlineCodeFindings(verb, how, source.word, context, cwd);
    case "file":
      return [];
    case "pipe": {
      const piped = pipedProgram(source.producer);
      if (piped.kind === "unreadable") {
        return [
          {
            detail: `the code piped into ${verb} cannot be read — ${piped.reason}${tail}`,
            target: null,
            resolved: null,
            cause: "unreadable_program",
          },
        ];
      }
      if (piped.kind === "file") return [];
      return inlineCodeFindings(verb, how, piped.word, context, cwd);
    }
    case "opaque":
      return [
        {
          detail:
            `the code ${verb} reads from ${source.raw} cannot be read — nothing on ` +
            `the line says what it holds${tail}`,
          target: null,
          resolved: null,
          cause: "unreadable_program",
        },
      ];
  }
}

/**
 * The script a shell reads from its standard input.
 *
 * `bash <<'EOF' … EOF` and `echo '<script>' | sh` are the interpreter case with
 * one difference: the program is shell, which this module reads. So it is read
 * — as a command in its own right, from the directory the shell stands in —
 * rather than refused for being on the wrong side of a pipe. What cannot be
 * read is refused, and a script **file** is left unaccounted for exactly as a
 * `sh script.sh` operand always has been.
 */
function shellFromStdin(
  verb: string,
  source: StdinSource,
  context: Context,
): { findings: WriteFinding[]; script: string[]; accounted: boolean } {
  const tail = `: ${context.segment.slice(0, 200)}`;
  const unreadable = (reason: string) => ({
    findings: [
      { detail: `the script ${verb} reads from ${reason}${tail}`, target: null, resolved: null },
    ],
    script: [],
    accounted: true,
  });
  switch (source.kind) {
    case "heredoc":
      return { findings: [], script: [source.body], accounted: true };
    case "word":
      return source.word.variable || source.word.substitutions.length > 0
        ? unreadable("a here-string cannot be read — it is built at run time")
        : { findings: [], script: [source.word.value], accounted: true };
    // A file: its contents are not read here, which is what `accounted: false`
    // says — the segment falls through to the patterns kept at the bottom of
    // this file, as `sh script.sh` does.
    case "file":
      return { findings: [], script: [], accounted: false };
    case "pipe": {
      const piped = pipedProgram(source.producer);
      if (piped.kind === "unreadable") {
        return unreadable(`a pipe cannot be read — ${piped.reason}`);
      }
      if (piped.kind === "file") return { findings: [], script: [], accounted: false };
      return { findings: [], script: [piped.word.value], accounted: true };
    }
    case "opaque":
      return unreadable(`${source.raw} cannot be read — nothing on the line says what it holds`);
  }
}

/**
 * What the stage before a pipe produces, where that is text this guard can
 * read: `echo '<code>' | python3` puts the program on the line as surely as
 * `-c` does, and `cat <file> | python3` names a file the review reads.
 * Anything else — a command's output, a substitution, a variable — is a
 * program computed at run time.
 */
function pipedProgram(
  producer: readonly Word[],
):
  | { kind: "text"; word: Word }
  | { kind: "file"; words: Word[] }
  | { kind: "unreadable"; reason: string } {
  const words = producer.filter((word) => !isAssignment(word.value));
  const first = words[0];
  if (first === undefined) return { kind: "unreadable", reason: "the stage before it is empty" };
  if (first.variable || first.substitutions.length > 0) {
    return { kind: "unreadable", reason: "the stage before it is built at run time" };
  }
  const verb = basename(first.value);
  const operands = words.slice(1).filter((word) => !word.value.startsWith("-"));
  if (verb === "cat") {
    if (operands.length === 0) {
      return { kind: "unreadable", reason: "`cat` was given no file to read" };
    }
    return { kind: "file", words: operands };
  }
  if (verb !== "echo" && verb !== "printf") {
    return { kind: "unreadable", reason: `it is the output of \`${verb}\`` };
  }
  const literal = words.slice(1).filter((word) => !/^-[neE]+$/.test(word.value));
  if (literal.some((word) => word.variable || word.substitutions.length > 0)) {
    return { kind: "unreadable", reason: `the text \`${verb}\` writes is built at run time` };
  }
  return {
    kind: "text",
    word: {
      // Unwrapped word by word rather than once at the end: `printf '%s' '<code>'`
      // is two words, and joining them with their quoting still on makes the
      // second one look like a string literal to whoever reads the result.
      raw: literal
        .map((word) => unwrapped(word.raw.length > 0 ? word.raw : word.value))
        .join(" "),
      value: literal.map((word) => word.value).join(" "),
      substitutions: [],
      variable: false,
    },
  };
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

  const stopHere = (): Analysis => ({
    findings,
    accounted,
    mutating,
    programs,
    invocations,
    nested: nestedSegments,
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
        detail: `${describe(label, raw, destination)}: ${context.segment.slice(0, 200)}`,
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
    const destination = judgeTarget(operand.value, context.scope, cwd, true);
    cwd = moved(destination, operand.raw, `the directory ${wrapper} ${option} runs in`);
    return null;
  };

  /**
   * Consume a wrapper's leading options. Returns an Analysis when the wrapper
   * cannot be seen through, and null when the next word names the program.
   */
  const consumeOptions = (wrapper: string, spec: WrapperSpec): Analysis | null => {
    const flags = set(spec.flags);
    const values = set(spec.values);
    const commands = set(spec.commands);
    const dirs = set(spec.dirs);
    const refused = set(spec.refuse);
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
        if (dirs.has(name)) {
          const operand = attached === null ? words[i + 1] : { ...word, raw: attached, value: attached };
          const stop = moveInto(operand, name, wrapper);
          if (stop !== null) return stop;
          i += attached === null ? 2 : 1;
          continue;
        }
        if (commands.has(name)) {
          const operand = attached === null ? words[i + 1] : { ...word, raw: attached, value: attached };
          if (operand === undefined) return unknownOption(raw, wrapper);
          if (operand.variable || operand.substitutions.length > 0) {
            return unreadable(operand, `${wrapper} ${name}`);
          }
          nested.push(operand.value);
          i += attached === null ? 2 : 1;
          continue;
        }
        if (values.has(name)) {
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
        if (flags.has(option)) {
          at += 1;
          continue;
        }
        if (refused.has(option)) return refusedOption(option, wrapper);
        if (dirs.has(option)) {
          const inline = raw.slice(at + 1);
          const operand = inline.length > 0 ? { ...word, raw: inline, value: inline } : words[i + 1];
          const stop = moveInto(operand, option, wrapper);
          if (stop !== null) return stop;
          separate = inline.length === 0;
          break;
        }
        if (values.has(option)) {
          separate = raw.length === at + 1;
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

  while (i < words.length) {
    const value = words[i]!.value;
    if (value === "" || value === "--" || isAssignment(value) || KEYWORDS.has(value)) {
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
    if (wrapper !== undefined) {
      i += 1;
      const stop = consumeOptions(program, wrapper);
      if (stop !== null) return stop;
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
      findings.push(...writerFindings(verb, spec, rest, { ...context, cwd }));
    } else if (verb === "ln") {
      programs.push(verb);
      mutating = true;
      findings.push(...linkFindings(rest, { ...context, cwd }));
    } else if (verb === "git") {
      programs.push(verb);
      findings.push(...gitFindings(rest, { ...context, cwd }));
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
      const at = rest.findIndex((word) => word.value === "-exec" || word.value === "-execdir");
      if (at !== -1) {
        const body: Word[] = [];
        for (const word of rest.slice(at + 1)) {
          if (word.value === ";" || word.value === "+") break;
          body.push(word);
        }
        // The body is a command of its own: it inherits the directory, not the
        // standard input the line gave the `find`.
        const inner = analyzeWords(body, { ...context, cwd, stdin: undefined });
        findings.push(...inner.findings);
        if (!inner.accounted) accounted = false;
        // `find … -exec rm {} ;` runs `rm`: what the line writes is the body's,
        // and the admission decision is about the same act.
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
    for (const item of group) {
      if (item.kind === "word") {
        words.push(item.word);
        continue;
      }
      if (item.kind === "operator") continue;
      if (item.kind === "stdin") {
        // The last one wins, as it does in the shell.
        stdin = item.source;
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
    // Every `$(…)` and backtick body is a command in its own right.
    for (const word of words) {
      for (const body of word.substitutions) {
        findings.push(...inspectSegments(body, context.scope, cwd, context.depth + 1).findings);
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
    if (item.kind === "word" && (item.word.value === "(" || item.word.value === ")")) {
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
function inspectSegments(
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
  const { texts, separators, balanced, bodies } = scanSegments(command);
  const heredocs = heredocQueue(bodies);
  const findings: WriteFinding[] = [];
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
  const effective: ResolvedScope =
    scope.tmpdir !== null && SCRATCH_REBOUND.test(withoutHeredocBodies(text).text)
      ? { ...scope, tmpdir: null }
      : scope;
  return inspectSegments(
    text,
    effective,
    { path: effective.base, unknown: effective.baseUnknown },
    0,
  );
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
