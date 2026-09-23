import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where `pnpm desktop:package` writes the app for this host, and where inside
 * it the binary and the resources are: `release/<platform>[-<arch>]/Perbo.app`
 * on macOS, `release/<platform>-unpacked/` elsewhere.
 */
export const desktop = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
export const productName = manifest.productName;

/** The package: the path given, or the single one under `release/`. */
export function packaged(given) {
  if (given) return resolve(given);
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
export function layout(app) {
  if (app.endsWith(".app")) {
    return { binary: join(app, "Contents", "MacOS", productName), resources: join(app, "Contents", "Resources") };
  }
  const exe = process.platform === "win32" ? `${productName}.exe` : manifest.name.replace(/^@.*\//, "");
  const binary = [join(app, exe), join(app, productName)].find((path) => existsSync(path));
  assert.ok(binary, `No app binary in ${app}`);
  return { binary, resources: join(app, "resources") };
}
