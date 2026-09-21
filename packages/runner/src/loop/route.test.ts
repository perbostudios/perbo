import { describe, expect, it } from "vitest";
import type { AttemptWait, TerminationReason } from "@perbo/contracts";
import { TRANSPORT_RETRY_DELAY_MS } from "../transport.js";
import { routeStopped } from "./route.js";
import { attempt } from "./test-support/fakes.js";

const CUT = attempt({ attempt_id: "att_0000000000000002", head_commit: "cafe1234" });
const RESET_AT = new Date("2026-08-27T02:00:00.000Z");

const park = (overrides: Partial<AttemptWait> = {}): AttemptWait => ({
  reason: "provider_reset",
  started_at: "2026-08-27T00:00:00.000Z",
  until: RESET_AT.toISOString(),
  waited_ms: 7_200_000,
  zone: "UTC",
  quoted: "resets at 2am",
  ...overrides,
});

const route = (overrides: Partial<Parameters<typeof routeStopped>[0]> = {}) =>
  routeStopped({
    termination: { reason: "agent_error", detail: "the agent exited 1" },
    attempt: CUT,
    transportRetry: 0,
    reset: null,
    park: null,
    parkMs: 0,
    waitBoundMs: 3_600_000,
    sealedItsOwn: true,
    spend: { micros: 0, priced: 0, unpriced: 0 },
    budget: null,
    declines: 0,
    ticketKey: "SCP-094",
    branch: "prb/scp094/the-feature-module",
    runNumber: 1,
    attemptsSoFar: 1,
    configPath: "/repo/.perbo/config.json",
    ...overrides,
  });

const overloaded = { reason: "transport_unavailable" as const, detail: "HTTP 529 — Overloaded." };

describe("where an attempt that stopped short of the work sends the run", () => {
  it("sits out the transport's own delay and starts one more attempt", () => {
    const step = route({ termination: overloaded });

    expect(step).toMatchObject({
      next: "retry",
      counter: "transport",
      superseded: CUT,
      wait: { ms: TRANSPORT_RETRY_DELAY_MS, park: null },
    });
    expect(step.next === "retry" && step.say).toBe(
      "HTTP 529 — Overloaded. Waiting 60s and starting one more attempt from the same base.",
    );
  });

  it("parks until a reset within the bound, and says how long for", () => {
    const waiting = park();
    const step = route({
      termination: overloaded,
      reset: { until: RESET_AT, zone: "UTC", zone_source: "stated", quoted: "resets at 2am" },
      park: waiting,
      parkMs: waiting.waited_ms,
    });

    expect(step).toMatchObject({
      next: "retry",
      counter: "transport",
      wait: { ms: waiting.waited_ms, park: waiting },
    });
    expect(step.next === "retry" && step.say).toContain(
      "parking SCP-094 for 120 minute(s) and resuming the same attempt then.",
    );
  });

  it("stops rather than waking before a reset beyond the bound, naming the limit", () => {
    const step = route({
      termination: overloaded,
      reset: { until: RESET_AT, zone: "UTC", zone_source: "stated", quoted: "resets at 2am" },
      park: null,
      parkMs: 7_200_000,
      waitBoundMs: 600_000,
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "terminated" } });
    expect(step.next === "stop" && step.end.detail).toContain("120 minute(s) away and past");
    expect(step.next === "stop" && step.end.detail).toContain(
      "limits.limits.wait_for_provider_ms in /repo/.perbo/config.json (currently 600000 ms)",
    );
  });

  it("stops on the second transport failure in a row rather than starting a third", () => {
    const step = route({ termination: overloaded, transportRetry: 1 });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "terminated" } });
    expect(step.next === "stop" && step.end.detail).toContain(
      "The attempt before it ended the same way, so the run stops rather than starting a third.",
    );
  });

  it("continues over the sealed work while the ticket budget has room", () => {
    const step = route({
      termination: { reason: "cost_ceiling_exceeded", detail: "the attempt cost $1.00" },
      spend: { micros: 1_000_000, priced: 2, unpriced: 0 },
      budget: 3_000_000,
      attemptsSoFar: 2,
    });

    expect(step).toMatchObject({ next: "retry", counter: "ceiling", superseded: CUT, wait: null });
    expect(step.next === "retry" && step.say).toBe(
      "cost_ceiling_exceeded on att_0000000000000002; its work is sealed on " +
        "prb/scp094/the-feature-module, and run 1 attempt 3 continues over it — $1.00 of the " +
        "$3.00 ticket budget is spent",
    );
  });

  it("continues past the two iteration ceilings and past none of the others", () => {
    const room = { spend: { micros: 1_000_000, priced: 2, unpriced: 0 }, budget: 3_000_000 };
    const nextOf = (reason: TerminationReason) =>
      route({ ...room, termination: { reason, detail: "" } }).next;

    expect(nextOf("iteration_ceiling_exceeded")).toBe("retry");
    expect(nextOf("round_iteration_ceiling_exceeded")).toBe("retry");
    expect(nextOf("token_ceiling_exceeded")).toBe("stop");
    expect(nextOf("wall_clock_exceeded")).toBe("stop");
    expect(nextOf("command_ceiling_exceeded")).toBe("stop");
    expect(nextOf("stalled")).toBe("stop");
  });

  it("continues over nothing an attempt did not seal for itself", () => {
    const step = route({
      termination: { reason: "cost_ceiling_exceeded", detail: "the attempt cost $1.00" },
      sealedItsOwn: false,
      spend: { micros: 1_000_000, priced: 2, unpriced: 0 },
      budget: 3_000_000,
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "terminated" } });
    expect(step.next === "stop" && step.end.detail).toBe(
      "cost_ceiling_exceeded: the attempt cost $1.00",
    );
  });

  it("gives a ceiling with no room of its own the reason there is none", () => {
    const cut = { reason: "cost_ceiling_exceeded" as const, detail: "the attempt cost $1.00" };
    const subscription = route({ termination: cut, budget: null });
    const unpriced = route({
      termination: cut,
      spend: { micros: 0, priced: 0, unpriced: 2 },
      budget: 3_000_000,
    });
    const spent = route({
      termination: cut,
      spend: { micros: 3_000_000, priced: 2, unpriced: 1 },
      budget: 3_000_000,
    });

    expect(subscription.next === "stop" && subscription.end.detail).toContain(
      "running on a credential nothing bills per token",
    );
    expect(unpriced.next === "stop" && unpriced.end.detail).toContain(
      "No attempt of SCP-094 carries a dollar figure",
    );
    expect(spent.next === "stop" && spent.end.detail).toContain(
      "The ticket has spent $3.00 of the $3.00 in limits.limits.ticket_cost_micros",
    );
    expect(spent.next === "stop" && spent.end.detail).toContain(
      "; 1 attempt(s) carry no dollar figure and are not in that sum.",
    );
  });

  it("reads a round that changed nothing but declined something as a person's", () => {
    const declined = route({
      termination: { reason: "no_changes", detail: "the agent changed nothing" },
      declines: 2,
    });
    const silent = route({ termination: { reason: "no_changes", detail: "the agent changed nothing" } });
    const afterDenials = route({
      termination: { reason: "no_changes_after_denials", detail: "every write was denied" },
    });

    expect(declined).toMatchObject({ next: "stop", end: { outcome: "escalated" } });
    expect(declined.next === "stop" && declined.end.detail).toBe(
      "2 finding(s) declared no-determinable-practice and nothing else was changed; a person decides",
    );
    expect(silent).toMatchObject({ next: "stop", end: { outcome: "no_changes" } });
    expect(afterDenials).toMatchObject({ next: "stop", end: { outcome: "no_changes" } });
  });

  it("ends any other stop as terminated, quoting the reason and what it said", () => {
    expect(route()).toMatchObject({
      next: "stop",
      end: { outcome: "terminated", detail: "agent_error: the agent exited 1" },
    });
  });
});
