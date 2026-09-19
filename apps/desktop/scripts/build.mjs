import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { build as buildRenderer } from "vite";
import { cp, copyFile, mkdir, writeFile, readFile } from "node:fs/promises";

await mkdir("dist/host", { recursive: true });
await build({
  entryPoints: ["src/host/main.ts"],
  outfile: "dist/host/main.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
});
await build({
  entryPoints: ["src/host/preload.ts"],
  outfile: "dist/host/preload.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
});
await mkdir("dist/cli/dist", { recursive: true });
for (const name of ["perbo.js", "guard-hook.js"])
  await copyFile(`../cli/dist/${name}`, `dist/cli/dist/${name}`);
const cli = JSON.parse(await readFile("../cli/package.json", "utf8"));
await writeFile(
  "dist/cli/package.json",
  JSON.stringify({ name: cli.name, version: cli.version, type: "module" }),
);

// The Claude Agent SDK, beside the bundled CLI rather than inside it.
//
// `tooling/package/bundle.mjs` keeps it external, and `loadInterviewSdk`
// imports it by name at the moment a session starts, which resolves here —
// `dist/cli/dist/perbo.js` walks up to `dist/cli/node_modules` — and says what
// to install when it is not there.
//
// Its own `node_modules` is left behind, which is where the published package
// keeps the per-platform copies of Claude Code it carries as optional
// dependencies: about 198 MB each, against roughly 3 MB of JavaScript. The
// interview passes `pathToClaudeCodeExecutable`, so the copy the SDK would
// otherwise reach for is one this app never runs.
const sdkName = "@anthropic-ai/claude-agent-sdk";
// Resolved through the package's entry point rather than its manifest: the
// `exports` map does not expose `./package.json`, so asking for that is a
// refusal rather than a path.
const sdkPackage = dirname(createRequire(resolve("../cli/package.json")).resolve(sdkName));
const sdkTarget = join("dist/cli/node_modules", sdkName);
await mkdir(dirname(sdkTarget), { recursive: true });
await cp(sdkPackage, sdkTarget, {
  recursive: true,
  dereference: true,
  // Judged on the path *within* the package: the package itself lives under a
  // `node_modules`, so testing the whole source path would exclude its own root
  // and copy nothing.
  filter: (source) => {
    const within = relative(sdkPackage, source);
    return within === "" || !within.split(/[\\/]/).includes("node_modules");
  },
});

await buildRenderer();
