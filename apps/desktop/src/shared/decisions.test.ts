import { beforeEach, describe, expect, it } from "vitest";
import { FINDING_ROUTINGS, NOTHING_TRIED, gateClosedNote } from "@perbo/contracts";
import { decisionQuestions, owedOnRecord, questionsOnRecord, settledFindings } from "./decisions.js";

/**
 * Which findings reach the person, and which answers each takes.
 *
 * The overlay renders only when this list is non-empty. A `blocks` finding is
 * the one that stops the loop, so it is asked, as an escalation is, and on a
 * review that judged the whole change it takes the three answers the loop acts
 * on. One whose closer the reviewer named as a person is asked too, for a
 * principle alone; one the executor is closing, one that closes no gate and
 * one already closed are not.
 */

const finding = (over: Record<string, unknown> = {}) =>
  ({
    key: "k" + Math.random().toString(36).slice(2, 8),
    rule_id: "product.preference",
    statement: "the change proves itself",
    status: "open",
    routing: "blocks",
    closure: "executor",
    blocking_reason: "the suite was added by the same change",
    ...over,
  }) as never;

const review = (findings: unknown[], decision = "changes_requested") => ({ decision, findings }) as never;

describe("the findings a person is asked to answer", () => {
  it("asks about a blocking finding, which is the one that stopped the loop", () => {
    const asked = decisionQuestions(review([finding({ routing: "blocks" })]));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.title).toBe("the change proves itself");
    // The reason travels with it: a question with no context is not answerable.
    expect(asked[0]?.context).toBe("The suite was added by the same change.");
  });

  it("asks about an escalation", () => {
    expect(decisionQuestions(review([finding({ routing: "escalates" })]))).toHaveLength(1);
  });

  it("asks where only the closer names a person, for a principle alone, since the loop would not act on an answer", () => {
    for (const routing of ["remediable", "advisory", "waived"]) {
      const asked = decisionQuestions(review([finding({ routing, closure: "human" })]));
      expect(asked.map((question) => question.choices), routing).toEqual([[]]);
    }
  });

  it("asks a finding routed to a person for a principle alone on a review that did not judge the whole change", () => {
    for (const decision of ["incomplete", "error"]) {
      const asked = decisionQuestions(review([finding({ routing: "blocks" }), finding({ routing: "escalates" })], decision));
      expect(asked.map((question) => question.choices), decision).toEqual([[], []]);
    }
    expect(decisionQuestions(review([finding({ routing: "escalates" })], "escalate"))[0]?.choices).toEqual([
      "approach",
      "let_it_decide",
      "ship_as_is",
    ]);
  });

  it("offers only Ship as it is on a finding the executor is never handed", () => {
    const asked = decisionQuestions(
      review([
        finding({ key: "a", rule_id: "security.secret_in_diff" }),
        finding({ key: "b", rule_id: "context.injected_instruction" }),
        finding({ key: "c", rule_id: "product.preference" }),
      ]),
    );
    expect(asked.map((question) => question.choices)).toEqual([
      ["ship_as_is"],
      ["ship_as_is"],
      ["approach", "let_it_decide", "ship_as_is"],
    ]);
  });

  it("does not ask about one the executor is already closing", () => {
    // `remediable` is not a softer `blocking`: the gate stays closed and the
    // executor is asked instead, in a new attempt graded independently. Putting
    // it here would interrupt a person for work already under way.
    expect(decisionQuestions(review([finding({ routing: "remediable" })]))).toEqual([]);
  });

  it("does not ask about a finding that closes no gate", () => {
    for (const routing of ["advisory", "waived"]) {
      expect(decisionQuestions(review([finding({ routing })])), routing).toEqual([]);
    }
  });

  it("does not ask about a finding that is already closed", () => {
    expect(
      decisionQuestions(review([finding({ routing: "blocks", status: "closed" })])),
    ).toEqual([]);
  });

  it("has an answer for every routing the contract defines", () => {
    // A routing the contract adds has to be decided here, rather than falling
    // through to "never ask".
    const asked = new Set(
      FINDING_ROUTINGS.filter(
        (routing) => decisionQuestions(review([finding({ routing })])).length > 0,
      ),
    );
    expect([...asked].sort()).toEqual(["blocks", "escalates"]);
  });

  it("survives a review that is absent or has no findings", () => {
    expect(decisionQuestions(null)).toEqual([]);
    expect(decisionQuestions(review([]))).toEqual([]);
  });
});

describe("the findings a person's answers and the rounds since have settled", () => {
  // The artifact was made before its bundle was recorded: the loop reads the
  // bundle's time, and so does this.
  const reviewed = {
    review: { review_id: "rev_0000000000000002", created_at: "2026-09-24T08:00:00.000Z" },
    verification: null,
    bundles: [{ kind: "review", subject_id: "rev_0000000000000002", created_at: "2026-09-24T09:00:00.000Z", inputs: {} }],
  };
  // Each round's verification, recorded a minute after the one before, from
  // just before the review: the loop reads the bundle, as this does.
  let minute = 59;
  beforeEach(() => {
    minute = 59;
  });
  const verified = (given: string[], open: string[], deterministic_failure: string | null = null) => {
    const at = new Date(Date.parse("2026-09-24T08:00:00.000Z") + minute++ * 60_000).toISOString();
    return {
      review: null,
      verification: { open_keys: open, per_finding: given.map((finding_key) => ({ finding_key })), deterministic_failure },
      bundles: [
        {
          kind: "review",
          subject_id: `cv_att_${minute}`,
          created_at: at,
          inputs: { findings_given: given.join(","), findings_open: open.join(",") },
        },
      ],
    };
  };
  const answer = (finding_key: string, over: Record<string, unknown> = {}) => ({
    review: { ticket_id: "ticket_1", reference: "PRB-1" },
    finding_key,
    decision: "decide",
    choice: "ship_as_is",
    decided_at: "2026-09-24T09:30:00.000Z",
    superseded_at: null,
    ...over,
  });
  const settled = (attempts: unknown[], verdicts: unknown[]) =>
    [...settledFindings({ ticket: { ticket_id: "ticket_1", history: [] }, attempts: attempts as never, verdicts }).keys].sort();

  it("counts a standing answer that shipped it as it is, taken after the review", () => {
    expect(
      settled(
        [reviewed],
        [
          answer("a"),
          answer("b", { choice: "approach" }),
          answer("c", { decided_at: "2026-09-24T08:30:00.000Z" }),
          answer("d", { superseded_at: "2026-09-24T09:40:00.000Z" }),
        ],
      ),
    ).toEqual(["a"]);
  });

  it("counts an answer that named a review by its id only on that review", () => {
    expect(
      settled(
        [reviewed],
        [
          answer("a", { review: { ticket_id: "ticket_1", reference: "rev_0000000000000002" } }),
          answer("b", { review: { ticket_id: "ticket_1", reference: "rev_0000000000000001" } }),
        ],
      ),
    ).toEqual(["a"]);
  });

  it("reads only the ticket's own answers, as perbo run reads them", () => {
    expect(
      settled([reviewed], [answer("a"), answer("b", { review: { ticket_id: "ticket_2", reference: "PRB-2" } })]),
    ).toEqual(["a"]);
  });

  it("reads an answer against the review's own bundle, never another review's", () => {
    const another = { kind: "review", subject_id: "rev_0000000000000001", created_at: "2026-09-24T08:00:00.000Z" };
    const own = { ...reviewed.bundles[0]!, created_at: "2026-09-24T10:00:00.000Z" };
    expect(
      settled(
        [{ ...reviewed, bundles: [another, own] }],
        [
          answer("a", { review: { ticket_id: "ticket_1", reference: "rev_0000000000000002" } }),
          answer("b", { review: { ticket_id: "ticket_1", reference: "rev_0000000000000001" }, decided_at: "2026-09-24T10:30:00.000Z" }),
        ],
      ),
    ).toEqual([]);
  });

  it("counts what a round since the review closed, by the last verification each finding was given", () => {
    expect(settled([verified(["x"], []), reviewed, verified(["a", "b"], ["b"]), verified(["b", "c"], ["c"])], [])).toEqual(["a", "b"]);
    // A round scoped to one finding, as a person's answer scopes it after a
    // stall, says nothing of the one it was not given: that stays open.
    expect(settled([reviewed, verified(["a", "b"], ["a", "b"]), verified(["a"], [])], [])).toEqual(["a"]);
  });

  it("settles nothing where no review is on record", () => {
    expect(settled([verified(["a"], [])], [answer("a")])).toEqual([]);
  });

  it("keeps a settled finding off the questions", () => {
    const asked = decisionQuestions(review([finding({ key: "a" }), finding({ key: "b" })]), {
      keys: new Set(["a"]),
      refusal: null,
      loop: NOTHING_TRIED,
      answers: new Map(),
    });
    expect(asked.map((question) => question.id)).toEqual(["b"]);
  });

  it("asks a finding a widened round left open with the scope refusal it was judged on, as a sentence of its own", () => {
    const refusal =
      "remediation round 1 was given 1 scope finding(s) and widened the change set instead: " +
      "test/extra.test.ts were not in the change set it was asked to narrow. " +
      "The contract's writes are admitted only under: `src/**`.";
    const standing = settledFindings({
      ticket: { ticket_id: "ticket_1", history: [] },
      attempts: [reviewed, verified(["a", "b"], ["a", "b"], refusal)] as never,
      verdicts: [],
    });
    expect(standing.refusal).toEqual({ sentence: refusal, open: new Set(["a", "b"]) });

    const asked = decisionQuestions(
      review([
        finding({ key: "a" }),
        finding({ key: "b", blocking_reason: null }),
        finding({ key: "c", blocking_reason: null }),
      ]),
      standing,
    );
    expect(asked.map((question) => [question.id, question.context])).toEqual([
      ["a", `The suite was added by the same change. R${refusal.slice(1)}`],
      ["b", `R${refusal.slice(1)}`],
      ["c", ""],
    ]);
  });

  it("names no refusal where the last round's verification stopped on none", () => {
    const standing = settledFindings({
      ticket: { ticket_id: "ticket_1", history: [] },
      attempts: [reviewed, verified(["a"], ["a"], "scope: an earlier round's failure"), verified(["a"], ["a"], null)] as never,
      verdicts: [],
    });
    expect(standing.refusal).toBeNull();
    expect(decisionQuestions(review([finding({ key: "a" })]), standing)[0]?.context).toBe(
      "The suite was added by the same change.",
    );
  });
});

/**
 * D-132 beside D-065: after a refinement that stalled, the findings it left
 * open are the person's, and so is one the executor declined, with the reason
 * it gave; and a run that would start with those unanswered and none handed
 * on is not offered.
 */
describe("the questions a stalled refinement leaves, beside a declined finding", () => {
  const REASON = "Which page size is right is a product call.";
  const remediable = (key: string) => finding({ key, routing: "remediable", closure: "executor" });
  const reviewAttempt = {
    startedAt: "2026-09-24T08:50:00.000Z",
    review: { review_id: "rev_0000000000000003", decision: "remediable", findings: [remediable("x"), remediable("y")] },
    verification: null,
    declines: [],
    bundles: [{ kind: "review", subject_id: "rev_0000000000000003", created_at: "2026-09-24T09:00:00.000Z", inputs: {} }],
  };
  const declinedRound = {
    startedAt: "2026-09-24T09:05:00.000Z",
    review: null,
    verification: { open_keys: ["y"], per_finding: [{ finding_key: "y" }], deterministic_failure: null },
    declines: [{ finding_key: "x", reason: REASON }],
    bundles: [
      {
        kind: "review",
        subject_id: "cv_att_2",
        created_at: "2026-09-24T09:10:00.000Z",
        inputs: { findings_given: "y", findings_open: "y" },
      },
    ],
  };
  const stalled = { at: "2026-09-24T09:20:00.000Z", note: gateClosedNote("remediation_stalled") };
  const detail = (verdicts: unknown[], history: unknown[] = [stalled]) =>
    ({ ticket: { ticket_id: "ticket_1", history }, attempts: [reviewAttempt, declinedRound], verdicts }) as never;
  const answer = (finding_key: string, choice: string) => ({
    review: { ticket_id: "ticket_1", reference: "PRB-1" },
    finding_key,
    decision: "decide",
    choice,
    decided_at: "2026-09-24T09:30:00.000Z",
    superseded_at: null,
  });

  it("asks the declined finding, with the executor's reason, and the one left open, each with the three answers", () => {
    const asked = questionsOnRecord(detail([]));
    expect(asked.map((question) => [question.id, question.choices, question.declined])).toEqual([
      ["x", ["approach", "let_it_decide", "ship_as_is"], [REASON]],
      ["y", ["approach", "let_it_decide", "ship_as_is"], []],
    ]);
  });

  it("owes the unanswered questions where nothing is handed on, and nothing once one is or the loop is still trying", () => {
    expect(owedOnRecord(detail([])).map((question) => question.id)).toEqual(["x", "y"]);
    expect(owedOnRecord(detail([answer("y", "ship_as_is")])).map((question) => question.id)).toEqual(["x"]);
    expect(owedOnRecord(detail([answer("x", "approach")]))).toEqual([]);
    expect(owedOnRecord(detail([answer("x", "ship_as_is"), answer("y", "ship_as_is")]))).toEqual([]);
    // No run finished trying: the finding left open is still the executor's to close.
    expect(owedOnRecord(detail([], []))).toEqual([]);
  });

  it("asks a declined finding with the three answers where the reviewer named a person its closer", () => {
    const humanClosed = {
      ...reviewAttempt,
      review: { ...reviewAttempt.review, findings: [finding({ key: "x", routing: "remediable", closure: "human" }), remediable("y")] },
    };
    const asked = questionsOnRecord({ ticket: { ticket_id: "ticket_1", history: [stalled] }, attempts: [humanClosed, declinedRound], verdicts: [] } as never);
    expect(asked.map((question) => [question.id, question.choices.length])).toEqual([
      ["x", 3],
      ["y", 3],
    ]);
  });
});
