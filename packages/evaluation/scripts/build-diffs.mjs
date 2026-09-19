#!/usr/bin/env node
/**
 * Regenerate `change.diff` for every fixture from its `before/` and `after/`
 * trees.
 *
 * The diff is produced by `git diff` inside a scratch repository rather than
 * written by hand, so the corpus exercises the parser against the format it
 * will actually meet. `before/` and `after/` stay in the repository because a
 * diff alone cannot be re-derived, reviewed, or corrected.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "corpus", "fixtures");

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "perbo-corpus",
      GIT_AUTHOR_EMAIL: "corpus@perbo.invalid",
      GIT_COMMITTER_NAME: "perbo-corpus",
      GIT_COMMITTER_EMAIL: "corpus@perbo.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

const clearTree = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
};

let written = 0;
const skipped = [];
for (const id of readdirSync(fixturesDir).sort()) {
  const fixture = join(fixturesDir, id);
  if (!statSync(fixture).isDirectory()) continue;

  // A pinned fixture has no `before/` or `after/` tree: it names a real commit
  // in a real repository and its diff is computed from a clone that is not
  // checked in. There is nothing here to regenerate, and `validate_fixture_diffs.py`
  // already skips them for the same reason — this script had not been taught to.
  if (!existsSync(join(fixture, "before"))) {
    skipped.push(id);
    continue;
  }

  const scratch = mkdtempSync(join(tmpdir(), "perbo-corpus-"));
  try {
    git(scratch, "init", "--quiet", "--initial-branch=main");
    git(scratch, "config", "core.autocrlf", "false");

    cpSync(join(fixture, "before"), scratch, { recursive: true });
    git(scratch, "add", "-A");
    git(scratch, "commit", "--quiet", "-m", "base");

    clearTree(scratch);
    cpSync(join(fixture, "after"), scratch, { recursive: true });
    git(scratch, "add", "-A");

    const diff = git(scratch, "diff", "--cached", "--no-color", "--no-ext-diff", "-M", "HEAD");
    writeFileSync(join(fixture, "change.diff"), diff);
    written += 1;
    const files = diff.split("\n").filter((line) => line.startsWith("diff --git ")).length;
    console.log(`${id}: ${files} file(s), ${diff.length} bytes`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
console.log(`\n${written} fixture diff(s) regenerated`);
if (skipped.length > 0) {
  // Named, not silent: a corpus that shrank must never look like a small one.
  console.log(
    `${skipped.length} pinned fixture(s) skipped — they name a real commit and have no ` +
      `before/ tree: ${skipped.join(", ")}`,
  );
}
