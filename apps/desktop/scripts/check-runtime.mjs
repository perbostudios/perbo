import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

/**
 * The interpreter the packaged app actually starts the CLI on.
 *
 * The host runs `process.execPath` with `ELECTRON_RUN_AS_NODE`, so the CLI is
 * bundled against one Node and executed by the one inside Electron. Nothing
 * else in the gate runs that pair, and a bump to either side is the way it
 * breaks: this asserts the CLI starts there and reports its own version.
 *
 * The floor, rather than an exact pin, is what the CLI's own `engines` field
 * claims. Electron decides which Node it carries, so pinning a version here
 * would only record which Electron was current when it was written.
 */
const desktop = new URL("../", import.meta.url);
const cli = JSON.parse(readFileSync(new URL("../cli/package.json", desktop), "utf8"));
const options = {
  encoding: "utf8",
  timeout: 30_000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
};

const version = spawnSync(electron, ["-p", "process.versions.node"], options);
assert.ifError(version.error);
assert.equal(version.status, 0, version.stderr);
const node = version.stdout.trim();
assert.ok(
  Number(node.split(".")[0]) >= 22,
  `Electron carries Node v${node}; the CLI declares engines.node >=22.`,
);

const entry = fileURLToPath(new URL("dist/cli/dist/perbo.js", desktop));
const result = spawnSync(electron, [entry, "--version"], options);
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stderr.trim(), `perbo ${cli.version}`);

// The Agent SDK sits beside the bundled CLI rather than inside it, so the
// interview's `import` resolves from a directory the packaging step wrote.
// Imported here the way that import does — resolved from the CLI's own file,
// then loaded — because the failure is silent until somebody starts an
// interview. This checks `dist/`; `check-package.mjs` checks what
// electron-builder makes of it.
const sdk = spawnSync(
  electron,
  [
    "-e",
    "const { createRequire } = require('node:module');" +
      "const { pathToFileURL } = require('node:url');" +
      `const resolved = createRequire(${JSON.stringify(entry)}).resolve('@anthropic-ai/claude-agent-sdk');` +
      "import(pathToFileURL(resolved).href).then((m) => {" +
      "  if (typeof m.query !== 'function') { process.stderr.write('no query export'); process.exit(3); }" +
      "  process.stdout.write(resolved);" +
      "});",
  ],
  options,
);
assert.ifError(sdk.error);
assert.equal(sdk.status, 0, `The Agent SDK does not load beside the bundled CLI: ${sdk.stderr}`);
const sdkPackage = dirname(sdk.stdout.trim());
// Its per-platform Claude Code copies are what the desktop deliberately does
// not ship — about 198 MB each, for an executable the interview never runs
// because it passes `pathToClaudeCodeExecutable`.
assert.ok(
  !existsSync(join(sdkPackage, "node_modules")),
  "The Agent SDK copy carries its own node_modules, which is where its per-platform Claude Code binaries live.",
);

console.log(
  `CLI v${cli.version} ran on Electron's bundled Node v${node}, with the Agent SDK beside it.`,
);
