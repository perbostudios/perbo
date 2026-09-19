import { describe, expect, it } from "vitest";
import { FINDING_ROUTINGS } from "@perbo/contracts";
import { decisionQuestions } from "../src/shared/decisions.js";

/**
 * Which findings reach the person.
 *
 * The overlay renders only when this list is non-empty. A `blocks` finding is
 * the one that stops the loop, so it is asked, as an escalation is; a finding
 * whose closer the reviewer named as a person is asked whatever its routing;
 * one the executor is closing, one that closes no gate and one already closed
 * are not.
 */

const finding = (over: Record<string, unknown> = {}) =>
  ({
    key: "k" + Math.random().toString(36).slice(2, 8),
    statement: "the change proves itself",
    status: "open",
    routing: "blocks",
    closure: "executor",
    blocking_reason: "the suite was added by the same change",
    ...over,
  }) as never;

const review = (findings: unknown[]) => ({ findings }) as never;

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

  it("asks when the reviewer named a person as the closer, whatever the routing", () => {
    const asked = decisionQuestions(
      review([finding({ routing: "remediable", closure: "human" })]),
    );
    expect(asked).toHaveLength(1);
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
