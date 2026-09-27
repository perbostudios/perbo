import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_ENV_ALLOW_LIST,
  interviewSaidMessage,
  OPENCODE_ACP_ARGV,
  OPENCODE_API_KEY_ENV,
  OPENCODE_BUILTIN_MODES,
  OPENCODE_SESSION_ATTEMPTS,
  OPENCODE_SESSION_RETRY_MS,
  opencodeConfig,
  opencodeEnvironment,
  opencodeInstructionsPath,
  scrubEnvironment,
} from "@perbo/contracts";
import {
  INTERVIEW_SERVER_NAME,
  type InterviewBoundTool,
  type InterviewSession,
  type InterviewStreamed,
  type InterviewTransport,
} from "./index.js";
import { UsageError } from "../../usage-error.js";

/**
 * The interview on OpenCode: the person's session over `opencode acp`
 * (D-102, D-NEW-opencode-is-a-provider).
 *
 * OpenCode runs its own reads, commands and file changes under the chat's
 * permission rules, which ask this client about every command, every file
 * change and every call reaching outside the checkout, and deny every other
 * tool of OpenCode's own. Each question is answered by
 * {@link InterviewSession.decide} — the interview's own rules — and never put
 * to the person: `once` where the rules admit the call and `reject` where they
 * refuse it, never `always`, so the next call of the same shape is judged
 * again. A refusal ends OpenCode's turn, so the transport starts the next one
 * itself with the refusals in its own words, and the person's turn ends when a
 * turn ends of its own accord.
 *
 * The chat's own tools are served to the session as a tool server on the
 * loopback interface, over MCP's HTTP transport, behind a bearer token minted
 * for this process, and named in the session's own configuration
 * (`opencodeConfig`): every call is judged by the same rules under the name
 * the other transports use (`mcp__perbo_interview__<tool>`) before it runs.
 *
 * OpenCode keeps its sessions in its data directory, and in the same database
 * the "always allow" rules a client gave it, which decide a call before any
 * client is asked. So the chat's data directory is Perbo's own, outside the
 * checkout where a repository could commit one: `~/.perbo/opencode/` and a
 * directory per repository ({@link openCodeDataDirectory}), mode 0700, which
 * the transport refuses to start in where it holds anything Perbo did not
 * create ({@link claimOpenCodeDataDirectory}). `--session` continues a session
 * from there through ACP's `session/resume`; every other directory OpenCode
 * reads is fresh per process, and no credential or "always allow" rule is
 * ever written to any of them, because this client never answers `always`.
 */

/** The file that says a data directory is one Perbo made, and for which repository. */
export const OPENCODE_DATA_MARKER = ".perbo-opencode";

/**
 * The one directory OpenCode 2 writes in its data directory, `$XDG_DATA_HOME`:
 * everything it keeps lives under `opencode/`.
 */
const OPENCODE_DATA_ROOT = "opencode";

/**
 * What OpenCode 2 writes under `opencode/` in its data directory: its database
 * and the directories it keeps logs, shells, snapshots, tool output and
 * worktrees in (measured on 2.0.14). Anything else there is something Perbo
 * did not see OpenCode write — a copied `auth.json`, which OpenCode imports as
 * a credential, among them — and the chat refuses to start over it.
 */
const OPENCODE_DATA_ENTRIES = new Set([
  "opencode.db",
  "opencode.db-shm",
  "opencode.db-wal",
  "opencode.db-journal",
  "log",
  "repos",
  "shell",
  "snapshot",
  "tool-output",
  "worktree",
]);

/**
 * Where the chat keeps OpenCode's data for the repository at `repositoryRoot`:
 * under the person's own `~/.perbo/opencode/`, named by the repository's
 * basename and a digest of its path, as the run's worktrees are, so two
 * checkouts with one name keep two.
 */
export function openCodeDataDirectory(repositoryRoot: string, home: string = homedir()): string {
  const digest = createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 12);
  return join(home, ".perbo", "opencode", `${basename(repositoryRoot)}-${digest}`);
}

/**
 * Make, or take up again, the chat's OpenCode data directory for
 * `repositoryRoot`, refusing where it holds anything Perbo did not create:
 * one that is a link, is not this user's, is open to anyone else, carries no
 * marker of Perbo's naming this repository while holding anything at all, or
 * holds an entry Perbo does not recognise from OpenCode 2.0.14.
 *
 * Whether the directory is open to others is read from its mode bits, which
 * Windows does not keep — Node reports group and other bits there whatever the
 * access list says — so on Windows the directory rests on the permissions of
 * the user's profile it sits in, as it rests without a uid check wherever
 * Node offers none.
 */
export function claimOpenCodeDataDirectory(
  directory: string,
  repositoryRoot: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const refuse = (why: string): never => {
    throw new UsageError(
      `the chat's OpenCode data directory ${directory} ${why}, so it may hold approvals Perbo did not give; ` +
        "remove it and run this again",
    );
  };
  const unrecognised = (entry: string): never => {
    throw new UsageError(
      `the chat's OpenCode data directory ${directory} holds ${entry}, which Perbo does not recognise from ` +
        `OpenCode 2.0.14; remove ${directory} to start the chat afresh; its saved sessions go with it`,
    );
  };
  const marker = join(directory, OPENCODE_DATA_MARKER);
  const claim = JSON.stringify({ created_by: "perbo", repository: repositoryRoot });
  if (!existsSync(directory)) {
    mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(marker, claim, { mode: 0o600 });
    return;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) refuse("is not a directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) refuse("belongs to another user");
  if (platform !== "win32" && (stat.mode & 0o077) !== 0) refuse("is open to other users");
  const entries = readdirSync(directory);
  if (entries.length === 0) {
    writeFileSync(marker, claim, { mode: 0o600 });
    return;
  }
  let recorded: unknown;
  try {
    recorded = lstatSync(marker).isFile() ? JSON.parse(readFileSync(marker, "utf8")) : null;
  } catch {
    recorded = null;
  }
  if (
    recorded === null ||
    typeof recorded !== "object" ||
    (recorded as { created_by?: unknown }).created_by !== "perbo" ||
    (recorded as { repository?: unknown }).repository !== repositoryRoot
  )
    refuse("was not made by Perbo for this repository");
  for (const entry of entries)
    if (entry !== OPENCODE_DATA_MARKER && entry !== OPENCODE_DATA_ROOT) unrecognised(entry);
  if (!entries.includes(OPENCODE_DATA_ROOT)) return;
  const root = join(directory, OPENCODE_DATA_ROOT);
  if (!lstatSync(root).isDirectory()) unrecognised(OPENCODE_DATA_ROOT);
  for (const entry of readdirSync(root))
    if (!OPENCODE_DATA_ENTRIES.has(entry)) unrecognised(`${OPENCODE_DATA_ROOT}/${entry}`);
}

export interface OpenCodeInterviewOptions {
  /** The `opencode` to start. */
  binary: string;
  /**
   * Where OpenCode keeps this repository's chat sessions, so a later run
   * continues one: {@link openCodeDataDirectory}, outside the checkout.
   */
  dataDirectory: string;
  env?: NodeJS.ProcessEnv;
}

const ToolCallSchema = z
  .object({
    toolCallId: z.string(),
    title: z.string().nullish(),
    kind: z.string().nullish(),
    rawInput: z.record(z.string(), z.unknown()).nullish(),
    locations: z.array(z.object({ path: z.string() }).loose()).nullish(),
  })
  .loose();
type ToolCall = z.infer<typeof ToolCallSchema>;

const UpdateSchema = z
  .object({
    sessionUpdate: z.string(),
    messageId: z.string().nullish(),
    content: z.object({ text: z.string().optional() }).loose().nullish(),
  })
  .loose();

const EnvelopeSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).loose().optional(),
  params: z.unknown().optional(),
});

const PromptResultSchema = z.object({ stopReason: z.string() }).loose();

export function openCodeInterviewTransport(options: OpenCodeInterviewOptions): InterviewTransport {
  return { run: (session) => runOpenCodeInterview(options, session) };
}

async function* runOpenCodeInterview(
  options: OpenCodeInterviewOptions,
  session: InterviewSession,
): AsyncIterable<InterviewStreamed> {
  claimOpenCodeDataDirectory(options.dataDirectory, session.cwd);
  const tools = await serveInterviewTools(session);
  const connection = new AcpClient(options, session, tools);
  try {
    const id = await connection.open(session);
    yield { session_id: id };
    for await (const streamed of connection.converse(id, session)) yield streamed;
    yield { reason: "the session ended" };
  } finally {
    connection.close();
    tools.close();
  }
}

/** The string at `key` of a call's input, where it is one. */
function text(input: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Every path a file change names — the locations OpenCode reports, the file
 * the tool was handed, each file of a multi-file change and where a move
 * lands, and every header of a patch — so the change is judged on each.
 */
export function openCodeLandings(call: ToolCall, cwd: string): string[] {
  const input = call.rawInput ?? {};
  const files = Array.isArray(input["files"]) ? (input["files"] as unknown[]) : [];
  const patch = text(input, "patchText") ?? "";
  const named = [
    ...(call.locations ?? []).map((location) => location.path),
    ...["path", "filePath", "filepath", "movePath"].flatMap((key) => text(input, key) ?? []),
    ...files.flatMap((file) =>
      file !== null && typeof file === "object"
        ? ["file", "path", "movePath"].flatMap((key) => text(file as Record<string, unknown>, key) ?? [])
        : [],
    ),
    ...[...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((found) =>
      (found[1] ?? found[2]!).trim(),
    ),
  ];
  return [...new Set(named.filter((path) => path.length > 0).map((path) => resolve(cwd, path)))];
}

/** The chat's tools on the loopback interface, and what OpenCode is told to reach them with. */
interface ServedTools {
  url: string;
  token: string;
  /** Settled once OpenCode has listed the tools, which is when it can offer them to a turn. */
  listed: Promise<void>;
  close(): void;
}

/**
 * How long a session waits for OpenCode to list the chat's tools before its
 * first turn, and how long after the listing. OpenCode connects to a tool
 * server beside the session rather than before it, and a turn started before
 * the tools are registered is offered none of them (measured on 2.0.14).
 */
const TOOLS_LISTED_WAIT_MS = 20_000;
const TOOLS_REGISTERED_GRACE_MS = 500;

/**
 * The chat's own tools as an MCP server on 127.0.0.1, over the protocol's
 * HTTP transport: each POST carries one JSON-RPC message and is answered with
 * one JSON reply. Only a request carrying this process's token is read; the
 * token and the port are minted here and reach nothing but OpenCode's
 * configuration.
 */
async function serveInterviewTools(session: InterviewSession): Promise<ServedTools> {
  const token = randomBytes(32).toString("base64url");
  let markListed: () => void = () => undefined;
  const listed = new Promise<void>((resolveListed) => {
    markListed = resolveListed;
  });
  const offered = session.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(z.strictObject(tool.shape), { io: "input" }),
  }));
  const answer = async (message: { id?: unknown; method?: unknown; params?: unknown }): Promise<unknown> => {
    const id = message.id ?? null;
    if (message.method === "initialize") {
      const version = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof version === "string" ? version : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: INTERVIEW_SERVER_NAME, version: "0.1.0" },
        },
      };
    }
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") {
      markListed();
      return { jsonrpc: "2.0", id, result: { tools: offered } };
    }
    if (message.method === "tools/call") {
      const call = z
        .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
        .loose()
        .safeParse(message.params);
      if (!call.success) return { jsonrpc: "2.0", id, error: { code: -32602, message: "the interview could not read tools/call" } };
      return { jsonrpc: "2.0", id, result: await callTool(session, call.data.name, call.data.arguments ?? {}) };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `the interview holds no ${String(message.method)}` } };
  };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          response.writeHead(400).end();
          return;
        }
        const messages = (Array.isArray(body) ? body : [body]) as Array<{ id?: unknown; method?: unknown; params?: unknown }>;
        const replies = [];
        for (const message of messages) if (message.id !== undefined) replies.push(await answer(message));
        if (replies.length === 0) {
          response.writeHead(202).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
      })();
    });
  });
  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the interview's tool server did not listen");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    listed,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * One call to a tool of the chat's own, judged under the name the other
 * transports use before it runs. A name the session does not hold is still
 * put to the rules under that name, and holding no tool of that name declines
 * it.
 */
async function callTool(
  session: InterviewSession,
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tool: InterviewBoundTool | undefined = session.tools.find((each) => each.name === name);
  const named = tool === undefined ? name : `mcp__${INTERVIEW_SERVER_NAME}__${tool.name}`;
  const decided = await session.decide(named, input);
  if (decided.behavior === "deny" || tool === undefined)
    return { content: [{ type: "text", text: decided.behavior === "deny" ? decided.message : named }], isError: true };
  const result = await tool.run(input);
  return { content: result.content, ...(result.isError === true ? { isError: true } : {}) };
}

/** One `opencode acp` child, and the conversation over it. */
class AcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  /** OpenCode's config, state and cache directories and the orientation, fresh for this process. */
  private readonly root: string;
  private readonly session: InterviewSession;
  private readonly tools: ServedTools;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private streamed: InterviewStreamed[] = [];
  private wake: (() => void) | null = null;
  /** What the session is saying, until it has finished saying it. */
  private speaking: { id: string | null; text: string } | null = null;
  /** What the rules refused in the turn in flight, in their own words. */
  private refusals: string[] = [];
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private failure: Error | null = null;
  private closed = false;

  constructor(options: OpenCodeInterviewOptions, session: InterviewSession, tools: ServedTools) {
    this.session = session;
    this.tools = tools;
    this.root = mkdtempSync(join(tmpdir(), "perbo-interview-opencode-"));
    chmodSync(this.root, 0o700);
    for (const directory of ["config", "state", "cache"]) mkdirSync(join(this.root, directory), { mode: 0o700 });
    // The orientation is beside OpenCode's own system prompt, as it is beside
    // Claude's preset and Codex's base instructions: the one instruction file
    // the session reads.
    const orientation = opencodeInstructionsPath(this.root);
    mkdirSync(dirname(orientation), { recursive: true, mode: 0o700 });
    writeFileSync(orientation, session.orientation, { mode: 0o600 });
    const { env } = scrubEnvironment({
      base: options.env ?? process.env,
      allow: [...DEFAULT_ENV_ALLOW_LIST, OPENCODE_API_KEY_ENV],
      extra: {
        ...opencodeEnvironment(
          this.root,
          opencodeConfig("interview", {
            url: tools.url,
            token: tools.token,
            names: session.tools.map((tool) => tool.name),
          }),
        ),
        XDG_DATA_HOME: options.dataDirectory,
      },
    });
    this.child = spawn(options.binary, [...OPENCODE_ACP_ARGV], {
      cwd: session.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8192);
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => {
      if (!this.closed) this.fail(new Error(`opencode stopped before the interview ended (${code ?? "signal"}): ${this.stderr}`));
    });
  }

  /** Start or continue the session and answer with its id. */
  async open(session: InterviewSession): Promise<string> {
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "perbo_interview", version: "0.1.0" },
    });
    const opened = z
      .object({
        sessionId: z.string().optional(),
        configOptions: z
          .array(
            z
              .object({ id: z.string(), options: z.array(z.object({ value: z.string() }).loose()).optional() })
              .loose(),
          )
          .optional(),
      })
      .loose()
      .parse(
        session.resume === null
          ? await this.retried(() => this.request("session/new", { cwd: session.cwd, mcpServers: [] }))
          : await this.retried(() =>
              this.request("session/resume", { sessionId: session.resume, cwd: session.cwd, mcpServers: [] }),
            ),
      );
    const id = session.resume ?? opened.sessionId;
    if (id === undefined) throw new Error("opencode did not name the session it opened");
    // The same assertion the executor and the reviewer make: a primary agent
    // beyond OpenCode's own was loaded from somewhere Perbo did not configure,
    // and its prompt and rules would ride in the chat's session.
    const loaded = (opened.configOptions ?? [])
      .filter((option) => option.id === "mode")
      .flatMap((option) => (option.options ?? []).map((choice) => choice.value))
      .filter((mode) => !(OPENCODE_BUILTIN_MODES as readonly string[]).includes(mode));
    if (loaded.length > 0)
      throw new Error(`OpenCode loaded agent definitions into the chat's session: ${loaded.join(", ")}`);
    await Promise.race([
      this.tools.listed,
      new Promise((resolveLater) => setTimeout(resolveLater, TOOLS_LISTED_WAIT_MS)),
    ]);
    await new Promise((resolveLater) => setTimeout(resolveLater, TOOLS_REGISTERED_GRACE_MS));
    if (session.model !== null) {
      const selected = z
        .object({ configOptions: z.array(z.object({ id: z.string(), currentValue: z.unknown().optional() }).loose()) })
        .loose()
        .parse(await this.request("session/set_config_option", { sessionId: id, configId: "model", value: session.model }));
      const current = selected.configOptions.find((option) => option.id === "model")?.currentValue;
      if (current !== session.model) throw new Error(`opencode selected ${String(current)} instead of ${session.model}`);
    }
    return id;
  }

  /**
   * A session asked for — opened or resumed — before OpenCode's model
   * catalogue has arrived is refused; it is asked again.
   */
  private async retried(open: () => Promise<unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await open();
      } catch (error) {
        if (attempt + 1 >= OPENCODE_SESSION_ATTEMPTS || this.closed) throw error;
        await new Promise((resolveLater) => setTimeout(resolveLater, OPENCODE_SESSION_RETRY_MS));
      }
    }
  }

  /**
   * One person's turn per line they type. A turn OpenCode ended because the
   * rules refused a call is followed by one the transport starts, carrying
   * the refusals; the person's turn is answered when a turn ends otherwise.
   */
  async *converse(sessionId: string, session: InterviewSession): AsyncIterable<InterviewStreamed> {
    for await (const line of session.turns) {
      let text = line;
      while (true) {
        this.refusals = [];
        let outcome: { stopReason: string } | null = null;
        let failure: Error | null = null;
        void this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }).then(
          (result) => {
            outcome = PromptResultSchema.parse(result);
            this.wakeUp();
          },
          (error: unknown) => {
            failure = error instanceof Error ? error : new Error(String(error));
            this.wakeUp();
          },
        );
        while (true) {
          while (this.streamed.length > 0) yield this.streamed.shift()!;
          if (outcome !== null || failure !== null) break;
          await new Promise<void>((wake) => {
            this.wake = wake;
          });
        }
        this.finishSpeaking();
        while (this.streamed.length > 0) yield this.streamed.shift()!;
        if (failure !== null) throw failure;
        const ended = outcome as { stopReason: string } | null;
        if (ended?.stopReason === "cancelled" && this.refusals.length > 0) {
          text =
            "The interview refused these calls:\n" +
            this.refusals.map((refusal) => `- ${refusal}`).join("\n") +
            "\nContinue within those limits.";
          continue;
        }
        if (ended !== null && ended.stopReason !== "end_turn")
          yield { message: { type: "opencode", stopReason: ended.stopReason } };
        break;
      }
      // Every turn that ends hands the next word to the person, and it
      // answered one of theirs (D-119).
      yield { idle: 1 };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("the interview closed the session"));
    this.child.stdin.end();
    if (this.child.pid) {
      try {
        if (process.platform !== "win32") process.kill(-this.child.pid, "SIGTERM");
        else this.child.kill("SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    rmSync(this.root, { recursive: true, force: true });
  }

  private wakeUp(): void {
    this.wake?.();
    this.wake = null;
  }

  private say(streamed: InterviewStreamed): void {
    this.streamed.push(streamed);
    this.wakeUp();
  }

  private finishSpeaking(): void {
    const said = this.speaking;
    this.speaking = null;
    if (said !== null && said.text.trim() !== "") this.say({ message: interviewSaidMessage(said.text) });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolveReply, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolveReply, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.wakeUp();
  }

  private receive(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) void this.line(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private async line(line: string): Promise<void> {
    let message: z.infer<typeof EnvelopeSchema>;
    try {
      message = EnvelopeSchema.parse(JSON.parse(line));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      await this.answer(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "opencode refused the request"));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "session/update") this.updated(message.params);
  }

  /** One update: what the session is saying, and what it is doing. */
  private updated(params: unknown): void {
    const parsed = z.object({ update: UpdateSchema }).loose().safeParse(params);
    if (!parsed.success) return;
    const update = parsed.data.update;
    if (update.sessionUpdate === "agent_message_chunk") {
      const id = update.messageId ?? null;
      if (this.speaking !== null && this.speaking.id !== id) this.finishSpeaking();
      this.speaking ??= { id, text: "" };
      this.speaking.text += update.content?.text ?? "";
      return;
    }
    // A step's words stream around its tool calls, so a call does not end
    // what the session is saying: the next message, or the turn's end, does.
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
      this.say({ message: { type: "opencode", ...(update as Record<string, unknown>) } });
  }

  /**
   * One request from OpenCode, answered by the interview's rules. Every
   * permission goes to {@link InterviewSession.decide}, which emits the
   * refusal where there is one; a request of any other method is refused under
   * the name OpenCode used for it, because the interview offers no such thing.
   */
  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    if (method !== "session/request_permission") {
      await this.session.decide(method, {});
      this.reply(id, { error: { code: -32601, message: `the interview holds no ${method}` } });
      return;
    }
    const request = z.object({ toolCall: ToolCallSchema }).loose().safeParse(params);
    const refusal = request.success ? await this.judge(request.data.toolCall) : await this.refuse(method);
    if (refusal !== null) this.refusals.push(refusal);
    this.reply(id, { result: { outcome: { outcome: "selected", optionId: refusal === null ? "once" : "reject" } } });
  }

  /** A request the rules cannot be asked about, refused under its own name. */
  private async refuse(name: string): Promise<string> {
    const decided = await this.session.decide(name, {});
    return decided.behavior === "deny" ? decided.message : `${name} is not a call the interview answers`;
  }

  /**
   * What the rules say about one call, by its kind: a command as a `Bash`
   * where OpenCode is about to run it, a file change as a `Write` on every
   * path it lands on, and a read outside the checkout as a `Read`. Null where
   * they admit it, and the refusal's words otherwise.
   */
  private async judge(call: ToolCall): Promise<string | null> {
    const kind = call.kind ?? "other";
    const input = call.rawInput ?? {};
    if (kind === "execute") {
      const decided = await this.session.decide(
        "Bash",
        { command: text(input, "command") ?? "" },
        text(input, "cwd") ?? this.session.cwd,
      );
      return decided.behavior === "deny" ? decided.message : null;
    }
    if (kind === "edit" || kind === "delete" || kind === "move") {
      const landing = openCodeLandings(call, this.session.cwd);
      if (landing.length === 0) return this.refuse("Write");
      let refusal: string | null = null;
      for (const path of landing) {
        const decided = await this.session.decide("Write", { file_path: path });
        if (decided.behavior === "deny") refusal = refusal ?? decided.message;
      }
      return refusal;
    }
    if (kind === "read" || kind === "search") {
      const paths = (call.locations ?? []).map((location) => location.path);
      if (paths.length === 0) return this.refuse("Read");
      for (const path of paths) {
        const decided = await this.session.decide("Read", { file_path: resolve(this.session.cwd, path) });
        if (decided.behavior === "deny") return decided.message;
      }
      return null;
    }
    return this.refuse(call.title ?? kind);
  }

  private reply(id: number | string, body: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`, (error) => {
      if (error) this.fail(error);
    });
  }
}
