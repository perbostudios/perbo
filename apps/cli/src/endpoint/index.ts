import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { VERSION } from "../version.js";
import { toolsFor, type QueueSurface, type ToolContext, type ToolRole } from "./internal/tools.js";

/**
 * The tool endpoint the queue hosts (the founder's decision of 2026-09-10).
 *
 * Paseo's mechanism, kept whole: a streamable-HTTP tool server on loopback,
 * one capability token per role, injected into a session at launch and
 * discovered by nothing on disk a repository could supply. What differs is
 * the authority — every tool is one of this build's own commands, and the
 * three person-only acts are absent by construction (`endpoint-tools.ts`).
 *
 * Hand-written rather than a dependency: the server is stateless, answers
 * one JSON-RPC request per POST with a JSON body, and needs nothing of the
 * protocol beyond `initialize`, `ping`, `tools/list` and `tools/call`. The
 * executor never sees it — its launch line still says `--mcp-config {}`.
 *
 * The record at `<store>/state/endpoint.json` is written with mode 0600 and
 * removed when the endpoint closes; a record whose pid is gone is stale and
 * reads as none. `perbo mcp` and `perbo agent` read it and nothing else.
 */

export const ENDPOINT_FILE = "endpoint.json";
export const ENDPOINT_PATHNAME = "/mcp";
/** The protocol revision this server speaks; a client naming another still gets this one. */
export const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 1024 * 1024;

export const EndpointRecordSchema = z.strictObject({
  url: z.url(),
  pid: z.number().int().positive(),
  started_at: z.iso.datetime(),
  /** One capability token per role. The person's reaches every tool; the drafter's, the reads. */
  tokens: z.strictObject({
    person: z.string().regex(/^[0-9a-f]{64}$/),
    drafter: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});
export type EndpointRecord = z.infer<typeof EndpointRecordSchema>;

export const endpointPath = (dir: string): string => join(dir, "state", ENDPOINT_FILE);

/** Whether the process a record names is alive on this host. `EPERM` is a process too. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The endpoint's record, or null where there is none or the queue that wrote it is gone. */
export function readEndpoint(dir: string): EndpointRecord | null {
  const path = endpointPath(dir);
  if (!existsSync(path)) return null;
  try {
    const record = EndpointRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return alive(record.pid) ? record : null;
  } catch {
    return null;
  }
}

export interface RunningEndpoint {
  url: string;
  /** The address the socket is bound to: loopback, and nothing else. */
  address: string;
  tokens: EndpointRecord["tokens"];
  close(): Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const error = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Answered, not cut off: the rest of the body is drained so the
        // 413 below reaches the client rather than a closed socket.
        over = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", () => resolve(null));
  });
}

/** Whether a browser-supplied Origin names this machine. Absent is a non-browser client. */
function originIsLocal(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  const bytes = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(bytes) });
  response.end(bytes);
}

/**
 * Start the endpoint for one store and write its record.
 *
 * Loopback only: `host` is not a parameter, because an endpoint that could
 * bind elsewhere is a different product with a different threat model.
 */
export async function startEndpoint(input: {
  dir: string;
  cwd: string;
  repo: string;
  store: string | null;
  queue: QueueSurface;
  now?: () => Date;
  /** 0 takes a free port, which is the only sensible value outside a test. */
  port?: number;
}): Promise<RunningEndpoint> {
  const now = input.now ?? (() => new Date());
  const tokens = { person: randomBytes(32).toString("hex"), drafter: randomBytes(32).toString("hex") };
  const roleOf = (token: string | null): ToolRole | null =>
    token === tokens.person ? "write" : token === tokens.drafter ? "read" : null;
  const context: ToolContext = { dir: input.dir, cwd: input.cwd, repo: input.repo, store: input.store, queue: input.queue };

  const server = createServer(async (request, response) => {
    if ((request.url ?? "").split("?")[0] !== ENDPOINT_PATHNAME) {
      send(response, 404, { error: `this endpoint lives at ${ENDPOINT_PATHNAME}` });
      return;
    }
    if (request.method !== "POST") {
      send(response, 405, { error: "this endpoint answers POST and nothing else" });
      return;
    }
    // DNS rebinding: a page on another origin, resolved to this address by a
    // hostile name, still sends its own Origin, and this is not for it.
    if (!originIsLocal(request.headers.origin)) {
      send(response, 403, { error: "this endpoint answers this machine's own sessions" });
      return;
    }
    const header = request.headers.authorization ?? "";
    const token = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : null;
    const role = roleOf(token);
    if (role === null) {
      send(response, 401, { error: "no capability token this endpoint issued" });
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      send(response, 413, { error: "the request body is over the endpoint's limit" });
      return;
    }
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(body) as JsonRpcRequest;
    } catch {
      send(response, 400, error(null, -32700, "the body is not JSON"));
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
      send(response, 400, error(null, -32600, "one JSON-RPC request per POST, with a method"));
      return;
    }
    const { id, method, params } = message;
    // A notification carries no id and is answered with nothing.
    if (id === undefined) {
      send(response, 202);
      return;
    }
    switch (method) {
      case "initialize":
        send(
          response,
          200,
          result(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "perbo", version: VERSION },
          }),
        );
        return;
      case "ping":
        send(response, 200, result(id, {}));
        return;
      case "tools/list":
        send(
          response,
          200,
          result(id, {
            tools: toolsFor(role).map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.schema ?? z.toJSONSchema(tool.input),
            })),
          }),
        );
        return;
      case "tools/call": {
        const call = params as { name?: unknown; arguments?: unknown } | undefined;
        const name = typeof call?.name === "string" ? call.name : null;
        const tool = name === null ? undefined : toolsFor(role).find((candidate) => candidate.name === name);
        if (tool === undefined) {
          const exists = name !== null && toolsFor("write").some((candidate) => candidate.name === name);
          send(
            response,
            200,
            error(id, -32602, exists ? `${name} is not for this role's token` : `no tool named ${name ?? "(none)"}`),
          );
          return;
        }
        const parsed = tool.input.safeParse(call?.arguments ?? {});
        if (!parsed.success) {
          send(
            response,
            200,
            error(
              id,
              -32602,
              `${tool.name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`,
            ),
          );
          return;
        }
        try {
          send(response, 200, result(id, await tool.run(parsed.data, context)));
        } catch (failure) {
          send(response, 200, error(id, -32603, failure instanceof Error ? failure.message : String(failure)));
        }
        return;
      }
      default:
        send(response, 200, error(id, -32601, `no method ${method} here`));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}${ENDPOINT_PATHNAME}`;

  const path = endpointPath(input.dir);
  mkdirSync(join(input.dir, "state"), { recursive: true });
  const record: EndpointRecord = { url, pid: process.pid, started_at: now().toISOString(), tokens };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);

  return {
    url,
    address: address.address,
    tokens,
    close: () =>
      new Promise<void>((resolve) => {
        // Only this endpoint's own record: a queue that took over the store
        // since has written its own, and that one is its to remove.
        try {
          const current = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
          if (current.pid === process.pid) rmSync(path, { force: true });
        } catch {
          // Already gone, or not ours to read.
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** What the session started against this endpoint is told it may do. */
export { agentOrientation } from "./internal/tools.js";
