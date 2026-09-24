import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ENV_ALLOW_LIST, scrubEnvironment, type ProviderEffort } from "@perbo/contracts";
import { DEFAULT_CLAUDE_MODEL } from "./defaults.js";
import { ProviderError, providerFailureText } from "./failure.js";
import {
  structuredTurnSchema,
  structuredTurnToolCalls,
  type StructuredTurn,
} from "./structured.js";
import type { Model, ModelRequest, ModelTurn } from "./turn.js";

/**
 * One invocation, with the prompt written to the process's stdin.
 *
 * `promisify(execFile)` cannot do this: it returns a promise and not the child,
 * so there is nowhere to write. The prompt is the whole reason it has to —
 * argv may not hold a NUL byte and may not exceed `ARG_MAX`, and a file the
 * reviewer reads can carry either (SCP-188).
 */
function runCli(
  binary: string,
  args: readonly string[],
  options: { cwd: string; maxBuffer: number; timeout: number; env: NodeJS.ProcessEnv },
  prompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, [...args], options, (error, stdout, stderr) => {
      // The CLI's own voice, kept beside the error: Node's message for a
      // non-zero exit opens with the whole argv, which says nothing.
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
    // A process that exits before draining the prompt — the timeout fired, the
    // binary refused its arguments — closes this pipe under the write. The
    // callback already carries why; the broken pipe is not a second failure.
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
}

/**
 * A second transport to the same reviewer, over the locally installed `claude`
 * binary rather than the Anthropic SDK.
 *
 * It exists for one reason: BYOK means the reviewer needs a key, and a machine
 * that has Claude Code has a credential already. It is a way to *measure*
 * without provisioning a second one, not a second product path — nothing about
 * the review changes. The system prompt, the context blocks and their trust
 * tiers, the verdict schema, the bounded file reader, the deterministic
 * overrides and the blocking matrix are all the same objects the SDK transport
 * uses. Only the wire differs, and `model.provider` in the artifact records
 * which wire carried it.
 *
 * Five properties are worth stating because they are the ones that could have
 * quietly changed:
 *
 * 1. **The verdict is still constrained output.** `--json-schema` is a real
 *    structured-output constraint, not a request for JSON in prose. Nothing
 *    here parses a verdict out of text (ADR-0023 §2).
 * 2. **Files are still served by `RepoReader`.** Claude Code's own Read tool is
 *    disabled with `--tools ""`; every read goes back through the reader that
 *    refuses materialized secrets and repository-supplied agent configuration.
 *    Two adversarial fixtures exist to check that, and they would be measuring
 *    nothing if the CLI's reader were used instead.
 * 3. **No configuration from anywhere but the user's own settings reaches the
 *    process**, and no hook, skill, plugin, tool server or slash command from
 *    there either. The invocation carries the same suppression flags the
 *    executor adapter carries, the process runs in a scratch directory rather
 *    than the repository under review, and its environment is the same
 *    allow-list the executor gets plus the provider's own variables.
 * 4. **Neither prompt is a command-line argument.** The prompt goes to the
 *    process on stdin and the system prompt in a file of this review's own,
 *    because both carry whole repository files: argv may hold neither a NUL
 *    byte nor more than `ARG_MAX` bytes, and one NUL in one file ended AYO-33's
 *    review outright (SCP-188).
 * 5. **One session per review, opened by this transport and removed with it.**
 *    The session id is minted here, `--session-id` opens the first turn and
 *    `--resume` continues it, so a turn carries only its own new text. The
 *    system prompt is the exception and goes on every turn, because a resumed
 *    session does not carry one. The session lives in the user's own
 *    configuration directory because Claude Code 2.1.247 finds a subscription
 *    credential only there — under a `CLAUDE_CONFIG_DIR` of its own the CLI
 *    authenticates as nobody — so the isolation is the private session id and
 *    the removal of its transcript when the review ends, on every path.
 */

export interface ClaudeCliOptions {
  submitSchema: Record<string, unknown>;
  modelId?: string;
  /** `--effort`; absent, none is passed and the CLI's own default applies. */
  effort?: ProviderEffort<"claude-cli">;
  binary?: string;
  timeoutMs?: number;
  /** Injected by tests. Production scrubs the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Injected by tests. Production mints a v4 UUID per review. */
  newSessionId?: () => string;
}

/**
 * What the reviewer process may see of the caller's environment: the same
 * baseline the executor gets, plus the two variables the `claude` binary
 * itself reads. Everything else — every token, every cloud credential, every
 * base-URL override — is dropped by name.
 */
export const CLAUDE_CLI_ENV_ALLOW_LIST = [
  ...DEFAULT_ENV_ALLOW_LIST,
  "ANTHROPIC_API_KEY",
  "CLAUDE_CONFIG_DIR",
] as const;

/**
 * A session id is a v4 UUID and is checked against this before it reaches
 * argv. The transport mints its own, so a value that fails this is a defect
 * here rather than something a model said — and it is refused either way,
 * because an argument is not a place to find out.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface CliResult {
  is_error?: boolean;
  structured_output?: StructuredTurn | null;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stop_reason?: string;
  api_error_status?: number | null;
}

/**
 * The text of the messages this transport has not sent yet, in order.
 *
 * Assistant messages are never rendered: the session already holds what the
 * model itself said, and on the first turn there are none. What reaches the
 * process is the orchestrator's side of the conversation — the context, and
 * each read's result as it comes back.
 */
export function pendingTurnText(messages: ModelRequest["messages"], from: number): string {
  const parts: string[] = [];
  for (const message of messages.slice(from)) {
    if (message.role === "assistant") continue;
    const content = message.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) {
      parts.push(String(content ?? ""));
      continue;
    }
    for (const block of content) {
      const item = block as { type?: string; text?: string; content?: string };
      if (item.type === "tool_result") parts.push(item.content ?? "");
      else if (item.text) parts.push(item.text);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Where the CLI keeps its session transcripts: one directory per working
 * directory under `projects/`, each holding a `<session id>.jsonl`.
 */
function sessionStore(base: NodeJS.ProcessEnv): string {
  return base.CLAUDE_CONFIG_DIR ?? join(base.HOME ?? homedir(), ".claude");
}

/**
 * Remove the transcript of one session and nothing else. The name is built
 * from the id this transport minted, matched exactly, and removed only where
 * it is a regular file — never a directory, never a pattern. A session the CLI
 * never wrote is not an error, and neither is a store that does not exist.
 */
async function removeTranscript(store: string, sessionId: string): Promise<void> {
  const projects = join(store, "projects");
  let entries;
  try {
    entries = await readdir(projects, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(projects, entry.name, `${sessionId}.jsonl`);
    try {
      const stats = await lstat(path);
      if (!stats.isFile()) continue;
      await rm(path);
    } catch {
      // Absent, or not ours to remove. Either way the review is over.
    }
  }
}

export interface ClaudeCliModel extends Model {
  dispose(): Promise<void>;
}

export function claudeCliModel(options: ClaudeCliOptions): ClaudeCliModel {
  const modelId = options.modelId ?? DEFAULT_CLAUDE_MODEL;
  const binary = options.binary ?? "claude";
  const schema = JSON.stringify(structuredTurnSchema(options.submitSchema));
  // Never the repository under review: nothing there should be auto-discovered.
  // It stays the shared temporary directory rather than this review's own,
  // because the CLI names a session store directory after its working directory
  // and a fresh one per review would leave a directory per review behind in the
  // user's store.
  const cwd = tmpdir();
  const base = options.env ?? process.env;
  const environment = scrubEnvironment({ base, allow: CLAUDE_CLI_ENV_ALLOW_LIST });
  const store = sessionStore(base);
  const mint = options.newSessionId ?? randomUUID;

  // This review's session, and how much of the conversation it has been told.
  let sessionId: string | null = null;
  let sent = 0;
  /**
   * This review's own directory, holding the system prompt `--system-prompt-file`
   * names. One per review, removed with it, so the file the flag points at is
   * this review's and no other's.
   */
  let scratch: string | null = null;

  return {
    provider: "claude-cli",
    model_id: modelId,
    async turn(request: ModelRequest): Promise<ModelTurn> {
      const resuming = sessionId !== null;
      const id = sessionId ?? mint();
      if (!SESSION_ID.test(id)) {
        throw new ProviderError(
          `the claude CLI transport minted a session id that is not a UUID: ${id}`,
          1,
          "provider_unavailable",
        );
      }
      // Recorded before the process starts: the CLI writes the transcript as it
      // opens the session, so a turn that fails still leaves one to remove.
      sessionId = id;

      scratch ??= await mkdtemp(join(tmpdir(), "perbo-review-cli-"));
      const systemPromptFile = join(scratch, "system-prompt.txt");
      await writeFile(systemPromptFile, request.system, "utf8");

      const prompt =
        pendingTurnText(request.messages, sent) +
        (request.forceSubmit
          ? "\n\nSubmit now: set next to submit_review and fill review with one coverage entry " +
            "per criterion. No further reads."
          : "");

      const args = [
        "-p",
        "--model",
        modelId,
        ...(options.effort ? ["--effort", options.effort] : []),
        // No built-in tools: file access goes back through RepoReader, and the
        // reviewer has no execution surface.
        "--tools",
        "",
        // The executor adapter's suppression set (ADR-0030): user settings
        // only, every customisation off, no tool server, no hook and no slash
        // command.
        "--setting-sources",
        "user",
        "--safe-mode",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--settings",
        '{"disableAllHooks":true}',
        "--disable-slash-commands",
        "--output-format",
        "json",
        "--json-schema",
        schema,
      ];
      // `--resume` names this review's own session and never `--continue`,
      // which would pick up whatever the user last ran. The system prompt goes
      // on every turn: a resumed session does not carry it, and a reviewer turn
      // without it runs with no criteria, no trust tiers and no verdict rules.
      if (resuming) {
        args.push("--resume", id);
      } else {
        args.push("--session-id", id);
      }
      // Neither the system prompt nor the prompt is an argument: one is a file
      // this review owns, the other arrives on stdin. A file the reviewer reads
      // can hold a NUL byte or more bytes than `ARG_MAX`, and argv can hold
      // neither — which is how one NUL ended AYO-33's review (SCP-188).
      args.push("--system-prompt-file", systemPromptFile);

      let stdout: string;
      try {
        stdout = await runCli(
          binary,
          args,
          {
            cwd,
            maxBuffer: 64 * 1024 * 1024,
            timeout: options.timeoutMs ?? 600_000,
            // The reviewer's own credential resolution, from HOME or the API
            // key variable. Nothing else from the caller's environment is
            // visible.
            env: environment.env,
          },
          prompt,
        );
      } catch (error) {
        const failure = error as { message?: string; stderr?: string; killed?: boolean };
        if (failure.killed) {
          throw new ProviderError("the claude CLI timed out", 1, "timeout");
        }
        const said = (failure.stderr ?? "").trim() || (failure.message ?? "");
        throw new ProviderError(
          `the claude CLI failed: ${providerFailureText(said, [prompt, request.system])}`,
          1,
          "provider_unavailable",
        );
      }

      let parsed: CliResult;
      try {
        parsed = JSON.parse(stdout) as CliResult;
      } catch {
        throw new ProviderError(
          "the claude CLI did not return a JSON result envelope",
          1,
          "provider_unavailable",
        );
      }
      if (parsed.is_error) {
        throw new ProviderError(
          `the claude CLI reported an error (api status ${parsed.api_error_status ?? "none"})`,
          1,
          "provider_unavailable",
        );
      }
      // Advanced only for a turn the process actually received, so a failure
      // that the caller retries does not skip the conversation past it.
      sent = request.messages.length;

      const usage = {
        input_tokens: parsed.usage?.input_tokens ?? 0,
        output_tokens: parsed.usage?.output_tokens ?? 0,
        cache_read_input_tokens: parsed.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: parsed.usage?.cache_creation_input_tokens ?? 0,
      };
      // The CLI reports what the turn actually cost, which is more honest than
      // recomputing it from tokens at list prices — it includes the harness
      // overhead this transport carries and the SDK one does not.
      const reported_cost_micros =
        typeof parsed.total_cost_usd === "number"
          ? Math.round(parsed.total_cost_usd * 1_000_000)
          : undefined;

      const structured = parsed.structured_output;
      if (!structured) {
        return {
          toolCalls: [],
          usage,
          stop_reason: parsed.stop_reason ?? null,
          ...(reported_cost_micros !== undefined ? { reported_cost_micros } : {}),
        };
      }

      return {
        toolCalls: structuredTurnToolCalls(structured),
        usage,
        stop_reason: "tool_use",
        ...(reported_cost_micros !== undefined ? { reported_cost_micros } : {}),
      };
    },

    /**
     * The review is over: its directory and its transcript both go, and the
     * next review on this model opens a session and a directory of its own.
     */
    async dispose(): Promise<void> {
      const id = sessionId;
      const dir = scratch;
      sessionId = null;
      sent = 0;
      scratch = null;
      if (dir !== null) await rm(dir, { recursive: true, force: true });
      if (id === null) return;
      await removeTranscript(store, id);
    },
  };
}
