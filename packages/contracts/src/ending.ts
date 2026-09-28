import type { UsageLimit, UsageLimitRole } from "./usage-limit.js";

/**
 * How an attempt ended, and the connection that ran it, in Perbo's words: the
 * one home for them, which the resumed executor's brief and the pull
 * request's list of attempts both read. Every word is from the records — the
 * termination reason, the wait and the usage limit the runner wrote, and the
 * connection a run configuration or a transport names — and never from a
 * termination's detail or anything a model wrote (ADR-0023).
 */

/**
 * The name a person knows a connection by, from the words the records use for
 * it: a run configuration's provider (`claude-cli`), an adapter's name
 * (`claude-code`), or a transport's provider. A name none of them uses is
 * given back as written.
 */
export function connectionName(id: string): string {
  switch (id) {
    case "claude-cli":
    case "claude-code":
      return "Claude Code";
    case "codex-cli":
    case "codex":
      return "Codex";
    case "opencode-cli":
    case "opencode":
      return "OpenCode";
    case "anthropic":
      return "Anthropic API";
    default:
      return id;
  }
}

/**
 * Who or what stopped an attempt part-way, where anything named did: a
 * person, a ceiling, or its connection's usage limit. Null for every other
 * ending, which is not a stop by someone or something.
 */
export function stoppedBy(reason: string, limit: UsageLimitRole | null): string | null {
  if (limit === "executor") return "its provider's usage limit";
  if (reason === "cancelled") return "a person";
  if (reason.endsWith("_exceeded")) return "a ceiling";
  return null;
}

/** The fields of an attempt record its ending is read from. */
export interface EndingAttempt {
  termination: { reason: string };
  wait: { until: string; zone: string } | null;
  usage_limit: Pick<UsageLimit, "role" | "provider" | "until" | "zone"> | null;
}

/** How one attempt ended, in a phrase a sentence or a table cell carries. */
export function attemptEnding(attempt: EndingAttempt): string {
  const { reason } = attempt.termination;
  const limit = attempt.usage_limit;
  if (limit !== null && limit.role === "reviewer") {
    return (
      `${reason === "completed" ? "completed" : `ended \`${reason}\``}; its review was refused by the usage limit ` +
      `on ${connectionName(limit.provider)} until ${limit.until} (${limit.zone})`
    );
  }
  if (limit !== null) {
    return `stopped by the usage limit on ${connectionName(limit.provider)} until ${limit.until} (${limit.zone})`;
  }
  if (attempt.wait !== null) {
    return reason === "transport_unavailable"
      ? `refused by its provider, which named its reset; the run waited until ${attempt.wait.until} ` +
          `(${attempt.wait.zone}) and went on`
      : `${reason === "completed" ? "completed" : `ended \`${reason}\``}; its review waited for its provider's ` +
          `reset until ${attempt.wait.until} (${attempt.wait.zone})`;
  }
  const by = stoppedBy(reason, null);
  if (by !== null) return `stopped by ${by} (\`${reason}\`)`;
  switch (reason) {
    case "completed":
      return "completed";
    case "transport_unavailable":
      return "ended when its provider was unavailable";
    case "stalled":
      return "stalled: no tool activity for the stall window";
    case "no_changes":
      return "changed nothing";
    case "no_changes_after_denials":
      return "changed nothing after the guard refused its commands";
    default:
      return `ended \`${reason}\``;
  }
}
