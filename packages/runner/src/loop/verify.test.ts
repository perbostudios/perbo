import { describe, expect, it } from "vitest";
import type { ClosureRow, ClosureVerification } from "@perbo/review";
import { refuseWidening, routeVerification } from "./verify.js";
import { finding } from "./test-support/fakes.js";

const verification = (overrides: Partial<ClosureVerification> = {}): ClosureVerification => ({
  all_closed: true,
  open_keys: [],
  per_finding: [],
  deterministic_failure: null,
  deterministic_failure_kind: null,
  prompt_version: "closure_v1",
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  cost_micros: 1000,
  cost_basis: "transport_reported",
  ...overrides,
});

const closed = (key: string): ClosureRow => ({
  finding_key: key,
  status: "closed",
  pointer: "test/feature.test.ts",
  idiomatic: "cannot_tell",
  practice: "",
});
const open = (key: string): ClosureRow => ({
  finding_key: key,
  status: "not_closed",
  pointer: "",
  idiomatic: "cannot_tell",
  practice: "",
});

const route = (overrides: Partial<Parameters<typeof routeVerification>[0]> = {}) =>
  routeVerification({
    verification: verification(),
    toVerify: [],
    openFindings: [],
    declines: 0,
    remediationRound: 1,
    maxRounds: 2,
    spend: { micros: 0, priced: 0 },
    budget: null,
    configPath: "/repo/.perbo/config.json",
    ...overrides,
  });

describe("a scope round that widened instead of narrowing", () => {
  it("is refused with the paths that arrived and the globs the contract admits", () => {
    const step = refuseWidening({
      widened: ["src/other.ts"],
      scopeGiven: [finding({ rule_id: "scope.outside_allowed" })],
      remediationRound: 1,
      pathsAllowed: ["src/feature/**"],
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "changes_requested" } });
    expect(step?.end.detail).toContain("was given 1 scope finding(s) and widened");
    expect(step?.end.detail).toContain("src/other.ts");
    expect(step?.end.detail).toContain("src/feature/**");
  });

  it("names five paths and says there are more", () => {
    const step = refuseWidening({
      widened: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
      scopeGiven: [],
      remediationRound: 1,
      pathsAllowed: [],
    });

    expect(step?.end.detail).toContain("a.ts, b.ts, c.ts, d.ts, e.ts, … were not in");
  });

  it("says nothing about a round that narrowed", () => {
    expect(
      refuseWidening({ widened: [], scopeGiven: [], remediationRound: 1, pathsAllowed: [] }),
    ).toBeNull();
  });
});

describe("where a round's closure verification sends the run", () => {
  it("reads a check that was already failing as still failing rather than as a regression", () => {
    const step = route({
      toVerify: [finding({ source: "deterministic", rule_id: "check.unit" })],
      verification: verification({
        deterministic_failure: "check_ut is failed",
        deterministic_failure_kind: "check",
      }),
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "changes_requested" } });
    expect(step.next === "stop" && step.end.detail).toBe(
      "the pinned checks still fail after remediation round 1: check_ut is failed",
    );
  });

  it("reads any other deterministic failure as the fix having regressed", () => {
    const scope = route({
      toVerify: [finding({ source: "deterministic", rule_id: "check.unit" })],
      verification: verification({
        deterministic_failure: "scope: src/other.ts",
        deterministic_failure_kind: "scope",
      }),
    });
    const checkNobodyRouted = route({
      toVerify: [finding({ source: "semantic", rule_id: "test.missing_for_criterion" })],
      verification: verification({
        deterministic_failure: "check_ut is failed",
        deterministic_failure_kind: "check",
      }),
    });

    expect(scope.next === "stop" && scope.end.detail).toBe("the fix regressed: scope: src/other.ts");
    expect(checkNobodyRouted.next === "stop" && checkNobodyRouted.end.detail).toBe(
      "the fix regressed: check_ut is failed",
    );
  });

  it("approves a round that closed everything, and asks a person where any was declined", () => {
    const approved = route({ remediationRound: 2 });
    const withDeclines = route({ remediationRound: 2, declines: 1 });

    expect(approved).toMatchObject({ next: "stop", end: { outcome: "approved" } });
    expect(approved.next === "stop" && approved.end.detail).toBe(
      "round 0's routed findings verified closed after 2 remediation round(s)",
    );
    expect(withDeclines).toMatchObject({ next: "stop", end: { outcome: "escalated" } });
    expect(withDeclines.next === "stop" && withDeclines.end.detail).toContain(
      "1 finding(s) declared no-determinable-practice",
    );
  });

  it("stalls a round that closed none of what it was given, naming what is still open", () => {
    const one = finding({ key: "a".repeat(64) });
    const step = route({
      toVerify: [one],
      openFindings: [one],
      verification: verification({
        all_closed: false,
        open_keys: [one.key],
        per_finding: [open(one.key)],
      }),
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "remediation_stalled" } });
    expect(step.next === "stop" && step.end.detail).toContain(
      `closed none of the 1 finding(s) it was given`,
    );
    expect(step.next === "stop" && step.end.detail).toContain(`Still open: ${one.key}`);
  });

  it("buys the next round for one that closed something and has rounds and money left", () => {
    const shut = finding({ key: "a".repeat(64) });
    const left = finding({ key: "b".repeat(64) });
    const step = route({
      toVerify: [shut, left],
      openFindings: [shut, left],
      spend: { micros: 100, priced: 1 },
      budget: 1_000_000,
      verification: verification({
        all_closed: false,
        open_keys: [left.key],
        per_finding: [closed(shut.key), open(left.key)],
      }),
    });

    expect(step).toMatchObject({
      next: "advance",
      kind: "remediate",
      remediation: true,
      carry: { openFindings: [left] },
    });
  });

  it("checks the cap before the budget, and each says where to raise itself", () => {
    const shut = finding({ key: "a".repeat(64) });
    const left = finding({ key: "b".repeat(64) });
    const stillClosing = {
      toVerify: [shut, left],
      openFindings: [shut, left],
      verification: verification({
        all_closed: false,
        open_keys: [left.key],
        per_finding: [closed(shut.key), open(left.key)],
      }),
    };
    const atBoth = route({
      ...stillClosing,
      remediationRound: 2,
      spend: { micros: 3_000_000, priced: 2 },
      budget: 500_000,
    });
    const atTheBudget = route({
      ...stillClosing,
      remediationRound: 1,
      spend: { micros: 3_000_000, priced: 2 },
      budget: 500_000,
    });

    expect(atBoth).toMatchObject({ next: "stop", end: { outcome: "remediation_exhausted" } });
    expect(atBoth.next === "stop" && atBoth.end.detail).toContain("2 is the cap");
    expect(atTheBudget).toMatchObject({ next: "stop", end: { outcome: "remediation_exhausted" } });
    expect(atTheBudget.next === "stop" && atTheBudget.end.detail).toContain(
      "the ticket has spent $3.00 of the $0.50 in limits.limits.ticket_cost_micros",
    );
  });

  it("leaves an unpriced run to the cap alone", () => {
    const shut = finding({ key: "a".repeat(64) });
    const left = finding({ key: "b".repeat(64) });
    const step = route({
      toVerify: [shut, left],
      openFindings: [shut, left],
      spend: { micros: 9_000_000, priced: 0 },
      budget: 500_000,
      verification: verification({
        all_closed: false,
        open_keys: [left.key],
        per_finding: [closed(shut.key), open(left.key)],
      }),
    });

    expect(step).toMatchObject({ next: "advance", kind: "remediate" });
  });

  it("adds the declined count to every stop that names what is still open", () => {
    const shut = finding({ key: "a".repeat(64) });
    const left = finding({ key: "b".repeat(64) });
    const step = route({
      toVerify: [shut, left],
      openFindings: [shut, left],
      declines: 2,
      remediationRound: 2,
      verification: verification({
        all_closed: false,
        open_keys: [left.key],
        per_finding: [closed(shut.key), open(left.key)],
      }),
    });

    expect(step.next === "stop" && step.end.detail).toContain("(and 2 declined for a person)");
  });
});
