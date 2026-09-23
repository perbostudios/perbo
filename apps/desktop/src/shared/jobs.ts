/**
 * The two lanes a desktop command runs in (D-101).
 *
 * The host, the sample host and the renderer all read these lists, so there is
 * one answer to what may run beside what.
 */

/**
 * Planning: any number at once, and never in the way of the other lane. The
 * explorer's reads and marks are here, and so are the interview's three
 * requests and the Impact pane's own, and all of them are answered directly
 * rather than as jobs, so they never enter the job list at all.
 */
export const PLANNING_KINDS = [
  "draft",
  "admit",
  "edit",
  "explorerList",
  "explorerRead",
  "explorerMark",
  "explorerUndo",
  "graphRead",
  "graphEdit",
  "graphUndo",
  "impactRead",
  "interviewStart",
  "interviewTurn",
  "interviewStop",
] as const;

/** Runs, decisions and publishing: one at a time, whatever is being planned. */
export const EXCLUSIVE_KINDS = [
  "run",
  "decide",
  "verdict",
  "sync",
  "principle",
  "doctor",
] as const;

export type Lane = "planning" | "exclusive";

const planning = new Set<string>(PLANNING_KINDS);
const exclusive = new Set<string>(EXCLUSIVE_KINDS);

/** A kind nobody has placed yet is exclusive: the safe side of an unlisted command. */
export function lane(kind: string): Lane {
  if (exclusive.has(kind)) return "exclusive";
  return planning.has(kind) ? "planning" : "exclusive";
}

export const isLive = (job: { state: string }): boolean =>
  job.state === "running" || job.state === "stopping";

/**
 * The exclusive command in the way, if there is one. A run, a decision or a
 * publication waits for it; planning does not.
 */
export function exclusiveJob<T extends { kind: string; state: string }>(
  jobs: Iterable<T>,
): T | undefined {
  for (const job of jobs)
    if (lane(job.kind) === "exclusive" && isLive(job)) return job;
  return undefined;
}

/** What the person is told when an exclusive command is already under way. */
export const busyMessage = (label: string): string =>
  `${label} is already running. Wait for it to finish or stop it before starting this one.`;

/**
 * Whether any command, in either lane, is still running in a repository.
 * Disconnecting it, deleting one of its contracts or changing its manifest
 * waits for that, since the command may be writing what would be removed.
 */
export function heldRepository<T extends { repoId: string; state: string }>(
  jobs: Iterable<T>,
  repoId: string,
): boolean {
  for (const job of jobs) if (job.repoId === repoId && isLive(job)) return true;
  return false;
}
