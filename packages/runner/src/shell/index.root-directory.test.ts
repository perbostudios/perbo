import { mkdirSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { readCommandLine, resolveScope } from "./index.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The filesystem root is a directory like any other. A shell moved there has to
 * be placed at `/` — a reading that answers with neither `/` nor "somewhere
 * this guard cannot say" puts a directory in the attempt's record that no path
 * on the machine names, and hands the next line a base it cannot resolve
 * against.
 */

const root = scratch("perbo-root-directory-");
mkdirSync(join(root, "sub"), { recursive: true });
const scope = resolveScope({ root, home: "/Users/nobody" });

describe("a line that moves the shell to the filesystem root", () => {
  for (const command of ["cd /", "pushd /", "cd /sub/..", "cd /.."]) {
    it(`places it at / — ${command}`, () => {
      expect(readCommandLine(command, scope).cwd, command).toMatchObject({
        path: "/",
        unknown: false,
      });
    });
  }

  it("still refuses a relative write from there", () => {
    const read = readCommandLine("cd / && echo x > y", scope);
    expect(read.findings.map((finding) => finding.resolved)).toEqual(["/y"]);
  });
});

/**
 * A symlink reaching the root is the same root, so the walk holds it the way
 * the anchor is held — without its separator — and the component after it joins
 * onto one `/`. A destination spelled with two names nothing on the machine,
 * and a path that comes back into the worktree through such a link is inside
 * it.
 */
describe("a path walked through a symlink to the filesystem root", () => {
  const through = scratch("perbo-root-symlink-");
  symlinkSync("/", join(through, "rootlink"));
  const linked = resolveScope({ root: through, home: "/Users/nobody" });
  // Directly under the root and named for this run, so it is a path no other
  // entry on the host can be.
  const absent = basename(through);

  it("records the destination by the name it has", () => {
    const read = readCommandLine(`echo x > rootlink/${absent}/y`, linked);
    expect(read.findings.map((finding) => finding.resolved)).toEqual([`/${absent}/y`]);
  });

  it("reads one that comes back into the worktree as inside it", () => {
    expect(readCommandLine(`echo x > rootlink${linked.root}/y`, linked).findings).toEqual([]);
  });
});
