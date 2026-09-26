import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readAttemptsFile } from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-attempts-file-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("an attempts record that does not parse", () => {
  it("names five of what it could not read, then how many more (D-NEW-nothing-shown-is-cut)", () => {
    const path = join(scratch, "ticket.attempts.json");
    writeFileSync(path, JSON.stringify({ ticket_id: "ticket_x", attempts: [1, 2, 3, 4, 5, 6, 7] }));
    let said = "";
    try {
      readAttemptsFile(path);
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    const listed = said.split("\n  ").slice(1);
    expect(listed).toHaveLength(6);
    expect(listed.at(-1)).toBe("and 2 more");
  });
});
