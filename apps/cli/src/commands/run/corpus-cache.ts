import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The corpus cache, as `perbo doctor` reports it.
 *
 * The regression suite is scored against a corpus of fixtures that is cloned
 * rather than checked in, so whether this machine can run it — and whether what
 * it would run is what the recorded score was measured on — is a property of a
 * directory nobody looks at until a suite comes back wrong. It is exactly the
 * kind of question `doctor` exists to answer before a run rather than during
 * one, so it is answered here, in one line, from the disk.
 *
 * It is a warning and only a warning. A cache that is missing or out of date
 * says nothing about whether this checkout can be materialized or whether this
 * machine can run an attempt, which is what `doctor`'s exit code means; a
 * diagnostic that failed because a corpus was not on the machine would be one
 * that most people learn to ignore. So nothing here reaches the exit code.
 */

/** Where the cache sits, relative to the checkout being diagnosed. */
export const CORPUS_CACHE_DIR = ".local/corpus-cache";

/**
 * The pin a synced cache records at its root: the corpus commit the fixtures
 * below it were taken from. Same file name and same `commit` key as the pin the
 * regression job reads, so one spelling covers both sides of the comparison.
 */
export const CORPUS_CACHE_PIN = "corpus-pin.json";

/**
 * What fixes a cache that is absent or behind, named as the fix on the line:
 * the `@perbo/evaluation` binary's `prepare`, which clones the repositories the
 * pinned fixtures name, at the commits they pin, into the cache.
 */
export const CORPUS_PREPARE_COMMAND = "perbo-corpus prepare";

/**
 * The recorded regression score, first match wins: this repository's own copy,
 * then the path the published tree carries it at. Two paths because it is one
 * file with two homes — the assembly authors the second from the first — and a
 * diagnostic that only knew the first would report nothing in the tree most of
 * its readers have.
 */
export const REGRESSION_SCORE_PATHS = [
  "tooling/package/open-ci/regression-score.json",
  ".github/regression-score.json",
];

/**
 * What a cached fixture directory carries: the computed change a prepared
 * fixture is read from, or the fixture's own definition where the corpus has
 * been synced but not yet prepared. A directory with neither — the shared clone
 * pool the harness keeps beside the fixtures — is not a fixture and is not
 * counted as one.
 */
const FIXTURE_FILES = ["change.diff", "fixture.json"];

/**
 * `absent` is "there is nothing here to review against": no directory, or a
 * directory holding no fixtures. `behind` is the narrower claim that the cache
 * and the recorded score name *different* commits, which needs both of them; a
 * cache that records no commit is not evidence of divergence and is not
 * reported as if it were.
 */
export type CorpusCacheState = "absent" | "present" | "behind";

export interface CorpusCacheReport {
  /** The cache directory this checkout would use, absolute. */
  path: string;
  state: CorpusCacheState;
  /** The corpus commit the cache records, or null where it records none. */
  cached_commit: string | null;
  /** The corpus commit the recorded score was measured against, or null. */
  scored_commit: string | null;
  /** Fixture directories the cache holds. */
  fixtures: number;
  /** The command that fixes this state, or null where there is nothing to fix. */
  fix: string | null;
}

/**
 * A JSON object from a file that is being reported on rather than relied on.
 * Unreadable and malformed both come back as null: `doctor` is the command a
 * person runs when something is already wrong, and it may not be the thing that
 * throws.
 */
function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringAt(value: Record<string, unknown> | null, key: string): string | null {
  const found = value?.[key];
  return typeof found === "string" && found !== "" ? found : null;
}

/** Directories under the cache root that are fixtures, counted by what they hold. */
function countFixtures(cache: string): number {
  let entries: string[];
  try {
    entries = readdirSync(cache);
  } catch {
    return 0;
  }
  return entries.filter((entry) => {
    const dir = join(cache, entry);
    // statSync rather than the dirent, so a fixture reached through a symlink
    // counts and a dangling one does not throw.
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;
    return FIXTURE_FILES.some((file) => existsSync(join(dir, file)));
  }).length;
}

/** The commit the recorded regression score was measured against, or null. */
export function scoredCorpusCommit(checkout: string): string | null {
  for (const relative of REGRESSION_SCORE_PATHS) {
    const path = resolve(checkout, relative);
    if (!existsSync(path)) continue;
    const score = readJsonObject(path);
    const corpus = score?.["corpus"];
    return stringAt(
      typeof corpus === "object" && corpus !== null ? (corpus as Record<string, unknown>) : null,
      "commit",
    );
  }
  return null;
}

/** The corpus cache under `checkout`, read as it sits on disk. */
export function readCorpusCache(checkout: string): CorpusCacheReport {
  const path = resolve(checkout, CORPUS_CACHE_DIR);
  const scored = scoredCorpusCommit(checkout);
  const present = statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  const fixtures = present ? countFixtures(path) : 0;
  const cached = present ? stringAt(readJsonObject(join(path, CORPUS_CACHE_PIN)), "commit") : null;
  const state: CorpusCacheState =
    fixtures === 0 ? "absent" : cached !== null && scored !== null && cached !== scored ? "behind" : "present";
  return {
    path,
    state,
    cached_commit: cached,
    scored_commit: scored,
    fixtures,
    fix: state === "present" ? null : CORPUS_PREPARE_COMMAND,
  };
}

function fixtureCount(fixtures: number): string {
  return `${fixtures} ${fixtures === 1 ? "fixture" : "fixtures"}`;
}

/**
 * The CORPUS line, in the same label column as CHECKOUT, CONFIG and VERDICT.
 *
 * One line in every state, because a person scanning the report is asking one
 * question of it, and the two states that need doing something about it end
 * with the command that does it rather than with an instruction to go and find
 * out what does.
 */
export function renderCorpusCache(report: CorpusCacheReport): string {
  const fix = `; fill it with: ${CORPUS_PREPARE_COMMAND}`;
  switch (report.state) {
    case "absent":
      return `CORPUS    warning  ${CORPUS_CACHE_DIR} absent: no fixtures to review against${fix}`;
    case "behind":
      return (
        `CORPUS    warning  ${CORPUS_CACHE_DIR} behind: cached at ${report.cached_commit}, ` +
        `the recorded score at ${report.scored_commit}${fix}`
      );
    case "present":
      return (
        `CORPUS    ${CORPUS_CACHE_DIR} at ${report.cached_commit ?? "(no commit recorded)"}, ` +
        fixtureCount(report.fixtures)
      );
  }
}
