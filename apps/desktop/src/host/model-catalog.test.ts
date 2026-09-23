import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { discoverModels } from "./model-catalog.js";
import { RequestSchema } from "../shared/protocol.js";

const scratchDirectory = createScratch("perbo-catalog-test-");
afterEach(() => {
  scratchDirectory.removeAll();
});
function fixture(handler: string) {
  const root = scratchDirectory();
  const binary = join(root, "provider cli");
  const trace = join(root, "trace.jsonl");
  const login = join(root, "login");
  mkdirSync(login);
  writeFileSync(join(login, "auth.json"), "{}");
  writeFileSync(join(login, "config.toml"), "# must not be loaded");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const trace = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + '\\n');
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
trace({ cwd: process.cwd(), args: process.argv.slice(2), pid: process.pid, leaked: Boolean(process.env.EXTRA_SECRET || process.env.NODE_OPTIONS), privateHome: process.env.CODEX_HOME, userConfig: Boolean(process.env.CODEX_HOME && existsSync(process.env.CODEX_HOME + '/config.toml')) });
const input = createInterface({ input: process.stdin });
input.on('line', (line) => { const message = JSON.parse(line); trace(message); ${handler} });
`,
    { mode: 0o755 },
  );
  return {
    root,
    tracePath: trace,
    trace: () =>
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    options: {
      binaries: { claude: binary, codex: binary },
      env: {
        HOME: homedir(),
        PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
        CODEX_HOME: login,
        EXTRA_SECRET: "must-not-reach-cli",
        NODE_OPTIONS: "--trace-warnings",
      },
      timeoutMs: 3000,
    },
  };
}
describe("model catalogs without inference", () => {
  it("initializes Claude once, resolves aliases, removes duplicates and isolates configuration", async () => {
    const test =
      fixture(`reply({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: { models: [
      { value: 'default', resolvedModel: 'claude-example', displayName: 'Recommended', description: 'Reasoning' },
      { value: 'opus', resolvedModel: 'claude-example', displayName: 'Duplicate' },
      { value: 'sonnet', resolvedModel: 'claude-other', displayName: 'Éclair' }
    ] } } });`);
    const result = await discoverModels("claude-cli", test.options);
    expect(result.models.map((model) => model.id)).toEqual([
      "claude-example",
      "claude-other",
    ]);
    // The `default` alias points at the named model; the model keeps its own name and the default mark.
    expect(result.models[0]).toMatchObject({ label: "Duplicate", isDefault: true });
    expect(result.models[1]?.label).toBe("Éclair");
    const trace = test.trace();
    expect(trace).toHaveLength(2);
    expect(trace[0]?.leaked).toBe(false);
    expect(trace[0]?.args).toEqual(
      expect.arrayContaining([
        "--safe-mode",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--strict-mcp-config",
      ]),
    );
    expect(trace[1]?.request).toEqual({
      subtype: "initialize",
      hooks: {},
      agents: {},
      skills: [],
    });
    expect(existsSync(String(trace[0]?.cwd))).toBe(false);
  });
  it("paginates Codex, excludes hidden models and never opens a thread or loads user config", async () => {
    const test = fixture(`if (message.id === 1) reply({ id: 1, result: {} });
      else if (message.method === 'model/list') reply({ id: message.id, result: { data: message.params.cursor ? [
        { model: 'codex-b', displayName: 'B' }, { model: 'codex-a', displayName: 'Duplicate' }
      ] : [ { model: 'codex-a', displayName: 'A', isDefault: true }, { model: 'hidden', displayName: 'Hidden', hidden: true } ], nextCursor: message.params.cursor ? null : 'next' } });`);
    const result = await discoverModels("codex-cli", test.options);
    expect(result.models.map((model) => model.id)).toEqual([
      "codex-a",
      "codex-b",
    ]);
    const trace = test.trace();
    expect(trace.slice(1).map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "model/list",
    ]);
    expect(trace[0]?.userConfig).toBe(false);
    expect(trace[0]?.leaked).toBe(false);
    expect(existsSync(String(trace[0]?.privateHome))).toBe(false);
  });
  it.each([
    [
      "malformed data",
      "reply({ type: 'control_response', response: { request_id: 'catalog', subtype: 'success', response: { models: [{ value: 'x' }] } } });",
      /compatible model catalog/,
    ],
    ["early exit", "process.exit(1);", /exited before/],
    [
      "excessive output",
      "process.stdout.write('x'.repeat(2000001));",
      /output limit/,
    ],
  ])(
    "rejects %s without a guessed fallback",
    async (_name, handler, expected) => {
      const test = fixture(handler as string);
      await expect(discoverModels("claude-cli", test.options)).rejects.toThrow(
        expected as RegExp,
      );
      expect(existsSync(String(test.trace()[0]?.cwd))).toBe(false);
    },
  );
  it("times out and reaps a CLI that ignores graceful termination", async () => {
    const test = fixture(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); trace({ ready: true });",
    );
    // The process and filesystem handshake use real IO. Its startup cannot
    // consume either the discovery deadline or the graceful-stop interval.
    const watcher = watch(test.root, { signal: AbortSignal.timeout(10_000) });
    const ready = new Promise<void>((resolve, reject) => {
      watcher.on("change", () => {
        try {
          if (
            existsSync(test.tracePath) &&
            // A file-create notification can precede the first complete write.
            readFileSync(test.tracePath, "utf8").includes('{"ready":true}\n')
          ) resolve();
        } catch (error) {
          reject(error);
        }
      });
      watcher.once("error", reject);
      watcher.once("close", () => reject(new Error("Fixture CLI did not become ready")));
    });
    let childPid: number | undefined;
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const discovery = discoverModels("claude-cli", { ...test.options, timeoutMs: 500 });
    const timedOut = expect(discovery).rejects.toThrow("timed out");
    // Readiness can fail before the assertion is awaited below.
    void timedOut.catch(() => undefined);
    try {
      await ready;
      watcher.close();
      const started = test.trace()[0]!;
      const pid = Number(started.pid);
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      childPid = pid;

      await vi.advanceTimersByTimeAsync(499);
      expect(kill).not.toHaveBeenCalledWith(-pid, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1);
      expect(kill).toHaveBeenCalledWith(-pid, "SIGTERM");
      expect(() => process.kill(pid, 0)).not.toThrow();
      await vi.advanceTimersByTimeAsync(999);
      expect(kill).not.toHaveBeenCalledWith(-pid, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1);
      expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
      await timedOut;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(String(started.cwd))).toBe(false);
    } finally {
      watcher.close();
      try {
        // A failed readiness check may still have a complete startup record.
        if (childPid === undefined && existsSync(test.tracePath)) {
          const trace = readFileSync(test.tracePath, "utf8");
          const newline = trace.indexOf("\n");
          if (newline !== -1) {
            const started = JSON.parse(trace.slice(0, newline)) as Record<string, unknown>;
            const pid = Number(started.pid);
            if (Number.isSafeInteger(pid) && pid > 0) childPid = pid;
          }
        }
        // Cleanup must also work when the escalation under test is broken.
        if (childPid !== undefined) {
          try {
            realKill(process.platform === "win32" ? childPid : -childPid, "SIGKILL");
          } catch (error) {
            expect(error).toMatchObject({ code: "ESRCH" });
          }
        }
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([discovery, timedOut]),
          new Promise<never>((_resolve, reject) => {
            cleanupTimer = setTimeout(
              () => reject(new Error("Fixture CLI did not settle after cleanup")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
  }, 15_000);
  it("rejects an unavailable executable", async () => {
    const test = fixture("");
    await expect(
      discoverModels("claude-cli", {
        ...test.options,
        binaries: { claude: join(test.root, "absent"), codex: "absent" },
      }),
    ).rejects.toThrow("CLI unavailable");
  });
  it("discovers optional API models with fixed URLs and follows pagination", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "claude-api-a", display_name: "API A" }],
            has_more: true,
            last_id: "claude-api-a",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "claude-api-b", display_name: "API B" }],
            has_more: false,
            last_id: "claude-api-b",
          }),
        ),
      );
    const result = await discoverModels("anthropic", {
      env: { ANTHROPIC_API_KEY: "test-key" },
      fetch: fetcher,
    });
    expect(result.models.map((model) => model.id)).toEqual([
      "claude-api-a",
      "claude-api-b",
    ]);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "https://api.anthropic.com/v1/models?limit=100&after_id=claude-api-a",
    );
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(JSON.stringify(result)).not.toContain("test-key");
  });
  it("rejects provider names and process parameters outside the closed IPC contract", () => {
    expect(
      RequestSchema.safeParse({
        kind: "models",
        provider: "custom",
        binary: "anything",
      }).success,
    ).toBe(false);
    expect(
      RequestSchema.safeParse({
        kind: "models",
        provider: "codex-cli",
        cwd: "/anything",
      }).success,
    ).toBe(false);
  });
});
