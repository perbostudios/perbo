import { describe, expect, it } from "vitest";
import { createCli } from "./cli.js";
import type { LineProcess, ProcessOptions, ProcessResult } from "./process.js";
import type { RegisteredRepository } from "./profile/store.js";

const repo: RegisteredRepository = {
  id: "80000000-0000-4000-8000-000000000001",
  name: "repository with spaces",
  path: "/checkout/repository with spaces",
};
const result: ProcessResult = { code: 0, stdout: "{}", stderr: "", cancelled: false };
/** Records what the CLI was asked to run, without running anything. */
function recorder() {
  const runs: { binary: string; args: readonly string[]; options: ProcessOptions }[] = [];
  const spawns: { binary: string; args: readonly string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }[] = [];
  return {
    runs,
    spawns,
    execute: (binary: string, args: readonly string[], options: ProcessOptions) => {
      runs.push({ binary, args, options });
      return Promise.resolve(result);
    },
    spawn: (
      binary: string,
      args: readonly string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      spawns.push({ binary, args, options });
      return { write: () => true, stop: () => undefined } as unknown as LineProcess;
    },
  };
}
const cli = (over: { electronNode?: boolean } = {}) => {
  const recorded = recorder();
  return {
    ...recorded,
    cli: createCli({
      nodeBinary: "/usr/bin/node",
      cliPath: "/app/cli/perbo.js",
      execute: recorded.execute as never,
      spawn: recorded.spawn as never,
      ...over,
    }),
  };
};

describe("running the bundled CLI", () => {
  it("names the repository on the command line and as the working directory", async () => {
    const w = cli();
    await w.cli.run(["list", "--all", "--json"], repo);
    expect(w.runs[0]?.binary).toBe("/usr/bin/node");
    expect(w.runs[0]?.args).toEqual([
      "/app/cli/perbo.js",
      "list",
      "--all",
      "--json",
      "--repo",
      "/checkout/repository with spaces",
    ]);
    expect(w.runs[0]?.options.cwd).toBe("/checkout/repository with spaces");
  });

  it("keeps the caller's own process options, and answers with the result", async () => {
    const w = cli();
    const signal = new AbortController().signal;
    await expect(w.cli.run(["run"], repo, { signal, timeoutMs: 1000 })).resolves.toBe(result);
    expect(w.runs[0]?.options).toMatchObject({ signal, timeoutMs: 1000 });
  });

  it("tells Electron's binary to run as Node only where it is one", async () => {
    const plain = cli();
    await plain.cli.run(["list"], repo);
    expect(plain.runs[0]?.options.env?.["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
    const electron = cli({ electronNode: true });
    await electron.cli.run(["list"], repo);
    expect(electron.runs[0]?.options.env?.["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });

  it("gives the child a PATH, rather than whatever the app was launched with", async () => {
    const w = cli();
    await w.cli.run(["list"], repo);
    expect(w.runs[0]?.options.env?.["PATH"]).toBeTruthy();
  });

  it("spawns the long-lived command the same way", () => {
    const w = cli({ electronNode: true });
    w.cli.spawn(["interview", "--spec", "specs/a"], repo, {
      onLine: () => undefined,
      onClose: () => undefined,
    });
    expect(w.spawns[0]?.args).toEqual([
      "/app/cli/perbo.js",
      "interview",
      "--spec",
      "specs/a",
      "--repo",
      "/checkout/repository with spaces",
    ]);
    expect(w.spawns[0]?.options.cwd).toBe("/checkout/repository with spaces");
    expect(w.spawns[0]?.options.env?.["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });
});
