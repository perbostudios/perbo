// A test sits beside the module it covers, and `test/` holds only what cannot:
// a test a pull request may not edit, a suite whose subject is the repository
// rather than one module, and data a test reads (docs/07 Package layout). This
// holds four packages to that rule and names what is still under their `test/`
// as a list that only shrinks, so the next test lands beside its module rather
// than by habit where the last one was.
//
// It reads the files from `git ls-files`, so scratch a checkout happens to hold
// does not count and a file staged for commit does.
//
//   node --test scripts/test-placement.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { REPO_ROOT } from "./check.mjs";

/**
 * The packages this guard holds to the rule. A package joins the list when its
 * tests sit beside their modules: `packages/evaluation` keeps its suites in
 * `test/`, where they reach the corpus and the sample through shared helpers.
 */
const GUARDED = ["contracts", "planning", "runner", "workspace"];

/**
 * What a guarded package's `test/` may hold, each with the reason it is not
 * beside a module. An entry is an exact path or a `**` prefix.
 */
const STAYS = [
  {
    path: "packages/contracts/test/glob-conformance.json",
    why: "the cases what a path glob means is written as, which every copy of the matcher answers",
  },
  {
    path: "packages/contracts/test/source-bytes.test.ts",
    why: "its subject is every package's source, not a module here",
  },
  {
    path: "packages/planning/test/draft-request.golden.json",
    why: "recorded bytes src/draft/index.golden.test.ts compares against",
  },
  {
    path: "packages/planning/test/draft-sequence.golden.json",
    why: "recorded bytes src/draft/index.golden.test.ts compares against",
  },
  {
    path: "packages/runner/test/fixtures/**",
    why: "authored input a test reads, rather than code this package runs",
  },
  {
    path: "packages/runner/test/security.test.ts",
    why: "protected in .github/protected-paths.json: a pull request may not edit it to follow a move",
  },
  {
    path: "packages/runner/test/support.ts",
    why: "security.test.ts imports it by this path and may not be edited to import it from another",
  },
];

/**
 * The files still under a guarded package's `test/` that belong beside a
 * module. A burn-down list: a path may only leave it, and the list goes away
 * with its last entry. A path here that names no file fails, so a move that
 * leaves the list behind is caught rather than silently widening what `test/`
 * may hold.
 */
const PENDING = [
  "packages/runner/test/base-ref-origin.test.ts",
  "packages/runner/test/base-verification.test.ts",
  "packages/runner/test/briefed-round.test.ts",
  "packages/runner/test/delivery-checks.test.ts",
  "packages/runner/test/loop-incomplete-review.test.ts",
  "packages/runner/test/loop-merge.test.ts",
  "packages/runner/test/loop.test.ts",
  "packages/runner/test/merge-up.test.ts",
  "packages/runner/test/orphans.test.ts",
  "packages/runner/test/rebrief-round.test.ts",
  "packages/runner/test/relevel.test.ts",
  "packages/runner/test/standing-prohibited.test.ts",
  "packages/runner/test/ticketless-run.test.ts",
];

/** Every tracked file under `packages/`, as git lists them. */
function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z", "--", "packages"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path !== "");
}

/** Whether an entry — an exact path or a `**` prefix — covers a file. */
function covers(entry, file) {
  return entry.endsWith("/**") ? file.startsWith(entry.slice(0, -2)) : entry === file;
}

/** The files under a guarded package's `test/` that no entry covers. */
function unlisted(files, entries) {
  const roots = GUARDED.map((name) => `packages/${name}/test/`);
  return files
    .filter((file) => roots.some((root) => file.startsWith(root)))
    .filter((file) => !entries.some((entry) => covers(entry, file)))
    .sort();
}

/** The entries that cover no file, which is what a stale one looks like. */
function stale(entries, files) {
  return entries.filter((entry) => !files.some((file) => covers(entry, file))).sort();
}

/**
 * The tests under a guarded package's `src` that name no module beside them. A
 * test is `<module>.test.ts` or `<module>.<aspect>.test.ts` with `<module>.ts`
 * in the same directory, where a directory module's module is its `index`.
 * `test-support/` holds a module's fakes rather than tests of one.
 */
function orphans(files) {
  const tracked = new Set(files);
  const roots = GUARDED.map((name) => `packages/${name}/src/`);
  return files
    .filter((file) => roots.some((root) => file.startsWith(root)))
    .filter((file) => /\.test\.tsx?$/.test(file) && !file.includes("/test-support/"))
    .filter((file) => {
      const cut = file.lastIndexOf("/") + 1;
      const directory = file.slice(0, cut);
      const named = file.slice(cut).replace(/\.test\.tsx?$/, "").split(".");
      if (named.length > 2) return true;
      return !tracked.has(`${directory}${named[0]}.ts`) && !tracked.has(`${directory}${named[0]}.tsx`);
    })
    .sort();
}

const FILES = trackedFiles();
const LISTED = [...STAYS.map((entry) => entry.path), ...PENDING];

test("every file under a guarded package's test/ is listed", () => {
  assert.deepEqual(
    unlisted(FILES, LISTED),
    [],
    "a test belongs beside the module it covers; add it to PENDING only with the change that will move it",
  );
});

test("every listed path names a file that is there", () => {
  assert.deepEqual(
    stale(LISTED, FILES),
    [],
    "a path in STAYS or PENDING names no file: drop it in the change that moved or deleted it",
  );
});

test("a test under src sits beside the module it names", () => {
  assert.deepEqual(
    orphans(FILES),
    [],
    "a colocated test is <module>.test.ts or <module>.<aspect>.test.ts beside <module>.ts",
  );
});

test("a test under test/ that nothing lists is refused", () => {
  assert.deepEqual(unlisted(["packages/workspace/test/x.test.ts"], LISTED), [
    "packages/workspace/test/x.test.ts",
  ]);
});

test("a listed path with no file behind it is refused", () => {
  assert.deepEqual(stale(["packages/runner/test/gone.test.ts"], FILES), [
    "packages/runner/test/gone.test.ts",
  ]);
});

test("a test under src with no module beside it is refused", () => {
  assert.deepEqual(orphans(["packages/contracts/src/nothing.aspect.test.ts"]), [
    "packages/contracts/src/nothing.aspect.test.ts",
  ]);
});
