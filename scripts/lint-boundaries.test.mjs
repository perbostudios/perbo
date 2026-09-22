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

test("`export *` is refused in the reviewer's and the model's source", async () => {
  // Every one is reached by a later config object, which replaces the array
  // whole — the model's two transports by an override of their own.
  await refuses("packages/review/src/m.ts", EXPORT_ALL, NAME_WHAT);
  await refuses("packages/model/src/m.ts", EXPORT_ALL, NAME_WHAT);
  await refuses("packages/model/src/claude-cli.ts", EXPORT_ALL, NAME_WHAT);
  await refuses("packages/model/src/codex-cli.ts", EXPORT_ALL, NAME_WHAT);
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
  await allows("packages/workspace/src/m/test-support/fake-clock.ts", USES("../../test-support/build-run.js"));
});

test("production code reaches no `@perbo/test-support`, and a test does", async () => {
  await refuses("packages/x/src/a.ts", USES("@perbo/test-support"), NO_TEST_CODE);
  await allows("packages/x/src/a.test.ts", USES("@perbo/test-support"));
  await allows("packages/x/src/test-support/b.ts", USES("@perbo/test-support"));
  await allows("packages/x/test/support.ts", USES("@perbo/test-support"));
});

test("a package whose name merely starts with the fakes' is not one of them", async () => {
  await allows("packages/x/src/a.ts", USES("@perbo/test-supportive"));
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
  await refuses("packages/model/src/claude-cli.ts", SHELL_STRING, "No shell-string execution");
  await refuses("packages/contracts/src/index.ts", SHELL_STRING, "No shell-string execution");
});

test("no process execution in the reviewer, with no exception", async () => {
  await refuses("packages/review/src/m.ts", ARGV, "No process execution in the reviewer");
  await refuses("packages/review/src/index.ts", ARGV, "No process execution in the reviewer");
  await refuses("packages/review/test/m.test.ts", ARGV, "No process execution in the reviewer");
  // The rule covers a path, not a file: the two names the transports had are
  // refused like any other, so a transport cannot come back to the reviewer.
  await refuses("packages/review/src/provider-cli.ts", ARGV, "No process execution in the reviewer");
  await refuses(
    "packages/review/src/provider-codex-cli.ts",
    ARGV,
    "No process execution in the reviewer",
  );
});

test("no process execution in the model package, except in its two named transports", async () => {
  await refuses("packages/model/src/m.ts", ARGV, "No process execution in the model package");
  await refuses("packages/model/src/index.ts", ARGV, "No process execution in the model package");
  await refuses("packages/model/src/anthropic.ts", ARGV, "No process execution in the model package");
  await refuses(
    "packages/model/src/nested/claude-cli.ts",
    ARGV,
    "No process execution in the model package",
  );
  await allows("packages/model/src/claude-cli.ts", ARGV);
  await allows("packages/model/src/codex-cli.ts", ARGV);
});

// --------------------------------------------------------------------------
// Every git and gh process goes through one module
// --------------------------------------------------------------------------

const GIT_ARGV = 'import { execFileSync } from "node:child_process";\nexport const out = execFileSync("git", ["status"]);\n';
const GH_ARGV = 'import { run } from "./process.js";\nexport const out = run(["gh", "pr", "view"]);\n';
const NODE_ARGV = 'import { execFileSync } from "node:child_process";\nexport const out = execFileSync("node", ["--version"]);\n';
const GIT_WORDS = 'export const VERIFY: readonly string[] = ["git", "status", "--porcelain"];\n';
const ONE_MODULE = "go through @perbo/workspace";

test("a source file starts no git or gh process, whichever form it takes", async () => {
  await refuses("packages/x/src/a.ts", GIT_ARGV, ONE_MODULE);
  await refuses("packages/x/src/a.ts", GH_ARGV, ONE_MODULE);
  await refuses("apps/cli/src/commands/b.ts", GIT_ARGV, ONE_MODULE);
  await refuses("apps/desktop/src/host/b.ts", GH_ARGV, ONE_MODULE);
});

test("the module that runs them, and the one call it cannot express, are the exception", async () => {
  await allows("packages/workspace/src/repository/index.ts", GIT_ARGV);
  await allows("packages/workspace/src/repository/internal/environment.ts", GH_ARGV);
  // The write guard replays the agent's own push, with the agent's global
  // flags in the agent's environment, which the typed interface cannot say.
  await allows("packages/runner/src/push-remote.ts", GIT_ARGV);
  // Everything else in the runner is held to the rule.
  await refuses("packages/runner/src/preflight.ts", GH_ARGV, ONE_MODULE);
  await refuses("packages/runner/src/loop/index.ts", GIT_ARGV, ONE_MODULE);
});

test("a repository a test builds for itself is its own", async () => {
  await allows("tooling/test-support/src/repository.ts", GIT_ARGV);
  await allows("packages/x/src/a.test.ts", GIT_ARGV);
  await allows("packages/x/src/test-support/repository.ts", GH_ARGV);
});

test("the ban is on starting the process, not on naming the binary", async () => {
  await allows("packages/x/src/a.ts", NODE_ARGV);
  // `GREENFIELD_VERIFY` in packages/workspace/src/diagnostic.ts: an array of
  // words no call here takes, which the module it is handed to runs.
  await allows("packages/x/src/a.ts", GIT_WORDS);
});

test("the reviewer and the model carry the ban too, transports included", async () => {
  await refuses("packages/review/src/m.ts", GH_ARGV, ONE_MODULE);
  await refuses("packages/model/src/m.ts", GH_ARGV, ONE_MODULE);
  await refuses("packages/model/src/claude-cli.ts", GIT_ARGV, ONE_MODULE);
  await refuses("packages/model/src/codex-cli.ts", GH_ARGV, ONE_MODULE);
});

// --------------------------------------------------------------------------
// A caller in this process reaches a command as a function, not as a line
// --------------------------------------------------------------------------

const READS_NO_LINE = "reaches a command as a typed function";
const RUNS_NO_LINE = "do not run it from a line";

test("the endpoint imports nothing at the argv edge", async () => {
  const tools = "apps/cli/src/endpoint/internal/tools.ts";
  await refuses(tools, USES("../../command-line/grammar.js"), READS_NO_LINE);
  await refuses(tools, USES("../../command-line/terminal.js"), READS_NO_LINE);
  await refuses("apps/cli/src/endpoint/index.ts", USES("../command-line/terminal.js"), READS_NO_LINE);
  await refuses(tools, USES("../../command-line/table.js"), READS_NO_LINE);
  // What it does reach: the commands themselves, and what it gives them.
  await allows(tools, USES("../../commands/stops.js"));
  await allows(tools, USES("../../command.js"));
  await allows(tools, USES("../../diagnostics.js"));
  // And what every source file is held to, which this object repeats rather
  // than replaces.
  await refuses(tools, USES("../../commands/run/internal/relevel.js"), OWN_INTERIOR);
  await refuses(tools, USES("../../test-support/paths.js"), "imports no test code");
});

test("the queue and the interview read their own line and run no command from one", async () => {
  const serve = "apps/cli/src/commands/serve/index.ts";
  await refuses(serve, USES("../../command-line/terminal.js"), RUNS_NO_LINE);
  await refuses(
    "apps/cli/src/commands/interview/index.ts",
    USES("../../command-line/terminal.js"),
    RUNS_NO_LINE,
  );
  await allows(serve, USES("../../command-line/grammar.js"));
  // And the table it declares itself in: saying what a command is is not
  // running one from a line.
  await allows(serve, USES("../../command-line/table.js"));
  await refuses(serve, USES("../run/internal/relevel.js"), OWN_INTERIOR);
  await refuses(serve, USES("../../test-support/paths.js"), "imports no test code");
  // Every file of either module, not the four that call a command today.
  await refuses(
    "apps/cli/src/commands/serve/waits.ts",
    USES("../../command-line/terminal.js"),
    RUNS_NO_LINE,
  );
  await refuses(
    "apps/cli/src/commands/interview/claude.ts",
    USES("../../command-line/terminal.js"),
    RUNS_NO_LINE,
  );
});

test("a command that is nobody's in-process callee is not this rule's business", async () => {
  await allows("apps/cli/src/commands/admit.ts", USES("../command-line/terminal.js"));
  await allows("apps/cli/src/main.ts", USES("./command-line/terminal.js"));
});

// --------------------------------------------------------------------------
// The configuration a package resolves from its own directory
// --------------------------------------------------------------------------

test("a package running `eslint src test` from its own directory gets the same rules", async () => {
  const inside = new ESLint({ cwd: join(REPO_ROOT, "packages/review") });
  await refuses("packages/review/src/m.ts", EXPORT_ALL, NAME_WHAT, inside);
  await refuses("packages/review/src/m.ts", ARGV, "No process execution in the reviewer", inside);
  await allows("packages/review/src/index.ts", EXPORT_ALL, inside);

  const model = new ESLint({ cwd: join(REPO_ROOT, "packages/model") });
  await refuses("packages/model/src/m.ts", EXPORT_ALL, NAME_WHAT, model);
  await refuses("packages/model/src/m.ts", ARGV, "No process execution in the model package", model);
  await allows("packages/model/src/claude-cli.ts", ARGV, model);
});
