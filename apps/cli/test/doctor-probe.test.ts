import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticResultSchema, type DiagnosticResult } from "@perbo/contracts";
import type { PreflightResult } from "@perbo/runner";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runDoctorCommand, type DoctorOptions } from "../src/execute.js";

/**
 * `perbo doctor --probe`: one minimal call at the configured reviewer model,
 * before an attempt has spent anything.
 *
 * The provider is real here in the only sense a test can make it real. The
 * `claude-cli` transport is a binary this machine spawns, so the fake is a
 * binary — written by the test, put on PATH under the name the transport
 * spawns, and answering the way the CLI answers: a JSON result envelope on
 * stdout when it works, its own words on stderr and a non-zero exit when it
 * does not. Nothing about the probe is injected, so what these assertions
 * cover is the transport, the classification and the block a person reads,
 * rather than that a function was called.
 *
 * The preflight and the materialisation diagnostic *are* doubles, because they
 * are what this command does apart from the probe: holding them still is what
 * makes an exit code below attributable to the probe and to nothing else.
 *
 * Measured, not assumed: with `apps/cli/src` checked out at bb8040a — the
 * commit before this change — and this file left in place,
 * `pnpm exec vitest run test/doctor-probe.test.ts` reported
 * "Test Files 1 failed (1) · Tests 16 failed (16)", every one of them where the
 * PROVIDER block or the `provider` key of the JSON should have been. Every
 * assertion here discriminates: none of them passes without the change.
 */

const SPAWN_DEADLINE_MS = 20_000;

/**
 * A key shaped like the real one, planted in the environment so that the fake
 * can echo it back the way providers do. It is written here in two halves and
 * joined, so that the file's own text is not what a search for the key finds.
 */
const PLANTED_KEY = ["sk-ant-api03", "PROBEFIXTUREdoNOTprintME0123456789abcdef"].join("-");

/** The model the fake answers for. Anything else it refuses the way the API does. */
const KNOWN_MODEL = "claude-opus-5-probe-fixture";
const UNKNOWN_MODEL = "claude-model-that-does-not-exist";

const scratch = mkdtempSync(join(tmpdir(), "perbo-doctor-probe-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Mode = "answers" | "refuses-credential" | "no-network" | "rate-limited";

interface Fake {
  /** The directory to put in front of PATH. */
  bin: string;
  /** One line per invocation, holding the argv it was given. */
  calls: () => string[];
  /** What the fake wrote as its own error text, key and all. */
  said: () => string;
}

/**
 * A `claude` on PATH that answers as the CLI does under `-p --output-format
 * json`, and records what it was asked.
 */
function fakeClaude(name: string, mode: Mode): Fake {
  const bin = join(scratch, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  const said = join(bin, "said.txt");
  const script = join(bin, "claude");
  const failure: Record<Exclude<Mode, "answers">, string[]> = {
    // The provider quoting the credential back at the caller, which is the
    // channel a redaction that only handled perbo's own text would miss.
    "refuses-credential": [
      `printf 'Invalid API key · Please run /login (x-api-key %s was refused)\\n' "$ANTHROPIC_API_KEY" > "${said}"`,
      `cat "${said}" >&2`,
      "exit 1",
    ],
    "no-network": [
      `printf 'Error: getaddrinfo ENOTFOUND api.anthropic.com\\n' > "${said}"`,
      `cat "${said}" >&2`,
      "exit 1",
    ],
    "rate-limited": [
      `printf '{"type":"result","is_error":true,"api_error_status":429,"result":"rate_limit_error: too many requests"}\\n' > "${said}"`,
      `cat "${said}"`,
      "exit 1",
    ],
  } as Record<Exclude<Mode, "answers">, string[]>;

  writeFileSync(
    script,
    [
      "#!/bin/sh",
      // The argv, one line per call: what proves the model reached the process,
      // and that exactly one call was made.
      `printf '%s\\n' "$*" >> "${log}"`,
      // The prompt arrives on stdin and is drained, as the real binary drains it.
      "cat > /dev/null",
      'model=""',
      "while [ $# -gt 0 ]; do",
      '  if [ "$1" = "--model" ]; then model="$2"; fi',
      "  shift",
      "done",
      // A model the account cannot call is refused by the API, whatever else
      // is wrong, so the fake refuses it first and in the API's own words.
      `if [ "$model" != "${KNOWN_MODEL}" ]; then`,
      `  printf '{"type":"result","is_error":true,"api_error_status":404,"result":"not_found_error: model %s"}\\n' "$model" > "${said}"`,
      `  cat "${said}"`,
      "  exit 1",
      "fi",
      ...(mode === "answers"
        ? [
            `printf '{"type":"result","subtype":"success","is_error":false,"result":"pong","total_cost_usd":0.0004,"usage":{"input_tokens":4,"output_tokens":1}}\\n'`,
            "exit 0",
          ]
        : failure[mode]),
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    bin,
    calls: () =>
      existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
    said: () => (existsSync(said) ? readFileSync(said, "utf8") : ""),
  };
}

/** A machine and a checkout that are both fine, so the exit code is about the probe. */
const machineReady: PreflightResult = {
  ok: true,
  findings: [],
  tools: { node: { present: true, version: process.versions.node } },
  github: null,
};

const materializable: DiagnosticResult = DiagnosticResultSchema.parse({
  materializable: true,
  findings: [],
  proposed: null,
});

const doctorArgs = (
  repo: string,
  flags: { probe: boolean; publish: boolean; json?: boolean; writeConfig?: boolean },
): DoctorOptions["args"] => ({
  ticket: null,
  store: null,
  contract: null,
  config: null,
  repo,
  worktreeRoot: null,
  publish: flags.publish,
  json: flags.json ?? false,
  quiet: true,
  writeConfig: flags.writeConfig ?? false,
  probe: flags.probe,
  resumeFrom: null,
  outcome: null,
  criteria: [],
  paths: [],
  pr: null,
});

const originalPath = process.env.PATH;
const originalKey = process.env.ANTHROPIC_API_KEY;
const originalBase = process.env.ANTHROPIC_BASE_URL;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = originalBase;
});

/** A checkout, with the reviewer this repository has agreed on or with no config at all. */
function repository(name: string, config: Record<string, unknown> | null): string {
  const dir = join(scratch, `repo-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  if (config !== null) {
    mkdirSync(join(dir, ".perbo"), { recursive: true });
    writeFileSync(join(dir, ".perbo", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return dir;
}

const claudeCliRepo = (name: string, model: string) =>
  repository(name, {
    checks: [],
    reviewer_provider: "claude-cli",
    reviewer_model: model,
    publish: false,
  });

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

async function doctor(
  repo: string,
  options: {
    bin?: string;
    probe: boolean;
    publish?: boolean;
    key?: string | null;
    base?: string;
    /** `--json`. Off by default, as the block a person reads is the default. */
    json?: boolean;
    /** `--write-config`: this run is what configures the checkout. */
    writeConfig?: boolean;
    /** Piped rather than attached to a terminal, which renders JSON too. */
    isTTY?: boolean;
  },
): Promise<Run> {
  if (options.bin) process.env.PATH = `${options.bin}:${originalPath ?? ""}`;
  if (options.key === null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = options.key ?? PLANTED_KEY;
  if (options.base !== undefined) process.env.ANTHROPIC_BASE_URL = options.base;

  const out: string[] = [];
  const err: string[] = [];
  const code = await runDoctorCommand({
    args: doctorArgs(repo, {
      probe: options.probe,
      publish: options.publish ?? false,
      json: options.json ?? false,
      writeConfig: options.writeConfig ?? false,
    }),
    streams: {
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => err.push(chunk),
      isTTY: options.isTTY ?? true,
    },
    cwd: process.cwd(),
    preflight: () => machineReady,
    diagnose: () => Promise.resolve(materializable),
  });
  return { stdout: out.join(""), stderr: err.join(""), code };
}

/** The PROVIDER block, which is what every assertion below is about. */
function providerBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf("PROVIDER");
  expect(start, `no PROVIDER block in:\n${text}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() === "");
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

const fixLine = (block: string): string =>
  block.split("\n").find((line) => line.includes("fix:")) ?? "";

const failureLine = (block: string): string => block.split("\n")[0] ?? "";

describe("what one minimal call tells `perbo doctor --probe`", () => {
  it(
    "names the model that answered and how long it took, having called it once",
    async () => {
      const fake = fakeClaude("answers", "answers");
      const run = await doctor(claudeCliRepo("answers", KNOWN_MODEL), {
        bin: fake.bin,
        probe: true,
      });

      const block = providerBlock(run.stdout);
      expect(block).toContain(KNOWN_MODEL);
      expect(block).toMatch(/answered in \d+ ms/);
      expect(run.stdout).toContain("provider answers");

      // One call, carrying the configured model: a probe that asked twice, or
      // asked about a different model, would not be the thing the run makes.
      expect(fake.calls()).toHaveLength(1);
      expect(fake.calls()[0]).toContain(`--model ${KNOWN_MODEL}`);
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "gives each failure class its own line and its own fix",
    async () => {
      const classes = [
        {
          name: "authentication",
          fake: fakeClaude("auth", "refuses-credential"),
          model: KNOWN_MODEL,
          says: /refused the credential/,
          fixes: /sign in/,
        },
        {
          name: "unknown_model",
          fake: fakeClaude("model", "answers"),
          model: UNKNOWN_MODEL,
          says: new RegExp(`does not know the model .${UNKNOWN_MODEL}`),
          fixes: /reviewer_model/,
        },
        {
          name: "network",
          fake: fakeClaude("network", "no-network"),
          model: KNOWN_MODEL,
          says: /did not answer/,
          fixes: /connection/,
        },
        {
          name: "rate_limit",
          fake: fakeClaude("rate", "rate-limited"),
          model: KNOWN_MODEL,
          says: /rate or quota/,
          fixes: /wait for the limit to reset/,
        },
      ];

      const lines: string[] = [];
      const fixes: string[] = [];
      for (const expected of classes) {
        const run = await doctor(claudeCliRepo(expected.name, expected.model), {
          bin: expected.fake.bin,
          probe: true,
        });
        const block = providerBlock(run.stdout);
        expect(failureLine(block), `for ${expected.name}`).toContain(`${expected.name}:`);
        expect(failureLine(block), `for ${expected.name}`).toMatch(expected.says);
        expect(fixLine(block), `for ${expected.name}`).toMatch(expected.fixes);
        // The provider's own words are quoted back beside the class, because
        // the class is this command's reading and the text is the provider's.
        expect(block).toContain("said:");
        expect(expected.fake.calls(), `for ${expected.name}`).toHaveLength(1);
        lines.push(failureLine(block));
        fixes.push(fixLine(block));
      }

      // Four classes, four lines, four fixes: a class that shared another's
      // fix would be a label rather than an answer.
      expect(new Set(lines).size).toBe(4);
      expect(new Set(fixes).size).toBe(4);
    },
    SPAWN_DEADLINE_MS * 2,
  );
});

describe("what `perbo doctor --probe` never prints", () => {
  it(
    "keeps the provider key out of both streams, on every class and on success",
    async () => {
      const cases: Array<{ name: string; mode: Mode; model: string }> = [
        { name: "key-success", mode: "answers", model: KNOWN_MODEL },
        { name: "key-auth", mode: "refuses-credential", model: KNOWN_MODEL },
        { name: "key-model", mode: "answers", model: UNKNOWN_MODEL },
        { name: "key-network", mode: "no-network", model: KNOWN_MODEL },
        { name: "key-rate", mode: "rate-limited", model: KNOWN_MODEL },
      ];

      for (const one of cases) {
        const fake = fakeClaude(one.name, one.mode);
        const run = await doctor(claudeCliRepo(one.name, one.model), {
          bin: fake.bin,
          probe: true,
        });
        expect(run.stdout, `stdout for ${one.name}`).not.toContain(PLANTED_KEY);
        expect(run.stderr, `stderr for ${one.name}`).not.toContain(PLANTED_KEY);
        expect(run.stdout, `stdout for ${one.name}`).not.toContain(PLANTED_KEY.slice(0, 20));
        expect(run.stderr, `stderr for ${one.name}`).not.toContain(PLANTED_KEY.slice(0, 20));
      }

      // The control, without which the assertions above would pass on a
      // provider that never mentioned the key: the credential-refusing fake
      // did echo it, and it still did not reach either stream.
      const echoing = fakeClaude("key-echo", "refuses-credential");
      const run = await doctor(claudeCliRepo("key-echo", KNOWN_MODEL), {
        bin: echoing.bin,
        probe: true,
      });
      expect(echoing.said()).toContain(PLANTED_KEY);
      expect(run.stdout).toContain("Invalid API key");
      expect(run.stdout).toContain("[redacted:environment]");
      expect(run.stdout).not.toContain(PLANTED_KEY);
      expect(run.stderr).not.toContain(PLANTED_KEY);
    },
    SPAWN_DEADLINE_MS * 3,
  );
});

/**
 * The other rendering path. `doctor` writes JSON under `--json` and whenever it
 * is not attached to a terminal, which is how it is read in a script — and that
 * document carries the whole probe result, the provider's quoted words
 * included. So every assertion the block above makes about the key is made
 * again against this stream, on the same fake and on the same five readings.
 */
describe("the same probe as the JSON a script reads", () => {
  interface DoctorJson {
    provider: {
      transport: string;
      model: string;
      probed: boolean;
      probe:
        | ({ ok: boolean; provider: string; model: string; elapsed_ms: number } & {
            failure?: string;
            said?: string | null;
            fix?: string;
            detail?: string;
          })
        | null;
      dependency: { blocking: boolean; reason: string };
      blocking: boolean;
    };
  }

  const parse = (text: string): DoctorJson => JSON.parse(text) as DoctorJson;

  it(
    "serialises the class, the model and the round trip, and none of the key",
    async () => {
      const cases: Array<{ name: string; mode: Mode; model: string; failure: string | null }> = [
        { name: "json-success", mode: "answers", model: KNOWN_MODEL, failure: null },
        { name: "json-auth", mode: "refuses-credential", model: KNOWN_MODEL, failure: "authentication" },
        { name: "json-model", mode: "answers", model: UNKNOWN_MODEL, failure: "unknown_model" },
        { name: "json-network", mode: "no-network", model: KNOWN_MODEL, failure: "network" },
        { name: "json-rate", mode: "rate-limited", model: KNOWN_MODEL, failure: "rate_limit" },
      ];

      for (const one of cases) {
        const fake = fakeClaude(one.name, one.mode);
        const run = await doctor(claudeCliRepo(one.name, one.model), {
          bin: fake.bin,
          probe: true,
          json: true,
        });

        const { provider } = parse(run.stdout);
        expect(provider.probed, `probed for ${one.name}`).toBe(true);
        expect(provider.probe, `probe for ${one.name}`).not.toBeNull();
        expect(provider.probe!.ok, `ok for ${one.name}`).toBe(one.failure === null);
        expect(provider.probe!.model, `model for ${one.name}`).toBe(one.model);
        expect(typeof provider.probe!.elapsed_ms, `elapsed for ${one.name}`).toBe("number");
        if (one.failure !== null) {
          expect(provider.probe!.failure, `failure for ${one.name}`).toBe(one.failure);
          expect(provider.probe!.fix, `fix for ${one.name}`).toBeTruthy();
        }
        expect(run.stdout, `stdout for ${one.name}`).not.toContain(PLANTED_KEY);
        expect(run.stderr, `stderr for ${one.name}`).not.toContain(PLANTED_KEY);
        expect(run.stdout, `stdout for ${one.name}`).not.toContain(PLANTED_KEY.slice(0, 20));
        expect(run.stderr, `stderr for ${one.name}`).not.toContain(PLANTED_KEY.slice(0, 20));
      }

      // The same control as the block above: this document quotes a provider
      // that did echo the key, and the value in `said` is the redacted one.
      const echoing = fakeClaude("json-echo", "refuses-credential");
      const run = await doctor(claudeCliRepo("json-echo", KNOWN_MODEL), {
        bin: echoing.bin,
        probe: true,
        json: true,
      });
      expect(echoing.said()).toContain(PLANTED_KEY);
      const said = parse(run.stdout).provider.probe?.said ?? "";
      expect(said).toContain("Invalid API key");
      expect(said).toContain("[redacted:environment]");
      expect(said).not.toContain(PLANTED_KEY);
      expect(run.stdout).not.toContain(PLANTED_KEY);
      expect(run.stderr).not.toContain(PLANTED_KEY);
    },
    SPAWN_DEADLINE_MS * 3,
  );

  it(
    "says the probe was not run in a field, rather than leaving it to be inferred",
    async () => {
      const fake = fakeClaude("json-unprobed", "answers");
      const run = await doctor(claudeCliRepo("json-unprobed", KNOWN_MODEL), {
        bin: fake.bin,
        probe: false,
        json: true,
      });

      expect(fake.calls()).toEqual([]);
      const { provider } = parse(run.stdout);
      expect(provider.probed).toBe(false);
      expect(provider.probe).toBeNull();
      expect(provider.blocking).toBe(false);
      // The model it would call is still named, as it is on the line.
      expect(provider.model).toBe(KNOWN_MODEL);
      expect(provider.transport).toBe("claude-cli");
      expect(run.code).toBe(0);
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "renders the same document when it is piped rather than asked for --json",
    async () => {
      const fake = fakeClaude("piped", "refuses-credential");
      const run = await doctor(claudeCliRepo("piped", KNOWN_MODEL), {
        bin: fake.bin,
        probe: true,
        json: false,
        isTTY: false,
      });

      const { provider } = parse(run.stdout);
      expect(provider.probed).toBe(true);
      expect(provider.probe?.failure).toBe("authentication");
      expect(provider.blocking).toBe(true);
      expect(run.stdout).not.toContain(PLANTED_KEY);
      expect(run.stderr).not.toContain(PLANTED_KEY);
      expect(run.code).toBe(1);
    },
    SPAWN_DEADLINE_MS,
  );
});

describe("`perbo doctor` without --probe", () => {
  it(
    "calls no provider and says the probe was not run",
    async () => {
      const fake = fakeClaude("unprobed", "answers");
      const run = await doctor(claudeCliRepo("unprobed", KNOWN_MODEL), {
        bin: fake.bin,
        probe: false,
      });

      expect(fake.calls()).toEqual([]);
      const block = providerBlock(run.stdout);
      expect(block).toContain("the probe was not run");
      expect(block).toContain("--probe");
      // The model it would call is named, so the line says what the probe
      // would cost a person before they pay for it.
      expect(block).toContain(KNOWN_MODEL);
      expect(run.code).toBe(0);
    },
    SPAWN_DEADLINE_MS,
  );
});

describe("what a failed probe does to the exit code", () => {
  it(
    "leaves it unchanged where nothing on this checkout depends on the provider",
    async () => {
      // No `.perbo/config.json`: no run here is configured to review through
      // anything yet, so the probe is a reading and not a gate.
      const fake = fakeClaude("advisory", "refuses-credential");
      const unconfigured = repository("advisory", null);

      const before = await doctor(unconfigured, { bin: fake.bin, probe: false });
      const after = await doctor(unconfigured, { bin: fake.bin, probe: true });

      expect(before.code).toBe(0);
      expect(after.code).toBe(before.code);
      expect(providerBlock(after.stdout)).toContain("advisory:");
      expect(after.stdout).toContain("advisory)");
      expect(fake.calls()).toHaveLength(1);
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "blocks with --publish, which opens the pull request only after a review",
    async () => {
      const fake = fakeClaude("publish", "refuses-credential");
      const unconfigured = repository("publish", null);

      const unpublished = await doctor(unconfigured, { bin: fake.bin, probe: true });
      const published = await doctor(unconfigured, { bin: fake.bin, probe: true, publish: true });

      expect(unpublished.code).toBe(0);
      expect(published.code).toBe(1);
      expect(providerBlock(published.stdout)).toContain("blocking:");
      expect(providerBlock(published.stdout)).toContain("--publish");
      expect(published.stdout).toContain("blocking)");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "blocks where the reasons it prints say `run` here reviews through this provider",
    async () => {
      const fake = fakeClaude("configured", "refuses-credential");
      const configured = claudeCliRepo("configured", KNOWN_MODEL);

      const unprobed = await doctor(configured, { bin: fake.bin, probe: false });
      const probed = await doctor(configured, { bin: fake.bin, probe: true });

      expect(unprobed.code).toBe(0);
      expect(probed.code).toBe(1);
      const block = providerBlock(probed.stdout);
      expect(block).toContain("blocking:");
      expect(block).toContain("`perbo run` here reviews through this provider");
      expect(block).toContain(join(configured, ".perbo", "config.json"));
      // The keys that file actually holds, named: the reason is a claim about
      // a file a person can open, so it says which lines of it it read.
      expect(block).toContain("sets reviewer_provider and reviewer_model");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "reads a config that pins only the run's model as pinning only that",
    async () => {
      const fake = fakeClaude("model-only", "refuses-credential");
      // No `reviewer_provider`, no `reviewer_model`: the review takes this
      // `model`, which is the loop's own `reviewer_model ?? model`, so the
      // probe calls it and the reason names the key it came from.
      const configured = repository("model-only", { checks: [], model: KNOWN_MODEL });

      const probed = await doctor(configured, { bin: fake.bin, probe: true });

      expect(probed.code).toBe(1);
      const block = providerBlock(probed.stdout);
      const reason = block.split("\n").find((line) => line.includes("blocking:")) ?? "";
      expect(reason).toContain("sets model");
      expect(reason).not.toContain("reviewer_provider");
      expect(reason).not.toContain("reviewer_model");
      expect(fake.calls()[0]).toContain(`--model ${KNOWN_MODEL}`);
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "does not tell a config that names no reviewer that it named one",
    async () => {
      const fake = fakeClaude("no-reviewer", "answers");
      // A real config, with checks and nothing about the reviewer in it. A run
      // here still reviews — through the default transport — so the failed
      // probe still blocks; what the reason may not do is credit this file
      // with a choice it does not contain.
      const configured = repository("no-reviewer", { checks: [] });

      const probed = await doctor(configured, { bin: fake.bin, probe: true });

      expect(probed.code).toBe(1);
      const block = providerBlock(probed.stdout);
      const reason = block.split("\n").find((line) => line.includes("blocking:")) ?? "";
      expect(reason).toContain("names no reviewer");
      expect(reason).toContain("takes the default `claude-cli`");
      expect(reason).not.toMatch(/sets (?:reviewer_provider|reviewer_model|model)/);
      expect(reason).not.toContain("configures it");
      // And it is the default model that was called, which is the other half
      // of the same claim.
      expect(fake.calls()[0]).toContain("--model claude-opus-5");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "blocks on a checkout this same command has just configured, naming what it wrote",
    async () => {
      const fake = fakeClaude("write-config", "refuses-credential");
      const fresh = repository("write-config", null);

      const probed = await doctor(fresh, { bin: fake.bin, probe: true, writeConfig: true });

      // The file did not exist when the call went out and does now, so a run
      // here depends on the provider from this moment on.
      expect(existsSync(join(fresh, ".perbo", "config.json"))).toBe(true);
      expect(probed.code).toBe(1);
      const reason = providerBlock(probed.stdout)
        .split("\n")
        .find((line) => line.includes("blocking:")) ?? "";
      expect(reason).toContain(join(fresh, ".perbo", "config.json"));
      // The keys of the file it wrote, which is where a reader would look.
      expect(reason).toContain("sets reviewer_provider and model");
    },
    SPAWN_DEADLINE_MS,
  );
});

/**
 * The other transport. `anthropic` reviews over HTTP rather than over a
 * binary, so the provider here is a real server on loopback that answers the
 * way the API answers — the same probe, the same classes, the same silence
 * about the key, which is sent to this one as a header.
 */
describe("the same probe against the `anthropic` transport", () => {
  const servers: Server[] = [];
  afterAll(async () => {
    for (const server of servers) await new Promise((done) => server.close(done));
  });

  function api(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{
    base: string;
    seen: () => Array<{ key: string | undefined; body: string }>;
  }> {
    const seen: Array<{ key: string | undefined; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          key: request.headers["x-api-key"] as string | undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        handler(request, response);
      });
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resolve({ base: `http://127.0.0.1:${port}`, seen: () => seen });
      });
    });
  }

  const anthropicRepo = (name: string) =>
    repository(name, {
      checks: [],
      reviewer_provider: "anthropic",
      reviewer_model: KNOWN_MODEL,
      publish: false,
    });

  it(
    "names the model and the round trip when the API answers",
    async () => {
      const provider = await api((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "pong" }] }));
      });

      const run = await doctor(anthropicRepo("http-ok"), { probe: true, base: provider.base });

      const block = providerBlock(run.stdout);
      expect(block).toContain(KNOWN_MODEL);
      expect(block).toMatch(/answered in \d+ ms/);
      // One call, authenticated with the key and asking for one token at the
      // configured model.
      expect(provider.seen()).toHaveLength(1);
      expect(provider.seen()[0]!.key).toBe(PLANTED_KEY);
      expect(JSON.parse(provider.seen()[0]!.body)).toMatchObject({
        model: KNOWN_MODEL,
        max_tokens: 1,
      });
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "reads the status the API refuses with, and prints none of the key it was sent",
    async () => {
      const refusals = [
        { status: 401, class: "authentication", type: "authentication_error" },
        { status: 404, class: "unknown_model", type: "not_found_error" },
        { status: 429, class: "rate_limit", type: "rate_limit_error" },
        { status: 503, class: "network", type: "overloaded_error" },
      ];
      for (const refusal of refusals) {
        const provider = await api((_request, response) => {
          response.writeHead(refusal.status, { "content-type": "application/json" });
          // The API's own error body, echoing the key the way a badly
          // configured gateway does.
          response.end(
            JSON.stringify({
              type: "error",
              error: { type: refusal.type, message: `refused for x-api-key ${PLANTED_KEY}` },
            }),
          );
        });

        const run = await doctor(anthropicRepo(`http-${refusal.status}`), {
          probe: true,
          base: provider.base,
        });

        expect(failureLine(providerBlock(run.stdout))).toContain(`${refusal.class}:`);
        expect(run.stdout).not.toContain(PLANTED_KEY);
        expect(run.stderr).not.toContain(PLANTED_KEY);
      }
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "calls the API not at all where no key is set, and says the credential is what failed",
    async () => {
      const provider = await api((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });

      const run = await doctor(anthropicRepo("http-no-key"), {
        probe: true,
        base: provider.base,
        key: null,
      });

      expect(provider.seen()).toEqual([]);
      expect(failureLine(providerBlock(run.stdout))).toContain("authentication:");
      expect(providerBlock(run.stdout)).toContain("ANTHROPIC_API_KEY is not set");
    },
    SPAWN_DEADLINE_MS,
  );
});
