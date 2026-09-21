import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { preparePreToolGuard } from "./pretool.js";
import { buildPermissionProfile } from "./profile.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The hook command when the runner runs on Electron's Node, as it does under
 * the desktop. `process.execPath` is then the app, which runs as Node only while
 * `ELECTRON_RUN_AS_NODE` is set, and the hook inherits the executor's
 * environment, which does not carry it. The program here prints what the hook
 * process sees, in place of the guard.
 */

const PRINT = "process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE))";

function hookCommand(electron: boolean): string {
  const worktree = scratch("perbo-electron-hook-");
  const guard = preparePreToolGuard({
    worktree,
    tmpdir: null,
    profile: buildPermissionProfile({ worktree }),
    electron,
    hookProgram: [process.execPath, "-e", PRINT],
  });
  const settings = JSON.parse(readFileSync(guard.settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
  };
  return settings.hooks.PreToolUse[0]!.hooks[0]!.command;
}

/** Run a hook command the way the executor does: in a shell, without the variable. */
function runHook(command: string): string {
  return execFileSync("/bin/sh", ["-c", command], { env: { PATH: process.env.PATH ?? "" } }).toString();
}

describe("the guard hook's command", () => {
  it("sets ELECTRON_RUN_AS_NODE for the hook where the runner runs on Electron's Node", () => {
    expect(runHook(hookCommand(true))).toBe("1");
  });

  it("sets nothing where the runner runs on Node", () => {
    expect(runHook(hookCommand(false))).toBe("undefined");
  });
});
