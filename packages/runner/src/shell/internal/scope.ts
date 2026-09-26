import { standingProhibitedPaths } from "@perbo/contracts";
import { HOST_SEMANTICS, walkPath, type PathSemantics } from "./path.js";

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
  /**
   * The values the line being read gives `SIMPLE_BACKUP_SUFFIX`, the suffix a
   * GNU backup takes where the line spells none: absent where the line does
   * not name it, null where it names it in a way this guard cannot read.
   */
  simpleBackupSuffixes?: readonly string[] | null;
}

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
