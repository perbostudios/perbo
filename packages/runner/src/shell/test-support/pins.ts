import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectCommand } from "../../prohibited.js";
import { scratch } from "../../../test/support.js";

/**
 * SCP-190: every entry of every table the guard reads a command against is
 * pinned by removing it, and this is what those pins read a line with.
 *
 * A table entry with no test is an entry nobody can delete safely and nobody
 * can trust: `INLINE_WRITE_CALLS`'s "opens a file for writing" rule could be
 * deleted from #325 without a single one of 119 tests noticing. Asserting a
 * decision beside the entry is not enough either — the same assertion passes on
 * a guard that reached it some other way. So each entry is **taken out of the
 * table at run time**, the same line re-read, and the answer required to change.
 *
 * A table is read by the file that pins it rather than listed there, so an
 * entry added later with no line of its own fails that file instead of shipping
 * unpinned. What "change" means differs by table, and each file says which.
 *
 * The line is read through `inspectCommand`, the production path the pins are
 * written against.
 */

const ROOT = realpathSync(scratch("perbo-scp190-pins-"));
mkdirSync(join(ROOT, "src"), { recursive: true });
writeFileSync(join(ROOT, "package.json"), '{"name": "fixture"}\n');
writeFileSync(join(ROOT, "notes.md"), "notes\n");

const writes = (command: string) =>
  inspectCommand(command, { root: ROOT, home: "/Users/nobody" }).filter(
    (hit) => hit.action === "write_outside_worktree",
  );

export const decision = (command: string): "refused" | "allowed" =>
  writes(command).length > 0 ? "refused" : "allowed";

export const sentence = (command: string) => writes(command).map((hit) => hit.detail).join("\n");

/** Run `body` with one entry of a map taken out, and put it back afterwards. */
export const withoutMapEntry = <T>(table: Map<string, T>, key: string, body: () => void) => {
  const held = table.get(key)!;
  table.delete(key);
  try {
    body();
  } finally {
    table.set(key, held);
  }
};

/** Run `body` with one entry of a list taken out, and put it back afterwards. */
export const withoutListEntry = <T>(table: T[], index: number, body: () => void) => {
  const held = table[index]!;
  table.splice(index, 1);
  try {
    body();
  } finally {
    table.splice(index, 0, held);
  }
};
