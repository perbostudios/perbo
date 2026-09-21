import { describe, expect, it } from "vitest";
import type { AttemptWait, TerminationReason } from "@perbo/contracts";
import { TRANSPORT_RETRY_DELAY_MS } from "../transport.js";
import { routeConflict, routeResolution, routeStopped } from "./route.js";
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

const conflict = (overrides: Partial<Parameters<typeof routeConflict>[0]> = {}) =>
  routeConflict({
    conflict: { tip: "f00ba412", paths: ["src/feature.ts"], detail: "Automatic merge failed" },
    kind: "execute",
    baseRef: "main",
    branch: "prb/scp094/the-feature-module",
    ...overrides,
  });

describe("where a change set the base will not merge into sends the run", () => {
  it("gives a round to the resolution, naming what it is resuming afterwards", () => {
    expect(conflict({ kind: "remediate" })).toMatchObject({
      next: "advance",
      kind: "resolve_conflict",
      remediation: false,
      carry: {
        conflict: {
          tip: "f00ba412",
          paths: ["src/feature.ts"],
          before_executor: false,
          resume_kind: "remediate",
        },
      },
    });
  });

  it("stops on a merge that named no unmerged file, because no round can resolve one", () => {
    const step = conflict({
      conflict: { tip: "f00ba412", paths: [], detail: "error: your local changes" },
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "base_conflict" } });
    expect(step.next === "stop" && step.end.detail).toContain("git named no conflicting file");
    expect(step.next === "stop" && step.end.detail).toContain("error: your local changes");
  });

  it("stops rather than paying twice for the answer a resolution round already gave", () => {
    const step = conflict({ kind: "resolve_conflict" });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "base_conflict" } });
    expect(step.next === "stop" && step.end.detail).toBe(
      "main at f00ba412 will not merge into prb/scp094/the-feature-module: src/feature.ts. " +
        "The round given the conflict did not resolve it, so a person reconciles those files.",
    );
  });
});

const resolution = (overrides: Partial<Parameters<typeof routeResolution>[0]> = {}) =>
  routeResolution({
    markers: [],
    changedPaths: 3,
    beforeExecutor: true,
    resumeKind: "execute",
    relevel: false,
    round: 0,
    ...overrides,
  });

describe("where a round given a base conflict sends the run once it is sealed", () => {
  it("stops on a resolution that committed the markers, whatever git reports", () => {
    const routed = resolution({ markers: ["src/feature.ts", "src/other.ts"] });

    expect(routed.say).toBeNull();
    expect(routed.step).toMatchObject({ next: "stop", end: { outcome: "base_conflict" } });
    expect(routed.step?.next === "stop" && routed.step.end.detail).toContain(
      "left a conflict marker in src/feature.ts, src/other.ts",
    );
  });

  it("returns a conflict found before the executor to the brief it interrupted", () => {
    const toTheTicket = resolution({ resumeKind: "execute", round: 0 });
    const toARemediation = resolution({ resumeKind: "remediate", round: 2 });

    expect(toTheTicket.say).toBe("the base conflict is resolved on 3 file(s)");
    expect(toTheTicket.step).toMatchObject({
      next: "advance",
      kind: "execute",
      remediation: false,
      carry: { conflict: null, executeRound: 1 },
    });
    expect(toARemediation.step).toMatchObject({ next: "advance", kind: "remediate" });
    expect(
      toARemediation.step?.next === "advance" && toARemediation.step.carry?.executeRound,
    ).toBeUndefined();
  });

  it("judges a resolution that interrupted a round which had already done its work", () => {
    const afterTheSeal = resolution({ beforeExecutor: false });
    const forARelevel = resolution({ relevel: true });

    expect(afterTheSeal.step).toBeNull();
    expect(afterTheSeal.say).toBe("the base conflict is resolved on 3 file(s)");
    expect(forARelevel.step).toBeNull();
  });
});
