import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { expect, it } from "vitest";
import config from "../vite.config.js";

/**
 * The sample host is a development and test adapter
 * ([D-NEW-desktop-sample-host](../../../docs/11-open-decisions.md)), so the
 * packaged renderer must not contain it: the app the person installs answers
 * from their own records or says it could not, and never from a sample.
 *
 * Checked at the module graph rather than at the built bundle, because a
 * minified `dist` proves it only after a build and only for the strings that
 * survived tree shaking.
 */
it("keeps the sample host out of the renderer's own module graph", async () => {
  const result = await build({
    entryPoints: ["src/renderer/main.tsx"],
    platform: "browser",
    bundle: true,
    write: false,
    outdir: "dist/renderer",
    metafile: true,
    format: "esm",
    logLevel: "silent",
    loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
  });
  const reached = Object.keys(result.metafile.inputs).filter((input) =>
    input.includes("src/sample-host/"),
  );
  expect(reached).toEqual([]);
});

/** The one page the production build has an entry for is the app's own. */
it("builds the app from index.html alone", () => {
  const input = (config as { build?: { rollupOptions?: { input?: unknown } } }).build?.rollupOptions
    ?.input;
  expect(input === undefined || input === "index.html").toBe(true);
});

const policy = (file: string): string => {
  const meta = readFileSync(file, "utf8").match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
  );
  if (!meta?.[1]) throw new Error(`${file} declares no content security policy`);
  return meta[1];
};

/**
 * One policy, in two pages. The preview loads the same renderer, so a policy
 * that differs would let a screen work in the preview and be refused in the
 * app — which is the opposite of what the preview is for.
 */
it("holds the preview page to the app's content security policy", () => {
  expect(policy("preview.html")).toBe(policy("index.html"));
});
