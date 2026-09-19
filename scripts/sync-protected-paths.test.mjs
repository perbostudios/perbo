// sync-protected-paths.mjs against fixture repositories in a temporary
// directory, plus the shipped files, so what these tests prove is what a
// contributor's `--check` meets.
//
//   node --test scripts/sync-protected-paths.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  CLAUDE_SETTINGS,
  PERBO_CONFIG,
  PROTECTED_PATHS,
  REPO_ROOT,
  computeDenyList,
  protectedTestsDifferences,
  readSources,
  run,
  withDenyList,
} from "./sync-protected-paths.mjs";

const TESTS = [
  "packages/review/test/blocking.test.ts",
  "packages/runner/test/security.test.ts",
];
const PATHS = ["packages/evaluation/sample/**"];

function writeJson(dir, relative, value) {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/** A repository with the two declaring files, and whatever settings the test wants. */
function fixture({ configTests = TESTS, checkTests = TESTS, checkPaths = PATHS, settings } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "perbo-sync-protected-"));
  writeJson(dir, PERBO_CONFIG, { protected_tests: configTests, checks: [] });
  writeJson(dir, PROTECTED_PATHS, { protected_tests: checkTests, protected_paths: checkPaths });
  if (settings !== undefined) writeJson(dir, CLAUDE_SETTINGS, settings);
  return dir;
}

function invoke(argv, dir) {
  const out = [];
  const err = [];
  const code = run([...argv, "--repo", dir], {
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function settingsOf(dir) {
  return JSON.parse(readFileSync(join(dir, CLAUDE_SETTINGS), "utf8"));
}

test("the deny list is one Edit rule per protected test, then one per protected glob", () => {
  assert.deepEqual(computeDenyList({ configTests: TESTS, checkPaths: PATHS }), [
    "Edit(/packages/review/test/blocking.test.ts)",
    "Edit(/packages/runner/test/security.test.ts)",
    "Edit(/packages/evaluation/sample/**)",
  ]);
});

test("the shipped files produce the deny list the repository carries", () => {
  const sources = readSources(REPO_ROOT);
  assert.deepEqual(settingsOf(REPO_ROOT).permissions.deny, computeDenyList(sources));
  assert.equal(invoke(["--check"], REPO_ROOT).code, 0);
});

test("divergent protected_tests fail, naming which file has which entry", () => {
  const dir = fixture({
    configTests: [...TESTS, "packages/review/test/remediation.test.ts"],
    checkTests: [...TESTS, "packages/review/test/decision-order.test.ts"],
    settings: {},
  });
  const { code, err } = invoke(["--check"], dir);
  assert.equal(code, 1);
  assert.match(err, /remediation\.test\.ts — in \.perbo\/config\.json, not in \.github\/protected-paths\.json/);
  assert.match(err, /decision-order\.test\.ts — in \.github\/protected-paths\.json, not in \.perbo\/config\.json/);
});

test("the same entries in a different order are a difference too", () => {
  assert.deepEqual(protectedTestsDifferences(TESTS, TESTS), []);
  assert.deepEqual(protectedTestsDifferences(TESTS, [...TESTS].reverse()), [
    `  the same entries in a different order in ${PERBO_CONFIG} and ${PROTECTED_PATHS}`,
  ]);
});

test("--check fails when permissions.deny has drifted", () => {
  const dir = fixture({ settings: { permissions: { deny: ["Edit(/packages/review/test/blocking.test.ts)"] } } });
  const { code, err } = invoke(["--check"], dir);
  assert.equal(code, 1);
  assert.match(err, /permissions\.deny is not what the two lists produce/);
  assert.match(err, /Edit\(\/packages\/evaluation\/sample\/\*\*\)/);
});

test("--check fails when the settings file is missing", () => {
  const { code, err } = invoke(["--check"], fixture());
  assert.equal(code, 1);
  assert.match(err, /no \.claude\/settings\.json/);
});

test("--write preserves every key it did not generate", () => {
  const dir = fixture({
    settings: {
      attribution: { commit: "Assisted-by: LLM", pr: "" },
      permissions: { allow: ["Bash(pnpm test)"], deny: ["Edit(/gone.ts)"] },
    },
  });
  assert.equal(invoke(["--write"], dir).code, 0);
  const written = settingsOf(dir);
  assert.deepEqual(written.attribution, { commit: "Assisted-by: LLM", pr: "" });
  assert.deepEqual(written.permissions.allow, ["Bash(pnpm test)"]);
  assert.deepEqual(written.permissions.deny, computeDenyList({ configTests: TESTS, checkPaths: PATHS }));
  assert.equal(invoke(["--check"], dir).code, 0);
});

test("--write creates the settings file when there is none", () => {
  const dir = fixture();
  assert.equal(invoke(["--write"], dir).code, 0);
  assert.deepEqual(settingsOf(dir).permissions.deny, computeDenyList({ configTests: TESTS, checkPaths: PATHS }));
});

test("withDenyList replaces only permissions.deny", () => {
  const before = { attribution: { pr: "" }, permissions: { allow: ["a"], deny: ["old"] }, other: 1 };
  assert.deepEqual(withDenyList(before, ["new"]), {
    attribution: { pr: "" },
    permissions: { allow: ["a"], deny: ["new"] },
    other: 1,
  });
});

test("the generated file is JSON with no comment key", () => {
  const raw = readFileSync(join(REPO_ROOT, CLAUDE_SETTINGS), "utf8");
  assert.doesNotMatch(raw, /^\s*\/\//m);
  assert.ok(!Object.keys(JSON.parse(raw)).some((key) => key.startsWith("_")));
});

test("neither --check nor --write is a usage error", () => {
  assert.equal(invoke([], fixture()).code, 2);
  assert.equal(invoke(["--sync"], fixture()).code, 2);
});
