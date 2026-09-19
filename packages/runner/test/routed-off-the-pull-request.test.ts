import { describe, expect, it } from "vitest";
import type { Finding, PlanContractWithCriteria, ReviewArtifact } from "@perbo/contracts";
import { decideBlocking } from "@perbo/review";
import { pullRequestBody } from "../src/delivery.js";
import { finding, makeContract, makeReview } from "./support.js";

/**
 * What the pull request shows a person, and what it only counts.
 *
 * A finding routed to the executor was closed by the executor and verified
 * before the pull request opened. Nobody has to do anything about it, so it is
 * not on the surface a person reads first; it stays whole in the record, and
 * the body says how many there were and where to read them. What blocks or
 * escalates is on the pull request exactly as it was.
 */

const routedOne = finding({
  key: "1".repeat(64),
  rule_id: "test.assertion_missing",
  statement: "No test exercises total().",
});

const routedTwo = finding({
  key: "2".repeat(64),
  rule_id: "code.unused_import",
  statement: "`readFileSync` is imported and never used.",
});

const blocks = finding({
  key: "3".repeat(64),
  rule_id: "auth.token_never_expires",
  blocking: true,
  routing: "blocks",
  closure: "human",
  blocking_reason: "security: always blocks",
  statement: "The token carries no exp claim.",
});

const escalates = finding({
  key: "4".repeat(64),
  rule_id: "concurrency.unlocked_write",
  blocking: false,
  routing: "escalates",
  closure: "human",
  blocking_reason: "below the confidence floor: escalated to a human",
  statement: "Two writers reach the counter without a lock.",
});

const bodyWith = (findings: Finding[], declines?: { finding_key: string; reason: string }[]): string => {
  const review = makeReview({ review_id: "rev_0000000000000001", decision: "changes_requested" });
  const attempt = {
    attempt_id: "att_1",
    base_commit: "abc1234",
    head_commit: "def5678",
    usage: { cost_micros: 0 },
  };
  return pullRequestBody({
    contract: makeContract() as unknown as PlanContractWithCriteria,
    attempt: attempt as never,
    review: { ...review, findings } as unknown as ReviewArtifact,
    attempts: [attempt as never],
    ...(declines === undefined ? {} : { declines }),
  });
};

describe("the pull request the loop opens", () => {
  const body = bodyWith([routedOne, routedTwo, blocks, escalates]);

  it("shows what blocks and what escalates, with the statement each one is about", () => {
    expect(body).toContain("auth.token_never_expires");
    expect(body).toContain("The token carries no exp claim.");
    expect(body).toContain("concurrency.unlocked_write");
    expect(body).toContain("Two writers reach the counter without a lock.");
  });

  it("names no finding the executor closed, by rule id or by statement", () => {
    expect(body).not.toContain("test.assertion_missing");
    expect(body).not.toContain("No test exercises total().");
    expect(body).not.toContain("code.unused_import");
    expect(body).not.toContain("`readFileSync` is imported and never used.");
  });

  it("counts them on one line that says where the record is", () => {
    const line = body.split("\n").find((one) => one.includes("perbo inspect"));
    expect(line).toBeDefined();
    expect(line).toContain("2 findings");
    expect(line).toContain("perbo inspect ticket_SCP094");
  });

  it("says nothing about the executor's work when it did none", () => {
    expect(bodyWith([blocks])).not.toContain("perbo inspect");
  });

  it("leaves the stops a person answers exactly as they were", () => {
    expect(body).toContain(
      "  - [ ] I wanted to be asked before this was fixed " +
        `<!-- perbo:stop key=${blocks.key} answer=endorse rule=auth.token_never_expires routing=blocks -->`,
    );
    expect(body).toContain(
      "  - [ ] The agent should have fixed this on its own " +
        `<!-- perbo:stop key=${blocks.key} answer=override rule=auth.token_never_expires routing=blocks -->`,
    );
    expect(body).toContain("<!-- perbo:stops n=1 ticket=ticket_SCP094 -->");
  });

  it("keeps the verdict's own counts truthful", () => {
    expect(body).toContain("2 returned to the executor");
  });
});

describe("a routed finding the executor could not close", () => {
  it("is on the pull request as the person's decision when it declared no practice", () => {
    const body = bodyWith(
      [routedOne, blocks],
      [{ finding_key: routedOne.key, reason: "whether total() is exercised is a product call" }],
    );
    expect(body).toContain("test.assertion_missing");
    expect(body).toContain("no determinable practice");
    expect(body).toContain("whether total() is exercised is a product call");
    expect(body).toContain(
      `<!-- perbo:stop key=${routedOne.key} answer=endorse rule=test.assertion_missing routing=declined -->`,
    );
  });

  it("is on the pull request as a stop when the last round left nowhere to route it", () => {
    // The same lookup the reviewer runs, with the rounds spent: the outcome is
    // no longer `remediable`, so the body shows it like any other stop.
    const lookup = {
      row: "semantic_high_risk" as const,
      rule_id: "test.assertion_missing",
      criterion_id: "ac_1",
      confidence: 0.9,
      risk_level: "P3" as const,
      rule_demoted: false,
      waived: false,
      closure: "executor" as const,
      direction: "negative" as const,
      remediation_available: false,
    };
    const decision = decideBlocking(lookup);
    expect(decision.outcome).not.toBe("remediable");

    const lastRound = finding({
      ...routedOne,
      blocking: decision.blocking,
      routing: decision.outcome,
      blocking_reason: decision.reason,
    });
    const body = bodyWith([lastRound]);
    expect(body).toContain("test.assertion_missing");
    expect(body).toContain("No test exercises total().");
  });
});
