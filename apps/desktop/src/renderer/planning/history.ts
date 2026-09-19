import type { DraftEdit, GraphEditView } from "../../shared/protocol.js";

/**
 * One edit to this planning, whichever record holds it: the plan's own log
 * once a ticket exists, and the editing session's before one does (D-100).
 */
export interface HistoryRow {
  /** Its place in the record, counting from 1: what an undo names. */
  n: number;
  at: string;
  author: "you" | "interview";
  summary: string;
  undone: boolean;
  /** True once the plan was re-drafted from its spec over the top of it. */
  replaced: boolean;
  /** The edit this one undid, by its number, or null for an edit of its own. */
  undoes: number | null;
}

export const graphHistory = (edits: readonly GraphEditView[]): HistoryRow[] =>
  edits.map((edit) => ({ ...edit }));

/** The explorer's marks, which is all a session's own history holds before a plan. */
export const draftHistory = (edits: readonly DraftEdit[]): HistoryRow[] =>
  edits.map((edit) => ({
    n: edit.n,
    at: edit.at,
    author: edit.author,
    summary: edit.summary,
    undone: edit.undone,
    replaced: false,
    undoes: null,
  }));

/**
 * The one edit an undo may take: the latest still in force (D-100).
 *
 * An earlier one may have been built on, and the host refuses that naming the
 * edit in the way; an undo is not itself undone, and an edit the spec was
 * re-drafted past has no contract left to put back. One rule, so the Graph
 * pane's list and the history drawer offer the same edit.
 */
export const latestUndoable = (rows: readonly HistoryRow[]): HistoryRow | undefined =>
  [...rows].reverse().find((row) => !row.undone && !row.replaced && row.undoes === null);
