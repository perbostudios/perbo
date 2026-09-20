import { ESCAPE_WINDOW_DAYS, type EscapeRow } from "@perbo/contracts";

/**
 * When each merged change's fourteen days are up (`SCP-217`).
 *
 * The window is not a period anybody hands the command: it starts at the
 * change's **own** merge and closes fourteen days later, so two changes merged
 * on different days fall due on different days and a store read on one morning
 * holds both kinds at once. Everything here is that one sentence in arithmetic:
 * `merged_at` plus {@link ESCAPE_WINDOW_DAYS}, against the clock the report is
 * being read at.
 *
 * It is separate from `escapes/index.ts` because it is the only part of the reading
 * that needs neither a repository nor a record on disk — a row and a clock are
 * the whole input, which is what makes the boundary testable at a fixed instant
 * rather than at whatever day the suite happens to run on.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A change's fourteen days against the clock: `due` once they are up, `not yet
 * due` while they are not, and `no merge date` for a merged ticket no sync has
 * written a record for — that one has no merge date to read a window from, and
 * saying so is not the same as saying its window is open.
 */
export type Dueness = "due" | "not yet due" | "no merge date";

/**
 * The instant a change's fourteen days are up: its own merge, plus the window.
 *
 * Null when the row carries no merge date, which is a row with no escapes
 * record at all. This is the same arithmetic `perbo sync` wrote into the
 * record's `window_closes_at`; it is done again here so the command's reading
 * is the fourteen days it names, whatever window an older record was collected
 * under.
 */
export function dueAt(row: Pick<EscapeRow, "merged_at">): string | null {
  if (row.merged_at === null) return null;
  return new Date(Date.parse(row.merged_at) + ESCAPE_WINDOW_DAYS * DAY_MS).toISOString();
}

/**
 * Which of the three a row is, at `now`.
 *
 * The boundary belongs to the count: a change merged exactly fourteen days ago
 * is due. An escape that lands on the last minute of the fourteenth day is
 * inside the window `classifyEscapes` reads, so a fourteenth day spent waiting
 * would be a day of not counting a change that has already been fully watched.
 */
export function duenessOf(row: Pick<EscapeRow, "merged_at">, now: Date): Dueness {
  const due = dueAt(row);
  if (due === null) return "no merge date";
  return now.getTime() >= Date.parse(due) ? "due" : "not yet due";
}

/**
 * The population split three ways and never added back up.
 *
 * `due` and `not_yet_due` are printed as two figures for the reason the revert
 * and same-path columns are: one number over both would answer "how many
 * changes are there", which nobody asked, in place of "how many have had their
 * fourteen days", which is the reading.
 */
export interface DueCounts {
  /** Merged changes whose own fourteen days are up at the clock being read. */
  due: number;
  /** Merged changes still inside them. Each row says the day it falls due. */
  not_yet_due: number;
  /** Merged changes with no record, so with no merge date to count from. */
  no_merge_date: number;
}

export function countDueness(rows: readonly EscapeRow[], now: Date): DueCounts {
  const of = (dueness: Dueness): number => rows.filter((row) => duenessOf(row, now) === dueness).length;
  return { due: of("due"), not_yet_due: of("not yet due"), no_merge_date: of("no merge date") };
}

/**
 * What a ticket's row says in the `fourteen days` column.
 *
 * Dueness is about the clock and the merge date; whether a due change was
 * actually watched to the end of its window is about the record, and `stale`
 * is the row where the two differ — due, and read by nobody since. It stays out
 * of the rate and names the command that fixes it, as it did before.
 */
export function escapeReading(row: EscapeRow, now: Date): "due" | "not yet due" | "stale" | "not observed" {
  switch (duenessOf(row, now)) {
    case "no merge date":
      return "not observed";
    case "not yet due":
      return "not yet due";
    case "due":
      return row.status === "observed" ? "due" : "stale";
  }
}
