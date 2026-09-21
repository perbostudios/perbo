import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { explorerPath, safePath } from "./paths.js";
import type { RegisteredRepository } from "../profile/store.js";

const scratchDirectory = createScratch("perbo-paths-");
afterEach(() => {
  scratchDirectory.removeAll();
});
function repository(): RegisteredRepository {
  const root = scratchDirectory();
  const path = join(root, "checkout");
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "main.ts"), "export const a = 1;\n");
  return { id: "80000000-0000-4000-8000-000000000001", name: "checkout", path };
}

describe("safePath", () => {
  it("resolves a path the repository owns", () => {
    const repo = repository();
    expect(safePath(repo, "src", "main.ts")).toBe(join(repo.path, "src", "main.ts"));
  });

  it("refuses a path that leaves the repository", () => {
    const repo = repository();
    expect(() => safePath(repo, "..")).toThrow("Path is outside the selected repository.");
    expect(() => safePath(repo, "..", "elsewhere")).toThrow(
      "Path is outside the selected repository.",
    );
    expect(() => safePath(repo, join(repo.path, "..", "elsewhere"))).toThrow(
      "Path is outside the selected repository.",
    );
  });

  it("refuses a link on the way, wherever in the path it sits", () => {
    const repo = repository();
    const outside = join(repo.path, "..", "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "s\n");
    symlinkSync(outside, join(repo.path, "linked"));
    expect(() => safePath(repo, "linked", "secret.txt")).toThrow("refuses a symlink");
    expect(() => safePath(repo, "linked")).toThrow("refuses a symlink");
  });
});

describe("explorerPath", () => {
  it("takes a repository-relative path and normalises how it is spelled", () => {
    const repo = repository();
    expect(explorerPath(repo, "./src/main.ts")).toBe("src/main.ts");
  });

  it("refuses an absolute path, in either spelling", () => {
    const repo = repository();
    expect(() => explorerPath(repo, join(repo.path, "src", "main.ts"))).toThrow(
      "Perbo does not take an absolute path from a screen.",
    );
    expect(() => explorerPath(repo, "C:\\Windows\\win.ini")).toThrow(
      "Perbo does not take an absolute path from a screen.",
    );
    expect(() => explorerPath(repo, "/etc/passwd")).toThrow(
      "Perbo does not take an absolute path from a screen.",
    );
  });

  it("refuses a path that climbs out, and an empty one", () => {
    const repo = repository();
    expect(() => explorerPath(repo, "src/../../elsewhere")).toThrow(
      "That path would leave the repository.",
    );
    expect(() => explorerPath(repo, "../elsewhere")).toThrow(
      "That path would leave the repository.",
    );
    expect(() => explorerPath(repo, "")).toThrow("That path would leave the repository.");
  });

  it("refuses a path no surface reads, whether or not it is there", () => {
    const repo = repository();
    expect(() => explorerPath(repo, ".env")).toThrow("Perbo never lists nor reads this path");
    expect(() => explorerPath(repo, ".git/config")).toThrow(
      "Perbo never lists nor reads this path",
    );
    expect(() => explorerPath(repo, "packages/app/secrets/token.txt")).toThrow(
      "Perbo never lists nor reads this path",
    );
  });

  it("refuses a link, through safePath, once the spelling is sound", () => {
    const repo = repository();
    const outside = join(repo.path, "..", "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(repo.path, "linked"));
    expect(() => explorerPath(repo, "linked/secret.txt")).toThrow("refuses a symlink");
  });
});
