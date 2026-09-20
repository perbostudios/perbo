import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  InterviewSdk,
  InterviewSdkTool,
  InterviewQueryOptions,
} from "../src/interview-claude.js";

/**
 * The Claude Agent SDK, doubled: `tool` and `createSdkMcpServer` keep the
 * definitions as values, and `query` drives a script over them.
 *
 * No session is started and no model is called. What the real SDK does — offer
 * a tool call to `canUseTool`, run the ones it admits, and hand an admitted
 * in-process tool call to its handler — the script does here, in order, so a
 * test reads the same answers the session would have been given.
 */

/** One thing the session does, in the order the script names them. */
export type ScriptStep =
  | { kind: "message"; message: Record<string, unknown> }
  /**
   * A tool the session holds from the SDK: `canUseTool` decides it, and where
   * the step says what the tool wrote, an admitted one writes it. A `Write`
   * with no `writes` writes its own `content`, and a step with neither — an
   * `Edit` whose `old_string` is absent, say — is admitted and changes nothing,
   * which is a tool call that failed.
   */
  | { kind: "tool"; tool: string; input: Record<string, unknown>; writes?: { path: string; content: string } }
  /** One of the interview's own tools, called after `canUseTool` admits it. */
  | { kind: "call"; tool: string; input: Record<string, unknown> };

/** What the script's tool calls were answered with. */
export interface ScriptedCall {
  tool: string;
  input: Record<string, unknown>;
  behavior: "allow" | "deny";
  message: string | null;
  /** The result an in-process tool returned, as text. Null for an SDK tool. */
  result: string | null;
  isError: boolean;
}

export interface ScriptedSdk extends InterviewSdk {
  /** The options `query` was given, for a test that reads the invocation. */
  options: InterviewQueryOptions | null;
  calls: ScriptedCall[];
  /** The prompts the session was fed, which are the person's turns. */
  prompts: string[];
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((part) => part.text ?? "").join("\n");

/**
 * A script, and the session id the double answers with.
 *
 * An admitted `Write` is performed here, as a session's own would be, so a
 * test that asks whether a folder was created or a spec was brought up to date
 * is reading the file system rather than a claim.
 */
export function scriptedSdk(args: {
  steps: readonly ScriptStep[];
  sessionId?: string;
  /** Where a `Write` the double performs is resolved from. */
  cwd: string;
}): ScriptedSdk {
  const sessionId = args.sessionId ?? "session-0001";
  const sdk: ScriptedSdk = {
    options: null,
    calls: [],
    prompts: [],
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
    createSdkMcpServer: (options) => ({ type: "sdk", name: options.name, tools: options.tools }),
    query: (params) => run(params),
  };

  async function* run(params: {
    prompt: AsyncIterable<{ message: { content: string } }>;
    options: InterviewQueryOptions;
  }): AsyncGenerator<Record<string, unknown>> {
    sdk.options = params.options;
    const server = params.options.mcpServers?.[Object.keys(params.options.mcpServers)[0] ?? ""] as
      | { tools: InterviewSdkTool[] }
      | undefined;
    const byName = new Map((server?.tools ?? []).map((each) => [each.name, each]));
    yield { type: "system", subtype: "init", session_id: sessionId };
    // The person's first turn is read before the script runs, as a session
    // reads its first prompt.
    for await (const turn of params.prompt) {
      sdk.prompts.push(turn.message.content);
      break;
    }
    for (const step of args.steps) {
      if (step.kind === "message") {
        yield { ...step.message, session_id: sessionId };
        continue;
      }
      const name = step.kind === "call" ? qualified(step.tool, params.options) : step.tool;
      const permission = await params.options.canUseTool(name, step.input, {
        signal: new AbortController().signal,
      });
      const call: ScriptedCall = {
        tool: name,
        input: step.input,
        behavior: permission.behavior,
        message: permission.behavior === "deny" ? permission.message : null,
        result: null,
        isError: false,
      };
      sdk.calls.push(call);
      if (permission.behavior === "deny") continue;
      if (step.kind === "call") {
        const definition = byName.get(step.tool);
        if (definition === undefined) throw new Error(`the session was offered no ${step.tool}`);
        const result = await definition.handler(step.input, {});
        call.result = text(result);
        call.isError = result.isError === true;
        continue;
      }
      // What the session's own file tool does once it is admitted. The
      // folder is not created here: whether a missing one was created is the
      // command's answer to give, and a write into one that is not there
      // fails as it would in a session.
      const wrote = step.writes ?? fromWrite(step.input);
      if (wrote) writeFileSync(resolve(args.cwd, wrote.path), wrote.content);
    }
    yield { type: "result", subtype: "success", session_id: sessionId };
  }

  return sdk;
}

/** What a `Write` writes, taken from its own input. */
function fromWrite(input: Record<string, unknown>): { path: string; content: string } | null {
  const path = input["file_path"];
  const content = input["content"];
  return typeof path === "string" && typeof content === "string" ? { path, content } : null;
}

/** The name an in-process tool is offered under, which the server's name prefixes. */
function qualified(tool: string, options: InterviewQueryOptions): string {
  const server = Object.keys(options.mcpServers ?? {})[0] ?? "";
  return `mcp__${server}__${tool}`;
}
