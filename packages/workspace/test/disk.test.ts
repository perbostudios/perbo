import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { directoryBytes } from "../src/disk.js";

const scratchRoot = mkdtempSync(join(tmpdir(), "perbo-disk-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

const scratch = () => mkdtempSync(join(scratchRoot, "case-"));

describe("directoryBytes", () => {
  it("sums every file it walks, at whatever depth", () => {
    const root = scratch();
    writeFileSync(join(root, "a.txt"), "x".repeat(100));
    mkdirSync(join(root, "nested", "deeper"), { recursive: true });
    writeFileSync(join(root, "nested", "b.txt"), "x".repeat(250));
    writeFileSync(join(root, "nested", "deeper", "c.txt"), "x".repeat(650));

    expect(directoryBytes(root)).toBe(1000);
  });

  it("counts an empty tree as nothing, and a missing one too", () => {
    const root = scratch();
    mkdirSync(join(root, "empty"));
    expect(directoryBytes(root)).toBe(0);
    // A worktree removed before it was measured must not throw: this number is
    // reported, never gated on.
    expect(directoryBytes(join(root, "absent"))).toBe(0);
  });

  it("does not follow a link, or count the link itself", () => {
    // The pnpm shape: the real package lives in the store beside the tree, and
    // node_modules holds a link to it. Following the link would bill the store
    // to the worktree once per package that references it.
    const root = scratch();
    const store = join(root, "store", "pkg");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "index.js"), "x".repeat(400));

    const modules = join(root, "node_modules");
    mkdirSync(modules);
    symlinkSync(store, join(modules, "pkg"), "junction");

    // The store's 400 bytes, counted once where they live.
    expect(directoryBytes(root)).toBe(400);
    // And the link on its own contributes nothing at all.
    expect(directoryBytes(modules)).toBe(0);
  });

  it("survives a link that points nowhere", () => {
    const root = scratch();
    writeFileSync(join(root, "real.txt"), "x".repeat(50));
    symlinkSync(join(root, "gone"), join(root, "dangling"), "junction");

    expect(directoryBytes(root)).toBe(50);
  });
});
