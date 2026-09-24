import type { Request, Snapshot, TaskRow } from "./protocol.js";
import { isLive, isRun, ticketRun } from "./jobs.js";

type ArchiveFilter = Omit<Extract<Request, { kind: "exportArchive" }>, "kind">;
/** A terminal Ticket state: finished, whether or not it has been filed. */
export const isArchived = (state: string): boolean =>
  ["merged", "closed", "done", "cancelled", "rolled_back"].includes(state);
/**
 * The states a ticket is in before approval starts its loop.
 *
 * These belong to the Create picker and not to Home: a plan nobody has
 * approved is work still being planned, and Home is the board for work the
 * loop is carrying (D-129). Declared here, beside
 * the other rule about what Home shows, because both readers are that split.
 */
const PRE_LOOP_STATES: readonly string[] = ["draft", "specifying", "plan_review"];

/** Whether this ticket is still being planned rather than run. */
export const isPreLoop = (row: { ticket: { state: string } }): boolean =>
  PRE_LOOP_STATES.includes(row.ticket.state);

/** Where a ticket's journey ends once its merge is decided: merged, or closed without merge, and what follows a merge. */
export const DECIDED_STATES: readonly string[] = ["merged", "closed", "done", "deployed", "observing"];
/** Where a ticket's journey ends: a pull request opened and waiting on the merge decision, or that decision made. */
export const JOURNEY_END_STATES: readonly string[] = ["pr_open", ...DECIDED_STATES];
/** The states from which the loop will not carry a ticket to that end unless a person starts it again. */
export const GIVEN_UP_STATES: readonly string[] = ["failed", "cancelled", "inconclusive", "rolled_back", "plan_invalid"];

/**
 * Whether a ticket may be filed in the archive: the person has decided its
 * merge, merged or closed without merge, or its run stopped. A ticket the loop
 * still carries — running, waiting on a decision or the queue — and one whose
 * pull request still waits on the merge decision stay on Home, and the host
 * refuses to file them (S4). Nothing is filed but by hand.
 */
export function isArchivable(
  snapshot: Pick<Snapshot, "jobs">,
  row: Pick<TaskRow, "repoId" | "ticket">,
): boolean {
  const { jobs, stoppedShort } = ticketRun(snapshot, row);
  return (
    !jobs.some((job) => isLive(job) && isRun(job)) &&
    (DECIDED_STATES.includes(row.ticket.state) || GIVEN_UP_STATES.includes(row.ticket.state) || stoppedShort)
  );
}
/**
 * What the host and the sample host answer when asked to file a ticket that
 * cannot be: one whose pull request waits on the merge decision, or one the
 * loop still carries.
 */
export const notArchivable = (key: string, state: string): string =>
  state === "pr_open"
    ? `${key} waits on the merge decision. Archive it once its pull request is merged or closed.`
    : `${key} is still in its loop. Archive it once it has finished or its run has stopped.`;

/** Filed away from Home by hand (S4). A ticket that could be filed and is not stays on Home. */
export const isFiled = (
  snapshot: Pick<Snapshot, "archived" | "jobs">,
  row: Pick<TaskRow, "repoId" | "ticket">,
): boolean =>
  (snapshot.archived?.includes(row.repoId + ":" + row.ticket.key) ?? false) &&
  isArchivable(snapshot, row);
export const taskTitle = (row: TaskRow, titles: Snapshot["titles"]): string =>
  titles?.[row.repoId + ":" + row.ticket.key] ?? row.ticket.title;

/** The visible archive and its export use the same filters, including all repositories. */
export function archiveRows(
  snapshot: Pick<Snapshot, "tasks" | "titles" | "archived" | "jobs">,
  filter: ArchiveFilter,
): TaskRow[] {
  const search = filter.search.toLowerCase();
  return snapshot.tasks
    .filter(
      (row) =>
        isFiled(snapshot, row) &&
        (filter.repoId === null || row.repoId === filter.repoId) &&
        (filter.outcome === "all" || row.ticket.state === filter.outcome) &&
        [
          taskTitle(row, snapshot.titles),
          row.ticket.key,
          row.repository,
          row.ticket.delivery.pull_request_number ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(search),
    )
    .sort((a, b) =>
      filter.sort === "title"
        ? taskTitle(a, snapshot.titles).localeCompare(
            taskTitle(b, snapshot.titles),
          )
        : (filter.sort === "oldest" ? 1 : -1) *
          a.ticket.updated_at.localeCompare(b.ticket.updated_at),
    );
}

export function archiveCsv(
  rows: TaskRow[],
  titles: Snapshot["titles"],
): string {
  // Spreadsheet applications interpret these prefixes even in a quoted CSV cell.
  const cell = (value: string): string =>
    '"' +
    (/^[\s]*[=+@\-\t\r]/.test(value) ? "'" : "") +
    value.replaceAll('"', '""') +
    '"';
  return [
    ["Ticket", "Task", "Repository", "Outcome", "Pull request", "Updated"],
    ...rows.map((row) => [
      row.ticket.key,
      taskTitle(row, titles),
      row.repository,
      row.ticket.state,
      row.ticket.delivery.pull_request_url ?? "",
      row.ticket.updated_at,
    ]),
  ]
    .map((row) => row.map(cell).join(","))
    .join("\n");
}
