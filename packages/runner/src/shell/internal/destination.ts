import { statSync } from "node:fs";
import { matchesAny } from "@perbo/contracts";
import {
  anchorOf,
  comparable,
  normalise,
  prohibitedComparable,
  walkPath,
  windowsAlias,
} from "./path.js";
import {
  allowedPathsSentence,
  prohibitedPathsSentence,
  type Cwd,
  type ResolvedScope,
} from "./scope.js";

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

export type Destination =
  | { kind: "inside"; resolved: string | null }
  | { kind: "outside"; resolved: string }
  /**
   * Inside the worktree, outside the contract's globs (SCP-195). `at` is the
   * destination relative to the root, `.` for the root itself, which is the
   * spelling the contract, the change set and the review all use — and the one
   * the executor has to recognise as a path it may not write.
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
 * The device files a redirect names to discard its output or to re-enter the
 * process's own streams. They are outside every worktree and are not writes to
 * anything: `> /dev/null` is the commonest redirect there is. The list is exact
 * rather than a `/dev/**` prefix, because `> /dev/disk0` is a real write.
 */
const DEVICE_TARGET = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/;

/**
 * Where a write to `target` lands, and which refusal it earns.
 *
 * `whole` reads the target as something the write may replace entirely — a
 * file, or a directory with everything under it. `place` reads it as a
 * directory a command works in, writing some of what is there and not the
 * rest (`git -C <dir>`): a prohibited path below it is judged when a write
 * names it, not held against the directory.
 */
export function judgeTarget(
  target: string,
  scope: ResolvedScope,
  cwd: Cwd,
  shell: boolean,
  reading: "whole" | "place" = "whole",
): Destination {
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
  const prohibited = scope.paths_prohibited.map(prohibitedFold);
  const judged = prohibitedFold(at);
  const below = (glob: string, how: "named" | "any") => reading === "whole" && reachesBelow(judged, glob, how);
  // A directory on disk is read by what a glob can match under it, so a
  // wildcard reaches inside it too: `src/keys` under `**/*.pem`, `packages/app`
  // under `packages/*/generated/**`, wherever the allowed globs put it.
  const within = isDirectory(walked.path) ? "any" : "named";
  if (covers(judged, prohibited) || prohibited.some((glob) => below(glob, within))) {
    return {
      kind: "prohibited_path",
      resolved: walked.path,
      at: at || ".",
      prohibited: scope.paths_prohibited,
    };
  }
  const allowed = scope.paths_allowed.map(fold);
  if (scope.paths_allowed.length === 0 || (at !== "" && matchesAny(fold(at), allowed))) {
    return { kind: "inside", resolved: walked.path };
  }
  // A directory not yet on disk is admitted whole only where no prohibited glob
  // can match anything inside it, so a write that fills it cannot reach a
  // prohibited path through it (D-105).
  if (covers(fold(at), allowed) && !prohibited.some((glob) => below(glob, "any"))) {
    return { kind: "inside", resolved: walked.path };
  }
  return { kind: "outside_scope", resolved: walked.path, at: at || ".", allowed: scope.paths_allowed };
}

/**
 * Whether globs cover a write to `at`, a repository-relative path with the
 * root as `""`. A write to a directory reaches everything under it, so a glob
 * covers a directory whose whole contents it matches: `<dir>/**` covers
 * `<dir>`, and only `**` covers the root.
 */
function covers(at: string, globs: readonly string[]): boolean {
  const contents = globs.filter((glob) => glob === "**" || glob.endsWith("/**"));
  return (at !== "" && matchesAny(at, globs)) || matchesAny(at, contents.map((glob) => glob.slice(0, -3)));
}

/**
 * Whether a glob can match a path strictly below `at`, the root being `""`:
 * what a write to `at` reaches if `at` is a directory.
 *
 * `named` asks whether the glob names a place inside `at`: every glob does
 * for the root, and `src/generated/**` does for `src` because its leading
 * segments spell `src` literally. A write there is refused as prohibited,
 * since a file cannot sit where the glob puts a directory. `any` also counts a
 * glob that reaches below `at` through a wildcard: one opening with `**`
 * reaches below every path, and one opening with `*` below `src`. That is held
 * against a target that is a directory on disk; a target that is not there
 * yet cannot be told from a file, so for it `any` only stops a directory
 * being admitted whole.
 */
function reachesBelow(at: string, glob: string, reading: "named" | "any"): boolean {
  if (at === "") return glob.length > 0;
  const parts = at.split("/");
  const segments = glob.split("/");
  for (const [index, part] of parts.entries()) {
    const segment = segments[index];
    if (segment === undefined) return false;
    if (segment.includes("**")) return reading === "any";
    if (reading === "named" ? segment !== part : !matchesAny(part, [segment])) return false;
  }
  return segments.length > parts.length;
}

/**
 * Whether a resolved destination is a directory on disk. The walk has already
 * followed every link on the way, the last one included. A path that cannot
 * be read is taken as one, which refuses the more.
 */
function isDirectory(resolved: string): boolean {
  try {
    return statSync(resolved, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return true;
  }
}

/**
 * A destination inside the worktree as the path relative to the root — the
 * spelling the contract, the change set and the review all use, with the root
 * itself as `""` — or null where the contract's paths have nothing to say
 * about it.
 *
 * The scratch directory is the runner's own: it is excluded from every list
 * the seal builds, so no contract names it and nothing written there can be a
 * scope escape or a prohibited path.
 */
function repositoryRelative(resolved: string, root: string, scope: ResolvedScope): string | null {
  if (scope.tmpdir !== null) {
    const path = comparable(resolved, scope.semantics);
    const tmpdir = comparable(scope.tmpdir, scope.semantics);
    if (path === tmpdir || path.startsWith(`${tmpdir}/`)) return null;
  }
  // Already in the contract's spelling: a glob is written with `/` whatever the
  // platform's separator, and the resolver holds that one alphabet on every
  // host, so the path it is matched against needs no further conversion.
  return resolved.slice(root.length + 1);
}

export function destinationSentence(label: string, raw: string, destination: Destination): string | null {
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
export function landed(destination: Destination): string | null {
  return destination.kind === "outside" ||
    destination.kind === "outside_scope" ||
    destination.kind === "prohibited_path"
    ? destination.resolved
    : null;
}

export const ruleOf = (destination: Destination): WriteRule =>
  destination.kind === "prohibited_path"
    ? "write_prohibited_path"
    : destination.kind === "outside_scope"
      ? "write_outside_scope"
      : "write_outside_worktree";

/** A finding about a path, carrying the word it was written as and where it went. */
export function pathFinding(
  label: string,
  word: { raw: string; value: string },
  destination: Destination,
  segment: string,
): WriteFinding[] {
  const detail = destinationSentence(label, word.raw, destination);
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
