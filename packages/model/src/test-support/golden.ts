import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

/**
 * Compare a captured value against a committed file.
 *
 * The file is written once, from the code as it stands, by running the test
 * with `PERBO_WRITE_GOLDEN=1` while it is absent. After that it is only ever
 * read: a run with the variable set and the file present still compares. So a
 * change to what a transport sends fails here rather than quietly rewriting
 * the record of what it used to send, and restoring the green means deleting
 * the file on purpose.
 *
 * The comparison is over the rendered text, not the parsed value, because key
 * order is part of the bytes a provider receives.
 */
export function expectGolden(url: URL, captured: unknown): void {
  const path = fileURLToPath(url);
  const rendered = `${JSON.stringify(captured, null, 2)}\n`;
  // A path that varies per run is a path the file would carry: the capture
  // normalises them, and this is the check that it did.
  for (const varying of [tmpdir(), process.env.TMPDIR ?? ""]) {
    if (varying !== "" && rendered.includes(varying)) {
      throw new Error(`the capture carries the temporary path ${varying}; normalise it first`);
    }
  }
  if (!existsSync(path)) {
    if (process.env.PERBO_WRITE_GOLDEN !== "1") {
      throw new Error(`no golden at ${path}; write it once with PERBO_WRITE_GOLDEN=1`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered, "utf8");
    return;
  }
  expect(rendered).toBe(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}
