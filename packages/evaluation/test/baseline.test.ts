import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { scratchDirectories } from "@perbo/test-support";
import { createGit, type GitProcess, type RunResult } from "@perbo/workspace";
import { isTestPath, splitTestPaths, baselineStatus, measureBaseline } from "../src/baseline.js";
import type { LoadedFixture } from "../src/corpus.js";
import { clonePathFor } from "../src/prepare.js";
import { sample } from "./sample-fixtures.js";

/**
 * Fail-first evidence for a pinned fixture.
 *
 * A pinned fixture's `checks.json` records one run, at the head commit, so it
 * can never show a test failing without the fix — and the reviewer asked for
 * exactly that in two of six `cln-016` reviews. It will ask it of every pinned
 * fixture. The evidence is obtainable: check out the base commit, apply only
 * the test files from the diff, and run.
 */

const scratchDirectory = scratchDirectories("perbo-baseline-");

describe("isTestPath", () => {
  it("recognises the test conventions of the repositories the corpus pins", () => {
    for (const path of [
      "packages/runtime-core/__tests__/hydration.spec.ts",
      "tests/test_basic.py",
      "tests/types/test_list.py",
      "src/foo.test.ts",
      "src/foo.spec.tsx",
      "test/support.ts",
      "packages/x/src/__tests__/y.ts",
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  it("does not mistake source for tests", () => {
    for (const path of [
      "pydantic/networks.py",
      "src/flask/app.py",
      "packages/runtime-dom/src/directives/vModel.ts",
      // The trap: a source file whose name contains "test".
      "src/latest.ts",
      "src/contest/index.ts",
      "packages/x/src/testing-library-adapter.ts",
    ]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });
});

describe("splitTestPaths", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-const a = 1",
    "+const a = 2",
    "diff --git a/src/__tests__/a.spec.ts b/src/__tests__/a.spec.ts",
    "index 3333333..4444444 100644",
    "--- a/src/__tests__/a.spec.ts",
    "+++ b/src/__tests__/a.spec.ts",
    "@@ -1 +1 @@",
    "-expect(a).toBe(1)",
    "+expect(a).toBe(2)",
    "",
  ].join("\n");

  it("separates the test files from the source files", () => {
    const split = splitTestPaths(diff);
    expect(split.tests).toEqual(["src/__tests__/a.spec.ts"]);
    expect(split.source).toEqual(["src/a.ts"]);
  });

  it("reports a change with no test files rather than guessing", () => {
    const sourceOnly = diff.split("diff --git a/src/__tests__")[0]!;
    expect(splitTestPaths(sourceOnly).tests).toEqual([]);
  });
});

describe("baselineStatus", () => {
  // The inversion: for a baseline run, the tests *failing* is the good
  // outcome. `passed` therefore means "the evidence was obtained", so that
  // "passed is good" holds for every check kind the reviewer sees.
  it("passes when the change's own tests fail without the change", () => {
    const check = baselineStatus({ code: 1, output: "Tests  1 failed | 3 passed" });
    expect(check.status).toBe("passed");
    expect(check.summary).toMatch(/fail/i);
  });

  it("fails when the tests pass without the change, because then they prove nothing", () => {
    const check = baselineStatus({ code: 0, output: "Tests  4 passed (4)" });
    expect(check.status).toBe("failed");
    expect(check.detail).toMatch(/pass(ed)? (at|against|without)/i);
  });

  it("distinguishes a collection error from a failing assertion", () => {
    // A new test file that does not compile against the base commit also exits
    // non-zero, and it is much weaker evidence — it shows the file is new, not
    // that the assertion discriminates.
    const check = baselineStatus({
      code: 2,
      output: "Interrupted: 1 error during collection\nModuleNotFoundError: no module named x",
    });
    expect(check.status).toBe("passed");
    expect(check.detail).toMatch(/collect|compile|import/i);
  });
});

describe("measureBaseline on an authored fixture", () => {
  // SCP-110's open item, closed: the discrimination measurement runs from the
  // command, not from a scratch script. The smallest authored clean fixture
  // stages its before/ tree, applies the diff's test files from after/, and
  // the suite failing there is the evidence (recorded as status "passed" —
  // "the evidence was obtained" — per baselineStatus's deliberate inversion).
  it("measures the before tree with the after tests, without a pinned repository", async () => {
    const fixture = sample.find((entry) => entry.fixture.id === "cln-025-archived-rows-hidden-from-listing");
    expect(fixture).toBeDefined();
    const result = await measureBaseline({
      fixture: fixture!,
      cacheRoot: scratchDirectory("perbo-base-test-"),
    });
    expect(result.skipped).toBeNull();
    expect(result.check?.status).toBe("passed");
    expect(result.check?.summary).toMatch(/before tree/);
  }, 120_000);
});

/**
 * A scripted git, so the worktree the measurement takes can be answered without
 * a clone. What git means by an answer is the repository module's; what
 * `measureBaseline` does with one is this.
 */
function scripted(answer: (argv: readonly string[]) => Partial<RunResult>): GitProcess {
  const reply = (argv: readonly string[]): RunResult => ({
    argv: [...argv],
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    duration_ms: 0,
    timed_out: false,
    truncated: false,
    ...answer(argv),
  });
  return {
    run: (argv) => Promise.resolve(reply(argv)),
    runSync: (argv) => reply(argv),
  };
}

describe("the test-only patch measureBaseline applies", () => {
  const scratch = scratchDirectory("perbo-baseline-patch-");

  const testDiff = [
    "diff --git a/src/__tests__/a.spec.ts b/src/__tests__/a.spec.ts",
    "--- a/src/__tests__/a.spec.ts",
    "+++ b/src/__tests__/a.spec.ts",
    "@@ -1 +1 @@",
    "-expect(a).toBe(1)",
    "+expect(a).toBe(2)",
    "",
  ].join("\n");

  /** A pinned fixture whose change touches a test file, with a prepared clone. */
  const prepared = (name: string): { fixture: LoadedFixture; cacheRoot: string } => {
    const pinnedSample = sample.find((entry) => entry.fixture.pinned_repository !== null);
    expect(pinnedSample, "the sample carries a pinned fixture").toBeDefined();
    const cacheRoot = join(scratch, name);
    const clone = clonePathFor(cacheRoot, pinnedSample!.fixture.pinned_repository!.url);
    mkdirSync(join(clone, ".git"), { recursive: true });
    return { fixture: { ...pinnedSample!, diff: testDiff }, cacheRoot };
  };

  it("is refused when only part of it arrived, rather than measured with", async () => {
    // A patch cut at the ceiling applies cleanly or not at all for reasons that
    // have nothing to do with the base commit, and either outcome would be
    // recorded as fail-first evidence about the fixture.
    const result = await measureBaseline({
      ...prepared("cut"),
      git: createGit({
        process: scripted((argv) =>
          argv.includes("--no-color") ? { stdout: testDiff, truncated: true } : {},
        ),
      }),
    });
    expect(result.check).toBeNull();
    expect(result.skipped).toMatch(/patch is larger than \d+ bytes and only part of it arrived/);
  });

  it("is measured with when the whole of it arrived", async () => {
    const result = await measureBaseline({
      ...prepared("whole"),
      git: createGit({
        process: scripted((argv) =>
          argv.includes("--no-color")
            ? { stdout: testDiff }
            : argv.includes("apply")
              ? { code: 1, stderr: "error: patch does not apply" }
              : {},
        ),
      }),
    });
    expect(result.skipped).toMatch(/does not apply to the base commit/);
  });
});
