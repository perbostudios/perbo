// protected-paths.mjs against a real fixture repository: a temp directory,
// `git init`, a base commit and a branch that changes one file. The script is
// spawned exactly as the workflow spawns it, so what these tests prove is what
// a pull request's CI run actually does, not an internal function in isolation.
//
//   node --test .github/scripts/protected-paths.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { matchesGlob } from "./protected-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "protected-paths.mjs");

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

function writeAndCommit(cwd, path, contents, message) {
  const full = join(cwd, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  git(cwd, "add", path);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** A repo with one base commit carrying a fixed set of files, so every test starts from the same tree. */
function baseRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ayo-protected-paths-"));
  git(dir, "init", "-q");
  writeAndCommit(dir, "README.md", "base\n", "base commit");
  writeAndCommit(dir, "packages/runner/test/security.test.ts", "// original\n", "add security test");
  writeAndCommit(dir, "packages/review/test/blocking.test.ts", "// original\n", "add blocking test");
  writeAndCommit(dir, "packages/review/src/prompt.ts", "// original rule table\n", "add prompt.ts");
  writeAndCommit(
    dir,
    "packages/evaluation/sample/fixtures/sec-006-idor-in-attachment-download/fixture.json",
    '{"id":"sec-006-idor-in-attachment-download"}\n',
    "add a sample fixture",
  );
  writeAndCommit(dir, "packages/runner/src/loop.ts", "// original\n", "add ordinary source file");
  const base = git(dir, "rev-parse", "HEAD");
  return { dir, base };
}

/**
 * The config as it ships, so the two tests below prove what a contributor's
 * pull request meets rather than what a config written to suit the test does.
 */
const SHIPPED_CONFIG = join(HERE, "..", "protected-paths.json");
const CONFORMANCE = join(HERE, "..", "..", "packages", "contracts", "test", "glob-conformance.json");

function writeConfig(dir, { protected_tests = [], protected_paths = [] } = {}) {
  const path = join(dir, "protected-paths.json");
  writeFileSync(path, JSON.stringify({ protected_tests, protected_paths }, null, 2));
  return path;
}

/** Runs the script and returns {status, stdout, stderr} instead of throwing on a non-zero exit. */
function run(base, head, repo, config) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, base, head, "--repo", repo, "--config", config],
      { encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("a branch that changes a protected test is refused, naming the file", () => {
  const { dir, base } = baseRepo();
  const config = writeConfig(dir, { protected_tests: ["packages/runner/test/security.test.ts"] });
  git(dir, "checkout", "-q", "-b", "change-security-test");
  writeAndCommit(dir, "packages/runner/test/security.test.ts", "// tampered\n", "weaken the security test");
  const head = git(dir, "rev-parse", "HEAD");

  const result = run(base, head, dir, config);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packages\/runner\/test\/security\.test\.ts/);
});

test("a branch that changes only an unprotected file exits zero", () => {
  const { dir, base } = baseRepo();
  const config = writeConfig(dir, {
    protected_tests: ["packages/runner/test/security.test.ts"],
    protected_paths: ["packages/evaluation/sample/**"],
  });
  git(dir, "checkout", "-q", "-b", "change-ordinary-file");
  writeAndCommit(dir, "packages/runner/src/loop.ts", "// changed\n", "an ordinary implementation change");
  const head = git(dir, "rev-parse", "HEAD");

  const result = run(base, head, dir, config);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /none protected/);
});

test("a path that merely starts with a protected test's name is not refused", () => {
  const { dir, base } = baseRepo();
  // Only the exact test is protected here — this isolates the prefix bug from
  // a protected_paths glob that would separately cover the same directory.
  const config = writeConfig(dir, { protected_tests: ["packages/review/test/blocking.test.ts"] });
  git(dir, "checkout", "-q", "-b", "add-backup-file");
  writeAndCommit(
    dir,
    "packages/review/test/blocking.test.ts.bak",
    "// not the protected file\n",
    "add a same-stem backup file",
  );
  const head = git(dir, "rev-parse", "HEAD");

  const result = run(base, head, dir, config);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /none protected/);
});

test("the shipped config refuses a change to a sample fixture, naming the pattern it matched", () => {
  const { dir, base } = baseRepo();
  git(dir, "checkout", "-q", "-b", "weaken-a-fixture");
  writeAndCommit(
    dir,
    "packages/evaluation/sample/fixtures/sec-006-idor-in-attachment-download/fixture.json",
    '{"id":"sec-006-idor-in-attachment-download","must_not_approve":false}\n',
    "weaken the fixture the reviewer missed",
  );
  const head = git(dir, "rev-parse", "HEAD");

  const result = run(base, head, dir, SHIPPED_CONFIG);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packages\/evaluation\/sample\/fixtures\/sec-006/);
  assert.match(result.stderr, /protected path \(packages\/evaluation\/sample\/\*\*\)/);
});

// The point of the correction: the reviewer's prompt is what the sample
// fixtures judge, not something that judges them, and a pull request that
// rewrites it is the contribution this repository asks for. It carries a
// regression score; it is not refused here.
test("the shipped config does not refuse a change to the reviewer's prompt", () => {
  const { dir, base } = baseRepo();
  git(dir, "checkout", "-q", "-b", "change-prompt");
  writeAndCommit(dir, "packages/review/src/prompt.ts", "// a better rule table\n", "rewrite the rule table");
  const head = git(dir, "rev-parse", "HEAD");

  const result = run(base, head, dir, SHIPPED_CONFIG);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /none protected/);
});

test("the base and head arguments are positional and must be commit SHAs, not branch names", () => {
  const { dir } = baseRepo();
  const config = writeConfig(dir, {});
  assert.throws(() => {
    execFileSync(process.execPath, [SCRIPT, "main", "feature-branch", "--repo", dir, "--config", config], {
      encoding: "utf8",
    });
  }, /must be commit SHAs/);
});

test("corpus-pin.json parses and its commit is forty hex characters", () => {
  const pin = JSON.parse(readFileSync(join(HERE, "..", "corpus-pin.json"), "utf8"));
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof pin.repository, "string");
  assert.ok(pin.repository.startsWith("https://"));
  assert.match(pin.date, /^\d{4}-\d{2}-\d{2}$/);
});

/**
 * The glob this check matches with is a copy: it runs before anything is
 * built, so it cannot import `@perbo/contracts`. The conformance table is what
 * keeps the copy honest, and a row it answers differently is a rule two parts
 * of this repository disagree about.
 */
test("answers every case of the glob conformance table as @perbo/contracts does", () => {
  const { cases } = JSON.parse(readFileSync(CONFORMANCE, "utf8"));
  assert.ok(cases.length > 0);
  for (const { pattern, path, matches } of cases) {
    assert.equal(matchesGlob(path, pattern), matches, `${pattern} ~ ${path}`);
  }
});
