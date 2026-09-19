#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const environment = { ...process.env };
delete environment.PERBO_DESKTOP_DEV_URL;
const flags = process.argv.slice(2);
if (flags.includes("--help")) {
  console.log(
    "Usage: ./scripts/setup-local.mjs [--no-launch]\n\nChecks prerequisites, installs pinned dependencies, builds Perbo and opens the desktop.\n--no-launch  Build without opening a window (CI or headless setup).\nRequires Node 22+, npm and Git. Provider CLIs are installed and signed in separately.",
  );
  process.exit(0);
}
function fail(message) {
  console.error(`\nPerbo setup: ${message}`);
  process.exit(1);
}
if (flags.some((flag) => flag !== "--no-launch"))
  fail("Unknown option. Use --help for usage.");
if (Number(process.versions.node.split(".")[0]) < 22)
  fail(
    "Node 22 or newer is required. Install it from https://nodejs.org/en/download, then rerun this script.",
  );
// npm's .cmd shim needs a shell on Windows. Keep this script argv-only by using npm-cli.js.
const npm =
  process.platform === "win32"
    ? {
        binary: process.execPath,
        prefix: [
          join(
            dirname(process.execPath),
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ),
        ],
      }
    : { binary: "npm", prefix: [] };
function run(binary, args, quiet = false) {
  return spawnSync(binary, args, {
    cwd: root,
    env: environment,
    shell: false,
    stdio: quiet ? "pipe" : "inherit",
  });
}
for (const [name, binary, args, guide] of [
  ["Git", "git", ["--version"], "https://git-scm.com/downloads"],
  [
    "npm",
    npm.binary,
    [...npm.prefix, "--version"],
    "https://nodejs.org/en/download",
  ],
]) {
  const result = run(binary, args, true);
  if (result.error || result.status !== 0)
    fail(
      `${name} is required. Install it from ${guide}, then rerun this script.`,
    );
}
const { packageManager } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager))
  fail("package.json must specify an exact pnpm version.");
function pnpm(args) {
  // npm caches this exact pnpm version; no global install or Corepack mutation.
  const result = run(npm.binary, [
    ...npm.prefix,
    "exec",
    "--yes",
    `--package=${packageManager}`,
    "--",
    "pnpm",
    ...args,
  ]);
  if (result.error || result.status !== 0)
    fail(
      `Could not complete pnpm ${args.join(" ")}. Resolve the error above and rerun; existing app data and provider logins are preserved.`,
    );
}
console.log(
  `\nSetting up Perbo in ${root}\nUsing ${packageManager} and Node ${process.versions.node}.`,
);
pnpm(["install", "--frozen-lockfile", "--prod=false"]);
pnpm(["desktop:build"]);
console.log(
  "\nPerbo is ready. Connect Claude Code (claude auth login) and/or Codex (codex login) in the app. GitHub CLI login is needed only for GitHub delivery.",
);
if (flags.includes("--no-launch"))
  console.log("Run this script again without --no-launch to open the desktop.");
else pnpm(["desktop:start"]);
