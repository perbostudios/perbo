import { describe, expect, it } from "vitest";
import { desktopGitProcess } from "./git-process.js";
import type { Execute } from "./git.js";
import type { ProcessResult } from "../process.js";

const answering = (result: ProcessResult): { execute: Execute; calls: Parameters<Execute>[] } => {
  const calls: Parameters<Execute>[] = [];
  const execute: Execute = (binary, args, options) => {
    calls.push([binary, args, options]);
    return Promise.resolve(result);
  };
  return { execute, calls };
};

describe("git through the host's own runner", () => {
  it("starts the argv's binary with the rest as its arguments, under the call's ceilings", async () => {
    const { execute, calls } = answering({ code: 0, stdout: "abc\n", stderr: "", cancelled: false });
    const result = await desktopGitProcess(execute).run(["git", "rev-parse", "HEAD"], {
      cwd: "/checkout",
      env: { PATH: "/usr/bin" },
      timeoutMs: 1234,
      maxOutputBytes: 4096,
    });
    expect(calls[0]?.[0]).toBe("git");
    expect(calls[0]?.[1]).toEqual(["rev-parse", "HEAD"]);
    expect(calls[0]?.[2]).toEqual({
      cwd: "/checkout",
      env: { PATH: "/usr/bin" },
      timeoutMs: 1234,
      maxBytes: 4096,
    });
    expect(result).toMatchObject({
      argv: ["git", "rev-parse", "HEAD"],
      code: 0,
      stdout: "abc\n",
      stderr: "",
      signal: null,
      timed_out: false,
      truncated: false,
    });
  });

  it("reports a stopped read as one that ran out of time", async () => {
    const { execute } = answering({ code: 130, stdout: "", stderr: "", cancelled: true });
    const result = await desktopGitProcess(execute).run(["git", "status"], {
      cwd: "/checkout",
      env: {},
      timeoutMs: 10,
      maxOutputBytes: 4096,
    });
    expect(result.timed_out).toBe(true);
  });

  it("carries the runner's refusal of an oversized read rather than reporting a cut answer", async () => {
    const execute: Execute = () => Promise.reject(new Error("Command output exceeded the local capture limit."));
    await expect(
      desktopGitProcess(execute).run(["git", "ls-files"], {
        cwd: "/checkout",
        env: {},
        timeoutMs: 10,
        maxOutputBytes: 1,
      }),
    ).rejects.toThrow("exceeded the local capture limit");
  });

  it("refuses a synchronous read, which this host has no runner for", () => {
    const { execute } = answering({ code: 0, stdout: "", stderr: "", cancelled: false });
    expect(() =>
      desktopGitProcess(execute).runSync(["git", "rev-parse", "HEAD"], {
        cwd: "/checkout",
        env: {},
        timeoutMs: 10,
        maxOutputBytes: 10,
      }),
    ).toThrow("reads git asynchronously");
  });
});
