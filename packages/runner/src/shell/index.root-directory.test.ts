import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
