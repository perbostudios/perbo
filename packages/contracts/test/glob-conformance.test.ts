import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchesAny } from "../src/paths.js";

/**
 * `glob-conformance.json` is what a path glob means, written as cases, and
 * `matchesAny` is the implementation those cases define. A matcher written
 * elsewhere to these semantics — a check that runs before anything is built
 * cannot import this one — answers the same table.
 */

interface Case {
  pattern: string;
  path: string;
  matches: boolean;
}

const { cases } = JSON.parse(
  readFileSync(new URL("./glob-conformance.json", import.meta.url), "utf8"),
) as { cases: Case[] };

describe("what a path glob means", () => {
  it.each(cases)("$pattern ~ $path is $matches", ({ pattern, path, matches }) => {
    expect(matchesAny(path, [pattern])).toBe(matches);
  });

  /**
   * The table is what the other copies are held to, so a shorter table holds
   * them to less. These are the rows a matcher written the obvious way gets
   * wrong: a `**` prefix matching no segment at all, which is what covers a
   * root-level `.env` or `CODEOWNERS`, and `?` as one character rather than a
   * literal question mark.
   */
  it("carries the root-level `**/` and the `?` cases", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const [pattern, path] of [
      ["**/*.ts", "foo.ts"],
      ["**/.env*", ".env"],
      ["**/CODEOWNERS", "CODEOWNERS"],
      ["a/**/b", "a/b"],
      ["src/?.ts", "src/a.ts"],
    ]) {
      expect(
        cases.some((each) => each.pattern === pattern && each.path === path && each.matches),
      ).toBe(true);
    }
  });
});
