import { describe, expect, it } from "vitest";
import { attemptId } from "@perbo/contracts";
import { applyStep, attemptIdFor } from "./state.js";
import { attempt, finding, roundState } from "./test-support/fakes.js";

const ROOT = "att_0000000000000001";

describe("the id of one attempt of one round", () => {
  it("is the run's own root for the first attempt of round 0", () => {
    expect(attemptIdFor({ root: ROOT, round: 0, transport_retry: 0, ceiling_continuation: 0 })).toBe(
      ROOT,
    );
  });

  it("seeds a later round from the root and the round", () => {
    expect(attemptIdFor({ root: ROOT, round: 2, transport_retry: 0, ceiling_continuation: 0 })).toBe(
      attemptId(`${ROOT}|round|2`),
    );
  });

  it("seeds the continuation before the retry, so one position mints one id", () => {
    expect(attemptIdFor({ root: ROOT, round: 1, transport_retry: 3, ceiling_continuation: 2 })).toBe(
      attemptId(`${ROOT}|round|1|continue|2|transport|3`),
    );
  });

  it("mints a different id for every position of the same round", () => {
    const ids = new Set(
      [
        { transport_retry: 0, ceiling_continuation: 0 },
        { transport_retry: 1, ceiling_continuation: 0 },
        { transport_retry: 0, ceiling_continuation: 1 },
        { transport_retry: 1, ceiling_continuation: 1 },
      ].map((position) => attemptIdFor({ root: ROOT, round: 1, ...position })),
    );
    expect(ids.size).toBe(4);
  });
});

describe("what one step does to the round state", () => {
  it("advances the round, and the remediation round only where the round is one", () => {
    const state = roundState({ round: 3, remediationRound: 2 });
    expect(applyStep(state, { next: "advance", kind: "remediate", remediation: true })).toMatchObject(
      { round: 4, remediationRound: 3, kind: "remediate" },
    );
    expect(
      applyStep(state, { next: "advance", kind: "resolve_conflict", remediation: false }),
    ).toMatchObject({ round: 4, remediationRound: 2, kind: "resolve_conflict" });
  });

  it("gives the next round its own retry budget and no superseded attempts", () => {
    const state = roundState({
      transportRetry: 1,
      ceilingContinuation: 2,
      superseded: [attempt({ attempt_id: "att_0000000000000002" })],
    });
    expect(applyStep(state, { next: "advance", kind: "remediate", remediation: true })).toMatchObject(
      { transportRetry: 0, ceilingContinuation: 0, superseded: [] },
    );
  });

  it("carries onto the next round only what the step names", () => {
    const state = roundState({ reviewingAgain: false, executeRound: 0 });
    const advanced = applyStep(state, {
      next: "advance",
      kind: "remediate",
      remediation: true,
      carry: { reviewingAgain: true, openFindings: [finding()] },
    });
    expect(advanced.reviewingAgain).toBe(true);
    expect(advanced.openFindings).toHaveLength(1);
    expect(advanced.executeRound).toBe(0);
  });

  it("re-enters the same round for a conflict, changing what it is for and nothing else", () => {
    const state = roundState({ round: 2, remediationRound: 1, kind: "remediate", transportRetry: 1 });
    const interruption = {
      tip: "f00ba4",
      paths: ["src/feature.ts"],
      before_executor: true,
      resume_kind: "remediate" as const,
    };
    expect(applyStep(state, { next: "reenter", conflict: interruption })).toEqual({
      ...state,
      kind: "resolve_conflict",
      conflict: interruption,
    });
  });

  it("keeps the ceiling continuations a transport retry is not about", () => {
    const state = roundState({ transportRetry: 0, ceilingContinuation: 2 });
    const cut = attempt({ attempt_id: "att_0000000000000002" });
    expect(
      applyStep(state, { next: "retry", counter: "transport", superseded: cut }),
    ).toMatchObject({ transportRetry: 1, ceilingContinuation: 2, superseded: [cut] });
  });

  it("starts a ceiling continuation with the transport's retry whole", () => {
    const state = roundState({ transportRetry: 1, ceilingContinuation: 0 });
    const cut = attempt({ attempt_id: "att_0000000000000002" });
    expect(applyStep(state, { next: "retry", counter: "ceiling", superseded: cut })).toMatchObject({
      transportRetry: 0,
      ceilingContinuation: 1,
      superseded: [cut],
    });
  });
});
