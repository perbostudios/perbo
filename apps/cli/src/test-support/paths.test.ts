import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_ENTRY, FIXTURES, PACKAGE_ROOT, REPO_ROOT } from "./paths.js";

/**
 * Each constant is checked against something only the right directory holds,
 * so a path that is one level out fails here rather than in the suite that
 * reads through it.
 */
describe("where this package is", () => {
  it("names apps/cli by its own manifest", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      name: string;
    };
    expect(manifest.name).toBe("@perbo/cli");
  });

  it("names the repository root by the workspace manifest only it holds", () => {
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("names the fixture directory that carries the authored index repository", () => {
    expect(existsSync(join(FIXTURES, "symbol-index"))).toBe(true);
  });

  it("names the compiled entry point under this package's dist", () => {
    expect(BUILT_ENTRY).toBe(join(PACKAGE_ROOT, "dist", "main.js"));
  });
});
