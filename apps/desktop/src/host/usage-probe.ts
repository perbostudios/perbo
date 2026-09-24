import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_ENV_ALLOW_LIST, scrubEnvironment } from "@perbo/contracts";
import type { UsageWindow } from "../shared/protocol.js";
import { CLAUDE_METADATA_ARGS, metadataProcess } from "./model-catalog.js";
import { childEnvironment, redact } from "./process.js";

/**
 * A provider's own account of its plan windows (S6E), asked of its CLI with a
 * metadata request and never an inference turn: Claude Code answers the
 * `get_usage` control request and Codex's app-server `account/rateLimits/read`.
 * Each CLI calls its own endpoint with its own login; the desktop never holds
 * the credential. The Anthropic API reports no plan window.
 */
export interface ProviderUsage {
  plan: string | null;
  windows: UsageWindow[] | null;
  detail: string;
}

export const CLAUDE_USAGE_UNSUPPORTED =
  "This Claude Code does not report its limits without an inference turn. Update it to see them.";
const CLAUDE_NOT_REPORTED = "Claude Code did not report its limits. Check your connection and refresh.";

/**
 * Why a probe failed, written to the app's own log. The page says the probe
 * failed in words about usage; the failure underneath comes from the metadata
 * process the probe shares with model discovery and is worded about that, so
 * it goes to the log rather than to the person.
 */
function logFailure(provider: string, error: unknown): void {
  console.warn(
    `The ${provider} usage probe failed: ${redact(error instanceof Error ? error.message : String(error))}`,
  );
}

/** A provider's answer with no window to draw, and why. */
export const noWindows = (detail: string, plan: string | null = null): ProviderUsage => ({ plan, windows: null, detail });

const planLabel = (value: string | null | undefined): string | null =>
  value ? value.charAt(0).toUpperCase() + value.slice(1) : null;
const clamp = (percent: number): number => Math.max(0, Math.min(100, percent));
const isoOrNull = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

const ClaudeWindow = z.looseObject({
  utilization: z.number().nullable().optional(),
  resets_at: z.string().nullable().optional(),
});
const ClaudeUsage = z.looseObject({
  subscription_type: z.string().nullable().optional(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .looseObject({
      five_hour: ClaudeWindow.nullable().optional(),
      seven_day: ClaudeWindow.nullable().optional(),
      model_scoped: z
        .array(ClaudeWindow.extend({ display_name: z.string() }))
        .max(50)
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
const ClaudeReply = z.looseObject({
  request_id: z.string(),
  subtype: z.string(),
  response: z.unknown().optional(),
});

/** Claude's windows as its own `/usage` names them; a window reporting no utilization is left out. */
function claudeWindows(limits: z.infer<typeof ClaudeUsage>["rate_limits"]): UsageWindow[] {
  const row = (label: string, raw: z.infer<typeof ClaudeWindow> | null | undefined): UsageWindow | null =>
    raw && typeof raw.utilization === "number"
      ? { label, usedPercent: clamp(raw.utilization), resetsAt: isoOrNull(raw.resets_at) }
      : null;
  return [
    row("5-hour limit", limits?.five_hour),
    row("Weekly · all models", limits?.seven_day),
    ...(limits?.model_scoped ?? []).map((scoped) => row(`Weekly · ${scoped.display_name}`, scoped)),
  ].filter((window): window is UsageWindow => window !== null);
}

export async function claudeUsage(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; binary?: string } = {},
): Promise<ProviderUsage> {
  const scratch = mkdtempSync(join(tmpdir(), "perbo-usage-"));
  try {
    // ANTHROPIC_API_KEY is not passed, as the executor's environment does not pass it, so the windows are the login a run spends.
    const { env } = scrubEnvironment({
      base: options.env ?? childEnvironment(),
      allow: [...DEFAULT_ENV_ALLOW_LIST, "CLAUDE_CONFIG_DIR"],
      extra: { DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" },
    });
    return await metadataProcess<ProviderUsage>({
      binary: options.binary ?? "claude",
      cwd: scratch,
      env,
      timeoutMs: options.timeoutMs ?? 20_000,
      args: CLAUDE_METADATA_ARGS,
      initial: {
        type: "control_request",
        request_id: "initialize",
        request: { subtype: "initialize", hooks: {}, agents: {}, skills: [] },
      },
      receive: (message, send) => {
        if (message.type !== "control_response") return;
        const reply = ClaudeReply.safeParse(message.response);
        if (!reply.success) return;
        if (reply.data.request_id === "initialize") {
          if (reply.data.subtype !== "success") return noWindows(CLAUDE_NOT_REPORTED);
          send({
            type: "control_request",
            request_id: "usage",
            request: { subtype: "get_usage", skip_behaviors: true },
          });
          return;
        }
        if (reply.data.request_id !== "usage") return;
        if (reply.data.subtype !== "success") return noWindows(CLAUDE_USAGE_UNSUPPORTED);
        const usage = ClaudeUsage.safeParse(reply.data.response);
        if (!usage.success) return noWindows("Claude Code answered in a shape this desktop does not read.");
        const plan = planLabel(usage.data.subscription_type);
        if (!usage.data.rate_limits_available)
          return noWindows("Claude Code is signed in with an API key or a provider that has no plan limits.", plan);
        const windows = claudeWindows(usage.data.rate_limits);
        return {
          plan,
          windows,
          detail: windows.length ? "Read from Claude Code." : "Claude Code reported no active window.",
        };
      },
    });
  } catch (error) {
    logFailure("Claude Code", error);
    return noWindows(CLAUDE_NOT_REPORTED);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const CodexWindow = z.looseObject({
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
      primary: CodexWindow.nullable().optional(),
      secondary: CodexWindow.nullable().optional(),
      planType: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  planType: z.string().nullable().optional(),
});
const AccountSchema = z.looseObject({
  account: z.looseObject({ planType: z.string().nullable().optional(), type: z.string().optional() }).nullable().optional(),
});

/** Codex's window, labelled by its length the way Claude's `/usage` labels the same window. */
function codexWindow(fallback: string, raw: z.infer<typeof CodexWindow>, now: number): UsageWindow | null {
  const used = raw.usedPercent ?? raw.used_percent;
  if (used === undefined) return null;
  const minutes = raw.windowDurationMins ?? raw.windowMinutes ?? raw.window_minutes;
  const resets = raw.resetsAt ?? raw.resets_at;
  const seconds = raw.resetsInSeconds ?? raw.resets_in_seconds;
  const resetsAt =
    typeof resets === "number"
      ? new Date(resets * (resets > 1e12 ? 1 : 1000)).toISOString()
      : typeof resets === "string"
        ? isoOrNull(resets)
        : seconds !== undefined
          ? new Date(now + seconds * 1000).toISOString()
          : null;
  const label =
    minutes === undefined
      ? fallback
      : minutes >= 7 * 24 * 60 - 60
        ? "Weekly · all models"
        : `${Math.round(minutes / 60)}-hour limit`;
  return { label, usedPercent: clamp(used), resetsAt };
}

export async function codexUsage(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; binary?: string } = {},
): Promise<ProviderUsage> {
  const base = options.env ?? childEnvironment();
  const auth = join(base.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  // Signed in, since the host asks only then, but with no login file for the
  // isolated credential-only home to hold.
  if (!existsSync(auth))
    return noWindows("Codex's login is not in a file this desktop can read, so its limits are not shown.");
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
    return await metadataProcess<ProviderUsage>({
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
          limits?.primary ? codexWindow("5-hour limit", limits.primary, now) : null,
          limits?.secondary ? codexWindow("Weekly · all models", limits.secondary, now) : null,
        ].filter((window): window is UsageWindow => window !== null);
        return {
          plan,
          windows,
          detail: windows.length ? "Read from the Codex app-server." : "Codex reported no active window.",
        };
      },
    });
  } catch (error) {
    logFailure("Codex", error);
    return noWindows("Codex did not report its limits. Check your connection and refresh.");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
