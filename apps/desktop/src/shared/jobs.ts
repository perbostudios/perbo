import type { Job, Snapshot } from "./protocol.js";

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
 * rather than as jobs, so they never enter the job list at all. Reading the
 * plan against its spec is a job, because a model runs for it, and it is here
 * because it is planning too.
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
  "drift",
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
  "publish",
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

/**
 * The newest reading of this ticket's plan against its spec, whoever asked
 * for it: the one this pane asked for on arrival, or the one the host started
 * itself once the interview finished a turn. What the pane stands on is the
 * session's record; the job is read for whether a reading is under way, and
 * for a reading that failed, which lands nowhere else.
 */
export function newestReading(
  jobs: readonly Job[],
  repoId: string,
  key: string,
): Job | null {
  return jobs.reduce<Job | null>(
    (best, entry) =>
      entry.kind === "drift" &&
      entry.repoId === repoId &&
      entry.key === key &&
      (best === null || entry.startedAt >= best.startedAt)
        ? entry
        : best,
    null,
  );
}

/** The states the loop carries a ticket through while its run is under way. */
const IN_PROGRESS_STATES: readonly string[] = ["provisioning", "executing", "verifying", "independent_review"];

/** A ticket's run: the loop started on it, by a run or by a decision's answer. */
export const isRun = (job: Pick<Job, "kind">): boolean => job.kind === "run" || job.kind === "decide";

/**
 * One ticket's jobs, the one the loop is running for it, and whether its run
 * stopped short of the end. The renderer's projection of a ticket and the
 * archive's eligibility both read this, so a stopped run is one answer.
 *
 * A stop seals to `failed` or `cancelled` inside the executor's window and
 * strands the ticket where it stood outside it, so a ticket left in a loop
 * state with nothing running for it has stopped, whatever the journal holds.
 */
export function ticketRun(
  workspace: Pick<Snapshot, "jobs">,
  row: { repoId: string; ticket: { key: string; state: string } },
) {
  const { ticket, repoId } = row;
  const jobs = workspace.jobs.filter(
    (job) => job.repoId === repoId && (job.key === ticket.key || job.resultKey === ticket.key),
  );
  // The loop is what a ticket's screens watch and stop, so it wins over planning running beside it.
  const active = exclusiveJob(jobs) ?? jobs.find(isLive);
  const lastRun = jobs.filter(isRun).at(-1);
  const inProgress = IN_PROGRESS_STATES.includes(ticket.state);
  const stoppedShort =
    !active &&
    (inProgress || ["failed", "cancelled"].includes(ticket.state)) &&
    (["interrupted", "failed", "cancelled"].includes(lastRun?.state ?? "") || inProgress);
  return { jobs, active, stoppedShort };
}

/**
 * The job journal a host keeps: the last forty records, every record `kept`
 * holds, and each ticket's last run or decide, since its stopped page and
 * Continue read that record however long ago it ended. It is bounded by forty,
 * plus the live commands, plus one per ticket that has ever run.
 */
export function journal<T extends Pick<Job, "repoId" | "key" | "kind">>(
  jobs: readonly T[],
  kept: (job: T) => boolean = () => false,
): T[] {
  const lastRun = new Map<string, T>();
  for (const job of jobs) if (isRun(job)) lastRun.set(`${job.repoId}\0${job.key}`, job);
  const lastRuns = new Set(lastRun.values());
  return jobs.filter((job, index) => index >= jobs.length - 40 || lastRuns.has(job) || kept(job));
}
