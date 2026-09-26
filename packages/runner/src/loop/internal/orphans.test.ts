import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { sweepWorktree } from "./orphans.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The progress line names each process it ended by its whole command line
 * (D-NEW-nothing-shown-is-cut): what the machine was running is tool output a
 * person reads to know what was stopped.
 */
describe("the processes a sweep ended", () => {
  it("are named by their whole command line", async () => {
    const worktree = scratch("perbo-orphan-whole-");
    const words = Array.from({ length: 12 }, (_, n) => `an-argument-the-process-was-started-with-${n}`);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", ...words], {
      cwd: worktree,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    const printed: string[] = [];
    try {
      await new Promise((settle) => setTimeout(settle, 300));
      const ended = await sweepWorktree({ worktree, onProgress: (line) => printed.push(line), escalateAfterMs: 500 });
      const line = printed.find((each) => each.includes("still running under the worktree"));
      expect(ended.map((entry) => entry.pid)).toContain(child.pid);
      expect(ended.find((entry) => entry.pid === child.pid)!.command.length).toBeGreaterThan(120);
      expect(line).toContain(words.at(-1));
    } finally {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        // Already ended, which is what the sweep was for.
      }
    }
  }, 30_000);
});
