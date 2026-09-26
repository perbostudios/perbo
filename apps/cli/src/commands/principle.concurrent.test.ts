import { mkdtempSync, readFileSync } from "node:fs";
import type * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PRINCIPLES_FILENAME } from "@perbo/contracts";
import { principleCommandLine, principlesPath } from "./principle.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";

/**
 * Every check for the file answers that it is not there yet, which is what
 * a second `principle add` sees when it checks in the moment after the first
 * has checked and before the first has written.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      String(path).endsWith(PRINCIPLES_FILENAME) ? false : actual.existsSync(path),
  };
});

const add = (repo: string, text: string) =>
  runCommandLine(principleCommandLine, {
    argv: ["add", text, "--repo", repo],
    streams: recordStreams(),
    cwd: repo,
  });

/**
 * D-049: decisions on different tickets go on at the same time, and each
 * records its principle through `principle add`. The add that finds the file
 * there keeps what is in it, however late it learns the file exists.
 */
describe("principle add beside another", () => {
  it("keeps what an add beside it wrote, writing the header only where it creates the file", () => {
    const repo = mkdtempSync(join(tmpdir(), "perbo-principles-concurrent-"));
    add(repo, "The first decision's answer.");
    add(repo, "The second decision's answer.");
    const text = readFileSync(principlesPath(repo, { repo: ".", store: null }), "utf8");
    expect(text).toContain("The first decision's answer.");
    expect(text).toContain("The second decision's answer.");
    expect(text.match(/# Product principles/g)).toHaveLength(1);
  });
});
