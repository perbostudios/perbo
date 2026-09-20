import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScratch, scratchDirectories } from "./scratch.js";

/** The temporary directory as the filesystem names it, past /var → /private/var. */
const resolved = (path: string) => realpathSync(path);

describe("createScratch", () => {
  const started = process.env["TMPDIR"];

  afterEach(() => {
    if (started === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = started;
  });

  it("makes a directory under the temporary directory, named from the prefix", () => {
    const scratch = createScratch("p-");
    const dir = scratch();
    try {
      expect(existsSync(dir)).toBe(true);
      expect(basename(dir).startsWith("p-")).toBe(true);
      expect(resolved(dirname(dir))).toBe(resolved(tmpdir()));
    } finally {
      scratch.removeAll();
    }
  });

  it("follows TMPDIR between calls", () => {
    const scratch = createScratch("perbo-tmpdir-");
    const elsewhere = scratch();
    try {
      process.env["TMPDIR"] = elsewhere;
      const second = scratch();
      expect(resolved(dirname(second))).toBe(resolved(elsewhere));
    } finally {
      scratch.removeAll();
    }
  });

  it("takes back every directory it made, and forgets them", () => {
    const scratch = createScratch("perbo-remove-");
    const first = scratch();
    const second = scratch();
    // A directory something else already removed is not an error to remove.
    rmSync(second, { recursive: true, force: true });

    scratch.removeAll();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);

    // The list is empty afterwards, so a later removeAll() is not a second
    // chance to delete a path the caller has since made its own.
    mkdirSync(first, { recursive: true });
    try {
      scratch.removeAll();
      expect(existsSync(first)).toBe(true);
    } finally {
      rmSync(first, { recursive: true, force: true });
    }
  });

  it("names its directories perbo-test- when the caller does not", () => {
    const scratch = createScratch();
    try {
      expect(basename(scratch()).startsWith("perbo-test-")).toBe(true);
      expect(basename(scratch("perbo-other-")).startsWith("perbo-other-")).toBe(true);
    } finally {
      scratch.removeAll();
    }
  });
});

/** What the suite below made, read by the suite after it. */
let hooked = "";

describe("scratchDirectories", () => {
  const scratch = scratchDirectories("perbo-hooked-");

  it("hands out directories like createScratch", () => {
    hooked = scratch();
    expect(existsSync(hooked)).toBe(true);
    expect(basename(hooked).startsWith("perbo-hooked-")).toBe(true);
  });
});

describe("the suite that called scratchDirectories, once it has finished", () => {
  it("has had its directories taken back", () => {
    // The removal is registered on whatever vitest is collecting when
    // scratchDirectories() is called — the suite above — so by the time this
    // one runs it has already happened. In a test file the same call at the
    // top level gives the directories the lifetime of the file, which is what
    // a beforeAll fixture needs.
    expect(hooked).not.toBe("");
    expect(existsSync(hooked)).toBe(false);
  });
});
