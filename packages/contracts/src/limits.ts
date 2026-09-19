import { z } from "zod";
import type { CredentialClass } from "./attempt.js";

/**
 * Hard limits.
 *
 * One assertion over a limits table, plus the runner's stall detector, is what
 * stops work nobody meant to run.
 *
 * The table is data, not code: it is read from a file on the machine running
 * the attempt.
 */

export const LIMITED_RESOURCES = [
  "concurrent_local_attempts",
  "local_workspace_bytes",
  "attempt_stall_ms",
  "attempt_wall_clock_ms",
  "attempt_commands",
  "attempt_iterations",
  "round_iterations",
  "attempt_tokens",
  "attempt_cost_micros",
  "remediation_rounds",
  "ticket_cost_micros",
  "wait_for_provider_ms",
] as const;
export const LimitedResourceSchema = z.enum(LIMITED_RESOURCES);
export type LimitedResource = (typeof LIMITED_RESOURCES)[number];

/**
 * The six resources a run is bounded by only where a repository says so
 * (D-096).
 *
 * An iteration is one assistant event on the executor's stream — a message,
 * not a tool call — and a command is one tool call; both were proxies for
 * spend. Cost, wall clock and fresh tokens were the spend itself, and a person
 * reads that on their own provider account as the run goes. Every one of them
 * cut ordinary work when it fired, so none of them fires unless a repository
 * names it in its own configuration and gets exactly the ceiling it asked for.
 *
 * `attempt_cost_micros` is here as well as in `PER_TOKEN_COST_LIMITS`: the
 * table defaults it to nothing, and a per-token credential is what puts a
 * number behind it.
 */
export const UNSET_UNLESS_CONFIGURED = [
  "attempt_commands",
  "attempt_iterations",
  "round_iterations",
  "attempt_wall_clock_ms",
  "attempt_tokens",
  "attempt_cost_micros",
] as const;
export type UnsetUnlessConfigured = (typeof UNSET_UNLESS_CONFIGURED)[number];

/**
 * The cost caps, and the credential that gives them a number (D-096).
 *
 * A subscription bills by the month whatever an attempt does, so a dollar
 * figure on one is a measure and never a bill, and stopping ordinary work
 * against it charges nobody anything. An executor that authenticated with an
 * API key — from its environment or from the key helper the person's own
 * configuration names — is billed per token, and there these are the caps: $5
 * an attempt and $60 across a ticket, the numbers they have always had. A repository that names either
 * key overrides its number here, and on a subscription neither bounds anything
 * whether or not the table names it.
 *
 * `limitsForCredential` is the one place that decision is made; everything
 * downstream reads the table it returns.
 */
export const PER_TOKEN_COST_LIMITS: Readonly<Record<PerTokenCostLimit, number>> = {
  attempt_cost_micros: 5_000_000,
  ticket_cost_micros: 60_000_000,
};
export type PerTokenCostLimit = "attempt_cost_micros" | "ticket_cost_micros";

/** Every other resource: one number the table falls back to. */
export type DefaultedResource = Exclude<
  LimitedResource,
  UnsetUnlessConfigured | "ticket_cost_micros"
>;

/**
 * Kill switches (SCP-087). Three, and no more: an organisation's automation, a
 * provider or model, and a global read-only mode. Each is a boolean a human
 * flips, not a policy engine.
 */
export const KillSwitchesSchema = z.strictObject({
  organisation_automation_disabled: z.boolean().default(false),
  disabled_providers: z.array(z.string().min(1)).default([]),
  disabled_models: z.array(z.string().min(1)).default([]),
  global_read_only: z.boolean().default(false),
});
export type KillSwitches = z.infer<typeof KillSwitchesSchema>;

/**
 * The five resources every run is bounded by, and what each number is for.
 *
 * `concurrent_local_attempts` defaults to 1 and `local_workspace_bytes` to
 * 20 GiB because the execution substrate is a laptop (D-049). A ceiling that
 * assumes a cloud runner is not a ceiling. Neither is a run ceiling: they bound
 * the machine an attempt runs on rather than the work it does.
 *
 * `attempt_stall_ms` — 20 min. The one thing that stops an attempt nobody asked
 * to stop (D-096). It is measured from the last tool activity the runner saw on
 * the executor's stream, so it has to be longer than two things. The first is
 * the longest single turn a coding agent takes without calling a tool, which is
 * minutes: thinking, then a long answer. The second is the longest single tool
 * call, because the runner sees a call's result only when it returns and a cold
 * install plus a full build and test suite is one call that says nothing for
 * the whole of it. Twenty minutes clears both, and a genuine hang costs twenty
 * idle minutes and no money.
 *
 * `remediation_rounds` is 6, raised from 2 (SCP-194). It is a hard cap above
 * the progress rule rather than the rule itself: a round that closed nothing
 * ends the ticket well before this, and a round that closed something earns the
 * next until either this or the ticket budget is reached. Two was a number, not
 * a measurement, and it stopped AYO-34 with one finding open that the round it
 * was refused would have closed. It bounds a **ticket** rather than an attempt
 * (SCP-193), and is here rather than in a table of its own because it is read
 * from the same file, overridden by the same `limits.limits.<name>` key in
 * `<repo>/.perbo/config.json`, and printed by the same `doctor` block.
 *
 * `wait_for_provider_ms` — 6 h. The longest the loop will sit out a provider
 * session limit that named its own reset time. A reset further out than this is
 * not waited for; the run stops and says so, because waking before the
 * provider's own reset spends an attempt against a limit still in force. It is
 * a wait rather than a ceiling on the work.
 *
 * Cost, wall clock, fresh tokens, iterations and commands are absent, which is
 * the whole of D-096: an attempt and a remediation round are bounded by the
 * stall detector, the round count and — where the executor bills per token —
 * the two cost caps, and by nothing else. A table that names one of the absent
 * five gets exactly that ceiling.
 */
export const DEFAULT_LIMITS: Readonly<Record<DefaultedResource, number>> &
  Readonly<Partial<Record<UnsetUnlessConfigured | "ticket_cost_micros", number>>> = {
  concurrent_local_attempts: 1,
  local_workspace_bytes: 20 * 1024 * 1024 * 1024,
  attempt_stall_ms: 20 * 60 * 1000,
  remediation_rounds: 6,
  wait_for_provider_ms: 6 * 60 * 60 * 1000,
};

/**
 * The table an attempt is judged against, once the credential the executor
 * authenticated with is known (D-096).
 *
 * `unknown` is capped with `user_api_key` rather than exempted with
 * `subscription`: it means the runner could not read what the executor
 * authenticated with, and a credential nobody identified is not evidence that
 * nobody is billed per token.
 */
export function limitsForCredential(
  table: LimitsTable,
  credential: CredentialClass,
): LimitsTable {
  if (credential === "subscription") {
    const limits = { ...table.limits };
    for (const resource of Object.keys(PER_TOKEN_COST_LIMITS)) delete limits[resource];
    return { ...table, limits };
  }
  return { ...table, limits: { ...PER_TOKEN_COST_LIMITS, ...table.limits } };
}

/**
 * Overrides are partial and the key set is closed: an unknown resource name is
 * a typo that would otherwise silently raise no ceiling at all.
 */
const LimitOverridesSchema = z
  .record(z.string(), z.number().int().min(0))
  .superRefine((overrides, ctx) => {
    for (const key of Object.keys(overrides)) {
      if (!(LIMITED_RESOURCES as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            `unknown limited resource '${key}' ` +
            `(known: ${LIMITED_RESOURCES.join(", ")})`,
        });
      }
    }
  });

export const LimitsTableSchema = z.strictObject({
  organisation: z.string().min(1),
  limits: LimitOverridesSchema.default({}),
  kill_switches: KillSwitchesSchema.prefault({}),
});
export type LimitsTable = z.infer<typeof LimitsTableSchema>;

export const DEFAULT_LIMITS_TABLE: LimitsTable = LimitsTableSchema.parse({
  organisation: "local",
});

export const LIMIT_EXCEEDED_REASONS = [
  "limit_exceeded",
  "automation_disabled",
  "read_only_mode",
  "provider_disabled",
] as const;
export type LimitExceededReason = (typeof LIMIT_EXCEEDED_REASONS)[number];

/**
 * The typed refusal. Every ceiling terminates an attempt with one of these and
 * an audit entry, rather than with a generic error a caller has to pattern-match
 * on a message string.
 */
export class LimitExceededError extends Error {
  readonly reason: LimitExceededReason;
  readonly resource: LimitedResource | null;
  readonly limit: number | null;
  readonly requested: number | null;

  constructor(
    reason: LimitExceededReason,
    resource: LimitedResource | null,
    limit: number | null,
    requested: number | null,
    message: string,
  ) {
    super(message);
    this.name = "LimitExceededError";
    this.reason = reason;
    this.resource = resource;
    this.limit = limit;
    this.requested = requested;
  }
}

/** The ceiling in force for a resource, or `null` where nothing sets one. */
export function limitFor(table: LimitsTable, resource: DefaultedResource): number;
export function limitFor(table: LimitsTable, resource: LimitedResource): number | null;
export function limitFor(table: LimitsTable, resource: LimitedResource): number | null {
  return table.limits[resource] ?? DEFAULT_LIMITS[resource] ?? null;
}

/**
 * SCP-087 acceptance criterion 1: one call gates every countable resource.
 *
 * `n` is the value **after** the increment the caller is about to make, so a
 * caller asking for the first of something passes 1. Equal to the limit is
 * allowed; above it is not, and a resource with no ceiling has nothing to be
 * above.
 */
export function assertWithinLimits(
  table: LimitsTable,
  resource: LimitedResource,
  n: number,
): void {
  if (table.kill_switches.global_read_only) {
    throw new LimitExceededError(
      "read_only_mode",
      resource,
      null,
      n,
      "global read-only mode is engaged: no attempt may start or continue",
    );
  }
  if (table.kill_switches.organisation_automation_disabled) {
    throw new LimitExceededError(
      "automation_disabled",
      resource,
      null,
      n,
      `automation is disabled for organisation ${table.organisation}`,
    );
  }
  const limit = limitFor(table, resource);
  // No ceiling is not a ceiling of infinity: nothing is tested, and the caller
  // keeps counting (D-096).
  if (limit !== null && n > limit) {
    throw new LimitExceededError(
      "limit_exceeded",
      resource,
      limit,
      n,
      `${resource} would reach ${n}, above the limit of ${limit}`,
    );
  }
}

/** Provider and model kill switches, checked before an attempt spends anything. */
export function assertProviderEnabled(
  table: LimitsTable,
  provider: string,
  model: string,
): void {
  if (table.kill_switches.disabled_providers.includes(provider)) {
    throw new LimitExceededError(
      "provider_disabled",
      null,
      null,
      null,
      `provider ${provider} is disabled by kill switch`,
    );
  }
  if (table.kill_switches.disabled_models.includes(model)) {
    throw new LimitExceededError(
      "provider_disabled",
      null,
      null,
      null,
      `model ${model} is disabled by kill switch`,
    );
  }
}
