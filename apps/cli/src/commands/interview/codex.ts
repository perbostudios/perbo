import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_ENV_ALLOW_LIST, scrubEnvironment } from "@perbo/contracts";
import { interviewSaidMessage } from "@perbo/contracts/interview-protocol";
import { UsageError } from "../../usage-error.js";
import {
  INTERVIEW_SERVER_NAME,
  type InterviewSession,
  type InterviewStreamed,
  type InterviewTransport,
} from "./index.js";

/**
 * The interview on Codex: the person's own session over `codex app-server`
 * (D-102, SCP-312).
 *
 * Codex executes its own reads, commands and patches, and asks this client
 * before each act its sandbox does not already permit. That question is the
 * seam: it is answered by {@link InterviewSession.decide} — the interview's
 * own rules — and never put to the person, which is what "refused rather than
 * asked" means on this transport. Three settings make the seam whole, quoted
 * from the app server's own protocol as `codex app-server generate-json-schema`
 * emits it:
 *
 * - `sandbox: "read-only"`, so no write happens without an approval to
 *   escalate it, and `approvalPolicy: "untrusted"`, which `codex --help` at
 *   0.145.0 defines as "Only run "trusted" commands (e.g. ls, cat, sed)
 *   without asking for user approval. Will escalate to the user if the model
 *   proposes a command that is not in the "trusted" set". So Codex runs the
 *   commands it trusts as read-only without asking, and every other command
 *   reaches this client — the shape the Claude transport has too, whose
 *   classifier runs a read-only `Bash` line without consulting the guard.
 * - `approvalsReviewer` "[c]onfigures who approval requests are routed to for
 *   review … Defaults to `user`. `auto_review` uses a carefully prompted
 *   subagent to gather relevant context and apply a risk-based decision
 *   framework before approving or denying the request." The `user` here is the
 *   client program, which is this file, and it is named rather than left to
 *   the default so that no model of Codex's own is ever the one answering.
 *
 * `dynamicTools` is how the interview's own tools reach the thread, and it is
 * the one field here the generated schema does not carry: the pinned Codex
 * (0.145.0) holds it behind the `experimentalApi` capability that
 * `initialize` asks for, which is also how the runner's executor passes it.
 * A call to one arrives as the `item/tool/call` request. That schema names
 * the field on `thread/start` alone; it is sent on `thread/resume` as well,
 * and whether a resumed thread keeps the tools it was started with rests on
 * the server, which nothing here drives.
 *
 * Anything the rules do not admit is refused: a request of a shape this
 * client is not built to answer is declined with the method not found, and
 * reported as a refusal, rather than guessed at.
 */

/**
 * How the app server is started.
 *
 * `agents.enabled=false` because ADR-0038's subagents are not built here and a
 * child thread's approvals would arrive tagged with a thread this session does
 * not know; `web_search="disabled"` because the interview reads the repository
 * and asks the person, not the internet.
 */
export const CODEX_INTERVIEW_ARGV = [
  "-c",
  "agents.enabled=false",
  "-c",
  'model_provider="openai"',
  "-c",
  'web_search="disabled"',
  "app-server",
] as const;

/**
 * The five requests the app server makes of a client, and what the interview
 * does with each.
 *
 * The two under `item/` are how a turn started by `turn/start` asks; the two
 * without a prefix are the same two questions in the app server's older shape,
 * and they take a different answer — `approved`, or `denied` with the words to
 * say — so both are answered rather than one being met with silence.
 */
const APPROVALS = {
  command: "item/commandExecution/requestApproval",
  fileChange: "item/fileChange/requestApproval",
  legacyCommand: "execCommandApproval",
  legacyPatch: "applyPatchApproval",
} as const;

/**
 * What the interview reads out of an approval request.
 *
 * A file change carries no path: the paths are on the item the server
 * announced before asking, which is why the items are kept. A command carries
 * its own, and the item carries it too.
 */
const ApprovalSchema = z
  .object({
    itemId: z.string().optional(),
    callId: z.string().optional(),
    command: z.union([z.string(), z.array(z.string())]).nullish(),
    cwd: z.string().nullish(),
    /** A request to write under this root for the rest of the session. */
    grantRoot: z.string().nullish(),
    /** A host the command asks to reach, under a managed network policy. */
    networkApprovalContext: z.unknown().optional(),
    /** Permissions the act would gain beyond the ones it already has. */
    additionalPermissions: z.unknown().optional(),
    /**
     * The older shape's file changes, keyed by the file each names. An update
     * that moves its file carries where it lands as `move_path`:
     * `{ type: "update", unified_diff, move_path: string | null }`.
     */
    fileChanges: z
      .record(z.string(), z.object({ type: z.string(), move_path: z.string().nullish() }).loose())
      .optional(),
  })
  .loose();

const ChangeSchema = z
  .object({
    path: z.string(),
    kind: z
      .object({ type: z.string(), move_path: z.string().nullish() })
      .loose()
      .optional(),
  })
  .loose();

const ItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    text: z.string().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    changes: z.array(ChangeSchema).optional(),
  })
  .loose();

const NotificationSchema = z
  .object({ item: ItemSchema.optional(), turn: z.object({ id: z.string(), status: z.string() }).loose().optional() })
  .loose();

const ToolCallSchema = z
  .object({ tool: z.string(), arguments: z.unknown().optional() })
  .loose();

const OpenedSchema = z
  .object({ thread: z.object({ id: z.string() }).loose(), model: z.string().optional() })
  .loose();

const TurnStartedSchema = z.object({ turn: z.object({ id: z.string() }).loose() }).loose();

/** One line of the app server's stdout: a reply, a request, or a notification. */
const EnvelopeSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).loose().optional(),
  params: z.unknown().optional(),
});

export interface CodexInterviewOptions {
  /** The `codex` to start. */
  binary: string;
  /**
   * Where the person's `auth.json` is read from. Their login, and nothing else
   * of their configuration, reaches the session.
   */
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
}

export function codexInterviewTransport(options: CodexInterviewOptions): InterviewTransport {
  return {
    run: (session) => runCodexInterview(options, session),
  };
}

async function* runCodexInterview(
  options: CodexInterviewOptions,
  session: InterviewSession,
): AsyncIterable<InterviewStreamed> {
  const connection = new AppServer(options, session);
  try {
    const thread = await connection.open(session);
    yield { session_id: thread };
    for await (const streamed of connection.converse(thread, session)) yield streamed;
    // Only a conversation that ran to its end is an ending. A handshake the
    // server refused, a child that died and a reply this client cannot read
    // are none of them that, and a reason carrying their message would leave
    // the command reporting a session that never ran as one that finished —
    // the Claude transport lets such a failure out and so does this one.
    yield { reason: "the session ended" };
  } finally {
    connection.close();
  }
}

/**
 * One `codex app-server` child, and the conversation over it.
 *
 * Separate from the runner's executor session, which answers to an attempt's
 * ceilings, records every command and refuses a thread that loaded any
 * instruction source. This one answers to the interview: it carries no
 * ceilings, and the repository's own instruction files are data its session
 * may read. The Claude transport keeps its own session's out with
 * `settingSources: []`, so the two differ here rather than matching:
 * an instruction file the repository carries cannot widen what either
 * session may do, which is what admits it.
 */
class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly home: string;
  private readonly session: InterviewSession;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  /** Every item the server announced, by its id: a file approval names one. */
  private readonly items = new Map<string, z.infer<typeof ItemSchema>>();
  /** What the session has streamed and the conversation has not yielded yet. */
  private streamed: InterviewStreamed[] = [];
  /** The turn in flight, resolved when the server says it is over. */
  private turn: {
    outcome: { id: string; status: string } | null;
    failure: Error | null;
    wake: (() => void) | null;
  } | null = null;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private failure: Error | null = null;
  private closed = false;

  constructor(options: CodexInterviewOptions, session: InterviewSession) {
    this.session = session;
    this.home = mkdtempSync(join(tmpdir(), "perbo-interview-codex-"));
    chmodSync(this.home, 0o700);
    const auth = join(
      options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      "auth.json",
    );
    if (!existsSync(auth)) {
      rmSync(this.home, { recursive: true, force: true });
      throw new UsageError(
        "the interview runs on your own Codex login and there is none: run `codex login`, then run " +
          "this again",
      );
    }
    // The login and nothing else. A tool server, a hook or an approval rule in
    // the person's own `config.toml` would decide a call before the interview's
    // rules were consulted, and those rules are what D-102's boundary is made
    // of (ADR-0030).
    symlinkSync(auth, join(this.home, "auth.json"));
    const { env } = scrubEnvironment({
      base: options.env ?? process.env,
      allow: [...DEFAULT_ENV_ALLOW_LIST],
      extra: { CODEX_HOME: this.home },
    });
    this.child = spawn(options.binary, [...CODEX_INTERVIEW_ARGV], {
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
      if (!this.closed) {
        this.fail(new Error(`codex stopped before the interview ended (${code ?? "signal"}): ${this.stderr}`));
      }
    });
  }

  /** Start or continue the thread, and answer with the id the server gives. */
  async open(session: InterviewSession): Promise<string> {
    await this.request("initialize", {
      clientInfo: { name: "perbo_interview", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    // The boundary is named on every open, a resumed thread included: a thread
    // resumed without it would carry whatever it was started with.
    const boundary = {
      cwd: session.cwd,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      // Codex's own base prompt is what tells it how to use its tools, so the
      // orientation is beside it rather than in place of it — the same
      // position it takes on the other transport, which appends to the preset.
      developerInstructions: session.orientation,
      ...(session.model === null ? {} : { model: session.model }),
      dynamicTools: session.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(z.strictObject(tool.shape), { io: "input" }),
      })),
    };
    // "There are three ways to resume a thread: 1. By thread_id: load the
    // thread from disk by thread_id and resume it. … Prefer using thread_id
    // whenever possible." Its reply carries the thread the same way
    // `thread/start`'s does, so the id the session reports is the server's
    // either way.
    const opened = OpenedSchema.parse(
      session.resume === null
        // Not ephemeral, which the executor's throwaway thread is: this one is
        // loaded from disk by its id when the person comes back to the spec.
        ? await this.request("thread/start", { ...boundary, ephemeral: false })
        : await this.request("thread/resume", { ...boundary, threadId: session.resume }),
    );
    return opened.thread.id;
  }

  /** One turn per line the person types, each run to its end before the next. */
  async *converse(thread: string, session: InterviewSession): AsyncIterable<InterviewStreamed> {
    for await (const text of session.turns) {
      const turn: NonNullable<typeof this.turn> = { outcome: null, failure: null, wake: null };
      this.turn = turn;
      const started = TurnStartedSchema.parse(
        await this.request("turn/start", {
          threadId: thread,
          input: [{ type: "text", text, text_elements: [] }],
          cwd: session.cwd,
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          ...(session.model === null ? {} : { model: session.model }),
        }),
      );
      // The turn's notifications and its approvals arrive while it runs, so
      // what is yielded is whatever has been streamed each time this comes
      // back, and the wait is on the turn's own end rather than on a clock.
      while (true) {
        while (this.streamed.length > 0) yield this.streamed.shift()!;
        if (turn.outcome !== null || turn.failure !== null) break;
        await new Promise<void>((resolve) => {
          turn.wake = resolve;
        });
      }
      this.turn = null;
      if (turn.failure !== null) throw turn.failure;
      const outcome = turn.outcome!;
      if (outcome.id === started.turn.id && outcome.status !== "completed") {
        yield { message: { type: "codex", method: "turn/completed", turn: outcome } };
      }
      // Outside that: the message is only carried for a turn that ended some
      // other way, but every turn that ends hands the next word to the person,
      // and a turn that ended well is the ordinary case.
      yield { idle: true };
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
    rmSync(this.home, { recursive: true, force: true });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    const turn = this.turn;
    if (turn !== null && turn.outcome === null) {
      turn.failure = error;
      turn.wake?.();
      turn.wake = null;
    }
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
      if (message.error) waiter.reject(new Error(message.error.message ?? "codex refused the request"));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method !== undefined) this.notified(message.method, message.params);
  }

  /** One notification: what the session said, and what it is about to do. */
  private notified(method: string, params: unknown): void {
    const parsed = NotificationSchema.safeParse(params);
    if (!parsed.success) return;
    const item = parsed.data.item;
    if (item) this.items.set(item.id, item);
    if (method === "item/completed" && item?.type === "agentMessage" && item.text) {
      this.say({ message: interviewSaidMessage(item.text) });
      return;
    }
    if (method === "turn/completed" && parsed.data.turn) {
      const turn = this.turn;
      if (turn !== null) {
        turn.outcome = parsed.data.turn;
        turn.wake?.();
        turn.wake = null;
      }
      return;
    }
    this.say({ message: { type: "codex", method, ...(params as object) } });
  }

  /**
   * One request from the server, answered by the interview's rules.
   *
   * Every one goes to {@link InterviewSession.decide}, which emits the refusal
   * where there is one; nothing here reaches the person, and a request this
   * client is not built to answer is refused under the name the server used
   * for it, because the interview holds no such thing.
   */
  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    const legacy = method === APPROVALS.legacyCommand || method === APPROVALS.legacyPatch;
    if (method === "item/tool/call") {
      await this.answerToolCall(id, params);
      return;
    }
    if (
      method !== APPROVALS.command &&
      method !== APPROVALS.fileChange &&
      !legacy
    ) {
      await this.session.decide(method, {});
      this.reply(id, { error: { code: -32601, message: `the interview holds no ${method}` } });
      return;
    }
    const request = ApprovalSchema.safeParse(params);
    if (!request.success) {
      await this.session.decide(method, {});
      this.reply(id, { error: { code: -32602, message: `the interview could not read ${method}` } });
      return;
    }
    const decided = await this.judge(method, request.data);
    // Both shapes answer with a `decision`, and the two vocabularies differ:
    // `ReviewDecision` is `approved` or a `denied` carrying the words to say,
    // and the newer one is `accept` or `decline`. Neither `acceptForSession`
    // nor `approved_for_session` is ever sent, so the next call of the same
    // shape is judged again.
    this.reply(id, {
      result: {
        decision: legacy
          ? decided.allow
            ? "approved"
            : { denied: { rejection: decided.message ?? "refused by the interview" } }
          : decided.allow
            ? "accept"
            : "decline",
      },
    });
  }

  /**
   * What the interview's rules say about one approval.
   *
   * A request that would widen the boundary if its act were accepted — a root
   * to write under for the rest of the session (`grantRoot`), a permission the
   * act does not already have (`additionalPermissions`), a host to reach
   * (`networkApprovalContext`) — is refused whatever the act itself is,
   * because accepting it would answer a second question nobody put to the
   * rules. The runner's own Codex adapter refuses on the same three fields
   * (`adapter-codex.ts`), and the test drives each of them.
   *
   * A proposed amendment beside a command is not one of those. The generated
   * schema offers it as a separate answer: `accept` is "User approved the
   * command.", `acceptWithExecpolicyAmendment` is "User approved the command,
   * and wants to apply the proposed execpolicy amendment so future matching
   * commands can run without prompting", and `applyNetworkPolicyAmendment` is
   * "User chose a persistent network policy rule (allow/deny) for this host".
   * This client only ever answers `accept` or `decline`, so a proposal rides
   * along unapplied and the command is judged on its own.
   *
   * A file change is judged on every path it lands on, the destination of a
   * move included: the check goes on what the change does rather than on the
   * file it names.
   */
  private async judge(
    method: string,
    request: z.infer<typeof ApprovalSchema>,
  ): Promise<{ allow: boolean; message: string | null }> {
    // Each of the three is nullable in the schema, and null is its absence.
    const widening =
      request.grantRoot != null ||
      request.networkApprovalContext != null ||
      request.additionalPermissions != null;
    if (widening) {
      const decided = await this.session.decide(`${escalationTool(method)} for the rest of the session`, {});
      return { allow: false, message: decided.behavior === "deny" ? decided.message : null };
    }
    if (method === APPROVALS.command || method === APPROVALS.legacyCommand) {
      const item = request.itemId === undefined ? undefined : this.items.get(request.itemId);
      const command = commandText(request.command) ?? item?.command ?? "";
      // Where it runs comes from the request, which is the directory the
      // server is about to run it in, so a relative target in the line is
      // resolved against that rather than against a shell this client is not
      // the one keeping. Absent, the thread's own directory is where it runs.
      const where = request.cwd ?? item?.cwd ?? this.session.cwd;
      const decided = await this.session.decide("Bash", { command }, where);
      return { allow: decided.behavior === "allow", message: message(decided) };
    }
    const landing = this.landings(request);
    if (landing.length === 0) {
      const decided = await this.session.decide("Write", {});
      return { allow: false, message: message(decided) };
    }
    let refusal: string | null = null;
    for (const path of landing) {
      const decided = await this.session.decide("Write", { file_path: path });
      if (decided.behavior === "deny") refusal = refusal ?? decided.message;
    }
    return { allow: refusal === null, message: refusal };
  }

  /** Every path a file change lands on, the destination of a move included. */
  private landings(request: z.infer<typeof ApprovalSchema>): string[] {
    const item = request.itemId === undefined ? undefined : this.items.get(request.itemId);
    const changes = (item?.changes ?? []).flatMap((change) => [
      change.path,
      ...(change.kind?.move_path ? [change.kind.move_path] : []),
    ]);
    // The older shape carries its changes on the request, keyed by the file
    // each names, with a move's destination on the change itself.
    const legacy = Object.entries(request.fileChanges ?? {}).flatMap(([path, change]) => [
      path,
      ...(change.move_path ? [change.move_path] : []),
    ]);
    return [...changes, ...legacy];
  }

  /** One call to a tool of the interview's own, offered as a dynamic tool. */
  private async answerToolCall(id: number | string, params: unknown): Promise<void> {
    const call = ToolCallSchema.safeParse(params);
    if (!call.success) {
      await this.session.decide("item/tool/call", {});
      this.reply(id, { error: { code: -32602, message: "the interview could not read item/tool/call" } });
      return;
    }
    // A name the session does not hold is still put to the rules under that
    // name, so a call the rules refuse is reported as refused like any other.
    // The rules do not refuse every such name — one of the other transport's
    // agent tools is admitted by them — so holding no tool of that name is
    // itself what declines the call, and the answer says which name it was.
    const tool = this.session.tools.find((each) => each.name === call.data.tool);
    const named = tool === undefined ? call.data.tool : `mcp__${INTERVIEW_SERVER_NAME}__${tool.name}`;
    const input = (call.data.arguments ?? {}) as Record<string, unknown>;
    const decided = await this.session.decide(named, input);
    if (decided.behavior === "deny" || tool === undefined) {
      this.reply(id, {
        result: {
          success: false,
          contentItems: [
            { type: "inputText", text: decided.behavior === "deny" ? decided.message : named },
          ],
        },
      });
      return;
    }
    const result = await tool.run(input);
    this.reply(id, {
      result: {
        success: result.isError !== true,
        contentItems: result.content.map((part) => ({ type: "inputText", text: part.text })),
      },
    });
  }

  /** Put one thing on the stream, and wake the turn waiting to yield it. */
  private say(streamed: InterviewStreamed): void {
    this.streamed.push(streamed);
    const turn = this.turn;
    turn?.wake?.();
    if (turn) turn.wake = null;
  }

  private reply(id: number | string, body: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ id, ...body })}\n`, (error) => {
      if (error) this.fail(error);
    });
  }
}

const message = (decided: { behavior: string; message?: string }): string | null =>
  decided.behavior === "deny" ? (decided.message ?? null) : null;

/** The name an escalation is refused under, which is the act it rides on. */
const escalationTool = (method: string): string =>
  method === APPROVALS.fileChange || method === APPROVALS.legacyPatch ? "Write" : "Bash";

/** The command a request names, however its shape spells it. */
function commandText(command: string | readonly string[] | null | undefined): string | null {
  if (typeof command === "string") return command;
  // The older shape carries argv. Joined for the rules to read, which is safe
  // because nothing here runs it: Codex runs the command it already holds, and
  // this is only what the rules are asked about.
  if (Array.isArray(command)) return command.join(" ");
  return null;
}
