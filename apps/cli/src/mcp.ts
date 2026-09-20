import { resolve } from "node:path";
import { EXIT_CODES } from "@perbo/contracts";
import { parseListArgs } from "./admit.js";
import { UsageError } from "./usage-error.js";
import { readEndpoint, type EndpointRecord } from "./endpoint.js";
import type { Streams } from "./streams.js";
import { storeDir } from "./tickets.js";

/**
 * `perbo mcp` — how a session of the person's own finds the endpoint.
 *
 * Prints the block to paste, and writes nothing: Perbo never edits another
 * tool's user configuration. Paseo can inject because it spawns the agent;
 * for a session the person starts themselves, this is the handover, and
 * `perbo agent` is the one that spawns.
 */

export interface McpArgs {
  repo: string;
  store: string | null;
  role: "person" | "drafter";
  json: boolean;
}

export function parseMcpArgs(argv: readonly string[]): McpArgs {
  const role = argv.includes("--drafter") ? "drafter" : "person";
  const rest = argv.filter((token) => token !== "--drafter");
  const list = parseListArgs(rest.filter((token) => token !== "--json"));
  if (list.all) throw new UsageError("unknown option '--all' for mcp");
  return { repo: list.repo, store: list.store, role, json: rest.includes("--json") };
}

/** The `.mcp.json` entry a Claude Code project file or `--mcp-config` file carries. */
export function mcpConfig(record: EndpointRecord, role: McpArgs["role"]): { mcpServers: Record<string, unknown> } {
  return {
    mcpServers: {
      perbo: {
        type: "http",
        url: record.url,
        headers: { Authorization: `Bearer ${record.tokens[role]}` },
      },
    },
  };
}

export function renderMcp(record: EndpointRecord, role: McpArgs["role"]): string {
  const token = record.tokens[role];
  return [
    `The queue's endpoint is ${record.url} (pid ${record.pid}, since ${record.started_at}); this is the ${role}'s token.`,
    "",
    "Claude Code, for this session only:",
    `  claude --mcp-config '${JSON.stringify(mcpConfig(record, role))}'`,
    "",
    "Claude Code, saved for this project (writes ~/.claude.json; your choice):",
    `  claude mcp add --transport http perbo ${record.url} --header "Authorization: Bearer ${token}"`,
    "",
    "Codex, for this session only:",
    `  PERBO_ENDPOINT_TOKEN=${token} codex -c 'mcp_servers.perbo.url="${record.url}"' -c 'mcp_servers.perbo.bearer_token_env_var="PERBO_ENDPOINT_TOKEN"'`,
    "",
    "The two Claude Code lines put the token on a command line, which any process on this machine can",
    "list while the session runs; `perbo agent` launches without that, through a file only you can read.",
    "The token is this queue's alone and dies with it.",
    "",
  ].join("\n");
}

export function runMcpCommand(input: { argv: string[]; streams: Streams; cwd: string }): number {
  const args = parseMcpArgs(input.argv);
  const dir = storeDir(resolve(input.cwd, args.repo), args.store);
  const record = readEndpoint(dir);
  if (record === null) {
    input.streams.stderr(
      `no queue is serving ${dir}: start one with \`perbo serve\`, which hosts the endpoint and writes ` +
        "its record, and run this again\n",
    );
    return EXIT_CODES.did_not_complete;
  }
  if (args.json) {
    input.streams.stdout(`${JSON.stringify(mcpConfig(record, args.role), null, 2)}\n`);
  } else {
    input.streams.stdout(renderMcp(record, args.role));
  }
  return EXIT_CODES.approve;
}
