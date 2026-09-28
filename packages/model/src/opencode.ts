import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import {
  DEFAULT_ENV_ALLOW_LIST,
  OPENCODE_ACP_ARGV,
  OPENCODE_API_KEY_ENV,
  OPENCODE_BUILTIN_MODES,
  OPENCODE_SESSION_ATTEMPTS,
  OPENCODE_SESSION_RETRY_MS,
  awaitOpenCodeModel,
  opencodeConfig,
  opencodeEnvironment,
  opencodeInstructionsPath,
  scrubEnvironment,
} from "@perbo/contracts";
import { DEFAULT_OPENCODE_MODEL } from "./defaults.js";
import { ProviderError, providerFailureText } from "./failure.js";
import {
  lastUserText,
  structuredTurnSchema,
  structuredTurnToolCalls,
  type StructuredTurn,
} from "./structured.js";
import { SUBMIT_REVIEW_TOOL, type Model, type ModelRequest, type ModelTurn } from "./turn.js";
import type { ModelUsage } from "./usage.js";

/**
 * The reviewer on OpenCode, through `opencode acp`
 * (D-134): one session per conversation, holding no
 * tool at all, in a scratch directory of its own.
 *
 * OpenCode's Agent Client Protocol carries no output schema, so nothing
 * constrains the answer to the turn schema as it is decoded. The schema is in
 * the session's instructions instead, and the answer is read only where the
 * whole message is one JSON object — bare, or as the only thing in one fenced
 * block. Nothing is picked out of prose: a message that is anything else fails
 * the turn, and the review with it, rather than being read for a verdict
 * (ADR-0023 §2).
 */

const TRANSPORT_INSTRUCTIONS =
  "You are a stateless semantic reviewer. Do not call tools: none are available. " +
  "Answer every turn with one JSON object and nothing else, matching the JSON Schema below. " +
  "Choose read_files to ask the orchestrator for repository files, or submit_review to return " +
  "the verdict.";

export interface OpenCodeCliOptions {
  submitSchema: Record<string, unknown>;
  /** OpenCode's `provider/model`, as `opencode models` lists it. */
  modelId?: string;
  binary?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface Envelope {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: unknown;
}

interface PromptResult {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  } | null;
}

interface ConfigOption {
  id?: string;
  currentValue?: unknown;
  options?: Array<{ value?: string }>;
}

/**
 * The answer read out of one message: one JSON object, bare or as the only
 * thing in one fenced block. Null for anything else.
 */
export function openCodeStructured(message: string): StructuredTurn | null {
  const trimmed = message.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as StructuredTurn)
      : null;
  } catch {
    return null;
  }
}

/** One `opencode acp` child and the one session the conversation runs in. */
class OpenCodeAcp {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private readonly timeoutMs: number;
  private readonly root: string;
  private readonly scratch: string;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;
  private stderr = "";
  private closed = false;
  /** Why the process ended, once it has: every request from then on is refused with it at once. */
  private stopped: Error | null = null;
  /** The rejections that are OpenCode's own answer refusing a request, rather than the transport failing. */
  private readonly openCodeRefusals = new WeakSet<Error>();
  /** The message the turn in flight is saying, by its id, the last one kept. */
  private message: { id: string | null; text: string } | null = null;
  /** OpenCode's running total for the session, in dollars, as its last usage update said. */
  cost: number | null = null;
  /** Whether the turn in flight has seen a tool call, which this session holds none of. */
  toolCalled = false;

  constructor(options: OpenCodeCliOptions, system: string, schema: Record<string, unknown>) {
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.root = mkdtempSync(join(tmpdir(), "perbo-opencode-review-"));
    chmodSync(this.root, 0o700);
    this.scratch = join(this.root, "scratch");
    for (const directory of ["scratch", "config", "data", "state", "cache"])
      mkdirSync(join(this.root, directory), { mode: 0o700 });
    // The system prompt and the transport's own instructions travel as a
    // file, as the other transports' system prompts do: a file the caller
    // opened can hold more than an environment variable should. It is the one
    // instruction file the session reads.
    const instructions = opencodeInstructionsPath(this.root);
    mkdirSync(dirname(instructions), { recursive: true, mode: 0o700 });
    writeFileSync(
      instructions,
      `${system}\n\n${TRANSPORT_INSTRUCTIONS}\n\n${JSON.stringify(schema, null, 2)}\n`,
      { mode: 0o600 },
    );
    // The executor's allow-list and OpenCode Zen's key, by name. Every other
    // credential is absent by construction.
    const { env } = scrubEnvironment({
      base: options.env ?? process.env,
      allow: [...DEFAULT_ENV_ALLOW_LIST, OPENCODE_API_KEY_ENV],
      extra: opencodeEnvironment(this.root, opencodeConfig("reviewer")),
    });
    this.process = spawn(
      options.binary ?? process.env.PERBO_OPENCODE_BINARY ?? "opencode",
      [...OPENCODE_ACP_ARGV],
      { cwd: this.scratch, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    // A write to a process that has gone fails here; the exit says why it went.
    this.process.stdin.on("error", () => undefined);
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16_384);
    });
    this.process.on("error", (error) => {
      this.stopped = error;
      this.failAll(error);
    });
    this.process.on("exit", (code, signal) => {
      if (this.closed) return;
      this.stopped = new Error(
        `OpenCode exited before the review completed (${signal ?? code ?? "unknown"})` +
          (this.stderr.trim() ? `: ${this.stderr.trim()}` : ""),
      );
      this.failAll(this.stopped);
    });
  }

  /** Initialise, open the session and select `modelId`; the session's id. */
  async start(modelId: string): Promise<string> {
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "perbo_reviewer", version: "0.1.0" },
    });
    // The scratch session's catalogue snapshot settles on `modelId` before the
    // review's own session is opened (`awaitOpenCodeModel`).
    await awaitOpenCodeModel({
      model: modelId,
      scratch: () => mkdtempSync(join(this.root, "catalogue-")),
      request: (method, params) => this.request(method, params),
      refused: (error) => this.refused(error),
    });
    const opened = await this.openSession();
    const sessionId = opened?.sessionId;
    if (!sessionId)
      throw new ProviderError("OpenCode did not return a session id", 1, "provider_unavailable");
    const modes = (opened?.configOptions ?? [])
      .filter((option) => option.id === "mode")
      .flatMap((option) => (option.options ?? []).map((choice) => choice.value ?? ""));
    const loaded = modes.filter((mode) => !(OPENCODE_BUILTIN_MODES as readonly string[]).includes(mode));
    if (loaded.length > 0)
      throw new ProviderError(
        `OpenCode loaded agent definitions in the isolated reviewer: ${loaded.join(", ")}`,
        1,
        "provider_unavailable",
      );
    const selected = (await this.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: modelId,
    })) as { configOptions?: ConfigOption[] } | null;
    const current = selected?.configOptions?.find((option) => option.id === "model")?.currentValue;
    if (current !== modelId)
      throw new ProviderError(
        `OpenCode selected ${String(current ?? "an unknown model")} instead of registered ${modelId}`,
        1,
        "provider_unavailable",
      );
    return sessionId;
  }

  /**
   * `session/new` in the scratch directory, with no tool server. OpenCode
   * refuses a session asked for before its model catalogue has arrived; it is
   * asked again (`OPENCODE_SESSION_ATTEMPTS`, `OPENCODE_SESSION_RETRY_MS`
   * apart). Any other failure is thrown at once.
   */
  private async openSession(): Promise<{ sessionId?: string; configOptions?: ConfigOption[] } | null> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await this.request("session/new", { cwd: this.scratch, mcpServers: [] })) as {
          sessionId?: string;
          configOptions?: ConfigOption[];
        } | null;
      } catch (error) {
        if (!this.refused(error) || attempt + 1 >= OPENCODE_SESSION_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, OPENCODE_SESSION_RETRY_MS));
      }
    }
  }

  /** Whether a request's rejection is OpenCode's own answer refusing it. */
  private refused(error: unknown): boolean {
    return error instanceof Error && this.openCodeRefusals.has(error);
  }

  /** What the turn in flight has said last. */
  private said(): string | null {
    return this.message?.text ?? null;
  }

  /** One turn: what the session said last, and how the turn ended. */
  async turn(sessionId: string, prompt: string): Promise<{ message: string | null; result: PromptResult }> {
    this.message = null;
    this.toolCalled = false;
    const result = (await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    })) as PromptResult;
    return { message: this.said(), result };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("OpenCode closed"));
    }
    this.pending.clear();
    this.lines.close();
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    rmSync(this.root, { recursive: true, force: true });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("OpenCode is closed"));
    if (this.stopped !== null) return Promise.reject(this.stopped);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError(`OpenCode timed out during ${method}`, 1, "timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let message: Envelope;
    try {
      message = JSON.parse(line) as Envelope;
    } catch {
      this.failAll(new Error("OpenCode emitted non-JSON output"));
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      // The reviewer holds no tool, and offers OpenCode no file system and no
      // terminal: a permission is rejected and anything else is refused.
      this.process.stdin.write(
        `${JSON.stringify(
          message.method === "session/request_permission"
            ? { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: "reject" } } }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `the reviewer offers no ${message.method}` } },
        )}\n`,
      );
      if (message.method === "session/request_permission") this.toolCalled = true;
      return;
    }
    if (message.id !== undefined) {
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.error) {
        const refusal = new ProviderError(
          `OpenCode request failed: ${message.error.message ?? "unknown"}`,
          1,
          /usage.?limit|budget|quota|insufficient|credit/i.test(message.error.message ?? "")
            ? "budget_exhausted"
            : "provider_unavailable",
        );
        this.openCodeRefusals.add(refusal);
        pending.reject(refusal);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method !== "session/update") return;
    const update = (message.params as { update?: Record<string, unknown> } | undefined)?.update;
    if (!update) return;
    if (update["sessionUpdate"] === "agent_message_chunk") {
      const id = typeof update["messageId"] === "string" ? update["messageId"] : null;
      const content = update["content"] as { text?: unknown } | undefined;
      const text = typeof content?.text === "string" ? content.text : "";
      if (this.message === null || this.message.id !== id) this.message = { id, text };
      else this.message.text += text;
    } else if (update["sessionUpdate"] === "usage_update") {
      const cost = update["cost"] as { amount?: unknown; currency?: unknown } | undefined;
      if (typeof cost?.amount === "number" && cost.currency === "USD") this.cost = cost.amount;
    } else if (update["sessionUpdate"] === "tool_call") {
      this.toolCalled = true;
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

export function openCodeCliModel(options: OpenCodeCliOptions): Model {
  const modelId = options.modelId ?? DEFAULT_OPENCODE_MODEL;
  const schema = structuredTurnSchema(options.submitSchema);
  let server: OpenCodeAcp | null = null;
  let sessionId: string | null = null;
  /** The session's running dollars before the turn in flight, for what the turn itself cost. */
  let costBefore = 0;

  const close = () => {
    server?.close();
    server = null;
    sessionId = null;
    costBefore = 0;
  };

  return {
    provider: "opencode-cli",
    model_id: modelId,
    // A turn with no usage update from OpenCode has no dollars, and no list
    // price stands in for a model that may not be Claude.
    unreported_cost_basis: "unavailable",
    async turn(request: ModelRequest): Promise<ModelTurn> {
      let prompt = "";
      try {
        if (server === null) {
          server = new OpenCodeAcp(options, request.system, schema);
          sessionId = await server.start(modelId);
        }
        if (sessionId === null)
          throw new ProviderError("OpenCode reviewer has no active session", 1, "provider_unavailable");
        prompt =
          lastUserText(request) +
          (request.forceSubmit
            ? "\n\nSubmit now: set next to submit_review and fill review with one coverage entry " +
              "per criterion. No further reads."
            : "");
        const { message, result } = await server.turn(sessionId, prompt);
        if (server.toolCalled)
          throw new ProviderError("OpenCode offered the isolated reviewer a tool", 1, "provider_unavailable");
        if (result.stopReason !== "end_turn")
          throw new ProviderError(
            `OpenCode ended the turn: ${result.stopReason ?? "without a reason"}`,
            1,
            "provider_unavailable",
          );
        const structured = message === null ? null : openCodeStructured(message);
        if (message !== null && structured === null)
          throw new ProviderError(
            "OpenCode did not answer with one JSON object",
            1,
            "provider_unavailable",
          );
        const toolCalls = structured ? structuredTurnToolCalls(structured) : [];
        const reported = result.usage ?? {};
        const usage: ModelUsage = {
          input_tokens: reported.inputTokens ?? 0,
          output_tokens: reported.outputTokens ?? 0,
          cache_read_input_tokens: reported.cachedReadTokens ?? 0,
          cache_creation_input_tokens: reported.cachedWriteTokens ?? 0,
        };
        const cost = server.cost;
        const turnCost = cost === null ? null : Math.max(0, Math.round((cost - costBefore) * 1_000_000));
        if (cost !== null) costBefore = cost;
        // The session closes once the review is submitted, or when the caller
        // forced one; a turn that submitted nothing keeps it, so the next turn
        // is taken in the session that saw the plan and the diff.
        if (request.forceSubmit || toolCalls.some((call) => call.name === SUBMIT_REVIEW_TOOL)) close();
        return {
          toolCalls,
          usage,
          stop_reason: toolCalls.length > 0 ? "tool_use" : (result.stopReason ?? null),
          ...(turnCost === null ? {} : { reported_cost_micros: turnCost }),
        };
      } catch (error) {
        close();
        if (error instanceof ProviderError) throw error;
        // OpenCode's stderr comes through here, and a review record may not
        // quote what the review was reading.
        throw new ProviderError(
          providerFailureText(error instanceof Error ? error.message : String(error), [prompt, request.system]),
          1,
          "provider_unavailable",
        );
      }
    },
    async dispose() {
      close();
    },
  };
}
