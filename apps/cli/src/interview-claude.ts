import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { UsageError } from "./usage-error.js";
import {
  INTERVIEW_AGENT_TOOLS,
  INTERVIEW_DENIED_TOOLS,
  INTERVIEW_SERVER_NAME,
  type InterviewPermission,
  type InterviewSession,
  type InterviewStreamed,
  type InterviewToolResult,
  type InterviewTransport,
} from "./interview.js";

/**
 * The interview on Claude: the person's own Claude Code session, run through
 * the Claude Agent SDK (D-102).
 *
 * The session's rules are not here — {@link InterviewSession.decide} carries
 * them, and every call this transport can decide goes through it. What is here
 * is how this SDK is asked: the tools it is given, the mode a call takes when
 * nothing has decided it, and the callback the undecided call reaches.
 */

/** One tool as the SDK's `tool()` returns it. */
export interface InterviewSdkTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: unknown, extra: unknown) => Promise<InterviewToolResult>;
}

/** The options the interview hands `query`. */
export interface InterviewQueryOptions {
  cwd: string;
  /**
   * The Claude Code the session runs: the person's own, resolved on `PATH`.
   *
   * Left unset the SDK "uses the built-in executable" — the per-platform copy
   * of Claude Code it carries as an optional dependency, about 198 MB, which
   * the desktop package deliberately does not ship. Naming the person's own is
   * also the honest one to run: it is the install they signed in with, and the
   * provider CLIs own their credentials (ADR-0033).
   */
  pathToClaudeCodeExecutable: string;
  model?: string;
  resume?: string;
  /**
   * What a call nothing has decided does. `default` is the one that reaches
   * {@link InterviewQueryOptions.canUseTool}: every other mode either decides
   * the call itself or hands it to a classifier, and `dontAsk` denies it.
   */
  permissionMode: "default";
  /** Empty: a rule in a settings file decides a call before the callback sees it. */
  settingSources: readonly string[];
  systemPrompt: { type: "preset"; preset: "claude_code"; append: string };
  tools: readonly string[];
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  mcpServers: Record<string, unknown>;
  canUseTool: (
    tool: string,
    input: Record<string, unknown>,
    extra: { signal: AbortSignal },
  ) => Promise<InterviewPermission>;
  includePartialMessages: boolean;
  stderr: (data: string) => void;
}

/**
 * The part of the Claude Agent SDK the interview uses.
 *
 * An interface rather than the import, so a test drives a session the way the
 * runner's adapter tests drive a fake binary: the double keeps the tool
 * definitions as values, offers each call to `canUseTool`, and runs the
 * handlers of the ones it admits.
 */
export interface InterviewSdk {
  tool(
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown, extra: unknown) => Promise<InterviewToolResult>,
  ): InterviewSdkTool;
  createSdkMcpServer(options: { name: string; tools: InterviewSdkTool[] }): unknown;
  query(params: {
    prompt: AsyncIterable<{ type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null; session_id: string }>;
    options: InterviewQueryOptions;
  }): AsyncIterable<Record<string, unknown>>;
}

/**
 * The published SDK, loaded when a session is actually started.
 *
 * Imported here rather than at the top of the file because the shipped binary
 * keeps the SDK beside it rather than inside it (`tooling/package/bundle.mjs`),
 * so a build that has not got it says so here instead of failing on import.
 */
export async function loadInterviewSdk(): Promise<InterviewSdk> {
  try {
    return (await import("@anthropic-ai/claude-agent-sdk")) as unknown as InterviewSdk;
  } catch (error) {
    throw new UsageError(
      "the Claude Agent SDK is not installed beside this build, and the interview runs the session " +
        "through it: install @anthropic-ai/claude-agent-sdk where perbo can resolve it, then run " +
        `this again (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * The `claude` on `PATH`, as a path the Agent SDK can start.
 *
 * The SDK starts the executable itself, with no shell. On POSIX that takes a
 * file whose execute bit is set. On Windows it takes an `.exe` or a `.com`:
 * Node refuses to start a `.cmd` or `.bat` file without a shell, and npm's
 * `claude.cmd` is one, so an npm install there is passed over for a native
 * build later on `PATH`, and where the shim is all there is, the refusal names
 * the installer that works.
 *
 * A `PATH` entry that is not absolute, or that lies inside the repository, is
 * skipped. The CLI runs with the repository as its working directory, so `.`
 * there — or the repository's `node_modules/.bin`, which a package manager puts
 * on `PATH` for a script it runs — would find a `claude` the repository ships
 * and run it as the person's own.
 *
 * Under the desktop, the host puts the known install locations first on the
 * CLI's `PATH` (`childEnvironment` in `apps/desktop/src/host/process.ts`), so an
 * install a launch from Finder would not see is found here too.
 */
export function resolveClaudeExecutable(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const windows = platform === "win32";
  const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((each) => each.length > 0);
  const extensions = windows ? pathext.filter((each) => /^\.(com|exe)$/i.test(each)) : [""];
  const shims = windows ? pathext.filter((each) => /^\.(bat|cmd)$/i.test(each)) : [];
  let shim: string | null = null;
  const repository = inside(repositoryRoot);
  const directories = (env.PATH ?? "")
    .split(delimiter)
    .filter((each) => isAbsolute(each) && !repository(each));
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `claude${extension}`);
      if (startable(candidate, windows)) return candidate;
    }
    for (const extension of shims) {
      const candidate = join(directory, `claude${extension}`);
      if (shim === null && isFile(candidate)) shim = candidate;
    }
  }
  if (shim !== null)
    throw new UsageError(
      "the interview starts your own Claude Code without a shell, and the `claude` on PATH is " +
        `npm's shim (${shim}), which Windows will not start that way: install Claude Code with ` +
        "its native installer, which puts a claude.exe on PATH, sign in with `claude`, then run this again",
    );
  throw new UsageError(
    "the interview runs the session through your own Claude Code, and no `claude` is on PATH " +
      "outside the repository: " +
      (windows
        ? "install Claude Code with its native installer"
        : "install Claude Code (npm install -g @anthropic-ai/claude-code)") +
      " and sign in with `claude`, then run this again",
  );
}

/**
 * Whether a directory is `root` or under it, read with symlinks resolved where
 * a path exists, so a link into the repository counts as the repository.
 */
function inside(root: string): (directory: string) => boolean {
  const real = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  const base = real(root);
  return (directory) => {
    const at = relative(base, real(directory));
    return at === "" || (at !== ".." && !at.startsWith(`..${sep}`) && !isAbsolute(at));
  };
}

/** Whether this host starts `path` directly: a file, and on POSIX an executable one. */
function startable(path: string, windows: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // Windows keeps no execute bit to ask about; the extension has decided.
    if (!windows) accessSync(path, constants.X_OK);
    return true;
  } catch {
    // Absent, unreadable, or not executable: the next candidate answers.
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The Claude transport over one SDK.
 *
 * The session id is the SDK's own, which arrives on the first message rather
 * than before the first turn, so a session that says nothing is announced by
 * the command under the id it was resumed with.
 */
export function claudeInterviewTransport(
  sdk: InterviewSdk,
  executable: string,
): InterviewTransport {
  return {
    async *run(session: InterviewSession): AsyncIterable<InterviewStreamed> {
      const tools = session.tools.map((each) =>
        sdk.tool(each.name, each.description, each.shape, (raw) => each.run(raw)),
      );
      const options: InterviewQueryOptions = {
        cwd: session.cwd,
        pathToClaudeCodeExecutable: executable,
        ...(session.model === null ? {} : { model: session.model }),
        ...(session.resume === null ? {} : { resume: session.resume }),
        // The mode a call takes when nothing has decided it. `dontAsk` is not
        // it: it denies such a call outright, before the permission callback is
        // ever reached, which would leave the guard deciding nothing and the
        // session unable to write the spec it exists to write. Under `default`
        // an undecided call reaches `canUseTool` below, which answers allow or
        // deny from the guard and never asks, so nothing is ever put to the
        // person (D-102).
        permissionMode: "default",
        // No settings file is read. A `permissions.allow` rule in one decides a
        // call before the callback sees it, the same way `allowedTools` would,
        // and the guard is what decides here (D-102). It costs the person's own
        // hooks and rules in this one session; ADR-0030 says so.
        settingSources: [],
        systemPrompt: { type: "preset", preset: "claude_code", append: session.orientation },
        tools: [...INTERVIEW_AGENT_TOOLS],
        // Empty on purpose: a tool on this list is admitted by a rule, and a
        // rule that admits it is a rule the permission callback never sees.
        allowedTools: [],
        // The runner's deny list, and the tool that starts a subagent under
        // both its names: the roles are the executor's (D-102, D-106).
        disallowedTools: [...INTERVIEW_DENIED_TOOLS],
        mcpServers: {
          [INTERVIEW_SERVER_NAME]: sdk.createSdkMcpServer({ name: INTERVIEW_SERVER_NAME, tools }),
        },
        canUseTool: (tool, toolInput) => session.decide(tool, toolInput),
        includePartialMessages: false,
        stderr: (data) => session.stderr(data),
      };
      let reason = "the session ended";
      for await (const message of sdk.query({
        prompt: turnsAsMessages(session),
        options,
      })) {
        const id = typeof message.session_id === "string" ? message.session_id : null;
        yield { ...(id === null ? {} : { session_id: id }), message };
        if (message.type === "result" && typeof message.subtype === "string") {
          reason = message.subtype;
        }
      }
      yield { reason };
    },
  };
}

/** The person's turns, as the SDK's user messages. */
async function* turnsAsMessages(session: InterviewSession): AsyncGenerator<{
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  for await (const turn of session.turns) {
    yield {
      type: "user",
      message: { role: "user", content: turn },
      parent_tool_use_id: null,
      session_id: session.sessionId(),
    };
  }
}
