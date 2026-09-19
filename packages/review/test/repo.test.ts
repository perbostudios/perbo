import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoReader } from "../src/repo.js";

const scratch: string[] = [];

const repository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "perbo-repo-reader-"));
  scratch.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), "export const answer = 42;\n");
  return root;
};

afterEach(() => {
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the bounded repository tree", () => {
  it("is unchanged by machine-local cache directories and a worktree marker", () => {
    const clean = repository();
    const noisy = repository();

    for (const path of [
      ".hypothesis/examples/seed",
      ".pytest_cache/v/cache/nodeids",
      ".yarn/cache/package.zip",
    ]) {
      const full = join(noisy, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "machine-local\n");
    }
    writeFileSync(join(noisy, ".git"), "gitdir: /machine/local/worktree\n");

    expect(new RepoReader(noisy).tree()).toEqual(new RepoReader(clean).tree());
    expect(new RepoReader(noisy).tree()).toEqual([
      { path: "src/index.ts", bytes: Buffer.byteLength("export const answer = 42;\n") },
    ]);
  });

  it("does not serve a guessed worktree marker to the reviewer", () => {
    const root = repository();
    writeFileSync(join(root, ".git"), "gitdir: /machine/local/worktree\n");

    expect(new RepoReader(root).read(".git")).toEqual({
      ok: false,
      path: ".git",
      refusal: "refused: Git metadata is machine-local and never enters reviewer context",
    });
  });
});
