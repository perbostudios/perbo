import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findStoredReview, reviewsDirIn } from "./stored.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-stored-review-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("a stored review that does not parse", () => {
  it("names five of what it could not read, then how many more (D-NEW-nothing-shown-is-cut)", () => {
    const store = join(scratch, ".perbo");
    mkdirSync(reviewsDirIn(store), { recursive: true });
    writeFileSync(join(reviewsDirIn(store), "rev_broken.review.json"), JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 }));
    let said = "";
    try {
      findStoredReview(store, "rev_broken");
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    const listed = said.split("\n  ").slice(1);
    expect(listed).toHaveLength(6);
    expect(listed.at(-1)).toMatch(/^and \d+ more$/);
  });
});
