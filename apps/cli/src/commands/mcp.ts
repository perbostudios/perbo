import { z } from "zod";
import { EXIT_CODES } from "@perbo/contracts";
import {
  parseArgv,
  switchFlag,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../command-line/grammar.js";
import type { CommandContext, Rendered } from "../command.js";
import type { ReportCommand } from "../command-line/terminal.js";
import { readInput } from "../usage-error.js";
import { readEndpoint, type EndpointRecord } from "../endpoint/index.js";
import { storeFor, StoreTargetSchema } from "../store/index.js";

/**
 * `perbo mcp` — how a session of the person's own finds the endpoint.
 *
 * Prints the block to paste, and writes nothing: Perbo never edits another
 * tool's user configuration. Paseo can inject because it spawns the agent;
 * for a session the person starts themselves, this is the handover, and
 * `perbo agent` is the one that spawns.
 */

/** Whose token the block carries: the person's own session, or the drafter's read-only one. */
export const MCP_ROLES = ["person", "drafter"] as const;
export type McpRole = (typeof MCP_ROLES)[number];

export const HandoverInputSchema = z.strictObject({
  target: StoreTargetSchema,
  role: z.enum(MCP_ROLES),
});
export type HandoverInput = z.infer<typeof HandoverInputSchema>;

/** Where the queue's endpoint is, or null where nothing is serving this store. */
export interface HandoverReport {
  /** The store asked about, absolute, for the refusal that names it. */
  dir: string;
  record: EndpointRecord | null;
  role: McpRole;
}

export function endpointHandover(input: HandoverInput, context: CommandContext): HandoverReport {
  const dir = storeFor(context.cwd, input.target);
  return { dir, record: readEndpoint(dir), role: input.role };
}

/** The `.mcp.json` entry a Claude Code project file or `--mcp-config` file carries. */
export function mcpConfig(record: EndpointRecord, role: McpRole): { mcpServers: Record<string, unknown> } {
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

export function renderMcp(record: EndpointRecord, role: McpRole): string {
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

const FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--drafter": switchFlag(),
  "--json": switchFlag(),
} satisfies FlagTable;

const GRAMMAR: Grammar<typeof FLAGS> = {
  command: "mcp",
  flags: FLAGS,
  positionals: {
    min: 0,
    max: 0,
    refusal: "mcp takes no argument: it prints the block for this store, e.g. perbo mcp --drafter",
  },
  afterDoubleDash: "positionals",
};

export const mcpCommandLine: ReportCommand<HandoverInput, { json: boolean }, HandoverReport> = {
  kind: "report",
  name: "mcp",
  grammars: [GRAMMAR],
  jsonWhenPiped: false,
  grammarFor: () => GRAMMAR,
  read(argv) {
    const line = parseArgv(GRAMMAR, argv);
    return {
      input: readInput(HandoverInputSchema, {
        target: { repo: line.flags["--repo"] ?? ".", store: line.flags["--store"] ?? null },
        role: line.flags["--drafter"] === true ? "drafter" : "person",
      }),
      output: { json: line.flags["--json"] === true },
    };
  },
  run: endpointHandover,
  toJson: (report) => (report.record === null ? null : mcpConfig(report.record, report.role)),
  render(report, _output, target): Rendered {
    if (report.record === null) {
      return {
        stdout: "",
        stderr:
          `no queue is serving ${report.dir}: start one with \`perbo serve\`, which hosts the endpoint and writes ` +
          "its record, and run this again\n",
        exitCode: EXIT_CODES.did_not_complete,
      };
    }
    return {
      stdout: target.json
        ? `${JSON.stringify(mcpConfig(report.record, report.role), null, 2)}\n`
        : renderMcp(report.record, report.role),
      stderr: "",
      exitCode: EXIT_CODES.approve,
    };
  },
};
