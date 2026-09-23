import { archiveCsv, archiveRows } from "../../shared/archive.js";
import { redact } from "../process.js";
import type { RequestOf, Snapshot } from "../../shared/protocol.js";

/** A file the person is offered to save, named and ready to write. */
export interface Export {
  name: string;
  content: string;
}

/**
 * The filed tickets as a spreadsheet reads them, under the same filters as the
 * archive on screen. A ticket that has finished but has not been filed is not
 * in it (S4), and a credential in a title never leaves in a file.
 */
export function archiveExport(
  snapshot: Snapshot,
  filter: RequestOf<"exportArchive">,
): Export {
  return {
    name: "perbo-archive.csv",
    content: redact(archiveCsv(archiveRows(snapshot, filter), snapshot.titles)),
  };
}

/** One task's record, or a repository's tasks, as the JSON a person keeps. */
export function ticketExport(name: string, value: unknown): Export {
  return {
    name: `perbo-${name}.json`,
    content: redact(JSON.stringify(value, null, 2)),
  };
}
