// The import boundaries in eslint.config.mjs, each shown refusing the form it
// forbids and staying silent on the form it allows. A rule nobody can fail is
// indistinguishable from one that works, and a `no-restricted-syntax` array
// that a later config object replaces silently drops what it does not repeat —
// so the ADR-0023 bans are checked here too, at every file the overrides reach.
//
// Every case lints a snippet through the repository's own configuration, so
// what passes here is what passes in `eslint src test`.
//
//   node --test scripts/lint-boundaries.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import { EXPORT_ALL_BURN_DOWN } from "../eslint.config.mjs";
import { REPO_ROOT } from "./check.mjs";

// Through a package that declares it, because the package is what runs it.
const require = createRequire(join(REPO_ROOT, "packages/workspace/package.json"));
const { ESLint } = require("eslint");

const eslint = new ESLint({ cwd: REPO_ROOT });

/** Every message a snippet raises at `where`, as `rule: text`. */
async function lint(where, code, engine = eslint) {
  const [result] = await engine.lintText(code, { filePath: join(REPO_ROOT, where) });
  return result.messages.map((message) => `${message.ruleId}: ${message.message}`);
}

/** The snippet is refused at `where`, by a message carrying `fragment`. */
async function refuses(where, code, fragment, engine = eslint) {
  const messages = await lint(where, code, engine);
  assert.ok(
    messages.some((message) => message.includes(fragment)),
    `${where} allowed ${JSON.stringify(code)}\n  raised: ${JSON.stringify(messages, null, 2)}`,
  );
}

/** The snippet raises nothing at all at `where`. */
async function allows(where, code, engine = eslint) {
  assert.deepEqual(
    await lint(where, code, engine),
    [],
    `${where} refused ${JSON.stringify(code)}`,
  );
}

// --------------------------------------------------------------------------
// A package states its interface: no `export *` in a source file
// --------------------------------------------------------------------------

const EXPORT_ALL = 'export * from "./a.js";\n';
const EXPORT_NAMED = 'export { a } from "./a.js";\n';
const NAME_WHAT = "Name what the module exports";

test("`export *` is refused in a source file, and naming the exports is not", async () => {
  await refuses("packages/workspace/src/m.ts", EXPORT_ALL, NAME_WHAT);
  await allows("packages/workspace/src/m.ts", EXPORT_NAMED);
});

test("`export *` is refused in the reviewer's source and in its two transports", async () => {
  // Both are reached by a later config object, which replaces the array whole.
  await refuses("packages/review/src/m.ts", EXPORT_ALL, NAME_WHAT);
  await refuses("packages/review/src/provider-cli.ts", EXPORT_ALL, NAME_WHAT);
  await refuses("packages/review/src/provider-codex-cli.ts", EXPORT_ALL, NAME_WHAT);
});

test("`export *` outside a package's source is not this rule's business", async () => {
  await allows("packages/workspace/test/m.test.ts", EXPORT_ALL);
});

test("an entry on the burn-down list may still `export *`", async () => {
  for (const entry of EXPORT_ALL_BURN_DOWN) await allows(entry, EXPORT_ALL);
});

test("the burn-down list carries no entry that has already been curated", () => {
  for (const entry of EXPORT_ALL_BURN_DOWN) {
    const path = join(REPO_ROOT, entry);
    assert.ok(existsSync(path), `${entry} is on the burn-down list and does not exist`);
    assert.match(
      readFileSync(path, "utf8"),
      /^\s*export \*/m,
      `${entry} no longer exports with \`*\`; take it off the burn-down list`,
    );
  }
});

// --------------------------------------------------------------------------
// A module keeps an interior: `internal/` is its own
// --------------------------------------------------------------------------

const USES = (from) => `import { a } from "${from}";\nexport const b = a;\n`;
const OWN_INTERIOR = "imported only by that module";

test("a module reaches its own `internal/`, and no one else's", async () => {
  await allows("packages/workspace/src/m/index.ts", USES("./internal/part.js"));
  await allows("packages/workspace/src/m/internal/part.ts", USES("./other.js"));
  await refuses("packages/workspace/src/other.ts", USES("./m/internal/part.js"), OWN_INTERIOR);
  await refuses("packages/workspace/src/n/index.ts", USES("../m/internal/part.js"), OWN_INTERIOR);
});

test("a name that merely starts with `internal` is not an interior", async () => {
  await allows("packages/workspace/src/m.ts", USES("./internal-state.js"));
});

// --------------------------------------------------------------------------
// A package is imported by its name, never by a file inside it
// --------------------------------------------------------------------------

const BY_NAME = "Import a package by its name";

test("a deep import into another package is refused, and its entries are not", async () => {
  await refuses("packages/workspace/src/m.ts", USES("@perbo/contracts/dist/plan.js"), BY_NAME);
  await refuses("packages/workspace/src/m.ts", USES("@perbo/contracts/src/plan.js"), BY_NAME);
  await allows("packages/workspace/src/m.ts", USES("@perbo/contracts"));
  await allows("packages/workspace/src/m.ts", USES("@perbo/contracts/browser"));
});

// --------------------------------------------------------------------------
// Production code imports no test code
// --------------------------------------------------------------------------

const NO_TEST_CODE = "imports no test code";

test("production code reaches no `test-support/`, and a test does", async () => {
  await refuses("packages/workspace/src/m/index.ts", USES("./test-support/fake-clock.js"), NO_TEST_CODE);
  await allows("packages/workspace/src/m/index.test.ts", USES("./test-support/fake-clock.js"));
  await allows("packages/workspace/src/m/test-support/fake-clock.ts", USES("./builder.js"));
});

test("production code reaches no test module, and a test does", async () => {
  await refuses("packages/workspace/src/m.ts", USES("./n.test.js"), NO_TEST_CODE);
  await allows("packages/workspace/src/m.test.ts", USES("./n.test.js"));
});

// --------------------------------------------------------------------------
// ADR-0023: what the overrides must not drop
// --------------------------------------------------------------------------

const SHELL_STRING = 'import { execSync } from "node:child_process";\nexport const out = execSync("ls");\n';
const ARGV = 'import { spawn } from "node:child_process";\nexport const p = spawn("ls", []);\n';

test("no shell-string execution, wherever a source file is", async () => {
  await refuses("packages/workspace/src/m.ts", SHELL_STRING, "No shell-string execution");
  await refuses("packages/review/src/provider-cli.ts", SHELL_STRING, "No shell-string execution");
  await refuses("packages/contracts/src/index.ts", SHELL_STRING, "No shell-string execution");
});

test("no process execution in the reviewer, except in its two named transports", async () => {
  await refuses("packages/review/src/m.ts", ARGV, "No process execution in the reviewer");
  await refuses("packages/review/src/index.ts", ARGV, "No process execution in the reviewer");
  await refuses("packages/review/test/m.test.ts", ARGV, "No process execution in the reviewer");
  await allows("packages/review/src/provider-cli.ts", ARGV);
  await allows("packages/review/src/provider-codex-cli.ts", ARGV);
});

// --------------------------------------------------------------------------
// The configuration a package resolves from its own directory
// --------------------------------------------------------------------------

test("a package running `eslint src test` from its own directory gets the same rules", async () => {
  const inside = new ESLint({ cwd: join(REPO_ROOT, "packages/review") });
  await refuses("packages/review/src/m.ts", EXPORT_ALL, NAME_WHAT, inside);
  await refuses("packages/review/src/m.ts", ARGV, "No process execution in the reviewer", inside);
  await allows("packages/review/src/index.ts", EXPORT_ALL, inside);
});
