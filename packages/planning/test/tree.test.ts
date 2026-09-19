import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PlanningError, repositoryTree } from "../src/index.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-planning-tree-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function repository(files: string[]): string {
  const dir = join(scratch, `repo-${files.length}-${Math.random().toString(36).slice(2)}`);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "x\n");
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

describe("repositoryTree", () => {
  it("lists tracked directories two levels deep and files at the root, nothing deeper", () => {
    const dir = repository([
      "README.md",
      "packages/auth/src/signup.ts",
      "packages/auth/test/signup.test.ts",
      "packages/queue/src/index.ts",
      "docs/04-ticket.md",
      ".github/workflows/ci.yml",
    ]);
    expect(repositoryTree(dir)).toEqual([
      ".github/",
      ".github/workflows/",
      "README.md",
      "docs/",
      "packages/",
      "packages/auth/",
      "packages/queue/",
    ]);
  });

  it("says so when the directory is not a repository", () => {
    expect(() => repositoryTree(join(scratch, "not-a-repo"))).toThrow(PlanningError);
  });
});
