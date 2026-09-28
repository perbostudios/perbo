import { pendingEgressQuestion } from "./egress-question.js";
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

/**
 * Runs, decisions and publishing: one at a time for each ticket, and any
 * number across tickets, whatever is being planned (D-049, D-101). A readiness
 * check names no ticket, so it takes its turn over its whole repository.
 */
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

/** The first live command in the exclusive lane among these, if there is one. */
export function exclusiveJob<T extends { kind: string; state: string }>(
  jobs: Iterable<T>,
): T | undefined {
  for (const job of jobs)
    if (lane(job.kind) === "exclusive" && isLive(job)) return job;
  return undefined;
}

/**
 * The command a new one waits for, if there is one: a live command in the
 * exclusive lane over the same ticket, or over the same repository where
 * either names no ticket. Another ticket's run is in nobody's way, and
 * planning neither waits nor is waited for.
 */
export function inTheWay<T extends { repoId: string; key: string | null; kind: string; state: string }>(
  jobs: Iterable<T>,
  next: { repoId: string; key: string | null; kind: string },
): T | undefined {
  if (lane(next.kind) !== "exclusive") return undefined;
  for (const job of jobs)
    if (
      lane(job.kind) === "exclusive" &&
      isLive(job) &&
      job.repoId === next.repoId &&
      (job.key === null || next.key === null || job.key === next.key)
    )
      return job;
  return undefined;
}

/** What the person is told when an exclusive command is already under way. */
export const busyMessage = (label: string): string =>
  `${label} is already running. Wait for it to finish or stop it before starting this one.`;

/**
 * Whether any command, in either lane, is still running in a repository.
 * Disconnecting it or changing its manifest waits for that, since the command
 * may be writing what would be removed.
 */
export function heldRepository<T extends { repoId: string; state: string }>(
  jobs: Iterable<T>,
  repoId: string,
): boolean {
  for (const job of jobs) if (job.repoId === repoId && isLive(job)) return true;
  return false;
}

/**
 * Whether a command is still running for this one ticket: its run, a decision
 * on it, its publication, or any other command naming it by key or by the key
 * it produced. Deleting the ticket waits for that alone, since only that
 * command writes the records the delete removes; another ticket's run holds
 * nothing of this one's (D-129).
 */
export function heldTicket<T extends { repoId: string; key: string | null; resultKey?: string | null; state: string }>(
  jobs: Iterable<T>,
  repoId: string,
  key: string,
): boolean {
  for (const job of jobs)
    if (job.repoId === repoId && (job.key === key || job.resultKey === key) && isLive(job)) return true;
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
 * One ticket's jobs, the one the loop is running for it, whether its run
 * stopped short of the end, and whether it paused for the person. The
 * renderer's projection of a ticket and the archive's eligibility both read
 * this, so a stopped run is one answer.
 *
 * A stop seals to `failed` or `cancelled` inside the executor's window and
 * strands the ticket where it stood outside it, so a ticket left failed,
 * cancelled or in a loop state with nothing running for it has stopped. The
 * ticket's state is the whole answer: the journal keeps a ticket's last run
 * only while the host keeps its journal, and a stopped ticket filed in the
 * Archive long ago is still stopped once that record has gone.
 *
 * A run that completed on a verdict for the person (`outcome`) paused the
 * loop for them instead: the CLI writes the ticket's state only as it ends, so
 * until the records are read again the ticket still says the stage the run
 * started at, and that is the pause catching up, never a stop. A ticket in
 * `changes_requested` is paused for them too. Either is paused only where the
 * record puts a question to them (`TaskRow.questions`, the decision card's
 * count): one with none to ask has stopped short, and its stopped page says
 * why, because a pause with nothing to answer is one nobody can end. Where the
 * count is not read — a ticket the records have not caught up with — the
 * pause stands until they are. A run still going that waits on the person's
 * answer about a host off the allow-list (D-137) is
 * `asking`: paused for them the same way, until the answer is printed or the
 * run is stopped.
 */
export function ticketRun(
  workspace: Pick<Snapshot, "jobs">,
  row: { repoId: string; ticket: { key: string; state: string }; questions?: number },
) {
  const { ticket, repoId } = row;
  const jobs = workspace.jobs.filter(
    (job) => job.repoId === repoId && (job.key === ticket.key || job.resultKey === ticket.key),
  );
  // The loop is what a ticket's screens watch and stop, so it wins over planning running beside it.
  const active = exclusiveJob(jobs) ?? jobs.find(isLive);
  const last = jobs.filter(isRun).at(-1);
  const endedOnVerdict =
    last?.state === "completed" && last.outcome !== undefined && IN_PROGRESS_STATES.includes(ticket.state);
  const paused =
    !active && row.questions !== 0 && (ticket.state === "changes_requested" || endedOnVerdict);
  const asking = active !== undefined && active.state === "running" && isRun(active) && pendingEgressQuestion(active.log) !== null;
  const stoppedShort =
    !active &&
    !paused &&
    (IN_PROGRESS_STATES.includes(ticket.state) || ["failed", "cancelled", "changes_requested"].includes(ticket.state));
  return { jobs, active, stoppedShort, paused, asking };
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
