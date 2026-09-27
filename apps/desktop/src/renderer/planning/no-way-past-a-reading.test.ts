import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

/**
 * There is no way past a reading of the plan against its spec
 * (D-NEW-basic-and-epic-flows): a confirm with a problem open is refused, and
 * one whose reading did not run says so in a pop-up and confirms nothing. The
 * ways past it are gone by name, from the desktop's code and from the
 * documents alike, so neither can come back unnoticed. Tests are left out:
 * they name these to say the page does not show them.
 */

const DESKTOP = join(import.meta.dirname, "..", "..");
const DOCS = join(DESKTOP, "..", "..", "..", "docs");
const GONE = [
  "Go on to the contract anyway",
  "Going on leaves the problems open",
  "go ahead without the reading",
  "CONFIRM_WITHOUT",
];

function files(root: string, keep: (name: string) => boolean): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true }).flatMap((entry) =>
    entry.isFile() && keep(entry.name) ? [join(entry.parentPath, entry.name)] : [],
  );
}

it("names no way past a reading anywhere in the desktop's code or the documents", () => {
  const code = files(DESKTOP, (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name));
  const docs = files(DOCS, (name) => name.endsWith(".md"));
  // Floored on what is always there, so a scan that read nothing cannot pass.
  expect(code.map((path) => relative(DESKTOP, path))).toContain(join("renderer", "planning", "DriftPane.tsx"));
  expect(code.map((path) => relative(DESKTOP, path))).toContain(join("renderer", "tasks", "ContractScreen.tsx"));
  expect(docs.map((path) => relative(DOCS, path))).toContain("11-open-decisions.md");
  const found = [...code, ...docs].flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return GONE.filter((words) => text.includes(words)).map((words) => `${relative(DESKTOP, path)}: ${words}`);
  });
  expect(found).toEqual([]);
});
