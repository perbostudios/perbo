import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { driftPath } from "@perbo/contracts";
import { DriftRecordSchema, type DriftRecord } from "./drift-report.js";
import { PlanningError } from "./errors.js";

/**
 * `<KEY>.drift.json` on disk: the one reader and the one writer of the verdict
 * kept beside a ticket (D-128). The command line and the desktop host both
 * read and write it through here, so the file each of them reaches, the shape
 * each accepts and the bytes each writes are one.
 *
 * `store` is the repository's `.perbo` directory, however the caller holds it;
 * the record's place under it is `driftPath`'s.
 */

/** The hash a record is keyed by: of the spec's bytes, and of the plan's promise texts. */
export const driftHash = (bytes: Buffer | string): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** `<store>/tickets/<KEY>.drift.json`. */
export function driftRecordPath(store: string, key: string): string {
  return join(store, ...driftPath(key));
}

/**
 * Refuse a symlink on the way from the store to the record, the record itself
 * included, dangling or not: a link in the ticket store points wherever
 * whoever wrote it chose, and a read or a write through it would reach there.
 */
function refuseLink(store: string, key: string): void {
  let cursor = store;
  for (const segment of driftPath(key)) {
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
        `${cursor} is a symlink, and a drift record is read and written in the ticket store itself. ` +
          "Replace the link with the directory or the file",
      );
  }
}

/**
 * The record beside a ticket: null where none has been written, and a
 * `PlanningError` naming the file where one is there and is not a record — the
 * same hand edit the counter-seal catches on the contract, said in words a
 * person can act on rather than as a parse error.
 */
export function readDriftRecord(store: string, key: string): DriftRecord | null {
  refuseLink(store, key);
  const path = driftRecordPath(store, key);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PlanningError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PlanningError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = DriftRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlanningError(
      `${path} is not a drift record:\n  ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n  "),
    );
  }
  return parsed.data;
}

/** Write the record beside the ticket, refusing one that is not a record. */
export function writeDriftRecord(store: string, key: string, record: DriftRecord): void {
  refuseLink(store, key);
  const path = driftRecordPath(store, key);
  const checked = DriftRecordSchema.parse(record);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(checked, null, 2)}\n`);
}
