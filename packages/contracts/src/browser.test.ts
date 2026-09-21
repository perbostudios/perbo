import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

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

describe("@perbo/contracts/browser", () => {
  it("bundles for a browser with nothing tree-shaken away", async () => {
    const result = await bundle('import * as surface from "./browser.js"; export default surface;');
    expect(result.outputFiles[0]!.text).not.toMatch(/["']node:/);
  });

  it("fails for a module that needs Node, so the check above can fail", async () => {
    await expect(bundle('import "./changeset.js";')).rejects.toThrow(/node:crypto/);
  });
});
