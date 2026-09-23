import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import { admitCommandLine } from "../commands/admit.js";
import { ENDPOINT_FILE, readEndpoint, startEndpoint, type RunningEndpoint } from "./index.js";
import { ENDPOINT_TOOLS, PERSON_ONLY_ACTS } from "./internal/tools.js";
import { storeDir } from "../store/tickets.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";
import { emptyRepository } from "../test-support/repository.js";

/**
 * The tool endpoint the queue hosts: paseo's mechanism, Perbo's authority.
 *
 * Loopback HTTP, one capability token per role, JSON-RPC in the shape a
 * Claude Code or Codex session speaks to a streamable-HTTP tool server. What
 * is proven here is what a session can and cannot do through it — never
 * approve, publish or merge — and that the tokens reach nobody else.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-endpoint-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let repos = 0;
function repository(): string {
  const dir = join(scratch, `repo-${repos++}`);
  mkdirSync(dir, { recursive: true });
  emptyRepository(dir);
  mkdirSync(join(dir, ".perbo"), { recursive: true });
  writeFileSync(join(dir, ".perbo", "config.json"), JSON.stringify({ base_ref: "main" }));
  return dir;
}

function admitted(repo: string, outcome: string, path: string): string {
  const streams = recordStreams();
  const code = runCommandLine(admitCommandLine, {
    argv: ["--repo", repo, "--outcome", outcome, "--criterion", `${outcome} :: a test asserts it`, "--path", path, "--json"],
    streams,
    cwd: repo,
  });
  if (code !== EXIT_CODES.approve) throw new Error(streams.err());
  return (streams.json<{ ticket: { key: string } }>()).ticket.key;
}

const running: RunningEndpoint[] = [];
afterEach(async () => {
  for (const endpoint of running.splice(0)) await endpoint.close();
});

async function serve(repo: string) {
  const endpoint = await startEndpoint({
    dir: storeDir(repo),
    cwd: repo,
    repo,
    store: null,
    queue: {
      state: () => ({ paused: false, tick: null }),
      pause: () => undefined,
      resume: () => undefined,
    },
    now: () => new Date("2026-09-10T12:00:00.000Z"),
  });
  running.push(endpoint);
  return endpoint;
}

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpc(url: string, token: string | null, body: unknown): Promise<{ status: number; json: Rpc | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? null : (JSON.parse(text) as Rpc) };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("the endpoint", () => {
  it("binds to loopback, writes its record for this store alone, and answers initialize", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const path = join(storeDir(repo), "state", ENDPOINT_FILE);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const record = readEndpoint(storeDir(repo));
    expect(record?.url).toBe(endpoint.url);
    expect(record?.pid).toBe(process.pid);
    expect(Object.keys(record!.tokens).sort()).toEqual(["drafter", "person"]);
    expect(record!.tokens.person).toMatch(/^[0-9a-f]{64}$/);
    expect(record!.tokens.person).not.toBe(record!.tokens.drafter);

    const { status, json } = await rpc(endpoint.url, record!.tokens.person, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(status).toBe(200);
    expect(json?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "perbo" },
    });
    // A notification is taken and answered with nothing.
    const initialized = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${record!.tokens.person}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);
  });

  it("refuses a missing or wrong token, and anything but a POST", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    expect((await rpc(endpoint.url, null, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await rpc(endpoint.url, "f".repeat(64), { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const get = await fetch(endpoint.url, { headers: { authorization: `Bearer ${readEndpoint(storeDir(repo))!.tokens.person}` } });
    expect(get.status).toBe(405);
  });

  it("lists the person's tools without approve, publish or merge, and a drafter's reads only", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    const tokens = readEndpoint(storeDir(repo))!.tokens;
    const person = await rpc(endpoint.url, tokens.person, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = ((person.json?.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools).map((t) => t.name);
    expect(names).toEqual(ENDPOINT_TOOLS.map((tool) => tool.name));
    for (const act of PERSON_ONLY_ACTS) {
      expect(names.some((name) => name.includes(act))).toBe(false);
    }
    expect(names).toContain("admit_ticket");
    expect(names).toContain("list_tickets");
    expect(names).toContain("queue_state");
    const drafter = await rpc(endpoint.url, tokens.drafter, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    const reads = ((drafter.json?.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(reads).toEqual(ENDPOINT_TOOLS.filter((tool) => tool.role === "read").map((tool) => tool.name));
    expect(reads).not.toContain("admit_ticket");
    // Every tool carries a JSON schema a client can validate against.
    for (const tool of (person.json?.result as { tools: Array<{ inputSchema: { type: string } }> }).tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("runs the store's own commands: list after admit, and inspect by key", async () => {
    const repo = repository();
    const key = admitted(repo, "Docs say what is true.", "docs/**");
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    const listed = await rpc(endpoint.url, token, call("list_tickets", { all: true }));
    expect(listed.status).toBe(200);
    const result = listed.json?.result as { isError?: boolean; structuredContent?: { tickets: Array<{ key: string; state: string }> }; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.tickets.map((t) => [t.key, t.state])).toEqual([[key, "plan_review"]]);
    expect(result.content[0]?.type).toBe("text");

    const inspected = await rpc(endpoint.url, token, call("inspect_ticket", { key }));
    const shown = inspected.json?.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(shown.isError).toBeFalsy();
    expect(JSON.stringify(shown.structuredContent)).toContain(key);
  });

  it("admits through the endpoint as a draft, never approved, and refuses the drafter that", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    const tokens = readEndpoint(storeDir(repo))!.tokens;
    const drafted = await rpc(endpoint.url, tokens.person, call("admit_ticket", {
      outcome: "The CLI prints a version.",
      criteria: ["The CLI prints a version. :: a test asserts it"],
      paths: ["apps/cli/**"],
    }));
    const result = drafted.json?.result as { isError?: boolean; structuredContent?: { ticket: { key: string; state: string; approved_at: string | null } } };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.ticket.state).toBe("plan_review");
    expect(result.structuredContent?.ticket.approved_at).toBeNull();
    // The one thing the person's session may not do through here.
    const refused = await rpc(endpoint.url, tokens.person, call("admit_ticket", {
      outcome: "Nope.",
      criteria: ["Nope. :: no"],
      paths: ["docs/**"],
      approve: true,
    }));
    expect((refused.json?.result as { isError?: boolean }).isError).toBe(true);
    // A drafter's token reaches reads only.
    const denied = await rpc(endpoint.url, tokens.drafter, call("admit_ticket", { outcome: "x", criteria: ["x :: y"], paths: ["docs/**"] }));
    expect(denied.json?.error?.code).toBe(-32602);
    expect(denied.json?.error?.message).toContain("not for this role");
  });

  it("refuses two sources for one draft rather than preferring one of them", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    const both = await rpc(
      endpoint.url,
      token,
      call("admit_ticket", { from: "o/r#412", from_file: "/tmp/issue.md" }),
    );
    const result = both.json?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(
      /--from and --from-file are mutually exclusive: one contract is drafted from one document/,
    );
    // Nothing was admitted from either of them.
    const listed = await rpc(endpoint.url, token, call("list_tickets", { all: true }));
    expect(
      (listed.json?.result as { structuredContent: { tickets: unknown[] } }).structuredContent
        .tickets,
    ).toEqual([]);
  });

  it("never lets a session string become a flag: a value shaped like --x=--approve stays a value", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    for (const poison of [
      { outcome: "--x=--approve", criteria: ["--x=--approve :: y"], paths: ["docs/**"] },
      { outcome: "Fine.", criteria: ["Fine. :: y"], paths: ["docs/**"], labels: ["--x=--approve"] },
      { outcome: "Fine.", criteria: ["Fine. :: y"], paths: ["--x=--approve"] },
    ]) {
      const drafted = await rpc(endpoint.url, token, call("admit_ticket", poison));
      const result = drafted.json?.result as { isError?: boolean; structuredContent?: { ticket: { key: string; state: string; approved_at: string | null } } };
      if (!result.isError) {
        expect(result.structuredContent?.ticket.state).toBe("plan_review");
        expect(result.structuredContent?.ticket.approved_at).toBeNull();
      }
    }
    const listed = await rpc(endpoint.url, token, call("list_tickets", { all: true }));
    const tickets = (listed.json?.result as { structuredContent: { tickets: Array<{ key: string; title: string; state: string; approved_at: string | null }> } }).structuredContent.tickets;
    expect(tickets.every((ticket) => ticket.state === "plan_review" && ticket.approved_at === null)).toBe(true);
    // The same for an edit: a value shaped like a flag is a value.
    const first = tickets[0];
    expect(first).toBeDefined();
    const key = first!.key;
    const edited = await rpc(endpoint.url, token, call("edit_ticket", { key, outcome: "--repo=/nowhere" }));
    const shown = edited.json?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(shown.isError).toBeFalsy();
    const after = await rpc(endpoint.url, token, call("inspect_ticket", { key }));
    const report = (after.json?.result as { structuredContent: { title: string; outcome: string | null } })
      .structuredContent;
    expect(report.outcome).toBe("--repo=/nowhere");
    // The ticket's name stays what it was (D-NEW-a-ticket-is-named-apart-from-its-board).
    expect(report.title).toBe(first!.title);
  });

  it("appends a typed prohibition or generated glob to the command's own defaults, never in their place", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    const drafted = await rpc(endpoint.url, token, call("admit_ticket", {
      outcome: "The site builds.",
      criteria: ["The site builds. :: a test asserts it"],
      paths: ["site/**"],
      prohibit: ["site/secrets/**"],
      generated: ["site/dist/**"],
    }));
    const result = drafted.json?.result as {
      isError?: boolean;
      structuredContent?: { contract: { scope: { paths_prohibited: string[]; generated_paths: string[] } } };
    };
    expect(result.isError).toBeFalsy();
    const scope = result.structuredContent!.contract.scope;
    // The terminal's `--prohibit` adds to the standing list; so does this.
    expect(scope.paths_prohibited).toEqual(expect.arrayContaining([".github/**", "**/.env*", "site/secrets/**"]));
    expect(scope.generated_paths).toEqual(expect.arrayContaining(["pnpm-lock.yaml", "site/dist/**"]));
  });

  it("names the field a refusal is about, and shows edit's one-of-three rule in the schema it lists", async () => {
    const repo = repository();
    const key = admitted(repo, "Docs say what is true.", "docs/**");
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    const empty = await rpc(endpoint.url, token, call("admit_ticket", { outcome: "", criteria: ["x :: y"], paths: ["docs/**"] }));
    expect(empty.json?.error?.code).toBe(-32602);
    expect(empty.json?.error?.message).toMatch(/^admit_ticket: outcome: /);
    // An attempt id is an attempt id: a flag-shaped one never reaches the command.
    const loose = await rpc(endpoint.url, token, call("inspect_ticket", { key, attempt: "--repo=/tmp" }));
    expect(loose.json?.error?.code).toBe(-32602);
    expect(loose.json?.error?.message).toMatch(/^inspect_ticket: attempt: /);
    const listed = await rpc(endpoint.url, token, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (listed.json?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools.find((tool) => tool.name === "edit_ticket")?.inputSchema.anyOf).toEqual([
      { required: ["outcome"] },
      { required: ["criteria"] },
      { required: ["paths"] },
    ]);
  });

  it("refuses a flag-shaped key, date, reference or model, and an empty outcome, before any command sees it", async () => {
    const repo = repository();
    const key = admitted(repo, "Docs say what is true.", "docs/**");
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    const refused: Array<[string, Record<string, unknown>]> = [
      ["sync_ticket", { key: "--merge" }],
      ["sync_ticket", { key: `${key} --merge` }],
      ["stops", { since: "--repo=/tmp" }],
      ["admit_ticket", { from: "-x/y#1" }],
      ["admit_ticket", { outcome: "x", criteria: ["x :: y"], paths: ["docs/**"], model: "--model" }],
      ["edit_ticket", { key, outcome: "" }],
    ];
    for (const [name, args] of refused) {
      const answer = await rpc(endpoint.url, token, call(name, args));
      expect(answer.json?.error?.code, `${name} ${JSON.stringify(args)}`).toBe(-32602);
      expect(answer.json?.error?.message).toMatch(new RegExp(`^${name}: `));
    }
    // And the store is as it was: nothing synced, nothing edited.
    const after = await rpc(endpoint.url, token, call("inspect_ticket", { key }));
    expect(JSON.stringify((after.json?.result as { structuredContent: unknown }).structuredContent)).toContain("Docs say what is true.");
  });

  it("is bound to loopback and nothing else", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    expect(endpoint.address).toBe("127.0.0.1");
    expect(new URL(endpoint.url).hostname).toBe("127.0.0.1");
    // Where this machine has an address the network can reach, the endpoint
    // is not on it.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((address) => address !== undefined && address.family === "IPv4" && !address.internal);
    if (external !== undefined) {
      const port = new URL(endpoint.url).port;
      await expect(fetch(`http://${external.address}:${port}/mcp`, { method: "POST" })).rejects.toThrow();
    }
  });

  it("refuses an edit that names no field, so no editor is ever opened in the queue", async () => {
    const repo = repository();
    const key = admitted(repo, "Docs say what is true.", "docs/**");
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    const bare = await rpc(endpoint.url, token, call("edit_ticket", { key }));
    expect(bare.json?.error?.code).toBe(-32602);
    expect(bare.json?.error?.message).toContain("no editor");
  });

  it("answers its own path only, refuses a foreign origin, and reads the scheme case-insensitively", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    const elsewhere = await fetch(endpoint.url.replace("/mcp", "/other"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(elsewhere.status).toBe(404);
    const foreign = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(foreign.status).toBe(403);
    const local = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `bearer ${token}`, origin: "http://localhost:3000" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(local.status).toBe(200);
    const big = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "x".repeat(1024 * 1024 + 10),
    });
    expect(big.status).toBe(413);
  });

  it("answers an unknown method and an unknown tool in JSON-RPC's own words", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    const method = await rpc(endpoint.url, token, { jsonrpc: "2.0", id: 4, method: "resources/list" });
    expect(method.json?.error?.code).toBe(-32601);
    const tool = await rpc(endpoint.url, token, call("approve_ticket", { key: "AYO-1" }));
    expect(tool.json?.error?.code).toBe(-32602);
    const malformed = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });

  it("reports the queue's state through the tool the queue supplies", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    const token = readEndpoint(storeDir(repo))!.tokens.person;
    const state = await rpc(endpoint.url, token, call("queue_state"));
    expect((state.json?.result as { structuredContent: unknown }).structuredContent).toEqual({ paused: false, tick: null });
  });

  it("removes its record when it closes, and the record names a dead pid as stale", async () => {
    const repo = repository();
    const endpoint = await serve(repo);
    const dir = storeDir(repo);
    await endpoint.close();
    running.splice(0);
    expect(readEndpoint(dir)).toBeNull();
    writeFileSync(
      join(dir, "state", ENDPOINT_FILE),
      JSON.stringify({ url: "http://127.0.0.1:1/mcp", pid: 2_147_483_647, started_at: "2026-09-10T00:00:00.000Z", tokens: { person: "a".repeat(64), drafter: "b".repeat(64) } }),
    );
    expect(readEndpoint(dir)).toBeNull();
    expect(readFileSync(join(dir, "state", ENDPOINT_FILE), "utf8")).toContain("2147483647");
  });
});
