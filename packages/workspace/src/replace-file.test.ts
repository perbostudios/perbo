import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replaceFile } from "./replace-file.js";

const scratchRoot = mkdtempSync(join(tmpdir(), "perbo-replace-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

const scratch = (): string => mkdtempSync(join(scratchRoot, "case-"));

const windows = process.platform === "win32";
/** root ignores the permission bits these two cases take away. */
const privileged = process.getuid?.() === 0;

describe("replaceFile", () => {
  it("writes a record that was not there, and replaces one that was", () => {
    const directory = scratch();
    const path = join(directory, "record.json");

    replaceFile(path, '{"a":1}');
    expect(readFileSync(path, "utf8")).toBe('{"a":1}');

    replaceFile(path, '{"a":2}');
    expect(readFileSync(path, "utf8")).toBe('{"a":2}');
    // The temporary is the rename's source, so a call that landed leaves the
    // directory holding the record and nothing beside it.
    expect(readdirSync(directory)).toEqual(["record.json"]);
  });

  it.runIf(!windows)("gives the new file the permissions it was asked for", () => {
    const path = join(scratch(), "workspace.json");
    replaceFile(path, "{}", { mode: 0o600 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary behind when the rename cannot land", () => {
    const directory = scratch();
    const path = join(directory, "record.json");
    // A non-empty directory where the record should be: the write succeeds and
    // the rename is the step that fails, which is the one that leaves a
    // temporary behind unless the failure removes it.
    mkdirSync(path);
    writeFileSync(join(path, "x"), "");

    expect(() => replaceFile(path, "{}")).toThrow();
    expect(readdirSync(directory)).toEqual([basename(path)]);
  });

  it.runIf(!windows && !privileged)(
    "leaves the record that is there byte for byte when the write cannot start",
    () => {
      const directory = scratch();
      const path = join(directory, "record.json");
      replaceFile(path, '{"a":1}');
      chmodSync(directory, 0o500);
      try {
        expect(() => replaceFile(path, '{"a":2}')).toThrow(/EACCES/);
        expect(readFileSync(path, "utf8")).toBe('{"a":1}');
        expect(readdirSync(directory)).toEqual(["record.json"]);
      } finally {
        chmodSync(directory, 0o700);
      }
    },
  );
});
