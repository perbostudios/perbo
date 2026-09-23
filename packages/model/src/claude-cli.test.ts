import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLAUDE_CLI_ENV_ALLOW_LIST, claudeCliModel, pendingTurnText } from "./claude-cli.js";
import { ProviderError, providerFailureText } from "./failure.js";
import { argumentOf, fakeClaudeBinary } from "./test-support/fake-claude.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./test-support/spawn-timeout.js";
import { READ_FILE_TOOL, SUBMIT_REVIEW_TOOL } from "./turn.js";

/**
 * The mapping from the CLI's result envelope onto the tool calls the
 * orchestrator expects, and the invocation the transport builds. A fake binary
 * stands in for `claude`: what is under test is the transport, not the model.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-cli-provider-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Spelled as an escape: a raw one here would make this very file unreviewable. */
const NUL_BYTE = "\u0000";

let counter = 0;
function fakeClaude(body: string): string {
  counter += 1;
  const path = join(scratch, `fake-${counter}.sh`);
  // `cat >/dev/null` first: the prompt arrives on stdin, and a fake that left it
  // unread would have the transport writing into a pipe nobody drains.
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\ncat <<'ENVELOPE'\n${body}\nENVELOPE\n`);
  chmodSync(path, 0o755);
  return path;
}

const envelope = (structured: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    is_error: false,
    session_id: "sess_1",
    stop_reason: "tool_use",
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
    structured_output: structured,
    ...extra,
  });

const request = {
  system: "system prompt",
  messages: [{ role: "user" as const, content: "the context" }],
  forceSubmit: false,
};

/** The same conversation one turn later: a read was asked for and answered. */
const afterOneRead = {
  system: "system prompt",
  messages: [
    { role: "user" as const, content: "the context" },
    {
      role: "assistant" as const,
      content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a/b.ts" } }],
    },
    {
      role: "user" as const,
      content: [{ type: "tool_result", tool_use_id: "t1", content: "<file>body</file>" }],
    },
  ],
  forceSubmit: false,
};

describe("the claude-cli transport", () => {
  it("turns a read_files response into read_file tool calls", async () => {
    const model = claudeCliModel({
      submitSchema: { type: "object" },
      binary: fakeClaude(
        envelope({ next: "read_files", read_paths: ["a/b.ts", "a/c.ts"], review: null }),
      ),
    });
    const turn = await model.turn(request);
    expect(turn.toolCalls.map((call) => call.name)).toEqual([READ_FILE_TOOL, READ_FILE_TOOL]);
    expect(turn.toolCalls.map((call) => (call.input as { path: string }).path)).toEqual([
      "a/b.ts",
      "a/c.ts",
    ]);
  });

  it("turns a submit_review response into one submit_review tool call", async () => {
    const model = claudeCliModel({
      submitSchema: { type: "object" },
      binary: fakeClaude(
        envelope({
          next: "submit_review",
          read_paths: [],
          review: { coverage: [], findings: [], check_assertions: [], overall_confidence: 0.9 },
        }),
      ),
    });
    const turn = await model.turn(request);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.name).toBe(SUBMIT_REVIEW_TOOL);
    expect(turn.toolCalls[0]?.input).toMatchObject({ overall_confidence: 0.9 });
  });

  it("reports the cost the transport measured rather than one recomputed from tokens", async () => {
    const model = claudeCliModel({
      submitSchema: { type: "object" },
      binary: fakeClaude(envelope({ next: "read_files", read_paths: [], review: null })),
    });
    const turn = await model.turn(request);
    expect(turn.reported_cost_micros).toBe(250_000);
    expect(turn.usage).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    });
  });

  it("yields no tool call when the response carries no structured output", async () => {
    const model = claudeCliModel({
      submitSchema: { type: "object" },
      binary: fakeClaude(envelope(null)),
    });
    expect((await model.turn(request)).toolCalls).toEqual([]);
  });

  it("treats a reported error as a provider failure rather than a verdict", async () => {
    const model = claudeCliModel({
      submitSchema: { type: "object" },
      binary: fakeClaude(
        JSON.stringify({ is_error: true, api_error_status: 529, structured_output: null }),
      ),
    });
    await expect(model.turn(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it("treats output that is not a result envelope as a provider failure", async () => {
    const model = claudeCliModel({ submitSchema: { type: "object" }, binary: fakeClaude("not json") });
    await expect(model.turn(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it("records the transport on the artifact's provider field", () => {
    const model = claudeCliModel({ submitSchema: {}, binary: "claude" });
    expect(model.provider).toBe("claude-cli");
    expect(model.model_id).toBe("claude-opus-5");
  });
}, SPAWN_TEST_TIMEOUT_MS);

/**
 * A fake binary that reports what it was given: its argv, or the names in
 * its environment, as the `read_paths` of a read_files turn.
 */
function echoingClaude(what: "argv" | "env" | "stdin"): string {
  counter += 1;
  const path = join(scratch, `echo-${counter}.mjs`);
  const source = {
    argv: "process.argv.slice(2)",
    env: "Object.keys(process.env).sort()",
    stdin: "[stdin]",
  }[what];
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      // Drained in every mode: the prompt arrives here now, and a fake that
      // never read it would leave the transport writing into a closed pipe.
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "const stdin = Buffer.concat(chunks).toString('utf8');",
      `const paths = ${source};`,
      "process.stdout.write(JSON.stringify({ is_error: false, structured_output: { next: 'read_files', read_paths: paths, review: null } }));",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

const echoed = async (model: ReturnType<typeof claudeCliModel>, req = request) =>
  (await model.turn(req)).toolCalls.map((call) => (call.input as { path: string }).path);

describe("the claude-cli transport's invocation", () => {
  it("carries the executor adapter's suppression flags", async () => {
    const argv = await echoed(
      claudeCliModel({ submitSchema: { type: "object" }, binary: echoingClaude("argv") }),
    );
    for (const flag of ["--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]) {
      expect(argv, flag).toContain(flag);
    }
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("user");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(argv[argv.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
  });

  it("hands the process exactly the allow-listed environment, never the caller's", async () => {
    const caller = {
      PATH: process.env.PATH ?? "",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-ant-x",
      GH_TOKEN: "ghp_secret",
      AWS_SECRET_ACCESS_KEY: "s3cret",
      ANTHROPIC_BASE_URL: "https://evil.example",
      PERBO_TEST_LEAK: "must-not-leak",
    };
    const names = await echoed(
      claudeCliModel({
        submitSchema: { type: "object" },
        binary: echoingClaude("env"),
        env: caller,
      }),
    );
    // Exactly the allow-list, not a superset that happens to exclude the names
    // this test remembered to name. A name the caller never had cannot have
    // been inherited from it, which is what the filter drops: macOS adds
    // __CF_USER_TEXT_ENCODING to every process it spawns, whatever we pass.
    const inherited = names.filter((name) => name in caller);
    expect(new Set(inherited)).toEqual(new Set(["PATH", "HOME", "ANTHROPIC_API_KEY"]));
    for (const name of inherited) {
      expect(CLAUDE_CLI_ENV_ALLOW_LIST, name).toContain(name);
    }
  });

  it("puts neither the prompt nor the system prompt in argv", async () => {
    const { fake, model } = underFakeHome({ structured: [readFiles] });
    await model.turn(request);
    await model.dispose();

    const [call] = fake.invocations();
    expect(call).toBeDefined();
    for (const argument of call?.argv ?? []) {
      expect(argument, argument).not.toContain("the context");
      expect(argument, argument).not.toContain("system prompt");
    }
    // Both still reach the process: the prompt on stdin, the system prompt in a
    // file the flag names — the fake read it back out of that file.
    expect(call?.stdin).toContain("the context");
    expect(call?.system).toBe("system prompt");
    expect(argumentOf(call?.argv ?? [], "--system-prompt")).toBeUndefined();
  });

  it("carries a prompt holding a NUL byte, which no argv can hold", async () => {
    // AYO-33: the executor wrote a NUL into a source file, the reviewer asked to
    // read it, and `The argument 'args[22]' must be a string without null bytes`
    // ended the review as `provider_unavailable` (SCP-188).
    const { fake, model } = underFakeHome({ structured: [readFiles] });
    const turn = await model.turn({
      system: "system prompt",
      messages: [{ role: "user", content: `before${NUL_BYTE}after` }],
      forceSubmit: false,
    });
    await model.dispose();

    expect(turn.toolCalls).toHaveLength(1);
    expect(fake.invocations()[0]?.stdin).toContain(`before${NUL_BYTE}after`);
  });

  it("carries a prompt larger than the platform's argument limit", async () => {
    // `getconf ARG_MAX` is 1 MiB on this platform and 2 MiB on Linux; two of
    // them is past both, and well under one 64 KiB file the reader will serve.
    const huge = "x".repeat(2 * 1024 * 1024);
    const { fake, model } = underFakeHome({ structured: [readFiles] });
    const turn = await model.turn({
      system: "system prompt",
      messages: [{ role: "user", content: huge }],
      forceSubmit: false,
    });
    await model.dispose();

    expect(turn.toolCalls).toHaveLength(1);
    expect(fake.invocations()[0]?.stdin.length).toBeGreaterThanOrEqual(huge.length);
  });

  it("renders only the messages a turn has not sent yet, and no assistant text", () => {
    expect(pendingTurnText(afterOneRead.messages, 0)).toContain("the context");
    const delta = pendingTurnText(afterOneRead.messages, 1);
    expect(delta).toContain("<file>body</file>");
    expect(delta).not.toContain("the context");
    expect(delta).not.toContain("a/b.ts");
  });
}, SPAWN_TEST_TIMEOUT_MS);

/**
 * The session: one per review, opened by an id the transport minted, resumed
 * rather than re-sent, and removed from the user's store when the review ends.
 */

const sessionsOf = (home: string) => join(home, ".claude", "projects", "-scratch-review");
const transcript = (home: string, id: string) => join(sessionsOf(home), `${id}.jsonl`);
const neighbours = (home: string) => [
  join(sessionsOf(home), "a-session-of-the-users.jsonl"),
  join(home, ".claude", "projects", "-another-project", "a-second-session.jsonl"),
];

const readFiles = { next: "read_files", read_paths: ["a/b.ts"], review: null };

function underFakeHome(options: { structured: unknown[]; failOnCall?: number }) {
  const home = mkdtempSync(join(scratch, "home-"));
  const fake = fakeClaudeBinary({ dir: scratch, ...options });
  const model = claudeCliModel({
    submitSchema: { type: "object" },
    binary: fake.path,
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });
  return { home, fake, model };
}

describe("the claude-cli transport's session", () => {
  it("opens a session of its own rather than continuing one of the user's", async () => {
    const { fake, model } = underFakeHome({ structured: [readFiles] });
    await model.turn(request);
    await model.dispose();

    const [first] = fake.calls();
    expect(first).toBeDefined();
    expect(argumentOf(first ?? [], "--session-id")).toMatch(UUID);
    expect(first).not.toContain("--resume");
    expect(first).not.toContain("--continue");
    // The hardening flag that made resuming impossible is gone; nothing else is.
    expect(first).not.toContain("--no-session-persistence");
  });

  it("gives concurrent reviews sessions of their own", async () => {
    const a = underFakeHome({ structured: [readFiles] });
    const b = underFakeHome({ structured: [readFiles] });
    await Promise.all([a.model.turn(request), b.model.turn(request)]);
    await Promise.all([a.model.dispose(), b.model.dispose()]);

    const one = argumentOf(a.fake.calls()[0] ?? [], "--session-id");
    const two = argumentOf(b.fake.calls()[0] ?? [], "--session-id");
    expect(one).toMatch(UUID);
    expect(two).toMatch(UUID);
    expect(one).not.toBe(two);
  });

  it("resumes its own session on later turns, carrying only the new turn's text", async () => {
    const { fake, model } = underFakeHome({ structured: [readFiles, readFiles] });
    await model.turn(request);
    await model.turn(afterOneRead);
    await model.dispose();

    const [first, second] = fake.invocations();
    const opened = argumentOf(first?.argv ?? [], "--session-id");
    expect(opened).toMatch(UUID);
    expect(argumentOf(second?.argv ?? [], "--resume")).toBe(opened);
    expect(second?.argv).not.toContain("--session-id");
    // A resumed session does not carry the system prompt, so every turn does:
    // a resumed turn without it would review with no criteria, no trust tiers
    // and no verdict rules.
    expect(second?.system).toBe("system prompt");

    expect(second?.stdin).toContain("<file>body</file>");
    expect(second?.stdin).not.toContain("the context");
    expect(first?.stdin).toContain("the context");
  });

  it("never takes the session id from the result envelope", async () => {
    const { fake, model } = underFakeHome({ structured: [readFiles, readFiles] });
    await model.turn(request);
    await model.turn(afterOneRead);
    await model.dispose();

    const [, second] = fake.calls();
    expect(argumentOf(second ?? [], "--resume")).not.toBe(
      "an-envelope-session-id-that-is-not-a-uuid",
    );
  });

  it("removes the transcript its own session wrote, and leaves every other alone", async () => {
    const { home, fake, model } = underFakeHome({ structured: [readFiles, readFiles] });
    await model.turn(request);
    await model.turn(afterOneRead);

    const id = argumentOf(fake.calls()[0] ?? [], "--session-id") ?? "";
    expect(existsSync(transcript(home, id))).toBe(true);

    await model.dispose();

    expect(existsSync(transcript(home, id))).toBe(false);
    for (const path of neighbours(home)) {
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("removes it when a turn failed", async () => {
    const { home, fake, model } = underFakeHome({ structured: [readFiles], failOnCall: 1 });
    await expect(model.turn(request)).rejects.toBeInstanceOf(ProviderError);

    const id = argumentOf(fake.calls()[0] ?? [], "--session-id") ?? "";
    expect(existsSync(transcript(home, id))).toBe(true);

    await model.dispose();

    expect(existsSync(transcript(home, id))).toBe(false);
    for (const path of neighbours(home)) {
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("leaves a directory that shares the session's name alone", async () => {
    const { home, fake, model } = underFakeHome({ structured: [readFiles] });
    await model.turn(request);
    const id = argumentOf(fake.calls()[0] ?? [], "--session-id") ?? "";

    // The same name, one project directory over, but a directory rather than a
    // transcript: removal is for the file this session wrote, not for a name.
    const decoy = join(home, ".claude", "projects", "-a-third-project", `${id}.jsonl`);
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "inside.txt"), "not a transcript\n");

    await model.dispose();

    expect(existsSync(transcript(home, id))).toBe(false);
    expect(existsSync(decoy)).toBe(true);
    expect(existsSync(join(decoy, "inside.txt"))).toBe(true);
  });

  it("finds the session store at CLAUDE_CONFIG_DIR when the caller sets one", async () => {
    const home = mkdtempSync(join(scratch, "home-"));
    const configDir = mkdtempSync(join(scratch, "config-"));
    const fake = fakeClaudeBinary({ dir: scratch, structured: [readFiles] });
    const model = claudeCliModel({
      submitSchema: { type: "object" },
      binary: fake.path,
      env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CONFIG_DIR: configDir },
    });
    await model.turn(request);

    const id = argumentOf(fake.calls()[0] ?? [], "--session-id") ?? "";
    const written = join(configDir, "projects", "-scratch-review", `${id}.jsonl`);
    expect(existsSync(written)).toBe(true);
    // Nothing was written under HOME, so a transport that looked there would
    // find nothing to remove and this would still pass — the assertion that
    // bites is the one below.
    await model.dispose();
    expect(existsSync(written)).toBe(false);
  });

  it("refuses a session id that is not a uuid rather than putting it in argv", async () => {
    const home = mkdtempSync(join(scratch, "home-"));
    const fake = fakeClaudeBinary({ dir: scratch, structured: [readFiles] });
    const model = claudeCliModel({
      submitSchema: { type: "object" },
      binary: fake.path,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      newSessionId: () => "--not-a-uuid; rm -rf /",
    });
    await expect(model.turn(request)).rejects.toBeInstanceOf(ProviderError);
    expect(() => fake.calls()).toThrow();
    await model.dispose();
  });
}, SPAWN_TEST_TIMEOUT_MS);


/**
 * What a failed invocation is allowed to say (SCP-188).
 *
 * `errors[].message` on the review bundle is read by a person and, on AYO-33,
 * carried the contents of the file the review died on: Node quotes the argument
 * it refused, and the argument was the prompt.
 */
describe("the text a transport failure records", () => {
  const prompt =
    '<perbo:repo_file trust="repo" path="packages/contracts/src/verdicts.ts">\n' +
    "export function timingSafeEqual(a: string, b: string): boolean {\n";

  it("drops the argument Node quoted and keeps the reason it gave", () => {
    const said = providerFailureText(
      `The argument 'args[22]' must be a string without null bytes. Received '${prompt}'`,
      [prompt, "system prompt"],
    );
    expect(said).toContain("must be a string without null bytes");
    expect(said).not.toContain("timingSafeEqual");
    expect(said).not.toContain("verdicts.ts");
  });

  it("withholds a line that still opens with what was sent", () => {
    const said = providerFailureText(`${prompt} was rejected`, [prompt, "system prompt"]);
    expect(said).not.toContain("timingSafeEqual");
    expect(said).toContain("withheld");
  });

  it("keeps an ordinary failure whole, bounded to one line", () => {
    expect(providerFailureText("spawn E2BIG", [prompt])).toBe("spawn E2BIG");
    expect(providerFailureText("the CLI died\nand said more", [prompt])).toBe("the CLI died");
    expect(providerFailureText("", [prompt])).toBe("no error text");
    expect(providerFailureText("x".repeat(400), [prompt])).toHaveLength(301);
  });

  it("says what the process said, not what the process was given", async () => {
    const { model } = underFakeHome({ structured: [readFiles], failOnCall: 1 });
    const failure = await model
      .turn({
        system: "system prompt",
        messages: [{ role: "user", content: prompt }],
        forceSubmit: false,
      })
      .then(
        () => null,
        (error: unknown) => error as ProviderError,
      );
    await model.dispose();

    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure?.message).toContain("the fake claude failed");
    expect(failure?.message).not.toContain("timingSafeEqual");
    expect(failure?.message).not.toContain("verdicts.ts");
  });
}, SPAWN_TEST_TIMEOUT_MS);
