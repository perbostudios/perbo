import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT_CODES } from "@perbo/contracts";
import { UsageError } from "../usage-error.js";
import { agentOrientation, readEndpoint, type EndpointRecord } from "../endpoint/index.js";
import { mcpConfig } from "./mcp.js";
import {
  parseArgv,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../command-line/grammar.js";
import type { NarratedCommand } from "../command-line/table.js";
import { narratedStreams } from "../streams.js";
import type { CommandContext } from "../command.js";
import { repositoryRootOf, storeDir } from "../store/tickets.js";

/**
 * `perbo agent` — the person's own session, launched with the queue's
 * endpoint injected (the founder's decision of 2026-09-10).
 *
 * Paseo's launch, kept whole: the tool server is handed to the provider's
 * CLI for this process only, through a file or an environment variable so the
 * token is never on a command line another process can list. Nothing else
 * changes for the session — it is the person at a keyboard with a helper,
 * so their own configuration applies and nothing is neutralised; the
 * executor's rules protect the loop, and this session holds no loop authority
 * (the endpoint offers it no approve, publish or merge).
 *
 * The session runs in the primary checkout, never in a worktree of the
 * queue's, and the queue must already be serving: the endpoint is the
 * queue's, and a session with no queue behind it would be one with nothing
 * to read.
 */

export const AGENT_PROVIDERS = ["claude", "codex"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export interface AgentArgs {
  repo: string;
  store: string | null;
  provider: AgentProvider;
  /** Everything after `--`, handed to the provider's CLI as typed. */
  passthrough: string[];
}

const AGENT_FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--provider": valueFlag(),
} satisfies FlagTable;

const AGENT_GRAMMAR: Grammar<typeof AGENT_FLAGS> = {
  command: "agent",
  flags: AGENT_FLAGS,
  positionals: {
    min: 0,
    max: 0,
    refusal:
      "agent takes no positional argument: what the provider's own CLI is given goes after --, " +
      "e.g. perbo agent -- --model opus",
  },
  // What follows `--` is the provider's, verbatim: this command reads none of
  // it, and `perbo agent -- --help` asks the provider rather than printing
  // Perbo's help.
  afterDoubleDash: "passthrough",
  unknownFlagHint: "arguments for the provider go after --",
};

export function parseAgentArgs(argv: readonly string[]): AgentArgs {
  const line = parseArgv(AGENT_GRAMMAR, argv);
  const provider = line.flags["--provider"] ?? "claude";
  if (!(AGENT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new UsageError(`--provider takes ${AGENT_PROVIDERS.join(" or ")} (got '${provider}')`);
  }
  return {
    repo: line.flags["--repo"] ?? ".",
    store: line.flags["--store"] ?? null,
    provider: provider as AgentProvider,
    passthrough: [...line.passthrough],
  };
}

export interface AgentLaunch {
  command: string;
  argv: string[];
  cwd: string;
  /** Added to the process environment. The token travels here for Codex, in a file for Claude Code. */
  env: Record<string, string>;
  /** A file written for the launch and removed after it; null where none is needed. */
  file: string | null;
}

/**
 * The launch for one provider. Pure, so a test reads the argv and the file
 * without starting anything.
 */
export function agentLaunch(input: {
  provider: AgentProvider;
  record: EndpointRecord;
  repository_root: string;
  state_root: string;
  passthrough: readonly string[];
  pid: number;
}): AgentLaunch {
  const orientation = agentOrientation({ repo: input.repository_root });
  if (input.provider === "claude") {
    // A file rather than inline JSON: the header carries the token, and an
    // argument is readable by every process on the machine.
    const file = join(input.state_root, `agent-${input.pid}.mcp.json`);
    return {
      command: "claude",
      argv: ["--mcp-config", file, "--append-system-prompt", orientation, ...input.passthrough],
      cwd: input.repository_root,
      env: {},
      file,
    };
  }
  return {
    command: "codex",
    argv: [
      "-c",
      `mcp_servers.perbo.url=${JSON.stringify(input.record.url)}`,
      "-c",
      'mcp_servers.perbo.bearer_token_env_var="PERBO_ENDPOINT_TOKEN"',
      ...input.passthrough,
      // Codex takes no system prompt; the orientation is the first thing it reads.
      orientation,
    ],
    cwd: input.repository_root,
    env: { PERBO_ENDPOINT_TOKEN: input.record.tokens.person },
    file: null,
  };
}

/** The one thing a test replaces in a session: what starts the provider and waits for it. */
export interface AgentDeps {
  launch: (launch: AgentLaunch) => Promise<number>;
}

/** What a session is given: where it runs, what it says while it starts, and its launch. */
export type AgentContext = CommandContext & {
  stdout(chunk: string): void;
  isTTY: boolean;
} & Partial<AgentDeps>;

/**
 * `perbo agent`, over typed input.
 *
 * It says what it is starting and then hands the terminal to the provider, so
 * there is no record to hand back.
 */
export async function agent(args: AgentArgs, context: AgentContext): Promise<number> {
  const streams = narratedStreams(context);
  const repositoryRoot = resolve(context.cwd, args.repo);
  const dir = storeDir(repositoryRoot, args.store);
  const record = readEndpoint(dir);
  if (record === null) {
    streams.stderr(
      `no queue is serving ${dir}: start \`perbo serve\` first, which hosts the endpoint this session ` +
        "would read, and run this again\n",
    );
    return EXIT_CODES.did_not_complete;
  }
  const stateRoot = join(dir, "state");
  const launch = agentLaunch({
    provider: args.provider,
    record,
    repository_root: repositoryRootOf(dir, storeDirRelative(dir, repositoryRoot)),
    state_root: stateRoot,
    passthrough: args.passthrough,
    pid: process.pid,
  });
  if (launch.file !== null) {
    try {
      mkdirSync(stateRoot, { recursive: true });
      sweepStaleLaunchFiles(stateRoot);
      writeFileSync(launch.file, `${JSON.stringify(mcpConfig(record, "person"), null, 2)}\n`, { mode: 0o600 });
      chmodSync(launch.file, 0o600);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      streams.stderr(
        `error: cannot write the launch file ${launch.file}: ${reason}. The state directory ${stateRoot} ` +
          "has to be writable by you; nothing was started\n",
      );
      return EXIT_CODES.did_not_complete;
    }
  }
  streams.stderr(
    `starting ${launch.command} in ${launch.cwd} with the queue's endpoint at ${record.url}; the ` +
      "session can read every ticket and admit, edit and sync, and cannot approve, publish or merge\n",
  );
  try {
    return await (context.launch ?? startProvider)(launch);
  } finally {
    if (launch.file !== null) rmSync(launch.file, { force: true });
  }
}

/**
 * A launch file outlives a session killed outright — the `finally` below
 * never ran — and it carries the token. Each is named by the pid that wrote
 * it, so the ones whose process is gone are removed before a new one is
 * written.
 */
export function sweepStaleLaunchFiles(stateRoot: string): string[] {
  if (!existsSync(stateRoot)) return [];
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(stateRoot);
  } catch {
    // A directory this user cannot read holds nothing this user wrote.
    return [];
  }
  for (const name of names) {
    const match = /^agent-(\d+)\.mcp\.json$/.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code === "EPERM";
    }
    if (alive) continue;
    try {
      rmSync(join(stateRoot, name), { force: true });
      removed.push(name);
    } catch {
      // Not this user's to remove; the launch proceeds with its own file.
    }
  }
  return removed;
}

/** Resolve the checkout the store belongs to, as the store's own records name it. */
function storeDirRelative(dir: string, repositoryRoot: string): string {
  return resolve(repositoryRoot) === resolve(dir, "..") ? ".." : repositoryRoot;
}

function startProvider(launch: AgentLaunch): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(launch.command, launch.argv, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolveExit(code ?? EXIT_CODES.did_not_complete));
  });
}

/** `perbo agent`, over its own line. */
export const agentCommandLine: NarratedCommand<AgentArgs, Record<string, never>, AgentDeps> = {
  kind: "narrated",
  name: "agent",
  grammars: [AGENT_GRAMMAR],
  grammarFor: () => AGENT_GRAMMAR,
  read: (argv) => ({ input: parseAgentArgs(argv), output: {} }),
  run: (input, _output, context) => agent(input, context),
};
