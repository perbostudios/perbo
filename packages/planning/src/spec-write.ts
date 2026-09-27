import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, relative as relative_ } from "node:path";
import { DEFAULT_SPEC_FOLDER } from "@perbo/contracts";
import { PlanningError } from "./errors.js";
import {
  EMPTY_SPEC_TEXT,
  mergeSpecText,
  readSpecSections,
  renderSpec,
  retitleSpec,
  SpecConflict,
  specSlug,
  type SpecRequirement,
  type SpecRequirementDraft,
  type SpecText,
} from "./spec-text.js";

/**
 * One spec on disk: `specs/<slug>/spec.md`, created with its folders (D-103).
 *
 * The Markdown itself, the slug and the requirement ids are `spec-text.ts`,
 * which touches no file, so the desktop's browser preview assigns the same ids
 * as the command line does. What is here is where the bytes go.
 */

/** Where one spec's folder is, repository-relative and absolute. */
function specFolderOf(
  repositoryRoot: string,
  slug: string,
  folder: string = DEFAULT_SPEC_FOLDER,
): { relative: string; absolute: string; path: string } {
  const relative = `${folder}/${slug}`;
  const absolute = join(resolve(repositoryRoot), ...relative.split("/"));
  return { relative, absolute, path: join(absolute, "spec.md") };
}

/**
 * Refuse a symlink anywhere on the way from a root to a path written under
 * it, the path's own last segment included. A spec and its pages are
 * committed in the repository they are drafted for (D-103), and a link in the
 * tree, dangling or not, would carry the write somewhere else.
 */
export function assertNoSymlink(root: string, relative: string): void {
  const segments = relative.split("/").filter((each) => each.length > 0);
  // A path is walked as it is written: a `.` or `..` would let the walk and
  // the write name different places, so neither is a segment here.
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new PlanningError(`${relative} is not a plain repository-relative path`);
  }
  const base = resolve(root);
  let cursor = base;
  let deepest = base;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    let entry;
    try {
      entry = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new PlanningError(
        `${relative} passes through a symlink at ${cursor}, and a spec and its pages are ` +
          "written in the repository itself. Replace the link with a folder or a file",
      );
    }
    deepest = cursor;
  }
  // What exists of the path resolves inside the repository, whatever the
  // filesystem did on the way.
  let real: string;
  try {
    real = realpathSync(base);
  } catch (error) {
    throw new PlanningError(`no repository at ${root}`, { cause: error });
  }
  const inside = relative_(real, realpathSync(deepest));
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new PlanningError(`${relative} resolves outside the repository at ${root}`);
  }
}

/**
 * A folder's path relative to the repository, refusing one that lies outside
 * it: what {@link assertNoSymlink} walks, and what a page's path is named by.
 */
export function relativeInside(repositoryRoot: string, absolute: string): string {
  const within = relative(resolve(repositoryRoot), resolve(absolute)).split(sep).join("/");
  if (within.length === 0 || within.startsWith("..") || isAbsolute(within)) {
    throw new PlanningError(`${absolute} is outside the repository at ${repositoryRoot}`);
  }
  return within;
}

/** Read a spec file back as the five sections a person edits. */
export function readSpecText(path: string): {
  text: SpecText;
  requirements: SpecRequirementDraft[];
  highWater: number;
  markdown: string;
} {
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PlanningError(
      code === "ENOENT"
        ? `no spec at ${path}`
        : `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return { markdown, ...readSpecSections(markdown) };
}

export interface WrittenSpec {
  /** The `spec.md` itself, absolute. */
  path: string;
  slug: string;
  /** The spec's folder, repository-relative, with forward slashes. */
  folder: string;
  markdown: string;
  requirements: SpecRequirement[];
  /** True where this call created the spec: there was no file before it. */
  created: boolean;
}

/**
 * Write one spec, creating the spec folder and the slug's folder where they
 * are missing.
 *
 * `slug` names the spec being rewritten; without one the slug is minted from
 * the title and a spec that already exists there is refused. Two pieces of work
 * whose titles take the same slug are two specs, and letting the second one
 * land in the first one's folder would overwrite a spec — and, once a ticket
 * had been drafted from it, leave that ticket's recorded path pointing at a
 * document about something else. The person renames one, or names the spec
 * they meant to edit.
 *
 * Reading the current file, merging and writing it back are three steps here,
 * not one, and nothing makes them atomic against another process: a write
 * from elsewhere that lands between this call's own read and its own write is
 * not compared against and is lost underneath it. So the honest claim `base`
 * buys is that a save never overwrites what its writer did not read, not that
 * it never overwrites at all.
 */
export function writeSpecFile(args: {
  repositoryRoot: string;
  /** The repository's spec folder. `specs` unless the configuration names another. */
  folder?: string | undefined;
  /** The spec being rewritten. Null or absent mints one from `folderName`, else the title. */
  slug?: string | null | undefined;
  /**
   * The words a new spec's folder is named from where they are not its title:
   * the cut of a person's first turn, which names the folder and is no title,
   * so the spec it mints has an empty title and no title line (D-118).
   */
  folderName?: string | undefined;
  text: SpecText;
  /**
   * The file as this writer last read it, which is what its changes are
   * against. {@link EMPTY_SPEC_TEXT} for a spec being created.
   *
   * Required rather than optional, because a caller that could leave it out
   * would be a caller that silently overwrites whatever the other two writers
   * put in the file between its read and its write (SCP-321).
   */
  base: SpecText;
}): WrittenSpec {
  const named = args.folderName ?? args.text.title;
  const slug = args.slug ?? specSlug(named);
  const at = specFolderOf(args.repositoryRoot, slug, args.folder ?? DEFAULT_SPEC_FOLDER);
  const existed = existsSync(at.path);
  if (existed && (args.slug === null || args.slug === undefined)) {
    throw new PlanningError(
      `${at.relative}/spec.md already exists, and '${named}' takes the same folder. ` +
        "Two pieces of work are two specs: give this one a title of its own, or open the spec " +
        "that is already there",
    );
  }
  // Where the bytes go is settled before anything is read from there. A link at
  // `spec.md` names a file this repository does not own, and reading one first
  // would carry its text back to the caller inside the refusal.
  assertNoSymlink(args.repositoryRoot, `${at.relative}/spec.md`);
  // One read, and the comparison and the write both stand on it: a second read
  // would be a second answer to the question this refusal is asking.
  const current = existed ? readSpecText(at.path) : null;
  const merged = mergeSpecText({
    base: args.base,
    next: args.text,
    current: current?.text ?? EMPTY_SPEC_TEXT,
  });
  if (merged.conflicting.length > 0)
    throw new SpecConflict(merged.conflicting, current?.text ?? EMPTY_SPEC_TEXT);
  const rendered = renderSpec(merged.text, {
    highWater: current?.highWater ?? 0,
    existing: current?.requirements ?? [],
  });
  mkdirSync(at.absolute, { recursive: true });
  writeFileSync(at.path, rendered.markdown);
  return {
    path: at.path,
    slug,
    folder: at.relative,
    markdown: rendered.markdown,
    requirements: rendered.requirements,
    created: !existed,
  };
}

/**
 * Set a spec's title to its ticket's name, in the file, leaving every other
 * byte and the folder as they are (D-127).
 *
 * The one writer of that rule: admission calls it when the drafter names the
 * ticket, and the desktop when a person renames one still being planned. The
 * name is display text, so it reaches the file's first heading and nothing
 * else; the folder keeps the slug it was minted with
 * ([ADR-0023](../../../docs/adr/0023-untrusted-context-boundary.md) §4).
 * Returns the file as it now stands, so a caller recording its hash hashes
 * what was written.
 */
export function retitleSpecFile(args: {
  repositoryRoot: string;
  /** The `spec.md`, repository-relative, as the admission record carries it. */
  path: string;
  title: string;
}): string {
  assertNoSymlink(args.repositoryRoot, args.path);
  const absolute = join(resolve(args.repositoryRoot), ...args.path.split("/"));
  const { markdown } = readSpecText(absolute);
  const named = retitleSpec(markdown, args.title);
  if (named !== markdown) writeFileSync(absolute, named);
  return named;
}
