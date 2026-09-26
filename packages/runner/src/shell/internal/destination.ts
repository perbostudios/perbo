import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { matchesAny } from "@perbo/contracts";
import {
  anchorOf,
  comparable,
  normalise,
  prohibitedComparable,
  walkPath,
  windowsAlias,
} from "./path.js";
import type { Word } from "./lexer.js";
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
 * file, or a directory with everything under it. `place` reads it as the entry
 * itself, as `mkdir`, `rmdir`, `touch` and `git -C <dir>` use a directory,
 * writing nothing below it or only what a later write names: a prohibited path
 * below it is judged when a write names it, not held against the directory.
 *
 * `incoming` is what a `whole` write puts under the target from elsewhere, as
 * a copy or a move of a directory does: the resolved directories whose
 * contents land directly under it.
 */
export function judgeTarget(
  target: string,
  scope: ResolvedScope,
  cwd: Cwd,
  shell: boolean,
  reading: "whole" | "place" = "whole",
  incoming: readonly string[] = [],
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
  // A glob that names a place inside the target reaches it wherever the target
  // is. One that reaches inside only through a wildcard, `**/*.pem` under
  // `src/keys`, is held against it only where something on disk that the
  // write removes or puts there matches it, `src/keys/k.pem`.
  const named = (glob: string) => reading === "whole" && reachesBelow(judged, glob, "named");
  const wildcards = prohibited.filter(
    (glob) => reading === "whole" && !reachesBelow(judged, glob, "named") && reachesBelow(judged, glob, "any"),
  );
  let reach: Reach | undefined;
  const reached = (absent: boolean) => {
    reach ??=
      wildcards.length === 0
        ? "none"
        : reachOf(walked.path, incoming, at, (path) =>
            wildcards.some((glob) => covers(prohibitedFold(path), [glob])),
          );
    return reach === "some" || (reach === "absent" && absent);
  };
  if (covers(judged, prohibited) || prohibited.some(named) || reached(false)) {
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
  // A directory the allowed globs cover is admitted whole where no prohibited
  // glob can match anything the write reaches inside it, and one not yet on
  // disk only where none can match anything at all, so a write that fills it
  // cannot reach a prohibited path through it (D-105).
  if (covers(fold(at), allowed) && !reached(true)) {
    return { kind: "inside", resolved: walked.path };
  }
  return { kind: "outside_scope", resolved: walked.path, at: at || ".", allowed: scope.paths_allowed };
}

/**
 * What a `cp`, `mv`, `install` or `ln` writes when its destination is a
 * directory on disk: each source under its own name inside it, and nothing
 * else there (D-105). `cp src/a.ts src/other/` writes `src/other/a.ts`, so a
 * prohibited glob that reaches inside `src/other` through a wildcard is judged
 * against that path rather than held against the directory.
 *
 * The directory itself is judged as a place, so one the contract prohibits or
 * does not admit is still refused. A source that is a directory on disk is
 * judged as a directory under its name there holding what the source holds,
 * since copying or moving one writes everything below it. A link is one entry
 * whatever it names, so `linked` judges each as what it is.
 *
 * Null where the destination is not a directory on disk, where a source's
 * name inside it cannot be read from the line — a variable, a glob, a name a
 * wrapper supplies, or a trailing `/`, which BSD `cp -R` reads as the
 * directory's contents — or where a source copied or moved in lies outside the
 * worktree, whose contents this has not seen; the destination is then judged
 * whole.
 */
export function judgeInto(
  directory: Word,
  sources: readonly Word[],
  scope: ResolvedScope,
  cwd: Cwd,
  linked = false,
): Array<{ word: Pick<Word, "raw" | "value">; destination: Destination }> | null {
  if (sources.length === 0) return null;
  const place = judgeTarget(directory.value, scope, cwd, true, "place");
  const resolvedOf = (destination: Destination) =>
    destination.kind === "unresolvable" ? null : destination.resolved;
  const resolved = resolvedOf(place);
  if (place.kind === "outside" || resolved === null || onDisk(resolved) !== "directory") return null;
  const names: string[] = [];
  const from: Array<string | null> = [];
  for (const source of sources) {
    if (source.variable || source.substitutions.length > 0 || source.found === true) return null;
    const name = source.value.split("/").pop() ?? "";
    if (!/^[^*?[\]{}$`~\\]+$/.test(name) || name === "." || name === "..") return null;
    names.push(name);
    const at = linked ? null : judgeTarget(source.value, scope, cwd, true, "place");
    if (at?.kind === "outside") return null;
    from.push(at === null ? null : resolvedOf(at));
  }
  const under = (base: string, name: string) => `${base.replace(/\/+$/, "")}/${name}`;
  return [
    { word: directory, destination: place },
    ...names.map((name, index) => {
      const path = from[index] ?? null;
      const incoming = !linked && path !== null && onDisk(path) === "directory" ? [path] : [];
      return {
        word: { raw: under(directory.raw, name), value: under(directory.value, name) },
        destination: judgeTarget(under(directory.value, name), scope, cwd, true, "whole", incoming),
      };
    }),
  ];
}

/**
 * The directories on disk inside the worktree among the sources a copy or a
 * move names, whose contents land under a destination judged whole:
 * `src/keys` for `cp -rT src/keys src/other`. A source whose name the line
 * does not spell — a variable, a glob, a word a wrapper supplies — one outside
 * the worktree, and one that is not a directory on disk put nothing this
 * reads there.
 */
export function copiedDirectories(sources: readonly Word[], scope: ResolvedScope, cwd: Cwd): string[] {
  const directories: string[] = [];
  for (const source of sources) {
    if (source.variable || source.substitutions.length > 0 || source.found === true) continue;
    const at = judgeTarget(source.value, scope, cwd, true, "place");
    if (at.kind === "unresolvable" || at.kind === "outside") continue;
    if (at.resolved !== null && onDisk(at.resolved) === "directory") {
      directories.push(at.resolved);
    }
  }
  return directories;
}

/**
 * What is at a resolved path, following a link: a directory, something else,
 * or nothing — and, where `strict`, `unreadable` for a path whose stat fails
 * rather than nothing.
 */
function onDisk(resolved: string): "directory" | "file" | null;
function onDisk(resolved: string, strict: true): "directory" | "file" | "unreadable" | null;
function onDisk(resolved: string, strict = false): "directory" | "file" | "unreadable" | null {
  try {
    const entry = statSync(resolved, { throwIfNoEntry: false });
    return entry === undefined ? null : entry.isDirectory() ? "directory" : "file";
  } catch {
    return strict ? "unreadable" : null;
  }
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
 * against a target only where something on disk the write reaches under it
 * matches the glob; a target that is not there yet cannot be told from a file,
 * so for it `any` only stops a directory being admitted whole.
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
 * What a `whole` write reaches below its target through a wildcard glob:
 * `some` where something on disk under the target, or under a directory whose
 * contents it puts there, matches — or where that cannot be read — `none`
 * where nothing does, and `absent` for a target that is not a directory on
 * disk with nothing coming in, which cannot be told from a file.
 */
type Reach = "some" | "none" | "absent";

function reachOf(target: string, incoming: readonly string[], at: string, matches: (path: string) => boolean): Reach {
  const here = onDisk(target, true);
  if (here === "unreadable") return "some";
  const roots = here === "directory" ? [target, ...incoming] : incoming;
  if (roots.length === 0) return "absent";
  return holds(roots, at, matches) ? "some" : "none";
}

/**
 * Whether any entry under the directories `roots`, spelled as though it sat
 * under `at`, matches — or a directory among them cannot be read. A link inside
 * is one entry and is not followed, as a removal or a copy of the tree does not
 * follow it. It stops at the first match.
 */
function holds(roots: readonly string[], at: string, matches: (path: string) => boolean): boolean {
  const pending = roots.map((directory) => ({ directory, spelled: at }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let entries;
    try {
      entries = readdirSync(next.directory, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      const spelled = next.spelled === "" ? entry.name : `${next.spelled}/${entry.name}`;
      if (matches(spelled)) return true;
      if (entry.isDirectory()) pending.push({ directory: join(next.directory, entry.name), spelled });
    }
  }
  return false;
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
      detail: `${detail}: ${segment}`,
      target: word.raw,
      resolved: landed(destination),
      rule: ruleOf(destination),
    },
  ];
}
