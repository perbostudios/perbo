import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The tree is read by the runner's git, not by whatever the ambient
 * environment happens to be: a credential prompt is a failure rather than a
 * process waiting on a terminal nobody is watching, and a token that is in
 * this process's environment is not in the child's.
 */
describe("the git repositoryTree starts", () => {
  it.skipIf(process.platform === "win32")(
    "runs in the runner's environment, with prompts off and no ambient secret",
    () => {
      const dir = repository(["README.md"]);
      const bin = join(scratch, "env-dumping-git");
      const dump = join(scratch, "tree-child-env.txt");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nenv > ${JSON.stringify(dump)}\nprintf 'a/b/c.ts\\0README.md\\0'\n`,
      );
      chmodSync(join(bin, "git"), 0o755);

      const path = process.env.PATH;
      process.env.PATH = `${bin}:${path ?? ""}`;
      process.env.PERBO_SENTINEL_TOKEN = "a token the child must not see";
      let tree: string[];
      try {
        tree = repositoryTree(dir);
      } finally {
        process.env.PATH = path;
        delete process.env.PERBO_SENTINEL_TOKEN;
      }

      expect(tree).toEqual(["README.md", "a/", "a/b/"]);
      const child = readFileSync(dump, "utf8").split("\n");
      expect(child).toContain("GIT_TERMINAL_PROMPT=0");
      expect(child.filter((line) => line.startsWith("PERBO_SENTINEL_TOKEN="))).toEqual([]);
    },
  );
});
