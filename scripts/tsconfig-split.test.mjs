// Every package compiles two different programs, and this proves the split for
// each of them: `typecheck` reads the tests, so a test that has drifted from
// the interface it exercises is an error rather than a surprise at runtime, and
// `build` reads only `src` without them, so no test is published in `dist`.
//
// It reads the configs through TypeScript's own config parser rather than
// matching on their text, so a preset that moves an `include` between the leaf
// and the preset still passes and a preset that changes which files a program
// contains does not.
//
//   node --test scripts/tsconfig-split.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";

import { REPO_ROOT, workspacePackages } from "./check.mjs";

/**
 * Packages that still carry their own compiler options instead of extending the
 * shared presets. A burn-down list: an entry may only leave it, and the set
 * goes away with its last entry.
 */
const PENDING = new Set([
  "@perbo/contracts",
  "@perbo/evaluation",
  "@perbo/planning",
  "@perbo/review",
  "@perbo/runner",
  "@perbo/ui",
  "@perbo/workspace",
]);

/**
 * The files a package's typecheck program is allowed not to contain. Both are
 * protected tests that do not compile against the current `Finding` and
 * `BlockingInput` types; a pull request may not edit them, so the reviewer's
 * config excludes them by name. They still run under vitest.
 */
const TYPECHECK_EXCLUDED = [
  "packages/review/test/blocking.test.ts",
  "packages/review/test/remediation.test.ts",
];

/**
 * Packages whose `build` is not `tsc`. The desktop app is bundled by vite and
 * esbuild from `src`, emits no `dist` of compiled modules, and so has one
 * config that already reads its tests.
 */
const BUNDLED = new Set(["@perbo/desktop"]);

/** The directories `pnpm-workspace.yaml` globs, which is where a package can be. */
const WORKSPACE_ROOTS = ["apps", "packages", "tooling"];

const PROTECTED_PATHS = ".github/protected-paths.json";

/** A path as this file writes them: relative to the repository, forward slashes. */
function repoPath(path) {
  return relative(REPO_ROOT, path).split(/[\\/]/).join("/");
}

/** Every workspace package, by name, with the directory it lives in. */
function packageDirectories() {
  const found = new Map();
  for (const root of WORKSPACE_ROOTS) {
    const base = join(REPO_ROOT, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      found.set(JSON.parse(readFileSync(manifest, "utf8")).name, dir);
    }
  }
  return found;
}

const PACKAGES = packageDirectories();

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/**
 * A config as tsc reads it: the options it resolves and the files it contains,
 * relative to the repository. The package's own TypeScript does the reading,
 * because the package is what runs it.
 */
function parseConfig(dir, name) {
  const ts = createRequire(join(dir, "package.json"))("typescript");
  const path = join(dir, name);
  const where = repoPath(path);
  assert.ok(existsSync(path), `${where} does not exist`);
  const message = (diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(`${where}: ${message(diagnostic)}`);
    },
  });
  assert.ok(parsed, `${where}: tsc read no configuration`);
  assert.deepEqual(parsed.errors.map(message), [], `${where} does not parse cleanly`);
  return {
    where,
    options: parsed.options,
    fileNames: parsed.fileNames.map(repoPath).sort(),
  };
}

/**
 * Every `.ts`/`.tsx` under `src` and `test`, which is what a package's
 * typecheck program has to contain. `test/fixtures` is left out: it holds
 * authored repositories the product reads as input, whose imports resolve to
 * packages that are not installed here.
 */
function sourceFiles(dir) {
  const found = [];
  const walk = (current, skip) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || skip.has(path)) continue;
        walk(path, skip);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(repoPath(path));
      }
    }
  };
  const src = join(dir, "src");
  if (existsSync(src)) walk(src, new Set());
  const test = join(dir, "test");
  if (existsSync(test)) walk(test, new Set([join(test, "fixtures")]));
  return found.sort();
}

test("PENDING names packages that exist", () => {
  for (const name of PENDING) {
    assert.ok(PACKAGES.has(name), `${name} is in PENDING but is not a workspace package`);
  }
});

test("the packages found on disk are the ones check.mjs names", () => {
  assert.deepEqual([...PACKAGES.keys()].sort(), workspacePackages(REPO_ROOT));
});

test("a file left out of a typecheck program is a protected test", () => {
  const { protected_tests: protectedTests } = JSON.parse(
    readFileSync(join(REPO_ROOT, PROTECTED_PATHS), "utf8"),
  );
  for (const file of TYPECHECK_EXCLUDED) {
    assert.ok(
      protectedTests.includes(file),
      `${file} is excluded from a typecheck program but is not protected in ${PROTECTED_PATHS}; ` +
        "a test a pull request may edit is fixed rather than excluded",
    );
  }
});

for (const [name, dir] of [...PACKAGES].sort()) {
  const manifest = manifestOf(dir);
  // The tooling packages ship `.mjs` and JSON, run no compiler, and so have no
  // program to hold to the split.
  if (typeof manifest.scripts?.typecheck !== "string") continue;
  const skip = PENDING.has(name) && "still carries its own compiler options";

  test(`${name}: typecheck reads its tests and emits nothing`, { skip }, () => {
    const typecheck = parseConfig(dir, "tsconfig.json");
    assert.equal(typecheck.options.noEmit, true, `${typecheck.where} emits`);
    const contains = new Set(typecheck.fileNames);
    const missing = sourceFiles(dir).filter((file) => !contains.has(file));
    const excluded = TYPECHECK_EXCLUDED.filter((file) => file.startsWith(`${repoPath(dir)}/`));
    assert.deepEqual(missing, excluded, `${typecheck.where} does not read every file under src and test`);
  });

  if (BUNDLED.has(name)) {
    test(`${name}: is bundled, so it has no build config`, { skip }, () => {
      assert.doesNotMatch(manifest.scripts.build, /^tsc\b/, `${name} builds with tsc after all`);
      assert.ok(
        !existsSync(join(dir, "tsconfig.build.json")),
        `${name} has a tsconfig.build.json but nothing runs it`,
      );
    });
    continue;
  }

  test(`${name}: build emits src to dist and no test`, { skip }, () => {
    const build = parseConfig(dir, "tsconfig.build.json");
    const tests = build.fileNames.filter((file) => /\.test\.tsx?$/.test(file) || file.includes("/test-support/"));
    assert.deepEqual(tests, [], `${build.where} would publish test code in dist`);
    assert.equal(repoPath(build.options.rootDir ?? ""), `${repoPath(dir)}/src`);
    assert.equal(repoPath(build.options.outDir ?? ""), `${repoPath(dir)}/dist`);
  });

  test(`${name}: runs one config to build and the other to typecheck`, { skip }, () => {
    assert.ok(
      manifest.scripts.build.startsWith("tsc -p tsconfig.build.json"),
      `${name} build is "${manifest.scripts.build}"`,
    );
    assert.equal(manifest.scripts.typecheck, "tsc -p tsconfig.json");
  });
}
