// What the release stage holds before anything is archived: the binary and,
// beside it, the runner's write-guard hook. The hook is what an attempt's
// PreToolUse decision runs; a stage without one installs a CLI whose `run`
// stops at `executing`.
//
// The stage function is called with a `root` this test builds — a tree with
// the compiled entry points, a compiled hook and the licence in it, and
// nothing else.
// Running the scripts themselves would run a workspace build, and a test in
// this package cannot depend on one having happened: `@perbo/package` has no
// workspace dependencies, so turbo is free to run this before any package is
// built. What the real entry points bundle to is asserted where a build is
// guaranteed, in apps/cli/test/packaging.test.ts.
//
//   node --test tooling/package/stage.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, after } from "node:test";
import { dirname, join } from "node:path";

import { GUARD_HOOK_ENTRY, GUARD_HOOK_FILE, CLI_ENTRY_POINT } from "./bundle.mjs";
import { stageArchive } from "./pack.mjs";

const scratch = [];

after(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A file with its directories, under `root`. */
function put(root, path, text) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
}

/**
 * A tree shaped like this repository, carrying only what a stage reads: the two
 * compiled entry points, the compiled hook, and the install page pack.mjs cuts
 * its README from.
 */
function sourceTree() {
  const root = mkdtempSync(join(tmpdir(), "perbo-stage-source-"));
  scratch.push(root);
  put(root, CLI_ENTRY_POINT, '#!/usr/bin/env node\nprocess.stdout.write("0.0.0");\n');
  put(root, GUARD_HOOK_ENTRY, 'process.stdout.write("{}");\n');
  put(root, "LICENSE", "Apache License, Version 2.0 fixture\n");
  put(root, join("docs", "install.md"), "# Install\n\n<!-- pack.mjs: the tarball copy ends here -->\nrest\n");
  put(root, "tooling/skills/mattpocock/LICENSE", "MIT license fixture\n");
  put(root, "tooling/skills/mattpocock/source.json", '{"revision":"pinned-fixture"}\n');
  return root;
}

function stageDirectory() {
  const stage = join(mkdtempSync(join(tmpdir(), "perbo-stage-")), "perbo-0.0.0");
  scratch.push(dirname(stage));
  return stage;
}

test("the partner archive's stage holds the write-guard hook beside the binary", async () => {
  const stage = stageDirectory();
  await stageArchive({ stage, version: "0.0.0", root: sourceTree() });
  assert.ok(existsSync(join(stage, "bin", "perbo.mjs")), "the stage holds no binary");
  assert.equal(readFileSync(join(stage, "licenses/mattpocock-skills-MIT.txt"), "utf8"), "MIT license fixture\n");
  assert.ok(
    existsSync(join(stage, "bin", GUARD_HOOK_FILE)),
    `the stage holds no bin/${GUARD_HOOK_FILE}`,
  );
});

test("the archive carries the licence the software is under", async () => {
  const stage = stageDirectory();
  await stageArchive({ stage, version: "0.0.0", root: sourceTree() });
  assert.equal(readFileSync(join(stage, "LICENSE"), "utf8"), "Apache License, Version 2.0 fixture\n");
  assert.match(readFileSync(join(stage, "NOTICE"), "utf8"), /Apache License, Version 2\.0/);
  assert.equal(JSON.parse(readFileSync(join(stage, "package.json"), "utf8")).license, "Apache-2.0");
});
