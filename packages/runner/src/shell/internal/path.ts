import { lstatSync, readlinkSync } from "node:fs";
import { posix } from "node:path";

export type Resolved = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Whether this resolver reads paths the way Windows does. Carried rather than
 * assumed, so the semantics are a property of the run and a test can state
 * which one it means on any host.
 */
export type PathSemantics = "windows" | "posix";

export const HOST_SEMANTICS: PathSemantics = process.platform === "win32" ? "windows" : "posix";

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
export function normalise(path: string, semantics: PathSemantics): string {
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
export function comparable(path: string, semantics: PathSemantics): string {
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
export function prohibitedComparable(path: string, semantics: PathSemantics): string {
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
export function windowsAlias(at: string, semantics: PathSemantics): string | null {
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
export function anchorOf(path: string, semantics: PathSemantics): string | null {
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
export function walkPath(base: string, target: string, semantics: PathSemantics, depth = 0): Resolved {
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
