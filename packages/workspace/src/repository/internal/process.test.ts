import { describe, expect, it } from "vitest";
import { answered, nodeProcess, type ProcessOptions } from "./process.js";

/**
 * The adapter is exercised with `node -e` rather than git: what is under test
 * is how a process that hangs, floods or is not installed reaches the module,
 * and none of that is git's behaviour.
 */
const node = (script: string): string[] => [process.execPath, "-e", script];

const options = (overrides: Partial<ProcessOptions> = {}): ProcessOptions => ({
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "" },
  timeoutMs: 10_000,
  maxOutputBytes: 512 * 1024,
  ...overrides,
});

describe("the node adapter", () => {
  it("reports a command that outran its timeout as one, rather than as an exit code", () => {
    const result = nodeProcess.runSync(node("setTimeout(() => {}, 10_000)"), options({ timeoutMs: 300 }));
    expect(result.timed_out).toBe(true);
    expect(result.code).toBe(null);
  });

  it("says the output passed the buffer, synchronously", () => {
    const result = nodeProcess.runSync(node('process.stdout.write("x".repeat(4096))'), options({ maxOutputBytes: 64 }));
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(4096);
  });

  it("says the same asynchronously", async () => {
    const result = await nodeProcess.run(node('process.stdout.write("x".repeat(4096))'), options({ maxOutputBytes: 64 }));
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(4096);
  });

  it("leaves a whole answer unflagged", async () => {
    const asynchronous = await nodeProcess.run(node('process.stdout.write("hi")'), options());
    const synchronous = nodeProcess.runSync(node('process.stdout.write("hi")'), options());
    expect([asynchronous.stdout, asynchronous.truncated, asynchronous.code]).toEqual(["hi", false, 0]);
    expect([synchronous.stdout, synchronous.truncated, synchronous.code]).toEqual(["hi", false, 0]);
  });

  it("rethrows a binary that is not installed, on both paths", async () => {
    const missing = ["perbo-no-such-binary-0f3a"];
    let thrown: NodeJS.ErrnoException | null = null;
    try {
      nodeProcess.runSync(missing, options());
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    }
    expect(thrown?.code).toBe("ENOENT");
    expect(thrown?.syscall?.startsWith("spawn")).toBe(true);
    await expect(nodeProcess.run(missing, options())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("a named question's answer", () => {
  it("refuses a fragment, whether it was cut by the clock or by the buffer", () => {
    const timedOut = nodeProcess.runSync(node("setTimeout(() => {}, 10_000)"), options({ timeoutMs: 300 }));
    const cut = nodeProcess.runSync(node('process.stdout.write("x".repeat(4096))'), options({ maxOutputBytes: 64 }));
    expect(() => answered(timedOut)).toThrowError(/timed out/);
    expect(() => answered(cut)).toThrowError(/truncated/);
  });

  it("passes a whole answer through", () => {
    const result = nodeProcess.runSync(node('process.stdout.write("hi")'), options());
    expect(answered(result)).toBe(result);
  });
});
