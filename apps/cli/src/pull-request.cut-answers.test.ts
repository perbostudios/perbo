import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UsageError } from "./usage-error.js";
import { readPullRequest, readPullRequestChecks, readRefRange } from "./pull-request.js";
import { SPAWN_TEST_TIMEOUT_MS, gitEnvironment } from "@perbo/test-support";

/**
 * What these reads do with an answer that arrived cut.
 *
 * Every one of them is a ceiling away from a reading nobody can tell from a
 * whole one: a diff holds the tail of a change and reads as the change, a
 * listing holds the tail of a list and is counted, a workflow file holds the
 * tail of its own YAML and declares whatever `on:` survived. The property each
 * case pins is that the read says so instead of answering.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-cut-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** More bytes than any of these reads holds, written as fast as the pipe takes them. */
const FLOOD = "dd if=/dev/zero bs=1048576 count=65 2>/dev/null | tr '\\0' 'x'";

function executable(path: string, lines: readonly string[]): void {
  writeFileSync(path, `${["#!/bin/sh", ...lines].join("\n")}\n`);
  chmodSync(path, 0o755);
}

describe("a pull request whose diff is larger than the read holds", () => {
  it("refuses it rather than reviewing the tail of it", async () => {
    const dir = mkdtempSync(join(scratch, "pr-"));
    writeFileSync(
      join(dir, "view.json"),
      JSON.stringify({
        number: 7,
        title: "A change",
        body: "## Outcome\n\nIt is done.\n",
        url: "https://github.invalid/o/r/pull/7",
        headRefName: "head",
        baseRefName: "main",
        headRefOid: "1111111111111111111111111111111111111111",
        baseRefOid: "2222222222222222222222222222222222222222",
        headRepository: { nameWithOwner: "o/r" },
      }),
    );
    const binary = join(dir, "gh");
    executable(binary, [
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
      `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat ${JSON.stringify(join(dir, "view.json"))}; exit 0; fi`,
      `if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then ${FLOOD}; exit 0; fi`,
      "exit 1",
    ]);

    const read = readPullRequest("o/r#7", { binary, cwd: dir });
    await expect(read).rejects.toBeInstanceOf(UsageError);
    await expect(read).rejects.toThrow(/only the tail of it arrived/);
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("a range of local refs whose change is larger than the read holds", () => {
  it("refuses it rather than reviewing the tail of it", () => {
    const repo = mkdtempSync(join(scratch, "range-"));
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", repo, ...args], { env: gitEnvironment(), encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-q", "-b", "change");
    writeFileSync(join(repo, "wide.txt"), Buffer.alloc(65 * 1024 * 1024, "xxxxxxx\n"));
    git("add", "-A");
    git("commit", "-qm", "wide");

    expect(() => readRefRange({ repo, head: "change", base: "main" })).toThrow(UsageError);
    expect(() => readRefRange({ repo, head: "change", base: "main" })).toThrow(
      /only the tail of it arrived/,
    );
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("a workflow listing larger than the read holds", () => {
  it("leaves the reading unanswered rather than blaming the JSON", async () => {
    const dir = mkdtempSync(join(scratch, "checks-"));
    const bin = join(dir, ".bin");
    mkdirSync(bin, { recursive: true });
    executable(join(bin, "gh"), [
      'if [ "$1" = "workflow" ] && [ "$2" = "list" ]; then',
      "  printf '[{\"name\":\"CI\",\"path\":\"'",
      "  dd if=/dev/zero bs=1024 count=600 2>/dev/null | tr '\\0' 'w'",
      "  printf '\",\"state\":\"active\"}]'",
      "  exit 0",
      "fi",
      "exit 1",
    ]);

    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      const reading = await readPullRequestChecks({ worktree: dir, base_ref: "main" });
      expect(reading.answered).toBe(false);
      expect(reading.runs_checks).toBe(false);
      expect(reading.detail).toContain("only the tail arrived");
    } finally {
      process.env.PATH = previous;
    }
  }, SPAWN_TEST_TIMEOUT_MS);
});
