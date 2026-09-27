import { describe, expect, it } from "vitest";
import {
  answersFinding,
  decidable,
  decisionChoicesFor,
  DECISION_CHOICES,
  FINISHED_TRYING,
  judgedCommit,
  leftToPrinciple,
  loopOnRecord,
  loopOnReview,
  NEVER_HANDED_FAMILIES,
  NOTHING_TRIED,
  owedAnswers,
  routedToPerson,
  type DecisionChoice,
  type LoopOnReview,
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
const finished = (closed: readonly string[] = [], declined: readonly string[] = []): LoopOnReview => ({
  finished: true,
  closed: new Set(closed),
  declined: new Set(declined),
  lastGiven: new Map(),
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

  it("is never one the executor declined, whatever its routing: a principle answers that (D-065)", () => {
    for (const routing of ["blocks", "escalates", "remediable"] as const) {
      expect(routedToPerson({ key: KEY, status: "open", routing }, finished([], [KEY])), routing).toBe(false);
    }
    const other = "b".repeat(64);
    expect(routedToPerson({ key: other, status: "open", routing: "remediable" }, finished([], [KEY]))).toBe(true);
  });

  it("is never one already resolved or waived", () => {
    for (const status of ["resolved", "waived"] as const) {
      expect(routedToPerson({ key: KEY, status, routing: "blocks" }, NOTHING_TRIED), status).toBe(false);
      expect(routedToPerson({ key: KEY, status, routing: "remediable" }, finished()), status).toBe(false);
    }
  });
});

describe("which findings are left to a principle", () => {
  it("is an open finding the executor declined, which no choice answers, and no other", () => {
    expect(leftToPrinciple({ key: KEY, status: "open" }, finished([], [KEY]))).toBe(true);
    expect(leftToPrinciple({ key: KEY, status: "resolved" }, finished([], [KEY]))).toBe(false);
    expect(leftToPrinciple({ key: KEY, status: "open" }, finished())).toBe(false);
    // Never a finding a person answers with a choice, whatever its routing.
    for (const routing of ["blocks", "escalates", "remediable"] as const) {
      const finding = { key: KEY, status: "open", routing } as const;
      expect(leftToPrinciple(finding, finished([], [KEY])) && routedToPerson(finding, finished([], [KEY])), routing).toBe(false);
    }
  });
});

describe("the findings a run would start without an answer to", () => {
  const [x, y, z] = ["a", "b", "c"].map((digit) => digit.repeat(64)) as [string, string, string];
  const open = (key: string, rule_id = "product.preference") =>
    ({ key, status: "open", routing: "remediable", rule_id }) as const;
  const owed = (
    loop: LoopOnReview,
    answers: Array<[string, DecisionChoice]> = [],
    findings = [open(x), open(y)],
  ) => owedAnswers({ review: { decision: "remediable", findings }, loop, answers: new Map(answers) });

  it("is every finding a finished loop left the person unanswered, where none is handed on", () => {
    expect(owed(finished())).toEqual([x, y]);
    expect(owed(finished(), [[x, "ship_as_is"]])).toEqual([y]);
    expect(owed(finished(), [[x, "ship_as_is"], [y, "ship_as_is"]])).toEqual([]);
  });

  it("is none where one is handed to the executor, since the run is the round on it", () => {
    expect(owed(finished(), [[x, "approach"]])).toEqual([]);
    expect(owed(finished(), [[x, "let_it_decide"]])).toEqual([]);
  });

  it("counts an answer the finding does not take as none", () => {
    expect(owed(finished(), [[z, "approach"]], [open(z, "security.secret_in_diff")])).toEqual([z]);
  });

  it("leaves out what a round closed and what the executor declined", () => {
    expect(owed(finished([x], [y]), [], [open(x), open(y), open(z)])).toEqual([z]);
  });

  it("is none while the loop is still trying", () => {
    expect(owed(NOTHING_TRIED)).toEqual([]);
  });

  it("is a finding a person handed to a round that left it open, with the others routed to them, before any run finished trying", () => {
    const blocks = (key: string) => ({ key, status: "open", routing: "blocks", rule_id: "product.preference" }) as const;
    const handedAndLeft: LoopOnReview = { ...NOTHING_TRIED, lastGiven: new Map([[x, "2026-09-27T13:00:00.000Z"]]) };
    const review = (findings: ReturnType<typeof blocks>[]) => ({ decision: "changes_requested" as const, findings });
    expect(owedAnswers({ review: review([blocks(x), blocks(y)]), loop: handedAndLeft, answers: new Map() })).toEqual([x, y]);
    // Nothing handed and left open: the executor has not been tried on them.
    expect(owedAnswers({ review: review([blocks(x), blocks(y)]), loop: NOTHING_TRIED, answers: new Map() })).toEqual([]);
    // Answered again, and handed on: the run is the round on it.
    expect(
      owedAnswers({ review: review([blocks(x), blocks(y)]), loop: handedAndLeft, answers: new Map([[x, "approach"]]) }),
    ).toEqual([]);
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
      expect(loopOnReview({ reviewed_at: REVIEWED_AT, history: [ended(outcome)], verifications: [] }).finished).toBe(true);
    }
    for (const outcome of ["escalated", "changes_requested"]) {
      expect(loopOnReview({ reviewed_at: REVIEWED_AT, history: [ended(outcome)], verifications: [] }).finished).toBe(false);
    }
    // A stall on an earlier review is not one on this.
    const before = ended("remediation_stalled", "2026-09-27T12:40:00.000Z");
    expect(loopOnReview({ reviewed_at: REVIEWED_AT, history: [before], verifications: [] }).finished).toBe(false);
    // A run started since, or one it ended escalated, does not take it back.
    const later = [ended("remediation_stalled"), { at: "2026-09-27T13:10:00.000Z", note: "run started" }, ended("escalated", "2026-09-27T13:20:00.000Z")];
    expect(loopOnReview({ reviewed_at: REVIEWED_AT, history: later, verifications: [] }).finished).toBe(true);
  });

  it("reads each finding's status off the last verification given it", () => {
    const [a, b, c] = ["a", "b", "c"].map((digit) => digit.repeat(64));
    const loop = loopOnReview({
      reviewed_at: REVIEWED_AT,
      history: [],
      verifications: [
        { at: REVIEWED_AT, given: [a!, b!, c!], open: [a!, b!], declined: [] },
        // A round scoped to one finding says nothing of the others.
        { at: REVIEWED_AT, given: [a!], open: [], declined: [] },
      ],
    });
    expect([...loop.closed].sort()).toEqual([a, c]);
    const reopened = loopOnReview({
      reviewed_at: REVIEWED_AT,
      history: [],
      verifications: [
        { at: REVIEWED_AT, given: [a!], open: [], declined: [] },
        { at: REVIEWED_AT, given: [a!], open: [a!], declined: [] },
      ],
    });
    expect([...reopened.closed]).toEqual([]);
  });

  it("holds every finding a round since the review declined", () => {
    const [a, b] = ["a", "b"].map((digit) => digit.repeat(64));
    const loop = loopOnReview({
      reviewed_at: REVIEWED_AT,
      history: [],
      verifications: [
        { at: REVIEWED_AT, given: [b!], open: [b!], declined: [a!] },
        // A later round given only the other finding does not take the decline back.
        { at: REVIEWED_AT, given: [b!], open: [b!], declined: [] },
      ],
    });
    expect([...loop.declined]).toEqual([a]);
  });

  it("reads the declines off each closure verification's bundle", () => {
    const [a, b] = ["a", "b"].map((digit) => digit.repeat(64));
    const review = { kind: "review" as const, subject_id: "rev_0000000000000001", created_at: REVIEWED_AT, inputs: {} };
    const verification = {
      kind: "review" as const,
      subject_id: "cv_att_1",
      created_at: "2026-09-27T12:50:00.000Z",
      inputs: { findings_given: b!, findings_open: b!, findings_declined: a! },
    };
    const onRecord = loopOnRecord({ review_id: review.subject_id, bundles: [review, verification], history: [] });
    expect([...onRecord!.loop.declined]).toEqual([a]);
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

describe("which answers answer a finding", () => {
  const review = { review_id: "rev_0000000000000002", recorded_at: "2026-09-24T09:00:00.000Z" };
  const answer = (decided_at: string, review_id: string | null = null) => ({ finding_key: KEY, decided_at, review_id });

  it("is one taken at or after the review was recorded, and never before", () => {
    expect(answersFinding(answer("2026-09-24T09:00:00.000Z"), review, NOTHING_TRIED)).toBe(true);
    expect(answersFinding(answer("2026-09-24T08:59:59.999Z"), review, NOTHING_TRIED)).toBe(false);
  });

  it("is held to the review it names, where it names one", () => {
    const after = "2026-09-24T09:30:00.000Z";
    expect(answersFinding(answer(after, "rev_0000000000000002"), review, NOTHING_TRIED)).toBe(true);
    expect(answersFinding(answer(after, "rev_0000000000000001"), review, NOTHING_TRIED)).toBe(false);
  });

  it("is one taken after the last round handed the finding, and never the answer that round already tried", () => {
    const loop = loopOnReview({
      reviewed_at: review.recorded_at,
      history: [],
      verifications: [{ at: "2026-09-24T10:00:00.000Z", given: [KEY], open: [KEY], declined: [] }],
    });
    expect(answersFinding(answer("2026-09-24T09:30:00.000Z"), review, loop)).toBe(false);
    expect(answersFinding(answer("2026-09-24T10:30:00.000Z"), review, loop)).toBe(true);
    // A round given another finding says nothing of this one's answer.
    expect(answersFinding({ ...answer("2026-09-24T09:30:00.000Z"), finding_key: "b".repeat(64) }, review, loop)).toBe(true);
    // One whose round closed the finding stands.
    const closed = loopOnReview({
      reviewed_at: review.recorded_at,
      history: [],
      verifications: [{ at: "2026-09-24T10:00:00.000Z", given: [KEY], open: [], declined: [] }],
    });
    expect(answersFinding(answer("2026-09-24T09:30:00.000Z"), review, closed)).toBe(true);
  });
});

describe("the commit a record judged", () => {
  const verification = (inputs: Record<string, string>) => ({ inputs });

  it("is the review's where no verification judged since, and the last verification's that judged a tree", () => {
    expect(judgedCommit("abc1234", [])).toBe("abc1234");
    expect(judgedCommit("abc1234", [verification({ head_commit: "def5678" })])).toBe("def5678");
    // A round the scope rule refused judged no tree, and is passed over.
    expect(
      judgedCommit("abc1234", [verification({ head_commit: "def5678" }), verification({ refused_head_commit: "fff9999" })]),
    ).toBe("def5678");
    expect(judgedCommit("abc1234", [verification({})])).toBe(null);
  });
});
