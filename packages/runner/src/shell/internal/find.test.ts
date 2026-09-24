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
  // `-execdir` runs the body on the starting point itself a level up: GNU in
  // the directory above it, BSD in the command's own directory.
  "find sub -execdir cp a ../x \\;",
  "find src -execdir rm -rf ../x \\;",
  "find sub -okdir cp a ../x \\;",
  "find src/deep -execdir cp a ../x \\;",
  "find ~ -execdir touch x \\;",
  // Under `..`, every path the walk finds runs the body in `..` itself.
  "find .. -execdir touch x \\;",
  // A starting point after `--` is one: both finds end their options there.
  "find -- /etc -name x -delete",
  "find -- /etc -exec rm {} \\;",
  "find -P -- /etc -delete",
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
  "find src -execdir touch x \\;",
  "find src/deep -execdir rm {} \\;",
  "find . -fprint out/found.txt",
  "find -- src -name x -delete",
  "find -files0-from list -print",
];

/** A `find` whose starting points are in a file this guard does not read. */
const STARTS_IN_A_FILE = ["find -files0-from list -delete", "find -files0-from - -exec rm {} +"];

/**
 * A `find` a wrapper in front feeds, where what it reads can be a starting
 * point or an action: `-delete`, or `-fprint` taking the next word as its file.
 */
const FED_BY_A_WRAPPER = [
  "echo /etc/x -delete | xargs find",
  // Appended after the expression, a `-delete` or a new body still acts.
  "xargs find . -name x",
  "xargs find . -name x -exec rm {} \\;",
  // BSD's `-J` puts every word it reads where its placeholder stands.
  "echo /etc -delete | xargs -J % find % -name x",
  "xargs -J % find . -name %",
  // A placeholder standing as a starting point or as an action.
  "xargs -I{} find {} -name x",
  "xargs -I{} find /etc {}",
  "xargs -I{} find /etc -name -name {}",
];

/**
 * A placeholder `find` reads as a test's argument or as a body's word, which no
 * input turns into an action: `-I` substitutes one word however it is spelled.
 */
const AN_ARGUMENT = [
  "xargs -I{} find . -name {}",
  "xargs -I{} find /etc -newer {} -print",
  "xargs -I{} find . -newermt {}",
  "xargs -I{} find . -fprintf out {}",
  "xargs -I{} find . -exec echo {} \\;",
];

/**
 * A body whose nested shell line holds `{}`: each path the walk finds lands
 * in that line, where the shell reads a file's name as code.
 */
const FOUND_IN_A_NESTED_LINE = [
  "find . -exec sh -c 'rm {}' \\;",
  "find . -execdir bash -c 'mv {} {}.bak' \\;",
  "find -L src -exec sh -c 'cd {} && cp a ../../x' \\;",
  "find . -exec pnpm exec -c 'rm {}' \\;",
];

/** The same bodies with the path handed to the shell as an argument. */
const FOUND_AS_AN_ARGUMENT = [
  "find . -exec sh -c 'wc -l \"$1\"' _ {} \\;",
  "find . -name '*.tmp' -exec sh -c 'echo found' \\;",
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

  for (const command of STARTS_IN_A_FILE) {
    it(`cannot be read where ${command} reads it from a file`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain("-files0-from");
    });
  }

  for (const command of FED_BY_A_WRAPPER) {
    it(`cannot be read where a wrapper feeds ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain("what find walks and what it does there");
    });
  }

  for (const command of AN_ARGUMENT) {
    it(`is read where the wrapper's input is only an argument in ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }
});

describe("a path find puts into a body", () => {
  for (const command of FOUND_IN_A_NESTED_LINE) {
    it(`makes the nested line unreadable in ${command}`, () => {
      expect(decision(command), command).toBe("refused");
      expect(sentence(command), command).toContain("find puts each path it finds where {} stands");
    });
  }

  for (const command of FOUND_AS_AN_ARGUMENT) {
    it(`leaves the nested line readable in ${command}`, () => {
      expect(decision(command), command).toBe("allowed");
    });
  }
});
