import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { desktop, layout, packaged, productName } from "./package-layout.mjs";

/**
 * The packaged app, checked the way it will be run: by its own binary.
 *
 * `check-runtime.mjs` checks `dist/`, which is what electron-builder is given,
 * not what it produces — and it does not copy everything it is given. A
 * `node_modules` directly under an `extraResources` source is dropped whatever
 * the patterns say, so the Agent SDK beside the bundled CLI has an entry of
 * its own in `package.json`, and only a packaged app shows that it arrived.
 *
 *   node apps/desktop/scripts/check-package.mjs [path/to/App.app | unpacked dir]
 *
 * With no argument, the one package `pnpm desktop:package` wrote under
 * `release/` for this host.
 */
const app = packaged(process.argv[2]);
const { binary, resources } = layout(app);
const entry = join(resources, "cli", "dist", "perbo.js");
const options = { encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };

assert.ok(existsSync(entry), `The bundled CLI is missing from the package: ${entry}`);
const cli = JSON.parse(readFileSync(join(desktop, "..", "cli", "package.json"), "utf8"));
const version = spawnSync(binary, [entry, "--version"], options);
assert.ifError(version.error);
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stderr.trim(), `perbo ${cli.version}`);

// Imported, not only resolved: resolution finds a file, and loading it is what
// an interview does first.
const sdk = spawnSync(
  binary,
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
assert.equal(sdk.status, 0, `The Agent SDK does not load from the packaged CLI: ${sdk.stderr}`);
assert.ok(
  sdk.stdout.startsWith(resources),
  `The Agent SDK loaded from outside the package, at ${sdk.stdout}; the package does not carry it.`,
);

/** Every file under `dir` named like Claude Code's own executable. */
function claudeBinaries(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((each) => {
    const path = join(dir, each.name);
    if (each.isDirectory()) return claudeBinaries(path);
    return /^claude(\.exe)?$/.test(each.name) ? [path] : [];
  });
}
// The interview runs the person's own Claude Code; a copy the SDK brought
// would be about 198 MB of an executable nothing starts.
assert.deepEqual(claudeBinaries(join(resources, "cli")), []);

// The Dock and Finder name a macOS app from its bundle, not the running app.
if (app.endsWith(".app")) {
  const plist = (key) =>
    spawnSync("plutil", ["-extract", key, "raw", join(app, "Contents", "Info.plist")], { encoding: "utf8" }).stdout.trim();
  for (const key of ["CFBundleName", "CFBundleDisplayName", "CFBundleExecutable"])
    assert.equal(plist(key), productName, `${key} in the bundle's Info.plist`);
  const icon = plist("CFBundleIconFile");
  assert.ok(icon && existsSync(join(resources, icon)), `The bundle names an icon it does not carry: ${icon}`);
}

console.log(
  `${basename(app)}: CLI v${cli.version} ran on the app's own binary, the Agent SDK loaded from inside the package, and the bundle is named ${productName}.`,
);
