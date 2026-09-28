import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_ENV_ALLOW_LIST,
  EFFORT_LEVELS,
  OPENCODE_API_KEY_ENV,
  OPENCODE_SERVE_ARGV,
  opencodeConfig,
  opencodeEnvironment,
  scrubEnvironment,
  type EffortLevel,
  type EffortProvider,
} from "@perbo/contracts";
import { CLAUDE_METADATA_ARGS } from "@perbo/model/defaults";
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
    binaries?: { claude: string; codex: string; opencode?: string };
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
      } else if (provider === "opencode-cli") {
        models = await openCodeModels({
          binary: options.binaries?.opencode ?? "opencode",
          scratch,
          base,
          timeoutMs,
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
          : provider === "opencode-cli"
            ? "opencode"
            : "anthropic-api",
  });
}

/** One model as OpenCode's served model list reports it. */
const OpenCodeServedModel = z.object({
  id: z.string(),
  providerID: z.string(),
  name: z.string(),
  /** Absent or null where OpenCode reports no price: such a model is never counted free. */
  cost: z.array(z.object({ input: z.number(), output: z.number() }).loose()).max(20).nullish(),
});
const OpenCodeServed = <T extends z.ZodType>(data: T) => z.object({ data });
/**
 * A list OpenCode serves, each entry read on its own: one OpenCode reports in
 * a shape this reader does not know is left out, rather than failing the
 * whole list.
 */
const OpenCodeServedList = <T extends z.ZodType>(entry: T, max: number) =>
  OpenCodeServed(
    z
      .array(z.unknown())
      .max(max)
      .transform((entries) =>
        entries.flatMap((each) => {
          const read = entry.safeParse(each);
          return read.success ? [read.data as z.infer<T>] : [];
        }),
      ),
  );
const OpenCodeModelList = OpenCodeServedList(OpenCodeServedModel, 5000);
const OpenCodeProviderList = OpenCodeServedList(
  z.object({ id: z.string(), integrationID: z.string().optional() }).loose(),
  1000,
);
const OpenCodeIntegrationList = OpenCodeServedList(
  z.object({ id: z.string(), connections: z.array(z.unknown()) }).loose(),
  1000,
);
/** The default model, where OpenCode names one in a shape this reader knows; none otherwise. */
const OpenCodeDefault = OpenCodeServed(
  z.unknown().transform((value) => {
    const read = z.object({ id: z.string(), providerID: z.string() }).loose().safeParse(value);
    return read.success ? read.data : null;
  }),
);

/** How long apart two readings of OpenCode's model list are, to see it has settled. */
const OPENCODE_SETTLE_MS = 500;

/**
 * The models OpenCode reports that a person can run right now: every model it
 * lists whose price it reports as nothing, input and output alike, and every
 * model of a provider whose integration it reports a connection for. A model
 * OpenCode reports no price for is never counted free. Read from
 * OpenCode's own reports and nothing else — never from a model's or a
 * provider's name — so a model behind a key nobody set is not offered.
 */
export function runnableOpenCodeModels(reported: {
  models: readonly z.infer<typeof OpenCodeServedModel>[];
  providers: readonly { id: string; integrationID?: string | undefined }[];
  integrations: readonly { id: string; connections: readonly unknown[] }[];
}): z.infer<typeof OpenCodeServedModel>[] {
  const connected = new Set(reported.integrations.filter((each) => each.connections.length > 0).map((each) => each.id));
  const integrationOf = new Map(reported.providers.map((each) => [each.id, each.integrationID ?? each.id]));
  return reported.models.filter(
    (model) =>
      (model.cost != null && model.cost.length > 0 && model.cost.every((cost) => cost.input === 0 && cost.output === 0)) ||
      connected.has(integrationOf.get(model.providerID) ?? model.providerID),
  );
}

/**
 * The first line a stream prints, read up to `limit` characters. Once it is
 * read — or the limit refused — nothing more is kept: the listener comes off
 * and the stream is left flowing, so a server that keeps printing is drained
 * rather than held in memory or blocked on a full pipe.
 */
export function firstLine(stream: Readable, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const done = (): void => {
      buffer = "";
      stream.off("data", onData);
      stream.resume();
    };
    const onData = (chunk: string | Buffer): void => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        done();
        resolve(line);
        return;
      }
      if (buffer.length > limit) {
        done();
        reject(new Error("OpenCode's answer exceeded the output limit."));
      }
    };
    stream.setEncoding("utf8");
    stream.on("data", onData);
  });
}

/**
 * The models an OpenCode role can run, under the same home every role runs in
 * (D-134): fresh directories, no project configuration, OpenCode Zen's key
 * where the app environment has one and no other credential of the person's.
 *
 * ACP's `session/new` offers every model OpenCode's catalogue holds, a price
 * behind a missing key included, and says nothing of which can run; measured
 * on 2.0.14, a Zen model with a price and no key is offered and then refused
 * at the turn. So this asks OpenCode's own server instead
 * (`OPENCODE_SERVE_ARGV`): which integrations it reports connected, which
 * provider each model belongs to, and each model's price, reading the model
 * list until two readings agree, since OpenCode says the list may precede its
 * plugins settling. Only reads are sent; the password is minted here, sent
 * only to the loopback address the server names, and the server ends with
 * this process's hold on its stdin.
 */
async function openCodeModels(options: {
  binary: string;
  scratch: string;
  base: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<ProviderModel[]> {
  const home = join(options.scratch, "opencode");
  for (const directory of ["config", "data", "state", "cache"])
    mkdirSync(join(home, directory), { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString("base64url");
  const { env } = scrubEnvironment({
    base: options.base,
    allow: [...DEFAULT_ENV_ALLOW_LIST, OPENCODE_API_KEY_ENV],
    extra: { ...opencodeEnvironment(home, opencodeConfig("reviewer")), NO_COLOR: "1", OPENCODE_PASSWORD: password },
  });
  const child = spawn(options.binary, [...OPENCODE_SERVE_ARGV], {
    cwd: options.scratch,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
    detached: process.platform !== "win32",
  });
  const deadline = Date.now() + options.timeoutMs;
  /** Signal the server's process group, as the ACP transports' `close()` does. */
  const signal = (name: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      /* Already gone. */
    }
  };
  /** Whether the server has ended, or never started. */
  const ended = (): boolean => child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  /**
   * Its stdin closed and SIGTERM, then SIGKILL where it is still there 1.5 s
   * later, answered once it has exited: OpenCode writes its database under
   * the scratch home as it stops, and the home is removed only after that.
   */
  const stop = async (): Promise<void> => {
    child.stdin.end();
    if (ended()) return;
    signal("SIGTERM");
    const bound = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
    await Promise.race([exited, bound(1_500)]);
    if (ended()) return;
    signal("SIGKILL");
    await Promise.race([exited, bound(1_500)]);
  };
  try {
    const address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("OpenCode did not start in time. Check it is installed and refresh.")),
        options.timeoutMs,
      );
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("OpenCode is unavailable. Install OpenCode 2 and refresh."));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("OpenCode stopped before it reported its models. Update it and refresh."));
      });
      firstLine(child.stdout, limit).then(
        (line) => {
          clearTimeout(timer);
          try {
            resolve(z.object({ url: z.string() }).parse(JSON.parse(line)).url);
          } catch {
            reject(new Error("OpenCode did not name its server. Update it and refresh."));
          }
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    const url = new URL(address);
    // The password goes to the loopback address this process's server named, and nowhere else.
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("OpenCode named a server that is not on this machine.");
    const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const read = async <T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> => {
      const target = new URL(path, url);
      target.searchParams.set("directory", options.scratch);
      let response: Response;
      let body: string;
      // The request and its body both, since a body can stall after its headers.
      try {
        response = await fetch(target, {
          headers: { authorization },
          redirect: "error",
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        body = await response.text();
      } catch (error) {
        // A timeout or a server gone mid-read, each said in one sentence the picker can show.
        const name = error instanceof Error ? error.name : "";
        throw new Error(
          name === "TimeoutError" || name === "AbortError"
            ? "OpenCode did not report its models in time. Refresh to ask again."
            : "OpenCode stopped before it reported its models. Update it and refresh.",
          { cause: error },
        );
      }
      if (!response.ok) throw new Error(`OpenCode answered ${path} with HTTP ${response.status}.`);
      if (body.length > limit) throw new Error("OpenCode's answer exceeded the output limit.");
      let parsed: z.infer<T>;
      try {
        parsed = schema.parse(JSON.parse(body));
      } catch (error) {
        throw new Error(`OpenCode answered ${path} with something Perbo cannot read. Update it and refresh.`, {
          cause: error,
        });
      }
      return parsed;
    };
    const integrations = (await read("/api/integration", OpenCodeIntegrationList)).data;
    let models = (await read("/api/model", OpenCodeModelList)).data;
    for (;;) {
      if (Date.now() + OPENCODE_SETTLE_MS > deadline)
        throw new Error("OpenCode's model list did not settle in time. Refresh.");
      await new Promise((resolve) => setTimeout(resolve, OPENCODE_SETTLE_MS));
      const again = (await read("/api/model", OpenCodeModelList)).data;
      // Two readings that agree, an empty list included, are settled.
      const same =
        again.length === models.length &&
        again.every((model, at) => model.providerID === models[at]!.providerID && model.id === models[at]!.id);
      models = again;
      if (same) break;
    }
    const providers = (await read("/api/provider", OpenCodeProviderList)).data;
    const preferred = (await read("/api/model/default", OpenCodeDefault)).data;
    const runnable = runnableOpenCodeModels({ models, providers, integrations });
    if (runnable.length === 0)
      throw new Error(
        "OpenCode reports no model you can run now — none of its free models is listed and no provider is connected; " +
          `set ${OPENCODE_API_KEY_ENV} in the app environment for OpenCode Zen and refresh.`,
      );
    return runnable.map((model) => ({
      id: `${model.providerID}/${model.id}`,
      label: model.name,
      description: `${model.providerID}/${model.id}`,
      isDefault: preferred?.providerID === model.providerID && preferred.id === model.id,
      efforts: [],
    }));
  } finally {
    await stop();
  }
}
