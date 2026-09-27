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

describe("each model's name and effort levels, as its provider reports them", () => {
  it("names a Claude model by the version its description leads with, and keeps the levels Claude Code takes", async () => {
    const test =
      fixture(`reply({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: { models: [
      { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable', supportedEffortLevels: ['max', 'low', 'turbo'] },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' }
    ] } } });`);
    const result = await discoverModels("claude-cli", test.options);
    expect(result.models).toEqual([
      { id: "claude-opus-5[1m]", label: "Opus 5 with 1M context", description: "Best for everyday, complex tasks", isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
      // In the table's order, and a level no table names is left out.
      { id: "claude-fable-5-1", label: "Fable 5.1", description: "Most capable", isDefault: false, efforts: ["low", "max"] },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "Fastest for quick answers", isDefault: false, efforts: [] },
    ]);
  });

  it("keeps a Claude model's display name when its description does not lead with a version", async () => {
    const test =
      fixture(`reply({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: { models: [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Recommended · Balanced for everyday tasks' },
      { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: 'opus 5 · Deepest reasoning' }
    ] } } });`);
    const result = await discoverModels("claude-cli", test.options);
    expect(result.models.map((model) => [model.label, model.description])).toEqual([
      ["Sonnet", "Recommended · Balanced for everyday tasks"],
      ["Opus", "opus 5 · Deepest reasoning"],
    ]);
  });

  it("keeps the reasoning efforts Codex reports for each model", async () => {
    const test = fixture(`if (message.id === 1) reply({ id: 1, result: {} });
      else if (message.method === 'model/list') reply({ id: message.id, result: { data: [
        { model: 'codex-a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 'minimal' }] },
        { model: 'codex-b', displayName: 'B' }
      ], nextCursor: null } });`);
    const result = await discoverModels("codex-cli", test.options);
    expect(result.models.map((model) => [model.id, model.efforts])).toEqual([
      ["codex-a", ["low", "ultra"]],
      ["codex-b", []],
    ]);
  });
});

describe("OpenCode's catalog (D-134)", () => {
  /**
   * A stand-in for `opencode serve --stdio --port 0`: it names its loopback
   * server on its first line, answers only a request carrying the password it
   * was given, and reports what OpenCode 2.0.14 was measured to report — a
   * Zen catalogue with free and priced models, a provider nothing connects,
   * and the Zen integration connected where OPENCODE_API_KEY is set. Its
   * first two model lists are read before its providers have settled, as
   * OpenCode says one may be, each longer than the last. Every request and
   * its environment go to `trace`.
   */
  function fakeServe(
    options: {
      models?: unknown[];
      providers?: unknown[];
      /** The address the server names in place of its own loopback one. */
      names?: string;
      /** Exit once the integration list has been answered, as a server that dies mid-read does. */
      exitAfterIntegrations?: boolean;
      /** Never answer the model list, as a server that hangs does. */
      hangOnModels?: boolean;
      /** Send the model list's headers and never its body, as a server that stalls mid-answer does. */
      stallModelsBody?: boolean;
      /** Ignore SIGTERM and its stdin closing, as a server that will not stop does. */
      stubborn?: boolean;
    } = {},
  ) {
    const root = scratchDirectory();
    const binary = join(root, "opencode");
    const trace = join(root, "trace.jsonl");
    const zen = (id: string, input: number) => ({ id, providerID: "opencode", name: id, cost: [{ input, output: input * 5, cache: { read: 0, write: 0 } }] });
    const models = options.models ?? [
      zen("big-pickle", 0),
      // Free to send, priced to read: not free.
      { id: "half-free", providerID: "opencode", name: "half-free", cost: [{ input: 0, output: 2 }] },
      zen("claude-opus-5", 5),
      { id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5", cost: [{ input: 3, output: 15 }] },
      // No price reported: never counted free, and no parse failure of the list.
      { id: "unpriced", providerID: "anthropic", name: "Unpriced", cost: null },
      { id: "kimi-k3", providerID: "moonshot", name: "Kimi K3", cost: [{ input: 1, output: 4 }] },
      { id: "kimi-unpriced", providerID: "moonshot", name: "Kimi unpriced" },
      // A shape this reader does not know: left out, not a failure of the list.
      { id: 42, providerID: "moonshot" },
    ];
    const providers = options.providers ?? [
      { id: "opencode", integrationID: "opencode" },
      { id: "anthropic" },
      { id: "moonshot", integrationID: "moonshot-cn" },
    ];
    writeFileSync(
      binary,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
const trace = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + '\\n');
if (${JSON.stringify(options.stubborn === true)}) process.on('SIGTERM', () => undefined);
trace({ pid: process.pid, args: process.argv.slice(2), key: process.env.OPENCODE_API_KEY ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null, project: process.env.OPENCODE_DISABLE_PROJECT_CONFIG });
const models = ${JSON.stringify(models)};
const providers = ${JSON.stringify(providers)};
const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
let reads = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://x');
  trace({ path: url.pathname, directory: url.searchParams.get('directory'), authorized: request.headers.authorization === expected });
  if (request.headers.authorization !== expected) { response.writeHead(401).end(); return; }
  const send = (data) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ location: {}, data })); };
  if (url.pathname === '/api/integration') { if (${JSON.stringify(options.exitAfterIntegrations === true)}) setTimeout(() => process.exit(0), 50); return send([
    { id: 'opencode', connections: process.env.OPENCODE_API_KEY ? [{ type: 'env', name: 'OPENCODE_API_KEY' }] : [] },
    { id: 'anthropic', connections: [] },
    { id: 'moonshot-cn', connections: [{ type: 'key' }] },
  ]); }
  if (url.pathname === '/api/model' && ${JSON.stringify(options.hangOnModels === true)}) return;
  if (url.pathname === '/api/model' && ${JSON.stringify(options.stallModelsBody === true)}) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"location":{},'); return; }
  if (url.pathname === '/api/model') { reads += 1; return send(reads === 1 ? models.slice(0, 1) : reads === 2 ? models.slice(0, 2) : models); }
  if (url.pathname === '/api/provider') return send(providers);
  if (url.pathname === '/api/model/default') return send({ id: 'big-pickle', providerID: 'opencode' });
  response.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ url: ${JSON.stringify(options.names ?? null)} ?? 'http://127.0.0.1:' + server.address().port }) + '\\n'));
// Gone when the test's end of stdin closes, however the test ended; a
// server that ignores that is gone after 10 s all the same.
if (!${JSON.stringify(options.stubborn === true)}) process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 10_000).unref();
process.stdin.resume();
`,
      { mode: 0o755 },
    );
    const read = () =>
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    return {
      discover: (env: NodeJS.ProcessEnv, timeoutMs = 10_000) =>
        discoverModels("opencode-cli", {
          binaries: { claude: "absent", codex: "absent", opencode: binary },
          env: { HOME: homedir(), PATH: [dirname(process.execPath), process.env.PATH].join(delimiter), ...env },
          timeoutMs,
        }),
      read,
    };
  }

  it("lists OpenCode's free models and a connected provider's, and not an unconnected provider's or a priced Zen model without a key", async () => {
    const serve = fakeServe();
    const catalog = await serve.discover({ ANTHROPIC_API_KEY: "sk-ant-not-passed" });
    expect(catalog).toMatchObject({ provider: "opencode-cli", source: "opencode" });
    expect(catalog.models.map((model) => [model.id, model.isDefault])).toEqual([
      ["opencode/big-pickle", true],
      ["moonshot/kimi-k3", false],
      ["moonshot/kimi-unpriced", false],
    ]);
    const trace = serve.read();
    expect(trace[0]).toMatchObject({ args: ["serve", "--stdio", "--port", "0"], key: null, anthropic: null, project: "1" });
    // Every request carried the password, and only reads were made.
    expect(trace.slice(1).every((entry) => entry["authorized"] === true)).toBe(true);
    expect(new Set(trace.slice(1).map((entry) => entry["path"]))).toEqual(
      new Set(["/api/integration", "/api/model", "/api/provider", "/api/model/default"]),
    );
  });

  it("lists the priced Zen models where OPENCODE_API_KEY is set, since OpenCode then reports Zen connected", async () => {
    const catalog = await fakeServe().discover({ OPENCODE_API_KEY: "zen-key" });
    expect(catalog.models.map((model) => model.id)).toEqual([
      "opencode/big-pickle",
      "opencode/half-free",
      "opencode/claude-opus-5",
      "moonshot/kimi-k3",
      "moonshot/kimi-unpriced",
    ]);
  });

  it("settles an empty list at once into the one sentence, rather than waiting out the timeout", async () => {
    const started = Date.now();
    await expect(fakeServe({ models: [], providers: [] }).discover({})).rejects.toThrow("OpenCode reports no model you can run now");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("sends the password to no address but the loopback one", async () => {
    const serve = fakeServe({ names: "http://models.example.test:4096" });
    await expect(serve.discover({})).rejects.toThrow("OpenCode named a server that is not on this machine.");
    // Nothing was asked of the server, the named address or the loopback one.
    expect(serve.read().filter((entry) => "path" in entry)).toEqual([]);
  });

  it("says in one sentence that OpenCode did not answer in time, rather than the fetch's own words", async () => {
    await expect(fakeServe({ hangOnModels: true }).discover({}, 4_000)).rejects.toThrow(
      /^OpenCode did not report its models in time\. Refresh to ask again\.$/,
    );
  });

  it("says the same sentence where the model list's body stalls after its headers", async () => {
    await expect(fakeServe({ stallModelsBody: true }).discover({}, 4_000)).rejects.toThrow(
      /^OpenCode did not report its models in time\. Refresh to ask again\.$/,
    );
  });

  it("kills a server that will not stop on SIGTERM", async () => {
    const serve = fakeServe({ stubborn: true });
    await serve.discover({});
    const pid = serve.read()[0]!["pid"] as number;
    const gone = () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    await vi.waitFor(() => expect(gone()).toBe(true), { timeout: 5_000, interval: 100 });
  });

  it("says in one sentence that OpenCode stopped where its server goes mid-read", async () => {
    await expect(fakeServe({ exitAfterIntegrations: true }).discover({})).rejects.toThrow(
      /^OpenCode stopped before it reported its models\. Update it and refresh\.$/,
    );
  });

  it("says in one sentence that nothing can run where OpenCode reports no free model and no connection", async () => {
    const serve = fakeServe({
      models: [{ id: "claude-opus-5", providerID: "opencode", name: "Claude Opus 5", cost: [{ input: 5, output: 25 }] }],
      providers: [{ id: "opencode", integrationID: "opencode" }],
    });
    await expect(serve.discover({})).rejects.toThrow(
      "OpenCode reports no model you can run now — none of its free models is listed and no provider is connected; " +
        "set OPENCODE_API_KEY in the app environment for OpenCode Zen and refresh.",
    );
  });
});
