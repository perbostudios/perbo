import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * `browser.ts` is the part of this package the desktop's renderer imports, and
 * what makes it that is that nothing it names reaches a `node:` module. That is
 * a property of the module graph rather than of the file, so it is checked by
 * bundling it the way the renderer is bundled, with tree shaking off so a
 * reachable import counts whether or not the bundle would have kept it.
 *
 * `apps/desktop/src/renderer/browser-imports.test.ts` bundles the renderer end
 * to end. This says the same thing where the constraint is, so a module added
 * to the browser surface fails here rather than in another package.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

const bundle = (contents: string) =>
  build({
    stdin: { contents, resolveDir: SRC, sourcefile: "entry.ts", loader: "ts" },
    platform: "browser",
    bundle: true,
    write: false,
    treeShaking: false,
    format: "esm",
    logLevel: "silent",
  });

describe("@perbo/planning/browser", () => {
  it("bundles for a browser with nothing tree-shaken away", async () => {
    const result = await bundle('import * as surface from "./browser.js"; export default surface;');

    expect(result.outputFiles[0]?.text).not.toMatch(/["']node:/);
  });

  /** The same bundle over a module that reads the filesystem, so the check above can fail. */
  it("fails for a module that needs Node", async () => {
    await expect(bundle('import "./spec.js";')).rejects.toThrow(/node:fs/);
  });
});
