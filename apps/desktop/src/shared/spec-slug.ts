import { SPEC_SLUG } from "./protocol.js";

/**
 * The spec a ticket was drafted from, by its folder's name: the slug, or null
 * where the path its admission recorded is not a spec in the folder this
 * repository keeps specs in (D-103). The one answer to that question, for the
 * host and for the editing sessions both, so a surface that reads a ticket's
 * spec and a surface that deletes it name the same folder.
 *
 * Read against the folder the repository uses now rather than by taking the
 * last-but-one segment of whatever was recorded: a repository that moved its
 * spec folder would otherwise have `specs/foo/spec.md` answer "foo" and a
 * delete reach `docs/specs/foo`, a live spec that ticket never named. The
 * path is taken as written, so one that climbs with `..` or steps with `.` is
 * not a spec here even where it would land inside the folder.
 *
 * Pure, since the renderer loads this module: the caller reads the folder.
 */
export function specSlugOf(path: string | null | undefined, folder: string): string | null {
  if (path === undefined || path === null) return null;
  const parts = path.split("/");
  const slug = parts.at(-2);
  if (parts.at(-1) !== "spec.md" || slug === undefined || !SPEC_SLUG.test(slug)) return null;
  return parts.slice(0, -2).join("/") === folder ? slug : null;
}
