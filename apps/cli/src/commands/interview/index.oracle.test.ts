import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repository, type ContractStep, type InterviewHarness } from "./test-support/contract.js";
import { claudeHarness, codexHarness } from "./test-support/harness.js";
import { FIXTURES } from "../../test-support/paths.js";
import { gitEnvironment } from "@perbo/test-support";

/**
 * Every command spelling the five D-073 review rounds on SCP-355 drove
 * against the guard (`apps/cli/test/fixtures/read-only-shapes.txt`), read
 * back into the array {@link checkNoneWrite} asks the guard about — one
 * command per fixture line, each a JSON string literal so a here-document's
 * own newline survives the file.
 */
function readShapes(): string[] {
  const path = join(FIXTURES, "read-only-shapes.txt");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as string);
}

/**
 * A directory this test puts at the front of `PATH` before it runs anything
 * a shape admits — holding `evil.sh`, `p` and `program`, three names a
 * banned flag or a hidden invocation in the fixture asks to run
 * (`rg --pre p`, `rg --hostname-bin=p`, …), each of which writes `marker`
 * the moment it runs at all, standing in for whatever a real one would have
 * done.
 */
function fakeBin(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "perbo-oracle-bin-"));
  const script = `#!/bin/sh\ntouch "${marker}"\n`;
  for (const name of ["evil.sh", "p", "program"]) {
    writeFileSync(join(dir, name), script, { mode: 0o755 });
  }
  return dir;
}

/**
 * The oracle itself: every shape in the fixture, asked of `harness` in one
 * session, the same batched way every other case in this suite asks one —
 * and for every shape the guard admits, run for real, in a throwaway git
 * repository whose `PATH` starts with {@link fakeBin}'s directory, stdin
 * closed and a two-second timeout (a stray `cat` left waiting on stdin
 * would otherwise hang the whole run). What is checked after each is not
 * the exit code — a command failing for its own reasons (a file that does
 * not exist, a program not found) is not what this is about — but whether
 * anything actually changed: `git status --porcelain` inside the
 * repository, a listing of its parent directory (a write that escaped the
 * repository entirely), and the marker file. Any one of those moving is
 * this guard having admitted a shape a real shell proves is not read-only,
 * which is the one failure this test exists to catch.
 */
async function checkNoneWrite(harness: InterviewHarness, scratch: string, shapes: readonly string[]): Promise<void> {
  const repo = repository(scratch);
  const result = await harness.run({
    repo,
    steps: shapes.map((command) => ({ kind: "command", command }) as ContractStep),
  });
  expect(result.decisions).toHaveLength(shapes.length);

  const marker = join(scratch, `.marker-${harness.name}`);
  const binDir = fakeBin(marker);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
  const parentDir = join(repo, "..");
  const gitStatus = (): string => execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8", env: gitEnvironment() });
  const parentListing = (): string => [...readdirSync(parentDir)].sort().join("\n");

  for (let i = 0; i < shapes.length; i += 1) {
    if (result.decisions[i]?.behavior !== "allow") continue;
    const command = shapes[i]!;
    if (existsSync(marker)) rmSync(marker);
    const statusBefore = gitStatus();
    const listingBefore = parentListing();
    try {
      execFileSync("bash", ["-c", command], {
        cwd: repo,
        env,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 2000,
      });
    } catch {
      // A nonzero exit or a timeout is not a failure by itself — a shape
      // this guard is right to admit can still fail on its own terms (a
      // file that is not there, a program not found). Only a write, a
      // change, a deletion or the marker below is.
    }
    expect(gitStatus(), `admitted and changed the repository: ${JSON.stringify(command)}`).toBe(statusBefore);
    expect(parentListing(), `admitted and wrote outside the repository: ${JSON.stringify(command)}`).toBe(
      listingBefore,
    );
    expect(existsSync(marker), `admitted and ran a marker-writing program: ${JSON.stringify(command)}`).toBe(false);
  }
}

describe("the interview's read-only guard against a real shell (SCP-355 oracle)", () => {
  const shapes = readShapes();
  const scratch = mkdtempSync(join(tmpdir(), "perbo-oracle-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it(
    "admits nothing the shapes fixture holds that a real shell proves writes, changes or deletes, on claude",
    async () => {
      await checkNoneWrite(claudeHarness(), scratch, shapes);
    },
    5 * 60_000,
  );

  it(
    "admits nothing the shapes fixture holds that a real shell proves writes, changes or deletes, on codex",
    async () => {
      await checkNoneWrite(codexHarness(() => scratch), scratch, shapes);
    },
    5 * 60_000,
  );
});
