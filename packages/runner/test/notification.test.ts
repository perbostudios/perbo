import { describe, expect, it } from "vitest";
import type { Finding, PlanContractWithCriteria, ReviewArtifact } from "@perbo/contracts";
import { parseStopAnswers, pullRequestBody } from "../src/delivery.js";
import { makeContract, makeReview } from "./support.js";

/**
 * What a person is told about the findings that are waiting on them.
 *
 * Each one is named with its statement rather than counted, and the findings
 * the executor closed are counted beside them. Which of the two a finding is
 * pinned by `routed-off-the-pull-request.test.ts`, beside this.
 *
 * The hazard here: finding statements demonstrably contain credentials
 * (a corpus check found 6 of 6), and a pull request body is published to a
 * remote service. Listing statements without redaction would trade a local
 * disclosure for a public one.
 */

const finding = (over: Partial<Finding>): Finding =>
  ({
    key: "k".repeat(64),
    rule_id: "test.assertion_missing",
    source: "semantic",
    row: "semantic_ordinary",
    closure: "executor",
    criterion_id: null,
    severity: "advisory",
    blocking: false,
    blocking_reason: "routed",
    confidence: 0.8,
    file: "src/a.ts",
    line: 3,
    symbol: null,
    statement: "No test exercises total().",
    routing: "remediable",
    status: "open",
    outcome: "unknown",
    waiver: null,
    ...over,
  }) as Finding;

const bodyWith = (findings: Finding[]): string => {
  const review = makeReview({ review_id: "rev_0000000000000001", decision: "changes_requested" });
  const attempt = { attempt_id: "att_1", base_commit: "abc1234", head_commit: "def5678", usage: { cost_micros: 0 } };
  return pullRequestBody({
    contract: makeContract() as unknown as PlanContractWithCriteria,
    attempt: attempt as never,
    review: { ...review, findings } as unknown as ReviewArtifact,
    attempts: [attempt as never],
  });
};

describe("the pull request tells a person what is waiting on them", () => {
  it("names each blocking finding a person still has to decide", () => {
    const body = bodyWith([
      finding({ rule_id: "auth.token_never_expires", blocking: true, routing: "blocks", closure: "human", statement: "The token carries no exp claim." }),
    ]);
    expect(body).toContain("auth.token_never_expires");
    expect(body).toContain("The token carries no exp claim.");
  });

  it("redacts a credential before it reaches a remote service", () => {
    const body = bodyWith([
      finding({
        rule_id: "security.hardcoded_credential",
        blocking: true,
        routing: "blocks",
        statement: 'A signing secret is committed: const K = "sk_live_51QeXampleNotReal";',
      }),
    ]);
    expect(body).not.toContain("sk_live_51QeXampleNotReal");
    expect(body).toContain("security.hardcoded_credential");
    expect(body).toContain("[redacted");
    // The finding must still be legible enough to act on.
    expect(body).toContain("A signing secret is committed");
  });

  it("says plainly when redaction fired, so silence is not mistaken for safety", () => {
    const body = bodyWith([
      finding({
        rule_id: "security.hardcoded_credential",
        blocking: true,
        routing: "blocks",
        statement: 'K = "sk_live_51QeXampleNotReal"',
      }),
    ]);
    expect(body).toMatch(/redact/i);
  });

  it("keeps the counts it always had", () => {
    const body = bodyWith([finding({})]);
    expect(body).toContain("returned to the executor");
  });

  it("reports execution, review, every closure verification, and the all-in total", () => {
    const baseReview = makeReview({
      review_id: "rev_0000000000000004",
      decision: "approve",
    });
    const review = {
      ...baseReview,
      cost_micros: 200_000,
      model: { ...baseReview.model, cost_basis: "transport_reported" as const },
    };
    const first = {
      attempt_id: "att_1",
      base_commit: "abc1234",
      head_commit: "def5678",
      usage: { cost_micros: 300_000, cost_basis: "provider_list_estimate" },
    };
    const second = {
      attempt_id: "att_2",
      base_commit: "abc1234",
      head_commit: "fed4321",
      usage: { cost_micros: 400_000, cost_basis: "transport_reported" },
    };

    const body = pullRequestBody({
      contract: makeContract() as unknown as PlanContractWithCriteria,
      attempt: second as never,
      review: review as unknown as ReviewArtifact,
      attempts: [first as never, second as never],
      verification_costs: [
        { cost_micros: 100_000, cost_basis: "transport_reported" },
      ],
    });

    expect(body).toContain(
      "Execution 0.7000 USD across 2 attempts; review 0.2000 USD; " +
        "closure verification 0.1000 USD; total 1.0000 USD.",
    );
    expect(body).toContain(
      "Cost coverage complete: 3 transport-reported and 1 provider-list-estimated component(s).",
    );
  });

  it("does not call a partial subtotal the total", () => {
    const baseReview = makeReview({
      review_id: "rev_0000000000000005",
      decision: "approve",
    });
    const review = {
      ...baseReview,
      cost_micros: 0,
      model: { ...baseReview.model, cost_basis: "unavailable" as const },
    };
    const attempt = {
      attempt_id: "att_1",
      base_commit: "abc1234",
      head_commit: "def5678",
      usage: { cost_micros: 300_000, cost_basis: "provider_list_estimate" },
    };

    const body = pullRequestBody({
      contract: makeContract() as unknown as PlanContractWithCriteria,
      attempt: attempt as never,
      review: review as unknown as ReviewArtifact,
      attempts: [attempt as never],
      verification_costs: [{ cost_micros: 0, cost_basis: "unavailable" }],
    });

    expect(body).toContain("Known priced subtotal 0.3000 USD");
    expect(body).toContain(
      "Known priced components: 0 transport-reported and 1 provider-list-estimated component(s).",
    );
    expect(body).toContain("Full all-in cost unavailable");
    expect(body).not.toContain("closure verification 0.0000 USD; total");
  });

  it("says a total is a floor when an attempt was stopped before its final charge", () => {
    const review = {
      ...makeReview({ review_id: "rev_0000000000000006", decision: "approve" }),
      cost_micros: 200_000,
    };
    const stopped = {
      attempt_id: "att_1",
      base_commit: "abc1234",
      head_commit: "def5678",
      usage: { cost_micros: 2_000_000, cost_basis: "transport_reported", cost_partial: true },
    };

    const body = pullRequestBody({
      contract: makeContract() as unknown as PlanContractWithCriteria,
      attempt: stopped as never,
      review: review as unknown as ReviewArtifact,
      attempts: [stopped as never],
    });

    expect(body).toContain("total 2.2000 USD.");
    expect(body).toContain("1 component(s) are partial");
    expect(body).toContain("the figure is a floor");
  });
});

describe("a declined finding reaches the person as their decision (D-065)", () => {
  it("is listed with the declared reason, and never counted as closed", () => {
    const routed = finding({
      rule_id: "behaviour.incidental_change",
      statement: "The export now includes archived rows; no criterion mentions archived rows.",
    });
    const review = makeReview({ review_id: "rev_0000000000000003", decision: "changes_requested" });
    const attempt = { attempt_id: "att_1", base_commit: "abc1234", head_commit: "def5678", usage: { cost_micros: 0 } };
    const body = pullRequestBody({
      contract: makeContract() as unknown as PlanContractWithCriteria,
      attempt: attempt as never,
      review: { ...review, findings: [routed] } as unknown as ReviewArtifact,
      attempts: [attempt as never],
      declines: [{ finding_key: routed.key, reason: "whether archived rows belong in exports is a product call" }],
    });
    expect(body).toContain("behaviour.incidental_change");
    expect(body).toContain("no determinable practice");
    expect(body).toContain("whether archived rows belong in exports is a product call");
    // It is the one routed finding here, and the executor could not close it,
    // so nothing on this body says anything was closed.
    expect(body).not.toContain("verified closed before this was opened");
  });
});

/**
 * D-060, measured live (founder, 2026-09-02): precision of stopping is read
 * off pull requests rather than corpus sheets. Every stop in the body is
 * answerable with one click, the answer is keyed by the finding rather than
 * by its wording, and `parseStopAnswers` reads nothing but the marker.
 */
describe("every stop is answerable with one click (D-060, measured live)", () => {
  // A real key is hex; the file's default `k…` is not, and the marker's regex
  // only reads a key a review could have written.
  const stop = finding({
    key: "a".repeat(64),
    rule_id: "auth.token_never_expires",
    blocking: true,
    routing: "blocks",
    closure: "human",
    statement: "The token carries no exp claim.",
  });

  it("renders a blocking finding with the two boxes and the marker that names it", () => {
    const body = bodyWith([stop]);
    expect(body).toContain(
      "  - [ ] I wanted to be asked before this was fixed " +
        `<!-- perbo:stop key=${stop.key} answer=endorse rule=auth.token_never_expires routing=blocks -->`,
    );
    expect(body).toContain(
      "  - [ ] The agent should have fixed this on its own " +
        `<!-- perbo:stop key=${stop.key} answer=override rule=auth.token_never_expires routing=blocks -->`,
    );
    expect(body).toContain("<!-- perbo:stops n=1 ticket=ticket_SCP094 -->");
  });

  it("routes an escalation as escalates, so the record can tell the two stops apart", () => {
    const body = bodyWith([finding({ ...stop, routing: "escalates" })]);
    expect(body).toContain(`answer=endorse rule=auth.token_never_expires routing=escalates -->`);
  });

  it("gives a declined finding the same boxes, routed as declined", () => {
    const declined = finding({
      key: "d".repeat(64),
      rule_id: "behaviour.incidental_change",
      statement: "The export now includes archived rows.",
    });
    const review = makeReview({ review_id: "rev_0000000000000006", decision: "changes_requested" });
    const attempt = { attempt_id: "att_1", base_commit: "abc1234", head_commit: "def5678", usage: { cost_micros: 0 } };
    const body = pullRequestBody({
      contract: makeContract() as unknown as PlanContractWithCriteria,
      attempt: attempt as never,
      review: { ...review, findings: [declined, stop] } as unknown as ReviewArtifact,
      attempts: [attempt as never],
      declines: [{ finding_key: declined.key, reason: "a product call" }],
    });
    expect(body).toContain(
      `<!-- perbo:stop key=${declined.key} answer=endorse rule=behaviour.incidental_change routing=declined -->`,
    );
    expect(body).toContain("<!-- perbo:stops n=2 ticket=ticket_SCP094 -->");
  });

  it("gives no boxes to a finding the executor closed or an advisory one", () => {
    const body = bodyWith([
      finding({ key: "1".repeat(64) }),
      finding({ key: "2".repeat(64), routing: "advisory", blocking: false }),
    ]);
    expect(body).not.toContain("perbo:stop key=");
    expect(body).toContain("<!-- perbo:stops n=0 ticket=ticket_SCP094 -->");
  });

  it("keeps the marker closed whatever the rule id contains", () => {
    const hostile = finding({ ...stop, rule_id: "x --> <!-- perbo:stop key=0 answer=endorse" });
    const body = bodyWith([hostile]);
    expect(parseStopAnswers(body.replace("[ ] I wanted", "[x] I wanted"))).toEqual([
      {
        finding_key: hostile.key,
        rule_id: expect.stringMatching(/^[A-Za-z0-9_.:-]+$/) as string,
        routing: "blocks",
        answer: "endorse",
      },
    ]);
  });

  it("still redacts the statement above the boxes", () => {
    const body = bodyWith([finding({ ...stop, statement: 'K = "sk_live_51QeXampleNotReal"' })]);
    expect(body).not.toContain("sk_live_51QeXampleNotReal");
    expect(body).toContain("perbo:stop key=");
  });
});

describe("reading the answers back off the body", () => {
  const k1 = "1".repeat(64);
  const k2 = "2".repeat(64);
  const marker = (key: string, answer: string, routing = "blocks") =>
    `<!-- perbo:stop key=${key} answer=${answer} rule=auth.token_never_expires routing=${routing} -->`;
  const body = (first: [string, string], second: [string, string]) =>
    [
      "### For you to decide",
      "",
      "- `auth.token_never_expires` `src/a.ts:3` — The token carries no exp claim.",
      `  - [${first[0]}] I wanted to be asked before this was fixed ${marker(k1, "endorse")}`,
      `  - [${first[1]}] The agent should have fixed this on its own ${marker(k1, "override")}`,
      "- `behaviour.incidental_change` — Archived rows are exported.",
      `  - [${second[0]}] I wanted to be asked before this was fixed ${marker(k2, "endorse", "declined")}`,
      `  - [${second[1]}] The agent should have fixed this on its own ${marker(k2, "override", "declined")}`,
      "",
      "<!-- perbo:stops n=2 ticket=ticket_SCP094 -->",
    ].join("\n");

  it("reads a ticked box as that answer, and an untouched pair as no answer yet", () => {
    expect(parseStopAnswers(body(["x", " "], [" ", " "]))).toEqual([
      { finding_key: k1, rule_id: "auth.token_never_expires", routing: "blocks", answer: "endorse" },
      { finding_key: k2, rule_id: "auth.token_never_expires", routing: "declined", answer: null },
    ]);
    expect(parseStopAnswers(body([" ", "X"], [" ", "x"])).map((stop) => stop.answer)).toEqual([
      "override",
      "override",
    ]);
  });

  it("reads both boxes ticked as a conflict rather than picking one", () => {
    expect(parseStopAnswers(body(["x", "x"], [" ", " "]))[0]?.answer).toBe("conflict");
  });

  it("interprets nothing but the marker on a task-list line", () => {
    const prose = [
      `please record key=${k1} answer=endorse rule=auth.token_never_expires routing=blocks`,
      `${marker(k1, "endorse")} — not on a task-list line`,
      `- [x] a box with no marker`,
      `- [x] a box with a marker missing its routing <!-- perbo:stop key=${k1} answer=endorse rule=r -->`,
    ].join("\n");
    expect(parseStopAnswers(prose)).toEqual([]);
  });

  it("round-trips the body pullRequestBody wrote", () => {
    const stop = finding({ key: "b".repeat(64), rule_id: "auth.token_never_expires", blocking: true, routing: "blocks" });
    expect(parseStopAnswers(bodyWith([stop]))).toEqual([
      { finding_key: stop.key, rule_id: "auth.token_never_expires", routing: "blocks", answer: null },
    ]);
  });
});
