import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_ENV_ALLOW_LIST, EFFORT_LEVELS, scrubEnvironment, type EffortLevel, type EffortProvider } from "@perbo/contracts";
import { ModelCatalogSchema, ProviderModelSchema } from "../shared/protocol.js";
import type {
  ModelCatalog,
  ModelProvider,
  ProviderModel,
} from "../shared/protocol.js";
import { childEnvironment } from "./process.js";

const limit = 2_000_000;
const ClaudeResponse = z.object({
  subtype: z.literal("success"),
  response: z.object({
    models: z
      .array(
        z.object({
          value: z.string(),
          resolvedModel: z.string().optional(),
          displayName: z.string(),
          description: z.string().default(""),
          supportedEffortLevels: z.array(z.string()).max(20).default([]),
        }),
      )
      .max(1000),
  }),
});
const CodexPage = z.object({
  data: z
    .array(
      z.object({
        model: z.string(),
        displayName: z.string(),
        description: z.string().default(""),
        hidden: z.boolean().default(false),
        isDefault: z.boolean().default(false),
        supportedReasoningEfforts: z
          .array(z.object({ reasoningEffort: z.string() }))
          .max(20)
          .default([]),
      }),
    )
    .max(1000),
  nextCursor: z.string().nullable().optional(),
});
const ApiPage = z.object({
  data: z
    .array(z.object({ id: z.string(), display_name: z.string() }))
    .max(1000),
  has_more: z.boolean(),
  last_id: z.string().nullable(),
});

/**
 * Claude Code in stream-json mode with repository instructions, hooks, tools,
 * plugins and MCP servers off. The model catalog and the usage probe both speak
 * control requests to it and never write a user message, so no turn starts.
 */
export const CLAUDE_METADATA_ARGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--setting-sources",
  "user",
  "--settings",
  '{"disableAllHooks":true,"enabledPlugins":{}}',
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--tools",
  "",
  "--disable-slash-commands",
  "--no-chrome",
  "--safe-mode",
];

/** Only metadata requests are sent. No prompt, thread, tool approval or inference turn. */
export function metadataProcess<T = ProviderModel[]>(options: {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  initial: unknown;
  receive: (
    message: Record<string, unknown>,
    send: (value: unknown) => void,
  ) => T | undefined;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let result: T | undefined;
    let failure: Error | undefined;
    let stopped = false;
    let received = 0;
    let buffer = "";
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          failure ??= new Error("Could not stop model discovery.");
      }
    };
    const stop = (error?: Error): void => {
      if (stopped) return;
      stopped = true;
      failure = error;
      clearTimeout(timer);
      child.stdin.end();
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), 1000);
      forceTimer.unref();
    };
    const timer = setTimeout(
      () =>
        stop(
          new Error(
            "Model discovery timed out. Check your connection and refresh.",
          ),
        ),
      options.timeoutMs,
    );
    const send = (value: unknown): void => {
      child.stdin.write(JSON.stringify(value) + "\n");
    };
    child.stdin.on("error", () =>
      stop(new Error("The CLI closed model discovery. Update it and refresh.")),
    );
    child.once("error", () =>
      stop(
        new Error("Provider CLI unavailable. Install it, sign in and refresh."),
      ),
    );
    // Do not forward provider diagnostics: they can contain account or credential data.
    child.stderr.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit)
        stop(new Error("Model discovery exceeded the output limit."));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      received += Buffer.byteLength(chunk);
      if (received > limit) {
        stop(new Error("Model discovery exceeded the output limit."));
        return;
      }
      buffer += chunk;
      let newline: number;
      while (!stopped && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(line));
          result = options.receive(message, send);
          if (result !== undefined) stop();
        } catch {
          stop(
            new Error(
              "The CLI could not provide a compatible model catalog. Check sign-in, update the CLI and refresh.",
            ),
          );
        }
      }
    });
    child.once("close", () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (failure) reject(failure);
      else if (result !== undefined) resolve(result);
      else
        reject(
          new Error(
            "The CLI exited before returning models. Check sign-in and refresh.",
          ),
        );
    });
    send(options.initial);
  });
}

/**
 * The levels a catalog row reports that its provider's CLI takes, in the
 * table's order. A level Perbo does not know is left out rather than guessed at,
 * and a row reporting none offers no effort control.
 */
function efforts(provider: EffortProvider, reported: readonly string[]): EffortLevel[] {
  return EFFORT_LEVELS[provider].filter((level) => reported.includes(level));
}

/**
 * Claude Code names a row by its family ("Fable") and puts the version at the
 * head of the description ("Fable 5.1 · Most capable…"); the head is the name a
 * person tells the models apart by, and the rest describes it. A head that
 * does not read as a family and a version ("Fable 5.1") is not a name, and the
 * row keeps its display name and its whole description.
 */
function claudeRow(displayName: string, description: string): { label: string; description: string } {
  const split = description.indexOf(" · ");
  const head = split > 0 ? description.slice(0, split) : "";
  return /^[A-Z][a-z]+ \d/.test(head)
    ? { label: head, description: description.slice(split + 3) }
    : { label: displayName, description };
}

function unique(models: ProviderModel[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const candidate of models) {
    const model = ProviderModelSchema.parse(candidate);
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()];
}

/** Bounded, isolated CLI catalog discovery, shared by all native model pickers. */
export async function discoverModels(
  provider: ModelProvider,
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    binaries?: { claude: string; codex: string };
    fetch?: typeof fetch;
  } = {},
): Promise<ModelCatalog> {
  const base = options.env ?? childEnvironment();
  const timeoutMs = options.timeoutMs ?? 25_000;
  let models: ProviderModel[];
  if (provider === "anthropic") {
    if (!base.ANTHROPIC_API_KEY)
      throw new Error(
        "Set ANTHROPIC_API_KEY in the app environment to discover API models.",
      );
    models = [];
    const signal = AbortSignal.timeout(timeoutMs);
    let after: string | null = null;
    const seen = new Set<string>();
    do {
      const url = new URL("https://api.anthropic.com/v1/models");
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after_id", after);
      const response = await (options.fetch ?? fetch)(url, {
        headers: {
          "x-api-key": base.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        signal,
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          `API model discovery failed (HTTP ${response.status}). Check the API credential and refresh.`,
        );
      if (!response.body) throw new Error("The API returned no model catalog.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > limit) {
            await reader.cancel();
            throw new Error("Model discovery exceeded the output limit.");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const page = ApiPage.parse(JSON.parse(body));
      models.push(
        ...page.data.map((model) => ({
          id: model.id,
          label: model.display_name,
          description: "",
          isDefault: false,
          efforts: [],
        })),
      );
      after = page.has_more ? page.last_id : null;
      if (page.has_more && (!after || seen.has(after) || seen.size >= 10))
        throw new Error("The API returned an incomplete model catalog.");
      if (after) seen.add(after);
    } while (after);
  } else {
    const scratch = mkdtempSync(join(tmpdir(), "perbo-models-"));
    try {
      const { env } = scrubEnvironment({
        base,
        allow: [
          ...DEFAULT_ENV_ALLOW_LIST,
          "CLAUDE_CONFIG_DIR",
          "ANTHROPIC_API_KEY",
        ],
        extra: { DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" },
      });
      if (provider === "claude-cli") {
        models = await metadataProcess({
          binary: options.binaries?.claude ?? "claude",
          cwd: scratch,
          env,
          timeoutMs,
          args: CLAUDE_METADATA_ARGS,
          initial: {
            type: "control_request",
            request_id: "catalog",
            request: {
              subtype: "initialize",
              hooks: {},
              agents: {},
              skills: [],
            },
          },
          receive: (message) => {
            if (message.type !== "control_response") return;
            const envelope = z
              .object({ request_id: z.string() })
              .parse(message.response);
            if (envelope.request_id !== "catalog") return;
            const listed = ClaudeResponse.parse(message.response).response.models;
            // The `default` alias points at a model the list usually also names
            // (Opus, today). Keep the named entry and mark it default, so the
            // alias never hides the model it stands for.
            const aliasTarget = listed.find((model) => model.value === "default")?.resolvedModel;
            const named = listed.some((model) => model.value !== "default" && model.resolvedModel === aliasTarget);
            return listed
              .filter((model) => !(model.value === "default" && aliasTarget !== undefined && named))
              .map((model) => ({
                id: model.resolvedModel ?? model.value,
                ...claudeRow(model.displayName, model.description),
                isDefault: model.value === "default" || (named && model.resolvedModel === aliasTarget && model.resolvedModel !== undefined),
                efforts: efforts("claude-cli", model.supportedEffortLevels),
              }));
          },
        });
      } else {
        const auth = join(
          base.CODEX_HOME ?? join(homedir(), ".codex"),
          "auth.json",
        );
        if (!existsSync(auth))
          throw new Error(
            "Codex login is unavailable. Run codex login and refresh.",
          );
        const privateHome = join(scratch, "codex");
        mkdirSync(privateHome, { mode: 0o700 });
        symlinkSync(auth, join(privateHome, "auth.json"));
        // Match execution's isolated home: no user config, plugins or repository instructions.
        env.CODEX_HOME = privateHome;
        delete env.ANTHROPIC_API_KEY;
        const collected: ProviderModel[] = [];
        const cursors = new Set<string>();
        let id = 1;
        models = await metadataProcess({
          binary: options.binaries?.codex ?? "codex",
          cwd: scratch,
          env,
          timeoutMs,
          args: [
            "-c",
            "agents.enabled=false",
            "-c",
            'model_provider="openai"',
            "-c",
            'chatgpt_base_url="https://chatgpt.com/backend-api"',
            "app-server",
          ],
          initial: {
            id,
            method: "initialize",
            params: {
              clientInfo: { name: "perbo_models", version: "0.1.0" },
              capabilities: {},
            },
          },
          receive: (message, send) => {
            if (message.id !== id) return;
            if (message.error) throw new Error("Codex catalog request failed");
            if (id === 1) {
              send({ method: "initialized", params: {} });
              send({
                id: ++id,
                method: "model/list",
                params: { limit: 100, includeHidden: false },
              });
              return;
            }
            const page = CodexPage.parse(message.result);
            collected.push(
              ...page.data
                .filter((model) => !model.hidden)
                .map((model) => ({
                  id: model.model,
                  label: model.displayName,
                  description: model.description,
                  isDefault: model.isDefault,
                  efforts: efforts(
                    "codex-cli",
                    model.supportedReasoningEfforts.map((each) => each.reasoningEffort),
                  ),
                })),
            );
            if (!page.nextCursor) return collected;
            if (cursors.has(page.nextCursor) || cursors.size >= 10)
              throw new Error("Incomplete Codex catalog");
            cursors.add(page.nextCursor);
            send({
              id: ++id,
              method: "model/list",
              params: {
                limit: 100,
                includeHidden: false,
                cursor: page.nextCursor,
              },
            });
            return;
          },
        });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return ModelCatalogSchema.parse({
    provider,
    models: unique(models),
    discoveredAt: new Date().toISOString(),
    source:
      provider === "codex-cli"
        ? "codex-app-server"
        : provider === "claude-cli"
          ? "claude-code"
          : "anthropic-api",
  });
}
