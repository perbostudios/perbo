import { git } from "@perbo/workspace";
import { PlanningError } from "../../errors.js";

const DEFAULT_LIMIT = 400;

/**
 * The tracked tree, two directory levels deep plus the files at the root.
 *
 * This is what the drafter is shown so that a proposed scope glob names a
 * directory that exists. Two levels is where a monorepo's packages live and is
 * small enough to sit in one prompt; the executor and the reviewer see the
 * full tree, the drafter does not need to.
 *
 * The listing comes from `@perbo/workspace`'s repository module, which is where
 * every git process Perbo starts is decided: argv only, the runner's
 * environment rather than this one's, a bounded wait, and a listing too large
 * to hold refused rather than returned cut — a truncated tree is shaped exactly
 * like a complete one, and the directories missing from it are the ones a
 * proposed glob would be told do not exist.
 */
export function repositoryTree(
  repositoryRoot: string,
  options: { limit?: number } = {},
): string[] {
  let tracked: string[];
  try {
    tracked = git.trackedFilesSync(repositoryRoot);
  } catch (error) {
    throw new PlanningError(
      `cannot list the tracked files in ${repositoryRoot}: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
      { cause: error },
    );
  }

  const entries = new Set<string>();
  for (const path of tracked) {
    const segments = path.split("/");
    if (segments.length === 1) {
      entries.add(path);
      continue;
    }
    entries.add(`${segments[0]}/`);
    if (segments.length > 2) entries.add(`${segments[0]}/${segments[1]}/`);
  }
  return [...entries].sort().slice(0, options.limit ?? DEFAULT_LIMIT);
}
