import { describe, expect, it } from "vitest";
import {
  answersReview,
  decidable,
  decisionChoicesFor,
  DECISION_CHOICES,
  declinesOnRecord,
  FINISHED_TRYING,
  loopOnReview,
  NEVER_HANDED_FAMILIES,
  NOTHING_TRIED,
  routedToPerson,
} from "./decision.js";
import { gateClosedNote } from "./retained.js";
import { FINDING_ROUTINGS, REVIEW_DECISIONS } from "./review.js";

/**
 * D-132: which findings take a
 * person's answer, on which reviews, and which answers each takes. `perbo
 * verdict --decide`, the loop and the desktop all read these, so each is
 * pinned here, where they live.
 */

const KEY = "a".repeat(64);
const REVIEWED_AT = "2026-09-27T12:48:05.305Z";
const ended = (outcome: string, at = "2026-09-27T12:53:04.517Z") => ({ at, note: gateClosedNote(outcome) });
const finished = (closed: readonly string[] = []) => ({
  finished: true,
  closed: new Set(closed),
  declined: new Map(),
  refused: new Set<string>(),
});
const declined = (reasons: readonly string[] = ["No practice determines it."]) => ({
  finished: false,
  closed: new Set<string>(),
  declined: new Map([[KEY, reasons]]),
  refused: new Set<string>(),
});

describe("which findings are a person's to answer", () => {
  it("is an open finding routed blocks or escalates while the executor is still trying", () => {
    const asked = FINDING_ROUTINGS.filter((routing) => routedToPerson({ key: KEY, status: "open", routing }, NOTHING_TRIED));
    expect([...asked].sort()).toEqual(["blocks", "escalates"]);
  });

  it("adds every open finding routed remediable that no round closed, once the loop has finished trying", () => {
    const asked = FINDING_ROUTINGS.filter((routing) => routedToPerson({ key: KEY, status: "open", routing }, finished()));
    expect([...asked].sort()).toEqual(["blocks", "escalates", "remediable"]);
    expect(routedToPerson({ key: KEY, status: "open", routing: "remediable" }, finished([KEY]))).toBe(false);
  });

  it("is never one already resolved or waived", () => {
    for (const status of ["resolved", "waived"] as const) {
      expect(routedToPerson({ key: KEY, status, routing: "blocks" }, NOTHING_TRIED), status).toBe(false);
      expect(routedToPerson({ key: KEY, status, routing: "remediable" }, finished()), status).toBe(false);
    }
  });
});

describe("which reviews take an answer", () => {
  it("is a review that judged the whole change and stopped for a person", () => {
    const taking = REVIEW_DECISIONS.filter((decision) => decidable({ decision }, NOTHING_TRIED));
    expect([...taking].sort()).toEqual(["changes_requested", "escalate"]);
  });

  it("adds a remediable review once the loop has finished trying, and never an incomplete one", () => {
    const taking = REVIEW_DECISIONS.filter((decision) => decidable({ decision }, finished()));
    expect([...taking].sort()).toEqual(["changes_requested", "escalate", "remediable"]);
  });
});

describe("what the loop has done on a review", () => {
  it("has finished trying where a run since the review ended stalled or exhausted, and not otherwise", () => {
    expect([...FINISHED_TRYING].sort()).toEqual(["remediation_exhausted", "remediation_stalled"]);
    for (const outcome of FINISHED_TRYING) {
      expect(loopOnReview({ reviewed_at: REVIEWED_AT, history: [ended(outcome)], verifications: [], declines: [] }).finished).toBe(true);
    }
    for (const outcome of ["escalated", "changes_requested"]) {
      expect(loopOnReview({ reviewed_at: REVIEWED_AT, history: [ended(outcome)], verifications: [], declines: [] }).finished).toBe(false);
    }
    // A stall on an earlier review is not one on this.
    const before = ended("remediation_stalled", "2026-09-27T12:40:00.000Z");
    expect(loopOnReview({ reviewed_at: REVIEWED_AT, history: [before], verifications: [], declines: [] }).finished).toBe(false);
    // A run started since, or one it ended escalated, does not take it back.
    const later = [ended("remediation_stalled"), { at: "2026-09-27T13:10:00.000Z", note: "run started" }, ended("escalated", "2026-09-27T13:20:00.000Z")];
    expect(loopOnReview({ reviewed_at: REVIEWED_AT, history: later, verifications: [], declines: [] }).finished).toBe(true);
  });

  it("reads each finding's status off the last verification given it", () => {
    const [a, b, c] = ["a", "b", "c"].map((digit) => digit.repeat(64));
    const loop = loopOnReview({
      reviewed_at: REVIEWED_AT,
      history: [],
      verifications: [
        { at: "2026-09-27T12:51:00.000Z", given: [a!, b!, c!], open: [a!, b!], refused: false },
        // A round scoped to one finding says nothing of the others.
        { at: "2026-09-27T12:52:00.000Z", given: [a!], open: [], refused: false },
      ],
      declines: [],
    });
    expect([...loop.closed].sort()).toEqual([a, c]);
    const reopened = loopOnReview({
      reviewed_at: REVIEWED_AT,
      history: [],
      verifications: [
        { at: "2026-09-27T12:51:00.000Z", given: [a!], open: [], refused: false },
        { at: "2026-09-27T12:52:00.000Z", given: [a!], open: [a!], refused: false },
      ],
      declines: [],
    });
    expect([...reopened.closed]).toEqual([]);
  });
});

describe("the answers a finding takes", () => {
  it("is only shipping it as it is, in a family the executor is never handed", () => {
    expect([...NEVER_HANDED_FAMILIES].sort()).toEqual(["context", "security"]);
    for (const family of NEVER_HANDED_FAMILIES) {
      expect(decisionChoicesFor(`${family}.secret_in_diff`), family).toEqual(["ship_as_is"]);
    }
  });

  it("is all three in any other family, whose name only starts like one", () => {
    for (const rule of ["product.preference", "scope.outside_allowed", "securityish.rule", "contextual.rule", "norule"]) {
      expect(decisionChoicesFor(rule), rule).toEqual(DECISION_CHOICES);
    }
  });
});

describe("which answers answer a review", () => {
  const review = { review_id: "rev_0000000000000002", recorded_at: "2026-09-24T09:00:00.000Z" };

  it("is one taken at or after the review was recorded, and never before", () => {
    expect(answersReview({ decided_at: "2026-09-24T09:00:00.000Z", review_id: null }, review)).toBe(true);
    expect(answersReview({ decided_at: "2026-09-24T08:59:59.999Z", review_id: null }, review)).toBe(false);
  });

  it("is held to the review it names, where it names one", () => {
    const after = "2026-09-24T09:30:00.000Z";
    expect(answersReview({ decided_at: after, review_id: "rev_0000000000000002" }, review)).toBe(true);
    expect(answersReview({ decided_at: after, review_id: "rev_0000000000000001" }, review)).toBe(false);
  });
});

describe("a finding the executor declined (D-065)", () => {
  const reason = "A person must decide whether review should run the suite itself.";
  const decline = (at: string, why = reason) => ({ finding_key: KEY, reason: why, at });

  it("is the person's, with the three answers, while no later round closed it", () => {
    expect(routedToPerson({ key: KEY, status: "open", routing: "remediable" }, NOTHING_TRIED)).toBe(false);
    expect(routedToPerson({ key: KEY, status: "open", routing: "remediable" }, declined())).toBe(true);
    expect(routedToPerson({ key: "b".repeat(64), status: "open", routing: "remediable" }, declined())).toBe(false);
    expect(decidable({ decision: "remediable" }, declined())).toBe(true);
    expect(decidable({ decision: "incomplete" }, declined())).toBe(false);
  });

  it("reads it off the attempts since the review, keeps every reason, and lets a later closing round close it", () => {
    const at = (minute: number) => `2026-09-27T12:${String(minute).padStart(2, "0")}:00.000Z`;
    const loop = (verifications: { at: string; given: string[]; open: string[] }[], declines: ReturnType<typeof decline>[]) =>
      loopOnReview({
        reviewed_at: REVIEWED_AT,
        history: [],
        verifications: verifications.map((verification) => ({ ...verification, refused: false })),
        declines,
      });
    // Before the review: an earlier review's decline.
    expect(loop([], [decline(at(40))]).declined.size).toBe(0);
    expect(loop([], [decline(at(50))]).declined.get(KEY)).toEqual([reason]);
    // Handed on and declined again: both reasons.
    expect(loop([], [decline(at(50)), decline(at(55), "Still a person's call.")]).declined.get(KEY)).toEqual([
      reason,
      "Still a person's call.",
    ]);
    // A round given it that left it open keeps it the person's; one that closed it closes it.
    expect(loop([{ at: at(56), given: [KEY], open: [KEY] }], [decline(at(50))]).declined.has(KEY)).toBe(true);
    const closed = loop([{ at: at(56), given: [KEY], open: [] }], [decline(at(50))]);
    expect([closed.declined.has(KEY), closed.closed.has(KEY)]).toEqual([false, true]);
  });

  it("is read from each attempt's record, at the time the attempt started", () => {
    const at0 = "2026-09-27T12:50:00.000Z";
    expect(
      declinesOnRecord([
        { created_at: at0, declines: [{ finding_key: KEY, reason }] },
        { created_at: at0 },
      ]),
    ).toEqual([{ finding_key: KEY, reason, at: at0 }]);
  });
});

describe("a finding the runner refused a round on (SCP-194)", () => {
  const at = (minute: number) => `2026-09-27T12:${String(minute).padStart(2, "0")}:00.000Z`;
  const refusal = { at: at(50), given: [KEY], open: [KEY], refused: true };

  it("is the person's, with the three answers, until a later round closes it", () => {
    const loop = loopOnReview({ reviewed_at: REVIEWED_AT, history: [], verifications: [refusal], declines: [] });
    expect([...loop.refused]).toEqual([KEY]);
    expect(routedToPerson({ key: KEY, status: "open", routing: "remediable" }, loop)).toBe(true);
    expect(decidable({ decision: "remediable" }, loop)).toBe(true);
    const closed = loopOnReview({
      reviewed_at: REVIEWED_AT,
      history: [],
      verifications: [refusal, { at: at(55), given: [KEY], open: [], refused: false }],
      declines: [],
    });
    expect(closed.refused.size).toBe(0);
    expect(routedToPerson({ key: KEY, status: "open", routing: "remediable" }, closed)).toBe(false);
    // A round the verifier judged and left open is not a refusal.
    const judged = loopOnReview({ reviewed_at: REVIEWED_AT, history: [], verifications: [{ ...refusal, refused: false }], declines: [] });
    expect(routedToPerson({ key: KEY, status: "open", routing: "remediable" }, judged)).toBe(false);
  });
});
