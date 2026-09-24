import { spawn, spawnSync } from "node:child_process";
import { layout, packaged } from "./package-layout.mjs";

/**
 * Open the app `pnpm desktop:package` wrote, which the Dock and Finder name
 * Perbo, where `electron .` runs Electron's own bundle. macOS opens the bundle
 * through LaunchServices; elsewhere the binary is started and left running.
 *
 *   node apps/desktop/scripts/launch.mjs [path/to/App.app | unpacked dir]
 */
const app = packaged(process.argv[2]);
if (process.platform === "darwin") {
  const opened = spawnSync("open", [app], { stdio: "inherit" });
  process.exitCode = opened.status ?? 1;
} else spawn(layout(app).binary, [], { detached: true, stdio: "ignore" }).unref();
