import { matchesAny } from "@perbo/contracts/paths";
import { standingGlob } from "@perbo/contracts/standing";
import type { PlanNode } from "@perbo/contracts/plan";
import type { StandingProhibitedEntry } from "@perbo/contracts/standing";
import { markOf, type DraftMark } from "../../shared/contract-editing.js";
import type { EditingForm } from "../../shared/protocol.js";

/**
 * What the Explorer's tree is made of, and what each row is marked. Pure
 * readings over the listing the host answered and the draft's own scope: the
 * pane holds no second copy of either.
 *
 * A row's path is the repository's own spelling for a file and that spelling
 * with a trailing slash for a folder, which is what {@link standingGlob} turns
 * into the glob a mark is written as.
 */
export interface TreeRow {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
}

interface Folder {
  name: string;
  path: string;
  dirs: Map<string, Folder>;
  files: { name: string; path: string }[];
}

function folderOf(files: readonly string[]): Folder {
  const root: Folder = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split("/");
    let node = root;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      const path = `${parts.slice(0, index + 1).join("/")}/`;
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, path, dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ name: parts.at(-1) ?? file, path: file });
  }
  return root;
}

function walk(
  node: Folder,
  open: ReadonlySet<string>,
  all: boolean,
  depth: number,
  out: TreeRow[],
): TreeRow[] {
  for (const dir of [...node.dirs.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    out.push({ path: dir.path, name: dir.name, dir: true, depth });
    if (all || open.has(dir.path)) walk(dir, open, all, depth + 1, out);
  }
  for (const file of [...node.files].sort((left, right) => left.name.localeCompare(right.name)))
    out.push({ path: file.path, name: file.name, dir: false, depth });
  return out;
}

/**
 * The rows to draw. A filter narrows the listing to the paths that contain it
 * and opens every folder on the way, so a match deep in the tree is reachable
 * without opening each level by hand.
 */
export function treeRows(
  files: readonly string[],
  open: ReadonlySet<string>,
  filter: string,
): TreeRow[] {
  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? files.filter((file) => file.toLowerCase().includes(needle))
    : files;
  return walk(folderOf(matching), open, needle !== "", 0, []);
}

/** A path as a glob matches it: a folder covers what is under it. */
const probe = (path: string): string => (path.endsWith("/") ? `${path}x` : path);

/** Whether a glob covers a row's path, the row's own glob included. */
export function covers(glob: string, path: string): boolean {
  return glob === standingGlob(path) || matchesAny(probe(path), [glob]);
}

/**
 * What a row is marked: this draft's own mark, the standing entry that covers
 * it, and the prohibited folder it sits under. A path prohibited through a
 * folder is not marked itself; the row says which folder holds it.
 */
export interface RowMark {
  own: DraftMark;
  standing: StandingProhibitedEntry | null;
  via: string | null;
}

export function rowMark(
  form: EditingForm,
  standing: readonly StandingProhibitedEntry[],
  path: string,
): RowMark {
  const glob = standingGlob(path);
  return {
    own: markOf(form, glob),
    standing: standing.find((entry) => covers(entry.path, path)) ?? null,
    via:
      form.draft.prohibited.find(
        (entry) => entry !== glob && entry.endsWith("/**") && path.startsWith(entry.slice(0, -2)),
      ) ?? null,
  };
}

/** The folder a prohibition was inherited from, as a row shows it: `<dir>/`. */
export const viaLabel = (glob: string): string =>
  `${glob.slice(0, -3).split("/").at(-1) ?? glob}/`;

/** The plan's nodes that name a path, empty for a draft with no plan. */
export function nodesNaming(nodes: readonly PlanNode[], path: string): PlanNode[] {
  return nodes.filter((node) =>
    node.paths.some((glob) => covers(glob, path) || (path.endsWith("/") && glob.startsWith(path))),
  );
}
