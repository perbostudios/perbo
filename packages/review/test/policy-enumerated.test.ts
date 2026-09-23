import { describe, expect, it } from "vitest";
import { BLOCKING_ROWS, CLOSURE_AUTHORITIES, ROUTING_POLICIES } from "@perbo/contracts";
import { decideBlocking, type BlockingInput } from "../src/blocking.js";

/**
 * Every routing policy, exercised by enumerating the constant rather than by
 * naming the two that exist today.
 *
 * Both existing policy test files hardcode `d051` and `d056`, so a third would
 * ship with no coverage at all. That is the shape of the four defects a sample
 * population caused on 2026-08-30 — a discriminator added, the machinery
 * branching on it updated in some places and not others — and this is the same
 * hazard one discriminator over, written before it bites rather than after.
 *
 * These are invariants that must hold under **any** policy. A policy that
 * violates one is not a policy this matrix can express, and finding that out
 * here is the point.
 */

const base = (over: Partial<BlockingInput> = {}): BlockingInput => ({
  row: "semantic_ordinary",
  rule_id: "test.assertion_missing",
  confidence: 0.9,
  risk_level: "P2",
  rule_demoted: false,
  waived: false,
  closure: "executor",
  direction: null,
  remediation_available: true,
  ...over,
});

describe.each(ROUTING_POLICIES)("routing policy %s", (policy) => {
  it("decides every row without throwing, and returns a known outcome", () => {
    for (const row of BLOCKING_ROWS) {
      for (const closure of [...CLOSURE_AUTHORITIES, null]) {
        const decision = decideBlocking(base({ row, closure, policy }));
        expect(
          ["blocks", "escalates", "remediable", "advisory", "waived"],
          `${policy}/${row}/${closure} produced ${decision.outcome}`,
        ).toContain(decision.outcome);
      }
    }
  });

  it("never routes a deterministic finding to the executor", () => {
    for (const rule_id of ["check.failed", "scope.escape", "security.forged_artifact"]) {
      const decision = decideBlocking(
        base({ row: "deterministic", rule_id, closure: null, confidence: null, policy }),
      );
      expect(decision.outcome, `${policy}/${rule_id}`).not.toBe("remediable");
    }
    // The exceptions: illegible bytes the change itself added (d068 on), and a
    // pinned check that failed on a tree whose base verified (d069 on).
    const legibility = decideBlocking(
      base({
        row: "deterministic",
        rule_id: "legibility.control_character_in_source",
        closure: null,
        confidence: null,
        caused_by_change: true,
        policy,
      }),
    );
    expect(legibility.outcome, `${policy}/legibility`).toBe(
      policy === "d068" || policy === "d069" ? "remediable" : "blocks",
    );
    const brokenCheck = decideBlocking(
      base({
        row: "deterministic",
        rule_id: "check.unit",
        closure: null,
        confidence: null,
        caused_by_change: true,
        policy,
      }),
    );
    expect(brokenCheck.outcome, `${policy}/check`).toBe(policy === "d069" ? "remediable" : "blocks");
  });

  /**
   * These use rows that **do** route under this policy. The first version of
   * this test used `semantic_ordinary`, which never routes whatever the family
   * is, so it passed with `security` deleted from NEVER_REMEDIATED_FAMILIES —
   * a test.passes_for_wrong_reason, which is a rule id in this very corpus.
   * The rows below were found by probing the matrix, and the assertion was
   * confirmed by mutation afterwards.
   */
  const routingRows = BLOCKING_ROWS.filter(
    (row) =>
      decideBlocking(base({ row, rule_id: "test.assertion_missing", policy })).outcome ===
      "remediable",
  );

  it("has at least one row that routes, or the guards below prove nothing", () => {
    expect(routingRows.length).toBeGreaterThan(0);
  });

  it("never routes a security finding, at any closure answer", () => {
    for (const row of routingRows) {
      for (const closure of CLOSURE_AUTHORITIES) {
        const decision = decideBlocking(base({ row, rule_id: "security.auth_bypass", closure, policy }));
        expect(
          decision.outcome,
          `${policy}/${row} routed security.* on closure=${closure}`,
        ).not.toBe("remediable");
      }
    }
  });

  it("never routes a context finding, which would launder attacker text into a brief", () => {
    for (const row of routingRows) {
      for (const closure of CLOSURE_AUTHORITIES) {
        const decision = decideBlocking(
          base({ row, rule_id: "context.injected_instruction", closure, policy }),
        );
        expect(decision.outcome, `${policy}/${row} routed context.*`).not.toBe("remediable");
      }
    }
  });

  it("routes nothing when there is no remediation round left", () => {
    for (const closure of CLOSURE_AUTHORITIES) {
      const decision = decideBlocking(base({ closure, remediation_available: false, policy }));
      expect(decision.outcome).not.toBe("remediable");
    }
  });

  it("gives a reason whenever it does not route", () => {
    const decision = decideBlocking(base({ closure: "human", policy }));
    if (decision.outcome !== "remediable") {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("the policy list itself", () => {
  it("has more than one, or this suite is theatre", () => {
    expect(ROUTING_POLICIES.length).toBeGreaterThan(1);
  });
});
