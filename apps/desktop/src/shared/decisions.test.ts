import { describe, expect, it } from "vitest";
import { FINDING_ROUTINGS } from "@perbo/contracts";
import { decisionQuestions, settledFindings } from "./decisions.js";

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
    expect(asked[0]?.context).toBe("the suite was added by the same change");
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
    bundles: [{ kind: "review", subject_id: "rev_0000000000000002", created_at: "2026-09-24T09:00:00.000Z" }],
  };
  const verified = (given: string[], open: string[]) => ({
    review: null,
    verification: { open_keys: open, per_finding: given.map((finding_key) => ({ finding_key })) },
    bundles: [],
  });
  const answer = (finding_key: string, over: Record<string, unknown> = {}) => ({
    review: { reference: "PRB-1" },
    finding_key,
    decision: "decide",
    choice: "ship_as_is",
    decided_at: "2026-09-24T09:30:00.000Z",
    superseded_at: null,
    ...over,
  });
  const settled = (attempts: unknown[], verdicts: unknown[]) =>
    [...settledFindings({ attempts: attempts as never, verdicts })].sort();

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
          answer("a", { review: { reference: "rev_0000000000000002" } }),
          answer("b", { review: { reference: "rev_0000000000000001" } }),
        ],
      ),
    ).toEqual(["a"]);
  });

  it("reads an answer against the review's own bundle, never another review's", () => {
    const another = { kind: "review", subject_id: "rev_0000000000000001", created_at: "2026-09-24T08:00:00.000Z" };
    const own = { ...reviewed.bundles[0]!, created_at: "2026-09-24T10:00:00.000Z" };
    expect(
      settled(
        [{ ...reviewed, bundles: [another, own] }],
        [
          answer("a", { review: { reference: "rev_0000000000000002" } }),
          answer("b", { review: { reference: "rev_0000000000000001" }, decided_at: "2026-09-24T10:30:00.000Z" }),
        ],
      ),
    ).toEqual([]);
  });

  it("counts what a round since the review closed, by the last verification's open set", () => {
    expect(settled([verified(["x"], []), reviewed, verified(["a", "b"], ["b"]), verified(["b", "c"], ["c"])], [])).toEqual(["a", "b"]);
  });

  it("settles nothing where no review is on record", () => {
    expect(settled([verified(["a"], [])], [answer("a")])).toEqual([]);
  });

  it("keeps a settled finding off the questions", () => {
    const asked = decisionQuestions(review([finding({ key: "a" }), finding({ key: "b" })]), new Set(["a"]));
    expect(asked.map((question) => question.id)).toEqual(["b"]);
  });
});
