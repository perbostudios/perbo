import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fake `claude` binary for the CLI transport's tests.
 *
 * It records every invocation — its argv, whatever arrived on stdin, and the
 * system prompt read back out of the file `--system-prompt-file` names — writes
 * the session transcript the real CLI writes,
 * `$HOME/.claude/projects/<slug>/<session id>.jsonl`, beside two transcripts
 * that belong to no review, and answers with the structured output scripted for
 * that invocation. The `session_id` it reports is deliberately not a UUID, so a
 * transport that took its session id from the result envelope would fail the
 * resume assertions rather than pass them.
 *
 * Reading stdin to EOF is not incidental: the transport hands it the prompt
 * there (SCP-188), and a fake that ignored it would leave the transport writing
 * into a closed pipe and prove nothing about what the process received.
 */

let binaries = 0;

/** One invocation, as the fake saw it. */
export interface FakeCall {
  argv: string[];
  /** The prompt, as it arrived on stdin. */
  stdin: string;
  /** The contents of the file `--system-prompt-file` named, or null. */
  system: string | null;
}

export interface FakeClaude {
  /** Path to pass as the transport's `binary`. */
  path: string;
  /** Each invocation so far, in order. */
  invocations: () => FakeCall[];
  /** The argv of each invocation so far, in order. */
  calls: () => string[][];
}

export function fakeClaudeBinary(options: {
  /** Where the script and its invocation log are written. */
  dir: string;
  /** One `structured_output` per invocation; the last repeats. */
  structured: unknown[];
  /** Exit non-zero on this invocation (1-based) instead of answering. */
  failOnCall?: number;
}): FakeClaude {
  binaries += 1;
  const path = join(options.dir, `fake-claude-${binaries}.mjs`);
  const log = join(options.dir, `fake-claude-${binaries}.log`);
  const source = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const log = ${JSON.stringify(log)};
const structured = ${JSON.stringify(options.structured)};
const failOnCall = ${JSON.stringify(options.failOnCall ?? 0)};

const argv = process.argv.slice(2);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");

const systemAt = argv.indexOf("--system-prompt-file");
let system = null;
if (systemAt !== -1) system = readFileSync(argv[systemAt + 1], "utf8");

appendFileSync(log, JSON.stringify({ argv, stdin, system }) + "\\n");
const call = readFileSync(log, "utf8").trimEnd().split("\\n").length;

const flag = argv.indexOf("--session-id") !== -1 ? "--session-id" : "--resume";
const at = argv.indexOf(flag);
const sessionId = at === -1 ? "no-session-flag-given" : argv[at + 1];

const store =
  process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "/nonexistent", ".claude");
const projects = join(store, "projects");
const own = join(projects, "-scratch-review");
mkdirSync(own, { recursive: true });
writeFileSync(join(own, sessionId + ".jsonl"), "{}\\n");
writeFileSync(join(own, "a-session-of-the-users.jsonl"), "{}\\n");
mkdirSync(join(projects, "-another-project"), { recursive: true });
writeFileSync(join(projects, "-another-project", "a-second-session.jsonl"), "{}\\n");

if (call === failOnCall) {
  process.stderr.write("the fake claude failed\\n");
  process.exit(2);
}

process.stdout.write(
  JSON.stringify({
    is_error: false,
    session_id: "an-envelope-session-id-that-is-not-a-uuid",
    stop_reason: "tool_use",
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
    structured_output: structured[Math.min(call, structured.length) - 1] ?? null,
  }),
);
`;
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  const invocations = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCall);
  return {
    path,
    invocations,
    calls: () => invocations().map((call) => call.argv),
  };
}

/** The value passed after `flag`, or undefined when the flag is absent. */
export function argumentOf(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}
