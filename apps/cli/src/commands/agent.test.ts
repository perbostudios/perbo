import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import { UsageError } from "../usage-error.js";
import {
  agentCommandLine,
  agentLaunch,
  sweepStaleLaunchFiles,
  type AgentLaunch,
} from "./agent.js";
import { ENDPOINT_FILE, type EndpointRecord } from "../endpoint/index.js";
import { mcpCommandLine } from "./mcp.js";
import { runCommandLine } from "../command-line/terminal.js";
import type { Streams } from "../streams.js";

/**
 * `perbo agent` and `perbo mcp`: the launch and the handover. Both read the
 * endpoint's record and nothing else; neither writes another tool's
 * configuration; and the token never travels as an argument.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-agent-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (c) => out.push(c), stderr: (c) => err.push(c), isTTY: false };
}

const record: EndpointRecord = {
  url: "http://127.0.0.1:41999/mcp",
  pid: process.pid,
  started_at: "2026-09-10T12:00:00.000Z",
  tokens: { person: "a".repeat(64), drafter: "b".repeat(64) },
};

let repos = 0;
function repository(served: boolean): string {
  const dir = join(scratch, `repo-${repos++}`);
  mkdirSync(join(dir, ".perbo", "state"), { recursive: true });
  if (served) writeFileSync(join(dir, ".perbo", "state", ENDPOINT_FILE), JSON.stringify(record));
  return dir;
}

/** The input one line means, which is what the assertions below are about. */
const agentLine = (argv: readonly string[]) => agentCommandLine.read(argv).input;

describe("the line a session is asked for by", () => {
  it("takes a provider and passes everything after -- through", () => {
    expect(agentLine([])).toEqual({ repo: ".", store: null, provider: "claude", passthrough: [] });
    expect(agentLine(["--provider", "codex", "--", "--model", "gpt-5.4", "-a"])).toEqual({
      repo: ".",
      store: null,
      provider: "codex",
      passthrough: ["--model", "gpt-5.4", "-a"],
    });
    expect(() => agentLine(["--provider", "cursor"])).toThrow(UsageError);
    expect(() => agentLine(["--model", "x"])).toThrow(/after --/);
  });
});

describe("the launch", () => {
  const common = { record, repository_root: "/work/repo", state_root: "/work/repo/.perbo/state", passthrough: ["--verbose"], pid: 4242 };

  it("hands Claude Code a 0600 file and an appended orientation, never the token as an argument", () => {
    const launch = agentLaunch({ ...common, provider: "claude" });
    expect(launch.command).toBe("claude");
    expect(launch.cwd).toBe("/work/repo");
    expect(launch.file).toBe("/work/repo/.perbo/state/agent-4242.mcp.json");
    expect(launch.argv.slice(0, 2)).toEqual(["--mcp-config", launch.file]);
    expect(launch.argv).toContain("--append-system-prompt");
    expect(launch.argv[launch.argv.length - 1]).toBe("--verbose");
    expect(launch.argv.join(" ")).not.toContain(record.tokens.person);
    expect(launch.env).toEqual({});
    // The person's own session: nothing neutralised.
    expect(launch.argv).not.toContain("--strict-mcp-config");
    const orientation = launch.argv[launch.argv.indexOf("--append-system-prompt") + 1]!;
    expect(orientation).toContain("have no tool: approving a");
    expect(orientation).toContain("publishing a run, and merging");
    expect(orientation).toContain("/work/repo");
  });

  it("hands Codex the URL as an override and the token through the environment", () => {
    const launch = agentLaunch({ ...common, provider: "codex" });
    expect(launch.command).toBe("codex");
    expect(launch.argv).toContain('mcp_servers.perbo.url="http://127.0.0.1:41999/mcp"');
    expect(launch.argv).toContain('mcp_servers.perbo.bearer_token_env_var="PERBO_ENDPOINT_TOKEN"');
    expect(launch.argv.join(" ")).not.toContain(record.tokens.person);
    expect(launch.env).toEqual({ PERBO_ENDPOINT_TOKEN: record.tokens.person });
    expect(launch.file).toBeNull();
    // Passthrough before the orientation, which Codex reads as its first prompt.
    expect(launch.argv.indexOf("--verbose")).toBeLessThan(launch.argv.length - 1);
    expect(launch.argv[launch.argv.length - 1]).toContain("Perbo");
  });
});

describe("perbo agent", () => {
  it("refuses without a running queue, naming what to start", async () => {
    const repo = repository(false);
    const streams = capture();
    const launches: AgentLaunch[] = [];
    const code = await runCommandLine(agentCommandLine, {
      argv: ["--repo", repo],
      streams,
      cwd: repo,
      deps: {
        launch: async (launch) => {
          launches.push(launch);
          return 0;
        },
      },
    });
    expect(code).toBe(EXIT_CODES.did_not_complete);
    expect(launches).toEqual([]);
    expect(streams.err.join("")).toContain("perbo serve");
  });

  it("writes the Claude file for the launch alone and removes it afterwards", async () => {
    const repo = repository(true);
    const streams = capture();
    let seen: { exists: boolean; mode: number; body: string } | null = null;
    const code = await runCommandLine(agentCommandLine, {
      argv: ["--repo", repo],
      streams,
      cwd: repo,
      deps: {
        launch: async (launch) => {
          const file = launch.file!;
          seen = { exists: existsSync(file), mode: statSync(file).mode & 0o777, body: readFileSync(file, "utf8") };
          expect(launch.cwd).toBe(repo);
          return 0;
        },
      },
    });
    expect(code).toBe(0);
    expect(seen).not.toBeNull();
    expect(seen!.exists).toBe(true);
    if (process.platform !== "win32") expect(seen!.mode).toBe(0o600);
    expect(JSON.parse(seen!.body)).toEqual({
      mcpServers: { perbo: { type: "http", url: record.url, headers: { Authorization: `Bearer ${record.tokens.person}` } } },
    });
    expect(existsSync(join(repo, ".perbo", "state", `agent-${process.pid}.mcp.json`))).toBe(false);
    expect(streams.err.join("")).toContain("cannot approve, publish or merge");
  });

  it("removes a launch file left by a session that was killed, and keeps a live one", async () => {
    const repo = repository(true);
    const state = join(repo, ".perbo", "state");
    writeFileSync(join(state, "agent-2147483647.mcp.json"), "{}");
    writeFileSync(join(state, `agent-${process.pid}.mcp.json`), "{}");
    writeFileSync(join(state, "not-a-launch.json"), "{}");
    expect(sweepStaleLaunchFiles(state)).toEqual(["agent-2147483647.mcp.json"]);
    expect(existsSync(join(state, `agent-${process.pid}.mcp.json`))).toBe(true);
    expect(existsSync(join(state, "not-a-launch.json"))).toBe(true);
    rmSync(join(state, `agent-${process.pid}.mcp.json`), { force: true });
  });

  it("says which directory it cannot write the launch file to, and starts nothing", async () => {
    const repo = repository(true);
    const state = join(repo, ".perbo", "state");
    chmodSync(state, 0o500);
    try {
      const streams = capture();
      const launches: AgentLaunch[] = [];
      const code = await runCommandLine(agentCommandLine, {
        argv: ["--repo", repo],
        streams,
        cwd: repo,
        deps: {
          launch: async (launch) => {
            launches.push(launch);
            return 0;
          },
        },
      });
      expect(code).toBe(EXIT_CODES.did_not_complete);
      expect(launches).toEqual([]);
      expect(streams.err.join("")).toContain(`cannot write the launch file`);
      expect(streams.err.join("")).toContain(`The state directory ${state} has to be writable by you`);
    } finally {
      chmodSync(state, 0o700);
    }
  });

  it("returns the provider's own exit code", async () => {
    const repo = repository(true);
    const code = await runCommandLine(agentCommandLine, {
      argv: ["--repo", repo, "--provider", "codex"],
      streams: capture(),
      cwd: repo,
      deps: {
        launch: async () => 7,
      },
    });
    expect(code).toBe(7);
  });
});

describe("perbo mcp", () => {
  it("prints the person's block, or the drafter's, and writes nothing", () => {
    const repo = repository(true);
    const streams = capture();
    expect(mcpCommandLine.read(["--drafter", "--json"])).toMatchObject({
      input: { role: "drafter" },
      output: { json: true },
    });
    expect(runCommandLine(mcpCommandLine, { argv: ["--repo", repo], streams, cwd: repo })).toBe(EXIT_CODES.approve);
    const text = streams.out.join("");
    expect(text).toContain(record.url);
    expect(text).toContain(record.tokens.person);
    expect(text).not.toContain(record.tokens.drafter);
    expect(text).toContain("claude --mcp-config");
    expect(text).toContain("claude mcp add --transport http perbo");
    expect(text).toContain("bearer_token_env_var");

    const json = capture();
    runCommandLine(mcpCommandLine, { argv: ["--repo", repo, "--drafter", "--json"], streams: json, cwd: repo });
    expect(JSON.parse(json.out.join(""))).toEqual({
      mcpServers: { perbo: { type: "http", url: record.url, headers: { Authorization: `Bearer ${record.tokens.drafter}` } } },
    });
  });

  it("says which command to start when no queue is serving", () => {
    const repo = repository(false);
    const streams = capture();
    expect(runCommandLine(mcpCommandLine, { argv: ["--repo", repo], streams, cwd: repo })).toBe(EXIT_CODES.did_not_complete);
    expect(streams.err.join("")).toContain("perbo serve");
    expect(streams.out).toEqual([]);
  });
});
