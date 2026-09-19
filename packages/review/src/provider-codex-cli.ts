import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { DEFAULT_ENV_ALLOW_LIST, scrubEnvironment } from "@perbo/contracts";
import {
  ProviderError,
  providerFailureText,
  type ModelRequest,
  type ModelTurn,
  type ModelUsage,
  type ReviewModel,
} from "./provider.js";
import {
  lastUserText,
  structuredTurnSchema,
  structuredTurnToolCalls,
  type StructuredTurn,
} from "./provider-structured.js";
import { SUBMIT_REVIEW_TOOL } from "./verdict.js";

const DEFAULT_MODEL = "gpt-5.6-terra";
const TRANSPORT_INSTRUCTIONS =
  "You are a stateless semantic reviewer. Do not call tools: none are available. " +
  "Return only JSON matching the supplied schema. Choose read_files to ask the " +
  "orchestrator for repository files, or submit_review to return the verdict.";

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
}

interface ThreadStartResult {
  thread?: { id?: string };
  model?: string;
  instructionSources?: unknown;
}

interface TurnStartResult {
  turn?: { id?: string };
}

interface TokenUsageBreakdown {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

interface TurnState {
  message: string | null;
  usage: TokenUsageBreakdown | null;
  completed: { status?: string; error?: { message?: string } } | null;
  reroutedTo: string | null;
}

export interface CodexCliOptions {
  submitSchema: Record<string, unknown>;
  modelId?: string;
  binary?: string;
  timeoutMs?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** Source Codex home. Only auth.json is linked into an isolated temporary home. */
  codexHome?: string;
}

/**
 * Minimal JSON-RPC client for one ephemeral Codex app-server thread.
 *
 * A dedicated CODEX_HOME is the security boundary here. Merely changing cwd or
 * using an ephemeral thread is insufficient: Codex otherwise loads user skills,
 * plugins and the parent desktop task. The temporary home contains one symlink
 * to auth.json and nothing else, so the credential remains owned and read by
 * Codex while Perbo never opens or serialises it.
 */
class CodexAppServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private readonly timeoutMs: number;
  private readonly codexHome: string;
  private readonly scratch: string;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly turns = new Map<string, TurnState>();
  private readonly turnWaiters = new Map<
    string,
    { resolve: (state: TurnState) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private activeTurnId: string | null = null;
  private stderr = "";
  private closed = false;

  constructor(options: CodexCliOptions) {
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.scratch = mkdtempSync(join(tmpdir(), "perbo-codex-review-"));
    this.codexHome = mkdtempSync(join(tmpdir(), "perbo-codex-home-"));
    chmodSync(this.codexHome, 0o700);

    const sourceHome =
      options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const authFile = join(sourceHome, "auth.json");
    if (!existsSync(authFile)) {
      this.cleanupFiles();
      throw new ProviderError(
        `Codex authentication is unavailable: ${authFile} does not exist`,
        1,
        "provider_unavailable",
      );
    }
    symlinkSync(authFile, join(this.codexHome, "auth.json"));

    // The executor's allow-list, plus the isolated home. Every CODEX_* and
    // OPENAI_* override, and every credential of any other kind, is absent by
    // construction rather than by a list of names someone remembered.
    const { env } = scrubEnvironment({
      base: process.env,
      allow: DEFAULT_ENV_ALLOW_LIST,
      extra: { CODEX_HOME: this.codexHome },
    });

    this.process = spawn(
      options.binary ?? process.env.PERBO_CODEX_BINARY ?? "codex",
      [
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "-c",
        "agents.enabled=false",
        "app-server",
      ],
      {
        cwd: this.scratch,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16_384);
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signal) => {
      if (!this.closed) {
        this.failAll(
          new Error(
            `Codex app-server exited before the review completed (${signal ?? code ?? "unknown"})` +
              (this.stderr.trim() ? `: ${this.stderr.trim()}` : ""),
          ),
        );
      }
    });
  }

  get cwd(): string {
    return this.scratch;
  }

  async start(modelId: string, system: string): Promise<string> {
    await this.request("initialize", {
      clientInfo: {
        name: "perbo_reviewer",
        title: "Perbo semantic reviewer",
        version: "0.1.0",
      },
      capabilities: {
        // runtimeWorkspaceRoots and selectedCapabilityRoots are guarded by
        // this protocol capability. Attestation is not part of this transport.
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
    const started = (await this.request("thread/start", {
      model: modelId,
      allowProviderModelFallback: false,
      cwd: this.scratch,
      runtimeWorkspaceRoots: [this.scratch],
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: system,
      developerInstructions: TRANSPORT_INSTRUCTIONS,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      ephemeral: true,
    })) as ThreadStartResult;

    if (!Array.isArray(started.instructionSources)) {
      throw new ProviderError(
        "Codex did not report the isolated thread's instruction sources",
        1,
        "provider_unavailable",
      );
    }
    const sources = started.instructionSources;
    if (sources.length > 0) {
      throw new ProviderError(
        `Codex loaded instruction files in the isolated reviewer: ${sources.join(", ")}`,
        1,
        "provider_unavailable",
      );
    }
    if (started.model !== modelId) {
      throw new ProviderError(
        `Codex started ${started.model ?? "an unknown model"} instead of registered ${modelId}`,
        1,
        "provider_unavailable",
      );
    }
    const threadId = started.thread?.id;
    if (!threadId) {
      throw new ProviderError(
        "Codex app-server did not return a thread id",
        1,
        "provider_unavailable",
      );
    }
    return threadId;
  }

  async turn(args: {
    threadId: string;
    prompt: string;
    modelId: string;
    effort: CodexCliOptions["effort"];
    schema: Record<string, unknown>;
  }): Promise<{ structured: StructuredTurn | null; usage: ModelUsage; status: string | null }> {
    const started = (await this.request("turn/start", {
      threadId: args.threadId,
      input: [{ type: "text", text: args.prompt, text_elements: [] }],
      cwd: this.scratch,
      runtimeWorkspaceRoots: [this.scratch],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      environments: [],
      model: args.modelId,
      effort: args.effort ?? "medium",
      outputSchema: args.schema,
    })) as TurnStartResult;
    const turnId = started.turn?.id;
    if (!turnId) {
      throw new ProviderError(
        "Codex app-server did not return a turn id",
        1,
        "provider_unavailable",
      );
    }
    this.activeTurnId = turnId;
    const state = await this.waitForTurn(turnId);
    this.activeTurnId = null;

    if (state.reroutedTo !== null) {
      throw new ProviderError(
        `Codex rerouted the registered model to ${state.reroutedTo}`,
        1,
        "provider_unavailable",
      );
    }

    if (state.completed?.status !== "completed") {
      const message = state.completed?.error?.message ?? "Codex turn did not complete";
      const kind = /usage.?limit|budget|quota/i.test(message)
        ? "budget_exhausted"
        : "provider_unavailable";
      throw new ProviderError(message, 1, kind);
    }

    let structured: StructuredTurn | null = null;
    if (state.message !== null) {
      try {
        const parsed = JSON.parse(state.message) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("structured response was not an object");
        }
        structured = parsed as StructuredTurn;
      } catch (error) {
        throw new ProviderError(
          `Codex did not return the constrained JSON result: ${error instanceof Error ? error.message : String(error)}`,
          1,
          "provider_unavailable",
        );
      }
    }

    const raw = state.usage;
    const input = raw?.inputTokens ?? 0;
    const cached = raw?.cachedInputTokens ?? 0;
    return {
      structured,
      usage: {
        // Codex inputTokens includes cache reads and writes. ModelUsage keeps
        // all three disjoint; ReviewArtifact recombines them as total input and
        // retains the cache subsets for audit.
        input_tokens: Math.max(
          0,
          input - cached - (raw?.cacheWriteInputTokens ?? 0),
        ),
        output_tokens: raw?.outputTokens ?? 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: raw?.cacheWriteInputTokens ?? 0,
      },
      status: state.completed.status ?? null,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Codex app-server closed"));
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(new Error("Codex app-server closed"));
    }
    this.turnWaiters.clear();
    this.lines.close();
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    this.cleanupFiles();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError(`Codex app-server timed out during ${method}`, 1, "timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private waitForTurn(turnId: string): Promise<TurnState> {
    const existing = this.turns.get(turnId);
    if (existing?.completed) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new ProviderError("Codex app-server turn timed out", 1, "timeout"));
      }, this.timeoutMs);
      this.turnWaiters.set(turnId, {
        resolve: (state) => {
          clearTimeout(timer);
          resolve(state);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private stateFor(turnId: string): TurnState {
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    const created: TurnState = {
      message: null,
      usage: null,
      completed: null,
      reroutedTo: null,
    };
    this.turns.set(turnId, created);
    return created;
  }

  private handleLine(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      this.failAll(new Error("Codex app-server emitted non-JSON output"));
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new ProviderError(
            `Codex app-server request failed: ${message.error.message ?? message.error.code ?? "unknown"}`,
            1,
            "provider_unavailable",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const params = message.params as
      | {
          turnId?: string;
          item?: { type?: string; text?: string };
          tokenUsage?: { last?: TokenUsageBreakdown };
          turn?: { id?: string; status?: string; error?: { message?: string } };
          toModel?: string;
        }
      | undefined;
    const turnId = params?.turnId ?? params?.turn?.id ?? this.activeTurnId;
    if (!turnId) return;
    const state = this.stateFor(turnId);

    if (message.method === "item/completed" && params?.item?.type === "agentMessage") {
      state.message = params.item.text ?? null;
    } else if (message.method === "thread/tokenUsage/updated") {
      state.usage = params?.tokenUsage?.last ?? null;
    } else if (message.method === "model/rerouted") {
      state.reroutedTo = params?.toModel ?? "an unknown model";
    } else if (message.method === "turn/completed") {
      state.completed = params?.turn ?? { status: "failed" };
      const waiter = this.turnWaiters.get(turnId);
      if (waiter) {
        this.turnWaiters.delete(turnId);
        waiter.resolve(state);
      }
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(error);
    }
    this.turnWaiters.clear();
  }

  private cleanupFiles(): void {
    rmSync(this.codexHome, { recursive: true, force: true });
    rmSync(this.scratch, { recursive: true, force: true });
  }
}

export function codexCliModel(options: CodexCliOptions): ReviewModel {
  const modelId = options.modelId ?? DEFAULT_MODEL;
  const schema = structuredTurnSchema(options.submitSchema);
  let server: CodexAppServer | null = null;
  let threadId: string | null = null;

  const close = () => {
    server?.close();
    server = null;
    threadId = null;
  };

  return {
    provider: "codex-cli",
    model_id: modelId,
    // The ChatGPT transport reports tokens but not a per-review dollar value.
    // runReview records that as unavailable rather than applying Claude prices.
    unreported_cost_basis: "unavailable",
    async turn(request: ModelRequest): Promise<ModelTurn> {
      // Held outside the try so the catch can check that a failure did not
      // quote it back. The prompt carries whole files (SCP-188).
      let prompt = "";
      try {
        if (server === null) {
          server = new CodexAppServer(options);
          threadId = await server.start(modelId, request.system);
        }
        if (threadId === null) {
          throw new ProviderError(
            "Codex reviewer has no active thread",
            1,
            "provider_unavailable",
          );
        }
        prompt =
          lastUserText(request) +
          (request.forceSubmit
            ? "\n\nSubmit now: set next to submit_review and fill review with one coverage entry " +
              "per criterion. No further reads."
            : "");
        const result = await server.turn({
          threadId,
          prompt,
          modelId,
          effort: options.effort ?? "medium",
          schema,
        });
        const toolCalls = result.structured
          ? structuredTurnToolCalls(result.structured)
          : [];
        // The thread closes when the review has actually been submitted, or
        // when the caller forced one. `next: "submit_review"` with no review
        // is a turn that submitted nothing; closing on it would start the
        // next turn in a fresh thread that never saw the plan or the diff.
        if (
          request.forceSubmit ||
          toolCalls.some((call) => call.name === SUBMIT_REVIEW_TOOL)
        ) {
          close();
        }
        return {
          toolCalls,
          usage: result.usage,
          stop_reason: toolCalls.length > 0 ? "tool_use" : result.status,
        };
      } catch (error) {
        close();
        if (error instanceof ProviderError) throw error;
        // The app-server's stderr comes through here, and a review record may
        // not quote what the review was reading.
        throw new ProviderError(
          providerFailureText(error instanceof Error ? error.message : String(error), [
            prompt,
            request.system,
          ]),
          1,
          "provider_unavailable",
        );
      }
    },
  };
}
