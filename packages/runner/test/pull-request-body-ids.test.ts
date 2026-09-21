import { describe, expect, it } from "vitest";
import {
  TicketSourceSchema,
  type Finding,
  type MergeMode,
  type PlanContractWithCriteria,
  type ReviewArtifact,
} from "@perbo/contracts";
import { pullRequestBody } from "../src/delivery.js";
import { finding, makeContract, makeReview } from "../src/test-support/records.js";

/**
 * The pull-request body, read for identifiers only this repository knows.
 *
 * The body is published on the repository the run was pointed at and is read
 * by somebody holding none of this repository's decision records: a `D-0nn` or
 * `SCP-nnn` there names a document they cannot open, in the lines that tell
 * them what merging waits on.
 *
 * Every optional part of the body is rendered below, because a line no case
 * reaches is a line this test does not read. What the contract, the review and
 * the declines carry is the caller's data; what is read here are the strings
 * `pullRequestBody` writes itself.
 */

const DECISION_ID = /\b(D-0\d\d|SCP-\d{3})\b/;

const key = (digit: string): string => digit.repeat(64);

const blocks = finding({
  key: key("1"),
  rule_id: "auth.token_never_expires",
  blocking: true,
  routing: "blocks",
  closure: "human",
  blocking_reason: "security: always blocks",
  statement: "The token carries no exp claim.",
});

/** Carries a credential, so the redaction note renders too. */
const escalates = finding({
  key: key("2"),
  rule_id: "security.hardcoded_credential",
  blocking: false,
  routing: "escalates",
  closure: "human",
  blocking_reason: "below the confidence floor: escalated to a human",
  statement: 'A signing secret is committed: const K = "sk_live_51QeXampleNotReal";',
});

const declined = finding({
  key: key("3"),
  rule_id: "export.archived_rows_included",
  routing: "remediable",
  statement: "Archived rows reach the export.",
});

const routed = finding({
  key: key("4"),
  rule_id: "test.assertion_missing",
  statement: "No test exercises total().",
});

const advisory = finding({
  key: key("5"),
  rule_id: "code.unused_import",
  blocking: false,
  routing: "advisory",
  statement: "`readFileSync` is imported and never used.",
});

const source = TicketSourceSchema.parse({
  kind: "github",
  reference: "o/r#1",
  url: "https://github.com/o/r/issues/1",
  title_at_admission: "unslug turns a slug back into spaced words",
});

const findings: Finding[] = [blocks, escalates, declined, routed, advisory];

/** The attempt this pull request is for: a remediation round, after a sealed one. */
const attempt = {
  attempt_id: "att_2",
  base_commit: "abc1234",
  head_commit: "def5678",
  remediation_round: 2,
  prior_commits: [{ sha: "0".repeat(40), attempt_id: "att_1" }],
  usage: { cost_micros: 300_000, cost_basis: "transport_reported", cost_partial: true },
};
const first = {
  attempt_id: "att_1",
  base_commit: "abc1234",
  head_commit: "0".repeat(40),
  usage: { cost_micros: 400_000, cost_basis: "transport_reported" },
};

/**
 * A published run's body, with every line the caller can ask for in it: a
 * source, a carried commit, a remediation round, an escalation, a decline, a
 * redaction, and both merge switches.
 */
function body(over: { merge?: MergeMode; costBasis?: "provider_list_estimate" | "unavailable" } = {}): string {
  const review = makeReview({ review_id: "rev_0000000000000001", decision: "changes_requested" });
  return pullRequestBody({
    contract: makeContract() as unknown as PlanContractWithCriteria,
    attempt: attempt as never,
    review: {
      ...review,
      escalated: true,
      actual_risk: "P2",
      cost_micros: 200_000,
      model: { ...review.model, cost_basis: over.costBasis ?? "provider_list_estimate" },
      findings,
      coverage: [{ ...review.coverage[0]!, authored_in_response_to: key("a") }],
    } as unknown as ReviewArtifact,
    attempts: [first as never, attempt as never],
    source,
    verification_costs: [
      { cost_micros: 5_000, cost_basis: "transport_reported" },
      { cost_micros: 0, cost_basis: "not_incurred" },
    ],
    declines: [
      { finding_key: declined.key, reason: "whether archived rows belong in exports is a product call" },
    ],
    ...(over.merge === undefined ? {} : { merge: over.merge }),
  });
}

const bodies = (): Array<[string, string]> => [
  ["a person merges", body()],
  ["the loop merges", body({ merge: "loop" })],
  ["a person merges, with no priced total", body({ costBasis: "unavailable" })],
  ["the loop merges, with no priced total", body({ merge: "loop", costBasis: "unavailable" })],
];

describe("the pull request body a published run writes", () => {
  it("carries no decision or ticket identifier in any of it", () => {
    // Every body at once, so a failure names each line rather than the first.
    const offending = bodies().flatMap(([name, rendered]) =>
      rendered
        .split("\n")
        .filter((line) => DECISION_ID.test(line))
        .map((line) => `${name}: ${line}`),
    );
    expect(offending).toEqual([]);
  });

  it("renders every optional line it claims to read", () => {
    const rendered = body({ merge: "loop" });
    expect(rendered).toContain("Source: github o/r#1");
    expect(rendered).toContain("after 2 remediation rounds");
    expect(rendered).toContain("1 commit was sealed before this attempt");
    expect(rendered).toContain("evidence written in answer to finding");
    expect(rendered).toContain("No determinable practice");
    expect(rendered).toContain("For you to decide");
    expect(rendered).toContain("Advisory");
    expect(rendered).toContain("returned to the executor and verified closed");
    expect(rendered).toMatch(/redact/i);
    expect(rendered).toContain("component(s) are partial");
    expect(body({ costBasis: "unavailable" })).toContain("no defensible dollar basis");
  });

  it("says what merging waits on, in the words of whichever merges", () => {
    expect(body()).toContain("**A human merges this.**");
    expect(body({ merge: "loop" })).toContain("**The loop merges this**");
    expect(body({ merge: "loop" })).toContain("nothing outside the loop has touched the branch since the approval");
  });
});
