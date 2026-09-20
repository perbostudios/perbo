import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listExplorer, readExplorerFile } from "./explorer.js";
import { configPath } from "./repository/layout.js";
import { PREVIEW_BYTE_CAP } from "../shared/protocol.js";
import type { Execute } from "./repository/git.js";
import type { RegisteredRepository } from "./profile/store.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function repository(): RegisteredRepository {
  const root = mkdtempSync(join(tmpdir(), "perbo-explorer-"));
  temporary.push(root);
  const path = join(root, "checkout");
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "README.md"), "# Test repository\n");
  writeFileSync(join(path, "src", "main.ts"), "export const a = 1;\n");
  writeFileSync(join(path, ".env"), "SECRET=1\n");
  return { id: "80000000-0000-4000-8000-000000000001", name: "checkout", path };
}
/** Git, answering `ls-files -z` with the paths the repository tracks. */
const tracking = (...paths: string[]): Execute =>
  () =>
    Promise.resolve({
      code: 0,
      stdout: paths.map((path) => path + "\0").join(""),
      stderr: "",
      cancelled: false,
    });

describe("listExplorer", () => {
  it("lists the tracked files in order, and counts what it withholds", async () => {
    const repo = repository();
    const listing = await listExplorer(
      tracking("src/main.ts", "README.md", ".env", "certs.pem", "packages/app/secrets/token.txt"),
      repo,
    );
    expect(listing.files).toEqual(["README.md", "src/main.ts"]);
    // Tracked in the repository, and never named here.
    for (const hidden of [".env", "certs.pem", "packages/app/secrets/token.txt"])
      expect(listing.files, hidden).not.toContain(hidden);
    expect(listing.hidden).toBe(3);
    expect(listing.files).toEqual([...listing.files].sort());
    expect(listing.standing).toEqual([]);
  });

  it("carries the standing prohibitions the repository recorded", async () => {
    const repo = repository();
    mkdirSync(join(repo.path, ".perbo"), { recursive: true });
    writeFileSync(
      configPath(repo),
      JSON.stringify({ paths_prohibited: ["infra/**"] }),
    );
    const listing = await listExplorer(tracking("README.md"), repo);
    expect(listing.standing).toEqual([
      {
        path: "infra/**",
        draft: null,
        source: "written in .perbo/config.json",
        added_at: null,
      },
    ]);
  });
});

describe("readExplorerFile", () => {
  it("reads a tracked file as text", async () => {
    const repo = repository();
    const file = await readExplorerFile(tracking("src/main.ts"), repo, "src/main.ts");
    expect(file).toMatchObject({
      path: "src/main.ts",
      text: "export const a = 1;\n",
      refusal: null,
    });
    expect(file.bytes).toBe(20);
  });

  it("refuses a path no surface reads, before it is opened", async () => {
    const repo = repository();
    await expect(readExplorerFile(tracking(".env"), repo, ".env")).rejects.toThrow(
      "Perbo never lists nor reads this path",
    );
  });

  it("refuses a file Git does not track, and one that is not there", async () => {
    const repo = repository();
    await expect(
      readExplorerFile(tracking("README.md"), repo, "src/main.ts"),
    ).rejects.toThrow("is not a tracked file in this repository.");
    await expect(
      readExplorerFile(tracking("src/gone.ts"), repo, "src/gone.ts"),
    ).rejects.toThrow("is not a tracked file in this repository.");
  });

  it("refuses a folder, which the tree already lists", async () => {
    const repo = repository();
    await expect(readExplorerFile(tracking("src"), repo, "src")).rejects.toThrow(
      "is a folder. The tree already lists what is in it.",
    );
  });

  it("shows nothing rather than part of a file past the cap", async () => {
    const repo = repository();
    writeFileSync(join(repo.path, "big.txt"), "x".repeat(PREVIEW_BYTE_CAP + 1));
    const file = await readExplorerFile(tracking("big.txt"), repo, "big.txt");
    expect(file.text).toBeNull();
    expect(file.refusal).toMatch(/larger than the 256 KiB/);
    expect(file.bytes).toBe(PREVIEW_BYTE_CAP + 1);
  });

  it("says a file holding a NUL byte is binary rather than decoding it", async () => {
    const repo = repository();
    writeFileSync(join(repo.path, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const file = await readExplorerFile(tracking("image.bin"), repo, "image.bin");
    expect(file.text).toBeNull();
    expect(file.refusal).toContain("binary file");
  });

  it("refuses a path that reaches its file through a link", async () => {
    const repo = repository();
    const outside = join(repo.path, "..", "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "s\n");
    symlinkSync(outside, join(repo.path, "linked"));
    await expect(
      readExplorerFile(tracking("linked/secret.txt"), repo, "linked/secret.txt"),
    ).rejects.toThrow("refuses a symlink");
  });

  it("refuses an absolute path from a screen", async () => {
    const repo = repository();
    await expect(
      readExplorerFile(tracking("README.md"), repo, join(repo.path, "README.md")),
    ).rejects.toThrow("Perbo does not take an absolute path from a screen.");
  });
});

describe("a repository whose configuration cannot be read", () => {
  it("says which one it was, rather than listing without its standing marks", async () => {
    const repo = repository();
    mkdirSync(join(repo.path, ".perbo"), { recursive: true });
    writeFileSync(configPath(repo), "{");
    await expect(listExplorer(tracking("README.md"), repo)).rejects.toThrow(
      /could not be read as a JSON object/,
    );
  });
});
