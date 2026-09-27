import { describe, expect, it } from "vitest";
import type { ReviewArtifact, ReviewError } from "@perbo/contracts";
import { REVIEW_UNPARSED, reviewErrorSentence, runEnding } from "./task-context.js";
import type { AttemptView, Job } from "../../shared/protocol.js";

/**
 * A run that ended on a review whose answer could not be used says so in one
 * sentence on the loop page's ended card, with the review's error behind the
 * `i` exactly as it was recorded, and none of the run's log in the card.
 */

const RECORDED =
  "the reviewer returned 2 verdict(s) this plan cannot accept: (1) verdict names unknown criterion 'ac_99'; " +
  "(2) verdict covers ac_1 more than once";

const job: Job = {
  id: "job-1",
  repoId: "repo",
  key: "PRB-1",
  kind: "run",
  label: "Run engineering loop",
  state: "failed",
  startedAt: "2026-09-24T02:17:34.000Z",
  endedAt: "2026-09-24T02:20:02.000Z",
  log: "the whole run log",
  error: "the whole run log\nerror: review_failed: verdict_rejected",
  resultKey: null,
  result: null,
};
const error = (kind: ReviewError["kind"], message: string): ReviewError => ({
  kind,
  message,
  attempts: 2,
  unresolved_criteria: [],
  reading: [],
});
const attempt = (reviewError: ReviewError): AttemptView =>
  ({
    id: "att_1",
    run: 1,
    round: 0,
    startedAt: "2026-09-24T02:17:38.000Z",
    outcome: "review error",
    termination: "completed: the attempt ran to its end",
    ceilings: [],
    review: { decision: "error", findings: [], coverage: [], error: reviewError } as unknown as ReviewArtifact,
    reviewDecision: "error",
  }) as unknown as AttemptView;

describe("a run that ended on the reviewer's answer", () => {
  it.each(["verdict_rejected", "malformed_verdict", "unknown_criterion_id"] as const)(
    "says a %s answer could not be parsed, the recorded error only behind the i",
    (kind) => {
      const ending = runEnding([job], attempt(error(kind, RECORDED)), "failed");
      expect(ending).toMatchObject({
        title: "The run ended",
        sentence: "The reviewer's answer could not be parsed.",
        reason: RECORDED,
        log: null,
      });
      expect(ending!.sentence).not.toContain("cannot accept");
    },
  );

  it("keeps its own sentence where the review failed for another reason", () => {
    const ending = runEnding([job], attempt(error("provider_unavailable", "claude exited 1")), "failed");
    expect(ending!.sentence).toBe("The run failed after the loop recorded its attempt.");
    expect(ending!.log).toBe(job.error);
  });
});

describe("reviewErrorSentence", () => {
  it("names an unparsed answer, and leaves every other kind its own sentence", () => {
    expect(reviewErrorSentence(error("verdict_rejected", RECORDED), "other")).toBe(REVIEW_UNPARSED);
    expect(reviewErrorSentence(error("malformed_verdict", RECORDED), "other")).toBe(REVIEW_UNPARSED);
    expect(reviewErrorSentence(error("unknown_criterion_id", RECORDED), "other")).toBe(REVIEW_UNPARSED);
    for (const kind of ["provider_unavailable", "budget_exhausted", "timeout", "internal"] as const)
      expect(reviewErrorSentence(error(kind, "x"), "other")).toBe("other");
  });
});
