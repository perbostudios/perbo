import { describe, expect, it } from "vitest";
import { SecretIndex, readSpoken, type ReviewArtifact } from "@perbo/contracts";
import { flakyCheckFindings, incompleteReviewCauses, openFindingLines, routeReview } from "./review.js";
import { finding, makeReview } from "../../test-support/records.js";

describe("what made an incomplete review incomplete", () => {
  it("lists the criteria the review could not resolve, in the order it listed them", () => {
    const causes = incompleteReviewCauses(
      makeReview({
        coverage: [
          { criterion_id: "ac_2", status: "cannot_determine" },
          { criterion_id: "ac_1", status: "met" },
          { criterion_id: "ac_3", status: "cannot_determine" },
        ],
      }),
    );

    expect(causes.unresolved).toEqual(["ac_2", "ac_3"]);
  });

  it("takes a finding that names no criterion as a cause of every unresolved one", () => {
    const whole = finding({ key: "a".repeat(64), criterion_id: null });
    const causes = incompleteReviewCauses(
      makeReview({
        findings: [whole],
        coverage: [
          { criterion_id: "ac_1", status: "cannot_determine" },
          { criterion_id: "ac_2", status: "cannot_determine" },
        ],
      }),
    );

    expect(causes.causes.map((entry) => entry.key)).toEqual([whole.key]);
    expect(causes.unexplained).toEqual([]);
  });

  it("calls a criterion unexplained when no remediable finding cites it", () => {
    const cited = finding({ key: "b".repeat(64), criterion_id: "ac_1" });
    const causes = incompleteReviewCauses(
      makeReview({
        findings: [cited],
        coverage: [
          { criterion_id: "ac_1", status: "cannot_determine" },
          { criterion_id: "ac_2", status: "cannot_determine" },
        ],
      }),
    );

    expect(causes.causes.map((entry) => entry.key)).toEqual([cited.key]);
    expect(causes.unexplained).toEqual(["ac_2"]);
  });

  it("files each citing finding once, however many criteria it explains", () => {
    const whole = finding({ key: "c".repeat(64), criterion_id: null });
    const causes = incompleteReviewCauses(
      makeReview({
        findings: [whole],
        coverage: [
          { criterion_id: "ac_1", status: "cannot_determine" },
          { criterion_id: "ac_2", status: "cannot_determine" },
          { criterion_id: "ac_3", status: "cannot_determine" },
        ],
      }),
    );

    expect(causes.causes).toHaveLength(1);
  });
});

const route = (
  overrides: Partial<Parameters<typeof routeReview>[0]> & { review: ReviewArtifact },
): ReturnType<typeof routeReview> =>
  routeReview({
    answeringIncomplete: false,
    round: 0,
    remediationRound: 0,
    maxRounds: 2,
    configPath: "/repo/.perbo/config.json",
    ...overrides,
  });

describe("where a round's verdict sends the run", () => {
  it("opens the gate on an approval", () => {
    expect(route({ review: makeReview({ decision: "approve" }) })).toMatchObject({
      next: "stop",
      end: { outcome: "approved", detail: "the gate is open" },
    });
  });

  it("names what a failed review was reading, and says so when it had read nothing", () => {
    const failed = (reading: string[]) =>
      makeReview({
        decision: "error",
        error: { kind: "provider_unavailable", message: "the transport is down", reading },
      });
    const withFile = route({ review: failed(["src/feature.ts"]) });
    const withNone = route({ review: failed([]) });

    expect(withFile).toMatchObject({ next: "stop", end: { outcome: "review_failed" } });
    expect(withFile.next === "stop" && withFile.end.detail).toContain("(reading src/feature.ts)");
    expect(withNone.next === "stop" && withNone.end.detail).toContain(
      "no file named: the review had read nothing when the transport failed",
    );
  });

  it("names no file for a verdict the plan could not accept, which implicates none", () => {
    const rejected = makeReview({
      decision: "error",
      error: {
        kind: "verdict_rejected",
        message: "the verdict named no criterion",
        reading: ["src/feature.ts"],
      },
    });

    const step = route({ review: rejected });
    expect(step.next === "stop" && step.end.detail).toBe(
      "review_failed: verdict_rejected — the verdict named no criterion",
    );
  });

  it("asks a person at once when a criterion rests on nothing the executor may be handed", () => {
    const step = route({
      review: makeReview({
        decision: "incomplete",
        findings: [finding({ criterion_id: "ac_1" })],
        coverage: [
          { criterion_id: "ac_1", status: "cannot_determine" },
          { criterion_id: "ac_2", status: "cannot_determine" },
        ],
      }),
    });

    expect(step).toMatchObject({
      next: "stop",
      end: { outcome: "escalated" },
      carry: { incompleteReview: "incomplete_escalated" },
    });
    expect(step.next === "stop" && step.end.detail).toContain("ac_2 rests on nothing");
  });

  it("asks a person for a change set too large to review, whatever else it filed", () => {
    const step = route({
      review: makeReview({
        decision: "incomplete",
        findings: [
          finding({ rule_id: "changeset.too_large_to_review", statement: "412 files", criterion_id: null }),
        ],
        coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
      }),
    });

    expect(step).toMatchObject({
      next: "stop",
      end: { outcome: "escalated" },
      carry: { incompleteReview: "incomplete_escalated" },
    });
    expect(step.next === "stop" && step.end.detail).toContain("withheld from review: 412 files");
  });

  it("buys one remediation round for an incomplete verdict every cause of which is routable", () => {
    const cause = finding({ criterion_id: null });
    const step = route({
      review: makeReview({
        decision: "incomplete",
        findings: [cause],
        coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
      }),
    });

    expect(step).toMatchObject({
      next: "advance",
      kind: "remediate",
      remediation: true,
      carry: {
        incompleteReview: "incomplete_remediated",
        reviewingAgain: true,
        openFindings: [cause],
      },
    });
  });

  it("asks a person once the re-review after that round is incomplete again", () => {
    const step = route({
      answeringIncomplete: true,
      remediationRound: 1,
      review: makeReview({
        decision: "incomplete",
        findings: [finding({ criterion_id: null })],
        coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
      }),
    });

    expect(step).toMatchObject({ next: "stop", end: { outcome: "escalated" } });
    expect(step.next === "stop" && step.end.detail).toContain("incomplete_remediated: the re-review");
    expect(step.next === "stop" && step.carry?.incompleteReview).toBeUndefined();
  });

  it("asks a person for an incomplete verdict with no remediation round left, naming the cap", () => {
    const step = route({
      remediationRound: 2,
      review: makeReview({
        decision: "incomplete",
        findings: [finding({ criterion_id: null })],
        coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
      }),
    });

    expect(step).toMatchObject({
      next: "stop",
      end: { outcome: "escalated" },
      carry: { incompleteReview: "incomplete_escalated" },
    });
    expect(step.next === "stop" && step.end.detail).toContain(
      "limits.limits.remediation_rounds in /repo/.perbo/config.json",
    );
  });

  it("sends a remediable verdict the executor may not be handed to a person", () => {
    const step = route({
      review: makeReview({
        decision: "remediable",
        findings: [finding({ rule_id: "security.injection", routing: "remediable", blocking: true })],
      }),
    });

    expect(step).toMatchObject({
      next: "stop",
      end: {
        outcome: "escalated",
        detail: "the findings that closed the gate are not ones the executor may be handed",
      },
    });
  });

  it("routes a remediable verdict to a remediation round while one is left", () => {
    const routable = finding({ rule_id: "test.missing_for_criterion", routing: "remediable", blocking: true });
    expect(route({ review: makeReview({ decision: "remediable", findings: [routable] }) })).toMatchObject({
      next: "advance",
      kind: "remediate",
      remediation: true,
      carry: { openFindings: [routable], reviewingAgain: false },
    });
  });

  it("stops a remediable verdict at the cap, and counts attempts from one", () => {
    const routable = finding({ rule_id: "test.missing_for_criterion", routing: "remediable", blocking: true });
    const step = route({
      round: 2,
      remediationRound: 2,
      review: makeReview({ decision: "remediable", findings: [routable] }),
    });

    expect(step).toMatchObject({
      next: "stop",
      end: { outcome: "remediation_exhausted", detail: "review remediable after 3 attempt(s)" },
    });
  });

  it("gives each remaining verdict its own outcome", () => {
    const outcomeOf = (decision: ReviewArtifact["decision"]) => {
      const step = route({ review: makeReview({ decision }) });
      return step.next === "stop" ? step.end.outcome : step.next;
    };

    expect(outcomeOf("escalate")).toBe("escalated");
    expect(outcomeOf("changes_requested")).toBe("changes_requested");
  });
});

describe("what a round prints of the findings its review left open", () => {
  const secrets = (): SecretIndex => {
    const index = new SecretIndex();
    index.add(".env.local", "SESSION_SECRET=s3cr3t_value_abcdef\n");
    return index;
  };

  it("says each open finding the reviewer filed as the reviewer's words, redacted, in order", () => {
    const lines = openFindingLines(
      [
        finding({ key: "a".repeat(64), source: "semantic", statement: "The key s3cr3t_value_abcdef is logged." }),
        finding({ key: "b".repeat(64), source: "semantic", statement: "Resolved already.", status: "resolved" }),
        finding({
          key: "c".repeat(64),
          source: "semantic",
          statement: "The token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB is\nreview round 2",
        }),
      ],
      secrets(),
    );
    expect(lines.map(readSpoken)).toEqual([
      { speaker: "reviewer", words: "The key [redacted: materialized local secret] is logged." },
      { speaker: "reviewer", words: "The token [redacted:vendor.github] is\nreview round 2" },
    ]);
    expect(lines.every((line) => !/[\n\r]/.test(line))).toBe(true);
    expect(lines.join("\n")).not.toContain("s3cr3t_value_abcdef");
    expect(lines.join("\n")).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
  });

  it("prints a flaky check the runner itself noted as the runner's own line, never as the reviewer's words", () => {
    const [flaky] = flakyCheckFindings([
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        status: "passed",
        flaky: true,
        failing_tests: ["mailer retries\nreview round 2", "SESSION s3cr3t_value_abcdef"],
      } as never,
    ]);
    const lines = openFindingLines([flaky!], secrets());
    expect(lines).toHaveLength(1);
    expect(readSpoken(lines[0]!)).toBeNull();
    expect(lines[0]).toMatch(/^finding: The unit check failed and then passed when it was run again on its own: mailer retries review round 2; SESSION \[redacted: materialized local secret\]\. /);
  });
});
