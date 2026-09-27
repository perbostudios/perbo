import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decisionOptionsPath } from "@perbo/contracts";
import { DecisionOptionsRecordSchema, type DecisionOptionsRecord } from "./decision-options-report.js";
import { PlanningError } from "./errors.js";

/**
 * `<KEY>.options.json` on disk: the one reader and the one writer of the
 * answers the Architect offered to a review's findings
 * (D-NEW-decision-options), so reopening the decision page reads them back
 * rather than spending again. `store` is the repository's `.perbo` directory;
 * the record's place under it is `decisionOptionsPath`'s.
 */

/** `<store>/tickets/<KEY>.options.json`. */
export function decisionOptionsRecordPath(store: string, key: string): string {
  return join(store, ...decisionOptionsPath(key));
}

/**
 * Refuse a symlink on the way from the store to the record, the record itself
 * included: a link in the ticket store points wherever whoever wrote it chose.
 */
function refuseLink(store: string, key: string): void {
  let cursor = store;
  for (const segment of decisionOptionsPath(key)) {
    cursor = join(cursor, segment);
    let entry;
    try {
      entry = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entry.isSymbolicLink())
      throw new PlanningError(
        `${cursor} is a symlink, and the offered answers are read and written in the ticket store itself. ` +
          "Replace the link with the directory or the file",
      );
  }
}

/**
 * The record beside a ticket: null where none has been written, and a
 * `PlanningError` naming the file where one is there and is not a record.
 */
export function readDecisionOptionsRecord(store: string, key: string): DecisionOptionsRecord | null {
  refuseLink(store, key);
  const path = decisionOptionsRecordPath(store, key);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PlanningError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = DecisionOptionsRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlanningError(
      `${path} is not a record of offered answers:\n  ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

/**
 * Write the record beside the ticket, refusing one that is not a record. Written
 * whole to a file beside it and renamed over it, so a reader never meets half.
 */
export function writeDecisionOptionsRecord(store: string, key: string, record: DecisionOptionsRecord): void {
  refuseLink(store, key);
  const path = decisionOptionsRecordPath(store, key);
  const checked = DecisionOptionsRecordSchema.parse(record);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(checked, null, 2)}\n`);
  renameSync(partial, path);
}
