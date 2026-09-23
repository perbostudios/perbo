import { describe, expect, it } from "vitest";
import { run } from "./exec.js";

/**
 * A child that exits while a grandchild holds its pipes must still settle.
 *
 * `child.on("close")` fires when the process has exited **and** every stdio
 * pipe is closed. A grandchild that inherited stdout keeps the pipe open, so a
 * command that has already exited leaves the promise pending — and the timeout
 * cannot rescue it, because killing the child does not touch the grandchild
 * still holding the pipe.
 *
 * This is the defect dogfooding found in the agent adapter, in the function
 * every other spawn in the repository goes through. It cost a 53-minute hang
 * on a corpus measurement before it was looked for here.
 */
describe("run", () => {
  it("returns when the command exits, even if a grandchild holds the pipes", async () => {
    const started = Date.now();
    // The shell exits at once; `sleep` inherits stdout and holds it for 30s.
    const result = await run(["/bin/sh", "-c", "sleep 30 & exit 0"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 60_000,
    });
    const elapsed = Date.now() - started;

    expect(result.code).toBe(0);
    expect(result.timed_out).toBe(false);
    // Generous: the point is that it does not wait for the grandchild.
    expect(elapsed, `run took ${elapsed}ms; the grandchild holds the pipe for 30s`).toBeLessThan(10_000);
  }, 45_000);

  it("kills the whole process group on timeout, not just the child", async () => {
    const result = await run(["/bin/sh", "-c", "sleep 30 & wait"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 1_000,
    });
    expect(result.timed_out).toBe(true);
    expect(result.duration_ms).toBeLessThan(15_000);
  }, 45_000);
});
