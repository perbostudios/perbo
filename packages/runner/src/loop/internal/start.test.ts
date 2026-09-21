import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { RunRefusedError } from "../../refusal.js";
import { TicketRunConfigSchema } from "./config.js";
import type { RunLimits } from "./context.js";
import { start } from "./start.js";
import { contract, fakeLock } from "./test-support/fakes.js";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-27T04:00:00.000Z");

const limits = (waitBoundMs: number): RunLimits => ({
  maxRounds: 2,
  roundCeiling: 6,
  waitBoundMs,
  configPath: "/repo/.perbo/config.json",
  ticketBudgetMicros: () => null,
});

/** A run with its own state root, and a repository root nothing can materialize. */
function run(overrides: { limits?: Record<string, unknown>; state_root?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "perbo-start-"));
  scratch.push(dir);
  return {
    dir,
    config: TicketRunConfigSchema.parse({
      ticket_key: "AYO-1",
      repository_root: dir,
      worktree_root: join(dir, "worktrees"),
      bundle_root: join(dir, "bundles"),
      quarantine_root: join(dir, "quarantine"),
      state_root: overrides.state_root ?? join(dir, "state"),
      limits: LimitsTableSchema.parse({ organisation: "test", ...(overrides.limits ?? {}) }),
    }),
  };
}

describe("a provider the limits table has switched off", () => {
  it("stops the run before anything is read off disk", async () => {
    const { config } = run({ limits: { kill_switches: { disabled_providers: ["claude-code"] } } });
    const waits: number[] = [];

    await expect(
      start({
        config,
        contract: contract(),
        lock: fakeLock(),
        limits: limits(4 * 60 * 60 * 1000),
        clock: () => NOW,
        wait: async (ms) => {
          waits.push(ms);
        },
        progress: () => undefined,
      }),
    ).rejects.toThrow(/claude-code is disabled/);
    expect(waits).toEqual([]);
  });
});

describe("a park an earlier process was killed in the middle of", () => {
  /** A ticket whose record ends on an attempt parked an hour out. */
  function parked(dir: string, ticketId: string) {
    const stateRoot = join(dir, "state");
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(
      join(stateRoot, `${ticketId}.attempts.json`),
      JSON.stringify({
        schema_version: 1,
        ticket_id: ticketId,
        runs: 1,
        attempts: [
          {
            attempt_id: "att_0000000000000001",
            root_attempt_id: "att_0000000000000001",
            wait: {
              reason: "provider_reset",
              started_at: "2026-08-27T03:00:00.000Z",
              until: "2026-08-27T05:00:00.000Z",
              waited_ms: 3_600_000,
              zone: "UTC",
              quoted: "5:00am (UTC)",
            },
          },
        ],
      }),
    );
  }

  it("is waited out, and the lock says so while it lasts", async () => {
    const { dir, config } = run();
    const plan = contract();
    parked(dir, plan.ticket_id);
    const lock = fakeLock();
    const waits: number[] = [];

    await expect(
      start({
        config,
        contract: plan,
        lock,
        limits: limits(4 * 60 * 60 * 1000),
        clock: () => NOW,
        wait: async (ms) => {
          waits.push(ms);
        },
        progress: () => undefined,
      }),
      // Nothing here can be materialized, which is the refusal after the park.
    ).rejects.toBeInstanceOf(RunRefusedError);

    expect(waits).toEqual([60 * 60 * 1000]);
    expect(lock.parks).toEqual([
      expect.objectContaining({ reason: "provider_reset", until: "2026-08-27T05:00:00.000Z" }),
      null,
    ]);
  });

  it("is not waited out past a bound this configuration no longer allows", async () => {
    const { dir, config } = run();
    const plan = contract();
    parked(dir, plan.ticket_id);
    const lock = fakeLock();
    const waits: number[] = [];
    const said: string[] = [];

    await expect(
      start({
        config,
        contract: plan,
        lock,
        limits: limits(60 * 1000),
        clock: () => NOW,
        wait: async (ms) => {
          waits.push(ms);
        },
        progress: (message) => said.push(message),
      }),
    ).rejects.toBeInstanceOf(RunRefusedError);

    expect(waits).toEqual([]);
    expect(lock.parks).toEqual([]);
    expect(said.join("\n")).toContain("beyond limits.limits.wait_for_provider_ms");
  });
});
