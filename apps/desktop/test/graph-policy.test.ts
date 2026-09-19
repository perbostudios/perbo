import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * The Graph pane draws under the policy `index.html` declares: `default-src
 * 'self'`, no `worker-src` and no remote origin (D-101, SCP-316). A graph
 * library that starts a worker or pulls its code from a CDN would be blocked
 * there with no visible error at all, so the drawing is the pane's own —
 * positioned nodes and an SVG layer of edges — and this is what says so.
 */

const CSP = /http-equiv="Content-Security-Policy" content="([^"]+)"/;
const policy = (): string => CSP.exec(readFileSync("index.html", "utf8"))?.[1] ?? "";

/** The pane and everything it pulls in, as the renderer bundles it. */
const bundled = async (): Promise<string> => {
  const result = await build({
    entryPoints: ["src/renderer/planning/GraphPane.tsx"],
    platform: "browser",
    bundle: true,
    write: false,
    format: "esm",
    logLevel: "silent",
    loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
  });
  return result.outputFiles.map((file) => file.text).join("\n");
};

/** The pane's own modules, which are where a library would have been reached for. */
const sources = (): string =>
  [
    "src/renderer/planning/GraphPane.tsx",
    "src/renderer/planning/GraphInspector.tsx",
    "src/renderer/planning/graph-layout.ts",
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

describe("the Graph pane under the desktop's content-security policy", () => {
  it("declares no worker source and no remote origin to load from", () => {
    const declared = policy();
    expect(declared).toContain("default-src 'self'");
    expect(declared).toContain("script-src 'self'");
    expect(declared).not.toContain("worker-src");
  });

  it("starts no worker and injects no script or stylesheet", async () => {
    const code = await bundled();
    for (const forbidden of [
      "new Worker",
      "SharedWorker",
      "importScripts",
      "serviceWorker",
      "createObjectURL",
      'createElement("script"',
      'createElement("link"',
      'setAttribute("src"',
    ])
      expect(`${forbidden}: ${code.includes(forbidden)}`).toBe(`${forbidden}: false`);
  });

  it("reads through the host and from nowhere else", () => {
    const code = sources();
    for (const forbidden of ["Worker", "fetch(", "XMLHttpRequest", "WebSocket", "http://", "https://"])
      expect(`${forbidden}: ${code.includes(forbidden)}`).toBe(`${forbidden}: false`);
    expect(code).toContain("bridge.request");
  });
});
