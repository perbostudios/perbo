import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  DEFAULT_LIMITS_TABLE,
  LimitExceededError,
  LimitsTableSchema,
  PER_TOKEN_COST_LIMITS,
  assertProviderEnabled,
  assertWithinLimits,
  limitFor,
  limitsForCredential,
} from "./limits.js";

describe("assertWithinLimits", () => {
  it("gates every countable resource through one call", () => {
    expect(() =>
      assertWithinLimits(DEFAULT_LIMITS_TABLE, "concurrent_local_attempts", 1),
    ).not.toThrow();
    expect(() => assertWithinLimits(DEFAULT_LIMITS_TABLE, "concurrent_local_attempts", 2)).toThrow(
      LimitExceededError,
    );
  });

  it("defaults concurrent_local_attempts to 1 and states a workspace byte ceiling (D-049)", () => {
    expect(DEFAULT_LIMITS.concurrent_local_attempts).toBe(1);
    expect(DEFAULT_LIMITS.local_workspace_bytes).toBeGreaterThan(0);
  });

  it("carries the resource, the limit and the requested value on the refusal", () => {
    const table = LimitsTableSchema.parse({ organisation: "org", limits: { attempt_commands: 200 } });
    try {
      assertWithinLimits(table, "attempt_commands", 10_000);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LimitExceededError);
      const typed = error as LimitExceededError;
      expect(typed.reason).toBe("limit_exceeded");
      expect(typed.resource).toBe("attempt_commands");
      expect(typed.limit).toBe(200);
      expect(typed.requested).toBe(10_000);
    }
  });

  it("treats equal to the limit as within it", () => {
    const table = LimitsTableSchema.parse({ organisation: "org", limits: { attempt_commands: 3 } });
    expect(() => assertWithinLimits(table, "attempt_commands", 3)).not.toThrow();
    expect(() => assertWithinLimits(table, "attempt_commands", 4)).toThrow(LimitExceededError);
  });

  it("stops everything under global read-only, before any per-resource check", () => {
    const table = LimitsTableSchema.parse({
      organisation: "org",
      limits: { attempt_commands: 1000 },
      kill_switches: { global_read_only: true },
    });
    try {
      assertWithinLimits(table, "attempt_commands", 1);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as LimitExceededError).reason).toBe("read_only_mode");
    }
  });

  it("stops an organisation whose automation is disabled", () => {
    const table = LimitsTableSchema.parse({
      organisation: "org",
      kill_switches: { organisation_automation_disabled: true },
    });
    expect(() => assertWithinLimits(table, "attempt_tokens", 1)).toThrow(/automation is disabled/);
  });
});

describe("limits table", () => {
  it("rejects an unknown resource name rather than silently raising no ceiling", () => {
    const parsed = LimitsTableSchema.safeParse({
      organisation: "org",
      limits: { attempt_command: 5 },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("unknown limited resource");
  });

  it("falls back to the default for a resource with no override", () => {
    const table = LimitsTableSchema.parse({ organisation: "org" });
    expect(limitFor(table, "remediation_rounds")).toBe(DEFAULT_LIMITS.remediation_rounds);
  });

  /**
   * D-096. None of the six has a default: cost, wall clock and fresh tokens
   * were the ceilings people read on their own provider account anyway, and an
   * iteration or a command was only ever a proxy for those. A table without
   * them is a table with no ceiling on them, and what stops a hang is the stall
   * detector instead.
   */
  it("accepts a table naming none of the six counters, and bounds none of them", () => {
    const table = LimitsTableSchema.parse({ organisation: "org" });
    for (const resource of [
      "attempt_iterations",
      "round_iterations",
      "attempt_commands",
      "attempt_wall_clock_ms",
      "attempt_tokens",
      "attempt_cost_micros",
    ] as const) {
      expect(DEFAULT_LIMITS[resource]).toBeUndefined();
      expect(limitFor(table, resource)).toBeNull();
      expect(() => assertWithinLimits(table, resource, 10_000_000_000)).not.toThrow();
    }
  });

  it("accepts a table that sets them, and each one still fires at what it says", () => {
    const table = LimitsTableSchema.parse({
      organisation: "org",
      limits: {
        attempt_iterations: 400,
        round_iterations: 80,
        attempt_commands: 400,
        attempt_wall_clock_ms: 60_000,
        attempt_tokens: 1_000,
      },
    });
    expect(limitFor(table, "attempt_iterations")).toBe(400);
    expect(limitFor(table, "round_iterations")).toBe(80);
    expect(limitFor(table, "attempt_commands")).toBe(400);
    expect(limitFor(table, "attempt_wall_clock_ms")).toBe(60_000);
    expect(limitFor(table, "attempt_tokens")).toBe(1_000);
    expect(() => assertWithinLimits(table, "attempt_iterations", 401)).toThrow(LimitExceededError);
    expect(() => assertWithinLimits(table, "round_iterations", 81)).toThrow(LimitExceededError);
    expect(() => assertWithinLimits(table, "attempt_commands", 401)).toThrow(LimitExceededError);
    expect(() => assertWithinLimits(table, "attempt_wall_clock_ms", 60_001)).toThrow(
      LimitExceededError,
    );
    expect(() => assertWithinLimits(table, "attempt_tokens", 1_001)).toThrow(LimitExceededError);
  });

  /**
   * SCP-323: the one resource this ticket adds a default to, because it is the
   * only thing left that stops a run nobody asked to stop.
   */
  it("defaults the stall window, which no table has to name", () => {
    const table = LimitsTableSchema.parse({ organisation: "org" });
    expect(limitFor(table, "attempt_stall_ms")).toBe(20 * 60 * 1000);
    expect(() => assertWithinLimits(table, "attempt_stall_ms", 20 * 60 * 1000)).not.toThrow();
    expect(() => assertWithinLimits(table, "attempt_stall_ms", 20 * 60 * 1000 + 1)).toThrow(
      LimitExceededError,
    );
  });

  /**
   * A record written before D-096 names them, and it still parses: the schema
   * is the same closed key set, and only the default came out.
   */
  it("keeps an older configuration that names them parsing", () => {
    const parsed = LimitsTableSchema.safeParse({
      organisation: "perbo",
      limits: { attempt_iterations: 400, round_iterations: 80, attempt_commands: 400 },
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * D-096: a cost cap means something only where the executor is billed per
 * token. A subscription bills by the month whatever an attempt does, so a
 * dollar figure on it is a measure and never a bill, and capping on it stops
 * ordinary work for a number nobody is charged.
 */
describe("the cost caps follow the credential the attempt records", () => {
  const table = LimitsTableSchema.parse({ organisation: "org" });

  it("bounds neither cost resource on its own, whatever the table says", () => {
    expect(limitFor(table, "attempt_cost_micros")).toBeNull();
    expect(limitFor(table, "ticket_cost_micros")).toBeNull();
  });

  it("applies $5 an attempt and $60 a ticket against an API key", () => {
    const applied = limitsForCredential(table, "user_api_key");
    expect(limitFor(applied, "attempt_cost_micros")).toBe(PER_TOKEN_COST_LIMITS.attempt_cost_micros);
    expect(limitFor(applied, "ticket_cost_micros")).toBe(PER_TOKEN_COST_LIMITS.ticket_cost_micros);
    expect(PER_TOKEN_COST_LIMITS.attempt_cost_micros).toBe(5_000_000);
    expect(PER_TOKEN_COST_LIMITS.ticket_cost_micros).toBe(60_000_000);
    expect(() => assertWithinLimits(applied, "attempt_cost_micros", 5_000_001)).toThrow(
      LimitExceededError,
    );
  });

  it("lets the repository override the per-token defaults", () => {
    const configured = LimitsTableSchema.parse({
      organisation: "org",
      limits: { attempt_cost_micros: 15_000_000, ticket_cost_micros: 200_000_000 },
    });
    const applied = limitsForCredential(configured, "user_api_key");
    expect(limitFor(applied, "attempt_cost_micros")).toBe(15_000_000);
    expect(limitFor(applied, "ticket_cost_micros")).toBe(200_000_000);
  });

  it("bounds nothing on a subscription, including a cap the repository set", () => {
    const configured = LimitsTableSchema.parse({
      organisation: "org",
      limits: { attempt_cost_micros: 500, ticket_cost_micros: 1_000 },
    });
    const applied = limitsForCredential(configured, "subscription");
    expect(limitFor(applied, "attempt_cost_micros")).toBeNull();
    expect(limitFor(applied, "ticket_cost_micros")).toBeNull();
    expect(() => assertWithinLimits(applied, "attempt_cost_micros", 900_000_000)).not.toThrow();
  });

  it("caps a credential it could not identify, because unknown is not a subscription", () => {
    const applied = limitsForCredential(table, "unknown");
    expect(limitFor(applied, "attempt_cost_micros")).toBe(PER_TOKEN_COST_LIMITS.attempt_cost_micros);
  });

  it("leaves every other resource exactly as the table had it", () => {
    const configured = LimitsTableSchema.parse({
      organisation: "org",
      limits: { attempt_commands: 400, attempt_stall_ms: 90_000 },
    });
    for (const credential of ["subscription", "user_api_key"] as const) {
      const applied = limitsForCredential(configured, credential);
      expect(limitFor(applied, "attempt_commands")).toBe(400);
      expect(limitFor(applied, "attempt_stall_ms")).toBe(90_000);
      expect(applied.organisation).toBe("org");
      expect(applied.kill_switches).toEqual(configured.kill_switches);
    }
  });
});

describe("assertProviderEnabled", () => {
  it("refuses a disabled provider and a disabled model separately", () => {
    const table = LimitsTableSchema.parse({
      organisation: "org",
      kill_switches: { disabled_providers: ["claude-cli"], disabled_models: ["claude-opus-5"] },
    });
    expect(() => assertProviderEnabled(table, "claude-cli", "x")).toThrow(/provider claude-cli/);
    expect(() => assertProviderEnabled(table, "anthropic", "claude-opus-5")).toThrow(
      /model claude-opus-5/,
    );
    expect(() => assertProviderEnabled(table, "anthropic", "other")).not.toThrow();
  });
});
