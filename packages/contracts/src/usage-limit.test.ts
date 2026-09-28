import { describe, expect, it } from "vitest";
import { usageLimitHolds, usageLimitStop, type UsageLimit } from "./usage-limit.js";

/**
 * Which stops are a provider's usage limit (D-NEW-pass-a-limited-loop-on),
 * read from the attempt's recorded termination, wait and usage limit and the
 * review's recorded decision — never from a detail's words.
 */

const QUOTED = "You've hit your session limit · resets 4:30am (Europe/London)";
const executorLimit: UsageLimit = {
  role: "executor",
  provider: "claude-cli",
  model: "claude-opus-5-5",
  until: "2026-09-04T03:30:00.000Z",
  zone: "Europe/London",
  quoted: QUOTED,
};
const wait = { until: "2026-09-04T03:30:00.000Z", zone: "Europe/London", quoted: QUOTED };
const refused = {
  decision: "error",
  error: { kind: "provider_unavailable" },
  model: { provider: "codex-cli", model_id: "gpt-5.5" },
};

describe("usageLimitStop", () => {
  it("reads the executor's limit the runner recorded on an attempt its provider refused", () => {
    expect(
      usageLimitStop({ termination: { reason: "transport_unavailable" }, wait: null, usage_limit: executorLimit }, null),
    ).toEqual({ ...executorLimit, waited: false });
  });

  it("reads the reviewer's limit the runner recorded on the attempt whose review was refused", () => {
    const limit: UsageLimit = { ...executorLimit, role: "reviewer", provider: "anthropic", model: "claude-fable-5-1" };
    expect(
      usageLimitStop({ termination: { reason: "completed" }, wait: null, usage_limit: limit }, refused),
    ).toEqual({ ...limit, waited: false });
  });

  it("reads a review refused again after the run waited out its stated reset from the wait and the review", () => {
    expect(usageLimitStop({ termination: { reason: "completed" }, wait, usage_limit: null }, refused)).toEqual({
      role: "reviewer",
      provider: "codex-cli",
      model: "gpt-5.5",
      until: wait.until,
      zone: wait.zone,
      quoted: QUOTED,
      waited: true,
    });
  });

  it.each([
    ["an ordinary transport failure", { termination: { reason: "transport_unavailable" }, wait: null, usage_limit: null }, null],
    ["a stop of the person's", { termination: { reason: "cancelled" }, wait: null, usage_limit: null }, null],
    ["a ceiling", { termination: { reason: "cost_ceiling_exceeded" }, wait: null, usage_limit: null }, null],
    // Parked and gone on: the next attempt's record answers.
    ["an executor's park", { termination: { reason: "transport_unavailable" }, wait, usage_limit: null }, null],
    // Waited, and the review then judged the change.
    ["a review that answered after its wait", { termination: { reason: "completed" }, wait, usage_limit: null }, { ...refused, decision: "approve", error: null }],
    ["a review refused for anything but its provider", { termination: { reason: "completed" }, wait, usage_limit: null }, { ...refused, error: { kind: "rejected_verdict" } }],
    // A record whose role and termination disagree says two things.
    ["an executor's limit on a completed attempt", { termination: { reason: "completed" }, wait: null, usage_limit: executorLimit }, null],
    ["a reviewer's limit on an attempt its own provider refused", { termination: { reason: "transport_unavailable" }, wait: null, usage_limit: { ...executorLimit, role: "reviewer" as const } }, null],
  ] as const)("is not a usage limit for %s", (_name, attempt, review) => {
    expect(usageLimitStop(attempt, review)).toBeNull();
  });
});

describe("usageLimitHolds", () => {
  it("holds until the stated reset and not after it", () => {
    expect(usageLimitHolds(executorLimit, new Date("2026-09-04T03:29:59.000Z"))).toBe(true);
    expect(usageLimitHolds(executorLimit, new Date("2026-09-04T03:30:00.000Z"))).toBe(false);
  });
});
