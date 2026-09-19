import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_ENV_ALLOW_LIST, scrubEnvironment } from "@perbo/contracts";
import type { UsageWindow } from "../shared/protocol.js";
import { metadataProcess } from "./model-catalog.js";
import { childEnvironment } from "./process.js";

/**
 * A provider's own account of its plan windows (S6E). Only Codex answers a
 * metadata question about them; Claude Code and the API report a limit only
 * when an inference turn meets one, and the desktop never spends a turn to ask.
 */
const WindowSchema = z.looseObject({
  usedPercent: z.number().optional(),
  used_percent: z.number().optional(),
  windowDurationMins: z.number().optional(),
  windowMinutes: z.number().optional(),
  window_minutes: z.number().optional(),
  resetsAt: z.union([z.number(), z.string()]).optional(),
  resets_at: z.union([z.number(), z.string()]).optional(),
  resetsInSeconds: z.number().optional(),
  resets_in_seconds: z.number().optional(),
});
const RateLimitsSchema = z.looseObject({
  rateLimits: z
    .looseObject({
      primary: WindowSchema.nullable().optional(),
      secondary: WindowSchema.nullable().optional(),
      planType: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  planType: z.string().nullable().optional(),
});
const AccountSchema = z.looseObject({
  account: z.looseObject({ planType: z.string().nullable().optional(), type: z.string().optional() }).nullable().optional(),
});

export interface ProviderUsage {
  plan: string | null;
  windows: UsageWindow[] | null;
  detail: string;
}

const planLabel = (value: string | null | undefined): string | null =>
  value ? value.charAt(0).toUpperCase() + value.slice(1) : null;

function toWindow(label: string, raw: z.infer<typeof WindowSchema>, now: number): UsageWindow | null {
  const used = raw.usedPercent ?? raw.used_percent;
  if (used === undefined) return null;
  const minutes = raw.windowDurationMins ?? raw.windowMinutes ?? raw.window_minutes;
  const resets = raw.resetsAt ?? raw.resets_at;
  const seconds = raw.resetsInSeconds ?? raw.resets_in_seconds;
  const resetsAt =
    typeof resets === "number"
      ? new Date(resets * (resets > 1e12 ? 1 : 1000)).toISOString()
      : typeof resets === "string"
        ? resets
        : seconds !== undefined
          ? new Date(now + seconds * 1000).toISOString()
          : null;
  const name =
    minutes === undefined
      ? label
      : minutes <= 360
        ? `Session · ${Math.round(minutes / 60)}-hour window`
        : minutes >= 7 * 24 * 60 - 60
          ? "Weekly · all models"
          : `${Math.round(minutes / 60)}-hour window`;
  return { label: name, usedPercent: Math.max(0, Math.min(100, used)), resetsAt };
}

export async function codexUsage(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; binary?: string } = {},
): Promise<ProviderUsage> {
  const base = options.env ?? childEnvironment();
  const auth = join(base.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  if (!existsSync(auth))
    return { plan: null, windows: null, detail: "Codex is not signed in on this machine." };
  const scratch = mkdtempSync(join(tmpdir(), "perbo-usage-"));
  try {
    const { env } = scrubEnvironment({
      base,
      allow: [...DEFAULT_ENV_ALLOW_LIST],
      extra: { DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" },
    });
    const privateHome = join(scratch, "codex");
    mkdirSync(privateHome, { mode: 0o700 });
    symlinkSync(auth, join(privateHome, "auth.json"));
    env.CODEX_HOME = privateHome;
    delete env.ANTHROPIC_API_KEY;
    let plan: string | null = null;
    let id = 1;
    const now = Date.now();
    const result = await metadataProcess<ProviderUsage>({
      binary: options.binary ?? "codex",
      cwd: scratch,
      env,
      timeoutMs: options.timeoutMs ?? 20_000,
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
        params: { clientInfo: { name: "perbo_usage", version: "0.1.0" }, capabilities: {} },
      },
      receive: (message, send) => {
        if (message.id !== id) return;
        if (id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: ++id, method: "account/read", params: {} });
          return;
        }
        if (id === 2) {
          const account = AccountSchema.safeParse(message.result ?? {});
          if (account.success) plan = planLabel(account.data.account?.planType);
          send({ id: ++id, method: "account/rateLimits/read", params: {} });
          return;
        }
        if (message.error)
          return { plan, windows: null, detail: "This Codex CLI does not report its plan windows." };
        const parsed = RateLimitsSchema.safeParse(message.result ?? {});
        if (!parsed.success)
          return { plan, windows: null, detail: "Codex answered in a shape this desktop does not read." };
        const limits = parsed.data.rateLimits;
        plan = plan ?? planLabel(limits?.planType ?? parsed.data.planType);
        const windows = [
          limits?.primary ? toWindow("Session", limits.primary, now) : null,
          limits?.secondary ? toWindow("Weekly", limits.secondary, now) : null,
        ].filter((window): window is UsageWindow => window !== null);
        return {
          plan,
          windows,
          detail: windows.length ? "Read from the Codex app-server." : "Codex reported no active window.",
        };
      },
    });
    return result;
  } catch (error) {
    return {
      plan: null,
      windows: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
