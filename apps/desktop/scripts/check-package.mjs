import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const desktop = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const productName = manifest.productName;

/** The package to check: the argument, or the single one under `release/`. */
function packaged() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const release = join(desktop, "release");
  assert.ok(existsSync(release), "No release/ directory: run `pnpm desktop:package` first.");
  const found = readdirSync(release)
    .map((name) => join(release, name))
    .filter((path) => statSync(path).isDirectory())
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".app"))
        .map((name) => join(dir, name))
        .concat(/-unpacked$/.test(dir) ? [dir] : []),
    );
  assert.equal(found.length, 1, `Expected one package under release/, found: ${found.join(", ") || "none"}`);
  return found[0];
}

/** The app's own binary, and the directory its `extraResources` land in. */
function layout(app) {
  if (app.endsWith(".app")) {
    return { binary: join(app, "Contents", "MacOS", productName), resources: join(app, "Contents", "Resources") };
  }
  const exe = process.platform === "win32" ? `${productName}.exe` : manifest.name.replace(/^@.*\//, "");
  const binary = [join(app, exe), join(app, productName)].find((path) => existsSync(path));
  assert.ok(binary, `No app binary in ${app}`);
  return { binary, resources: join(app, "resources") };
}

const app = packaged();
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

console.log(
  `${basename(app)}: CLI v${cli.version} ran on the app's own binary, and the Agent SDK loaded from inside the package.`,
);
