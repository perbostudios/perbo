import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CLAUDE_METADATA_ARGS } from "./model-catalog.js";
import { CLAUDE_USAGE_UNSUPPORTED, claudeUsage, codexUsage } from "./usage-probe.js";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
/** A fake provider CLI that traces its argv, environment and every line it reads, and answers with `handler`. */
function fixture(handler: string, { login = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "perbo-usage-test-"));
  temporary.push(root);
  const binary = join(root, "provider cli");
  const trace = join(root, "trace.jsonl");
  const home = join(root, "login");
  mkdirSync(home);
  if (login) writeFileSync(join(home, "auth.json"), "{}");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const trace = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + '\\n');
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
trace({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), apiKey: Boolean(process.env.ANTHROPIC_API_KEY), leaked: Boolean(process.env.EXTRA_SECRET) });
const input = createInterface({ input: process.stdin });
input.on('line', (line) => { const message = JSON.parse(line); trace(message); ${handler} });
`,
    { mode: 0o755 },
  );
  return {
    started: () => existsSync(trace),
    trace: () =>
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    options: {
      binary,
      env: {
        HOME: homedir(),
        PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
        CODEX_HOME: home,
        ANTHROPIC_API_KEY: "must-not-reach-cli",
        EXTRA_SECRET: "must-not-reach-cli",
      },
      timeoutMs: 3000,
    },
  };
}
/** Answers `initialize`, then `get_usage` with `usage` as the reply body (the shape Claude Code answers with). */
const claude = (usage: string, subtype = "success") => `
  if (message.request?.subtype === 'initialize') reply({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: [] } } });
  else if (message.request?.subtype === 'get_usage') reply({ type: 'control_response', response: { subtype: '${subtype}', request_id: message.request_id, ${subtype === "success" ? `response: ${usage}` : "error: 'Unsupported control request subtype: get_usage'"} } });`;
const reply = `{
  session: { total_cost_usd: 0, total_api_duration_ms: 0, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 9, resets_at: '2026-09-23T19:00:00.085490+00:00', limit_dollars: null },
    seven_day: { utilization: 37, resets_at: '2026-09-26T04:00:00.085513+00:00' },
    seven_day_opus: null,
    nimbus_quill: { utilization: 0, resets_at: null },
    model_scoped: [
      { display_name: 'Fable', utilization: 36, resets_at: '2026-09-26T04:00:00.085695+00:00' },
      { display_name: 'Unreported', utilization: null, resets_at: null },
    ],
  },
  behaviors: null,
}`;

describe("Claude Code's plan windows from get_usage", () => {
  it("names the windows as Claude's /usage does, leaves out one with no utilization, and never writes a user message", async () => {
    const test = fixture(claude(reply));
    await expect(claudeUsage(test.options)).resolves.toEqual({
      plan: "Max",
      windows: [
        { label: "5-hour limit", usedPercent: 9, resetsAt: "2026-09-23T19:00:00.085Z" },
        { label: "Weekly · all models", usedPercent: 37, resetsAt: "2026-09-26T04:00:00.085Z" },
        { label: "Weekly · Fable", usedPercent: 36, resetsAt: "2026-09-26T04:00:00.085Z" },
      ],
      detail: "Read from Claude Code.",
    });
    const [spawned, ...messages] = test.trace();
    expect(spawned?.args).toEqual([...CLAUDE_METADATA_ARGS]);
    expect(spawned?.apiKey).toBe(false);
    expect(spawned?.leaked).toBe(false);
    expect(existsSync(String(spawned?.cwd))).toBe(false);
    expect(messages.map((message) => (message.request as { subtype?: string } | undefined)?.subtype)).toEqual(["initialize", "get_usage"]);
    expect(messages[1]?.request).toEqual({ subtype: "get_usage", skip_behaviors: true });
    // A user message is what starts an inference turn; the probe writes none.
    expect(messages.every((message) => message.type === "control_request")).toBe(true);
    expect(messages.some((message) => message.type === "user")).toBe(false);
  });

  it.each([
    [
      "a login with no plan limits",
      claude("{ subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null }"),
      { plan: null, windows: null, detail: "Claude Code is signed in with an API key or a provider that has no plan limits." },
    ],
    ["a CLI that refuses get_usage", claude("", "error"), { plan: null, windows: null, detail: CLAUDE_USAGE_UNSUPPORTED }],
    [
      "a CLI whose initialize fails",
      "reply({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'not signed in' } });",
      { plan: null, windows: null, detail: "Claude Code did not report its limits. Check your connection and refresh." },
    ],
    [
      "a reply this desktop does not read",
      claude("{ rate_limits: 'unknown' }"),
      { plan: null, windows: null, detail: "Claude Code answered in a shape this desktop does not read." },
    ],
  ])("says so, with no window, for %s", async (_name, handler, expected) => {
    const test = fixture(handler);
    await expect(claudeUsage(test.options)).resolves.toEqual(expected);
  });

  it("says so, with no window, for a CLI that never answers, and logs why", async () => {
    const test = fixture("");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(claudeUsage({ ...test.options, timeoutMs: 800 })).resolves.toEqual({
      plan: null,
      windows: null,
      detail: "Claude Code did not report its limits. Check your connection and refresh.",
    });
    expect(warned.mock.calls).toEqual([
      ["The Claude Code usage probe failed: Model discovery timed out. Check your connection and refresh."],
    ]);
  });

  it("settles at the timeout and leaves no child behind when the CLI never exits", async () => {
    const test = fixture("setInterval(() => {}, 60_000);");
    const started = Date.now();
    // Held open past stdin's end, so only the probe's kill ends it. The fixture's
    // timeout is long enough for the child to boot on a loaded machine, so its
    // trace names the pid whose death is checked.
    const pending = claudeUsage(test.options);
    await expect(pending).resolves.toMatchObject({ windows: null });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(4500);
    const pid = Number(test.trace()[0]?.pid);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
});

describe("Codex's plan windows from the app-server", () => {
  const codex = (limits: string) => `
    if (message.method === 'initialize') reply({ id: message.id, result: {} });
    else if (message.method === 'account/read') reply({ id: message.id, result: { account: { type: 'chatgpt', planType: 'pro' } } });
    else if (message.method === 'account/rateLimits/read') reply({ id: message.id, ${limits} });`;

  it("reads the account, then the limits, and labels the windows the way Claude's are labelled", async () => {
    const test = fixture(
      codex(`result: { rateLimits: {
        primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1790190000 },
        secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1790395200 } } }`),
    );
    await expect(codexUsage(test.options)).resolves.toEqual({
      plan: "Pro",
      windows: [
        { label: "5-hour limit", usedPercent: 23, resetsAt: new Date(1790190000 * 1000).toISOString() },
        { label: "Weekly · all models", usedPercent: 18, resetsAt: new Date(1790395200 * 1000).toISOString() },
      ],
      detail: "Read from the Codex app-server.",
    });
    const [spawned, ...messages] = test.trace();
    expect(spawned?.apiKey).toBe(false);
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
    ]);
  });

  it("says a CLI that errors on the limits does not report them", async () => {
    const test = fixture(codex(`error: { code: -32601, message: 'Method not found' }`));
    await expect(codexUsage(test.options)).resolves.toEqual({
      plan: "Pro",
      windows: null,
      detail: "This Codex CLI does not report its plan windows.",
    });
  });

  it("words a failed probe about usage, never about model discovery, and logs the failure underneath", async () => {
    const test = fixture("process.exit(1);");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await codexUsage(test.options);
    expect(result).toEqual({
      plan: null,
      windows: null,
      detail: "Codex did not report its limits. Check your connection and refresh.",
    });
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0]?.[0])).toMatch(/^The Codex usage probe failed: \S/);
  });

  it("does not read a login held outside a file as signed out, and starts nothing it cannot use", async () => {
    const test = fixture("", { login: false });
    const result = await codexUsage(test.options);
    expect(result.windows).toBeNull();
    expect(result.detail).toBe("Codex's login is not in a file this desktop can read, so its limits are not shown.");
    expect(test.started()).toBe(false);
  });
});
