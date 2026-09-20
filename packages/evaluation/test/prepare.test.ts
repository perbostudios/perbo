import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit, type GitProcess, type RunResult } from "@perbo/workspace";
import { afterAll, describe, expect, it } from "vitest";
import type { LoadedFixture } from "../src/corpus.js";
import { clonePathFor, prepareFixture } from "../src/prepare.js";
import { sample } from "./sample-fixtures.js";

describe("clonePathFor", () => {
  const cache = "/cache";

  it("gives every fixture pinning the same repository the same clone", () => {
    // Three fixtures pinning vuejs/core as three clones cost 1.4 GB. This is
    // the property that makes twenty of them fit.
    expect(clonePathFor(cache, "https://github.com/vuejs/core")).toBe(
      clonePathFor(cache, "https://github.com/vuejs/core.git"),
    );
    expect(clonePathFor(cache, "https://github.com/vuejs/core")).not.toBe(
      clonePathFor(cache, "https://github.com/vuejs/vue"),
    );
  });

  it("keeps the clone inside the cache whatever the URL says", () => {
    // The URL comes from a fixture file, which is authored here rather than
    // fetched — but a path built by string substitution from a URL is exactly
    // the shape that later grows a traversal, so the property is asserted now.
    for (const hostile of [
      "https://example.com/../../etc/passwd",
      "https://example.com/a/../../../b",
      "file:///etc/shadow",
    ]) {
      expect(clonePathFor(cache, hostile).startsWith("/cache/clones/")).toBe(true);
    }
  });
});

/**
 * A scripted git, so the calls `prepareFixture` makes can be answered without
 * cloning half a gigabyte over the network.
 *
 * Only what git *says* is scripted. What git means by it is the module's, and
 * `prepareFixture`'s own reading of an answer — the head it compares, the diff
 * it writes, the answer it refuses — is what these exercise.
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

const DIFF = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");

describe("prepareFixture", () => {
  const scratch = mkdtempSync(join(tmpdir(), "perbo-prepare-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const pinnedFixture = (): LoadedFixture => {
    const found = sample.find((entry) => entry.fixture.pinned_repository !== null);
    expect(found, "the sample carries a pinned fixture").toBeDefined();
    return found!;
  };

  const cacheRoot = (name: string): string => join(scratch, name);

  it("writes the diff between the pinned commits, and counts what it changed", async () => {
    const prepared = await prepareFixture({
      fixture: pinnedFixture(),
      cacheRoot: cacheRoot("whole"),
      git: createGit({
        process: scripted((argv) =>
          argv.includes("--no-color")
            ? { stdout: DIFF }
            : argv.includes("--name-only")
              ? { stdout: "x\ny\n" }
              : {},
        ),
      }),
    });
    expect(readFileSync(prepared.diff_path, "utf8")).toBe(DIFF);
    expect(prepared.files_changed).toBe(2);
  });

  it("refuses a diff too large to hold, rather than pinning the part that fits", async () => {
    // A cut diff is still a valid-looking diff. Writing one to `change.diff`
    // would pin a fixture whose change is not the change, and the reviewer
    // would be scored on it without anything ever saying so.
    await expect(
      prepareFixture({
        fixture: pinnedFixture(),
        cacheRoot: cacheRoot("cut"),
        git: createGit({
          process: scripted((argv) =>
            argv.includes("--no-color") ? { stdout: DIFF, truncated: true } : {},
          ),
        }),
      }),
    ).rejects.toThrow(/diff between the pinned commits is larger than \d+ bytes and only part of it arrived/);
  });

  it("refuses a cut list of changed files too, because the count is read", async () => {
    await expect(
      prepareFixture({
        fixture: pinnedFixture(),
        cacheRoot: cacheRoot("cut-names"),
        git: createGit({
          process: scripted((argv) =>
            argv.includes("--name-only")
              ? { stdout: "x\n", truncated: true }
              : argv.includes("--no-color")
                ? { stdout: DIFF }
                : {},
          ),
        }),
      }),
    ).rejects.toThrow(/list of files changed between the pinned commits is larger than/);
  });
});
