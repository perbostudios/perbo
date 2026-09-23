import { describe, expect, it } from "vitest";
import {
  LEAVE_IT_TO_THE_INTERVIEW,
  answersGroup,
  type InterviewQuestionGroup,
} from "./interview-protocol.js";

/**
 * What counts as a group's answer (D-117), read back off the turn.
 *
 * The desktop host moves its record of the asking on by it, and what that
 * record then withholds is the way on: the chat's note and the Spec pane both
 * refuse Generate plan while a group the interview asked still stands. Every
 * other check on it is indirect, through a UI test, and those put single-part
 * groups — so the lettered path can break while they stay green.
 */
const group = (...parts: { question: string; options: string[] }[]): InterviewQuestionGroup => ({
  title: "How the queue is split",
  parts: parts.map((part) => ({
    question: part.question,
    options: part.options.map((label) => ({ label, detail: null, recommended: false })),
  })),
});

const TWO = group(
  { question: "Where does the split go?", options: ["Split at the read", "Split at the write"] },
  { question: "What proves it?", options: ["A unit test per node", "One integration test"] },
);
const ONE = group({
  question: "What happens to the old node?",
  options: ["Delete it", "Keep it as a no-op"],
});

describe("answersGroup", () => {
  it("counts a lettered line a part, whatever is said under the letter", () => {
    // Every part picked, which is the shape a card of nothing but picks sends.
    expect(answersGroup(TWO, "a) Split at the read\nb) One integration test")).toBe(true);
    // One part picked and one in the person's own words: a part answered in
    // their own sentence answers it as much as a picked one does.
    expect(answersGroup(TWO, "a) Split at the read\nb) whatever proves the read is separate")).toBe(
      true,
    );
    // Both in their own words.
    expect(answersGroup(TWO, "a) neither, split at the queue\nb) an end-to-end test")).toBe(true);
    expect(answersGroup(TWO, `a) ${LEAVE_IT_TO_THE_INTERVIEW}\nb) A unit test per node`)).toBe(true);
  });

  it("does not count a lettered turn with a part left empty, out of order or missing", () => {
    expect(answersGroup(TWO, "a) Split at the read\nb) ")).toBe(false);
    expect(answersGroup(TWO, "a) Split at the read\nb)")).toBe(false);
    expect(answersGroup(TWO, "a) \nb) A unit test per node")).toBe(false);
    // The letters are the order the parts were read in, so a swapped pair is
    // not this group's answer.
    expect(answersGroup(TWO, "b) A unit test per node\na) Split at the read")).toBe(false);
    // A part's own words carrying a newline arrive as a third line, which is
    // why the card collapses one before it sends.
    expect(answersGroup(TWO, "a) Split at the read\nb) a unit test\nper node")).toBe(false);
    expect(answersGroup(TWO, "a) Split at the read")).toBe(false);
    expect(answersGroup(TWO, "Split at the read\nA unit test per node")).toBe(false);
  });

  it("counts only an offered answer on a single part, so their own words end the asking", () => {
    expect(answersGroup(ONE, "Delete it")).toBe(true);
    expect(answersGroup(ONE, `  ${LEAVE_IT_TO_THE_INTERVIEW}  `)).toBe(true);
    // The label carries an apostrophe, and is read back exactly as the card
    // sends it, alone or under a letter.
    expect(LEAVE_IT_TO_THE_INTERVIEW).toBe("Architect's call");
    expect(answersGroup(ONE, "Architect's call")).toBe(true);
    expect(answersGroup(TWO, "a) Architect's call\nb) Architect's call")).toBe(true);
    // A sentence of their own on a one-part group is not the group's answer:
    // there is no letter to tell it from talking past the question, and the
    // asking ending is what puts an unclosed problem again.
    expect(answersGroup(ONE, "Leave the old node where it is for now.")).toBe(false);
    expect(answersGroup(ONE, "a) Delete it")).toBe(false);
  });
});
