import { build } from "esbuild";
import { expect, it } from "vitest";

it("loads renderer modules in the browser even without production tree shaking", async () => {
  const result = await build({
    entryPoints: ["src/renderer/shell/App.tsx"],
    platform: "browser",
    bundle: true,
    write: false,
    treeShaking: false,
    format: "esm",
    logLevel: "silent",
    loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
  });
  expect(result.outputFiles.length).toBeGreaterThan(0);
});

/**
 * A test sits beside the module it covers, so nothing about where a file lives
 * keeps it out of the app: only the module graph does. The three entries
 * `scripts/build.mjs` builds from are read here rather than in `dist/`,
 * because a minified bundle shows only the names that survived it.
 */
const TEST_CODE = /\.test\.tsx?$|\/test-support\//;

it("ships neither a test nor its support from any build entry", async () => {
  const renderer = await build({
    entryPoints: ["src/renderer/main.tsx"],
    platform: "browser",
    bundle: true,
    write: false,
    // Nothing is written, but the stylesheets the entry imports need an output
    // path before esbuild will place them.
    outdir: "dist/renderer",
    metafile: true,
    format: "esm",
    logLevel: "silent",
    loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
  });
  const host = await build({
    entryPoints: ["src/host/main.ts"],
    platform: "node",
    target: "node22",
    bundle: true,
    write: false,
    outdir: "dist/host",
    metafile: true,
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  // The bridge the renderer is handed runs with the host's privileges, so what
  // it pulls in is read on the same terms as the other two.
  const preload = await build({
    entryPoints: ["src/host/preload.ts"],
    platform: "node",
    target: "node22",
    bundle: true,
    write: false,
    outdir: "dist/host",
    metafile: true,
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  for (const result of [renderer, host, preload])
    expect(Object.keys(result.metafile.inputs).filter((input) => TEST_CODE.test(input))).toEqual([]);
});
