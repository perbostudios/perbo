import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initRepository, scratchDirectories } from "@perbo/test-support";
import { PlanningError } from "../../errors.js";
import { repositoryTree } from "./tree.js";

const scratch = scratchDirectories("perbo-planning-tree-");
const root = scratch();

function repository(files: string[]): string {
  const dir = join(root, `repo-${files.length}-${Math.random().toString(36).slice(2)}`);
  return initRepository(dir, {
    files: Object.fromEntries(files.map((file) => [file, "x\n"])),
  }).dir;
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
    expect(() => repositoryTree(join(root, "not-a-repo"))).toThrow(PlanningError);
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
      // Only the child is under test here, so the directory it runs in has to
      // exist and nothing more; what git would have said is the fake's.
      const dir = join(root, "any-directory");
      const bin = join(root, "env-dumping-git");
      const dump = join(root, "tree-child-env.txt");
      mkdirSync(dir, { recursive: true });
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
