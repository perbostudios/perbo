import { describe, expect, it } from "vitest";
import { decision, sentence } from "../test-support/pins.js";

/**
 * What `find` finds is under a starting point, so a starting point is where
 * `-delete`, an `-exec` body run on what it finds and `-execdir` land: each is
 * judged there, as is every body and the file `-fprint` writes.
 */

/** Lines whose writes land under a starting point outside the worktree. */
const WRITES_OUTSIDE = [
  "find /etc -name x -delete",
  "find -L /etc -name x -delete",
  "find ~ -name '*.log' -delete",
  "find /etc -name x -exec rm {} +",
  "find /etc -exec rm {} \\;",
  // The found path is the copy's destination.
  "find /etc -exec cp a {} \\;",
  "find /etc -execdir rm {} \\;",
  "find /etc -execdir touch x \\;",
  // Every body is read, not only the first.
  "find . -exec true \\; -exec rm -rf /etc/x \\;",
  "find . -ok rm /etc/x \\;",
  "find . -fprint /etc/x",
];

/** The same shapes inside the worktree, or with the found path only read. */
const WITHIN_OR_READ = [
  "find . -name x -delete",
  "find -name x -delete",
  "find src -name '*.tmp' -exec rm {} +",
  "find /etc -name hosts -exec cp {} out \\;",
  "find /etc -name x -print",
  "find . -execdir touch x \\;",
  "find . -fprint out/found.txt",
];

describe("a find's starting point", () => {
  for (const command of WRITES_OUTSIDE) {
    it(`is where ${command} writes`, () => {
      expect(decision(command), command).toBe("refused");
    });
  }

  for (const command of WITHIN_OR_READ) {
    it(`is inside, or only read, in ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }

  it("is refused where a wrapper in front supplies it", () => {
    const command = "echo /etc | xargs -I{} find {} -delete";
    expect(decision(command), command).toBe("refused");
    expect(sentence(command), command).toContain("xargs");
  });
});
