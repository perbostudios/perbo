import { matchesAny, packageOf } from "./paths.js";

/**
 * How big a plan is, S to XL, by fixed thresholds over its nodes, its criteria
 * and the files and packages in scope (D-104).
 *
 * A description, not a forecast: it predicts neither cost nor time, and nothing
 * here reads a rate card or a clock. The thresholds are constants rather than
 * settings, because a size a repository can retune is a size no two plans can
 * be compared by.
 */

export const SIZE_NAMES = ["S", "M", "L", "XL"] as const;
export type SizeName = (typeof SIZE_NAMES)[number];

/** The four counts a size is derived from. A flat plan counts as one node. */
export interface SizeCounts {
  nodes: number;
  criteria: number;
  files: number;
  packages: number;
}

export type SizeCount = keyof SizeCounts;

/** The counts in the order a reader is shown them. */
export const SIZE_COUNTS = ["nodes", "criteria", "files", "packages"] as const;

/**
 * The upper bound of each band. XL is what nothing bounds, so it has no row:
 * a count past L's row is XL.
 */
export const SIZE_THRESHOLDS: ReadonlyArray<{ name: SizeName } & SizeCounts> = [
  { name: "S", nodes: 1, criteria: 4, files: 10, packages: 1 },
  { name: "M", nodes: 3, criteria: 10, files: 25, packages: 2 },
  { name: "L", nodes: 6, criteria: 20, files: 50, packages: 3 },
];

export interface SizeEstimate {
  name: SizeName;
  counts: SizeCounts;
  /**
   * The counts that reach the size, in the order above. Every count reaches S,
   * which is the band nothing exceeds, so an S plan names all four.
   */
  drivers: SizeCount[];
}

/** The band one count falls in on its own. */
function bandOf(count: SizeCount, value: number): SizeName {
  return SIZE_THRESHOLDS.find((row) => value <= row[count])?.name ?? "XL";
}

/** A plan takes the largest size any one of its counts reaches (D-104). */
export function sizeEstimate(counts: SizeCounts): SizeEstimate {
  const bands = SIZE_COUNTS.map((count) => ({ count, band: bandOf(count, counts[count]) }));
  const rank = (name: SizeName) => SIZE_NAMES.indexOf(name);
  const name = bands.reduce<SizeName>(
    (largest, each) => (rank(each.band) > rank(largest) ? each.band : largest),
    "S",
  );
  return {
    name,
    counts,
    drivers: bands.filter((each) => each.band === name).map((each) => each.count),
  };
}

/**
 * The counts a plan's size is taken from, over one repository's tracked files.
 *
 * The files in scope are the tracked files the graph's node paths reach — or
 * the plan's whole `paths_allowed` where it has no graph — less the prohibited
 * ones, and the packages are the distinct packages those files fall in. A flat
 * plan counts as one node, which is what it is: one piece of work.
 *
 * Tracked files rather than a directory walk, so a build directory, a cache or
 * an uncommitted scratch file cannot change a plan's size.
 */
export function planSizeCounts(input: {
  nodes: readonly { paths: readonly string[] }[];
  criteria: number;
  paths_allowed: readonly string[];
  paths_prohibited: readonly string[];
  trackedFiles: readonly string[];
}): SizeCounts {
  const globs =
    input.nodes.length > 0 ? input.nodes.flatMap((node) => [...node.paths]) : [...input.paths_allowed];
  const files = input.trackedFiles.filter(
    (path) => matchesAny(path, globs) && !matchesAny(path, input.paths_prohibited),
  );
  return {
    nodes: Math.max(1, input.nodes.length),
    criteria: input.criteria,
    files: files.length,
    packages: new Set(files.map(packageOf)).size,
  };
}
