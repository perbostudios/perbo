import { describe, expect, it } from "vitest";
import type { InterviewQuestionGroup } from "@perbo/contracts";
import { NOTHING_ASKED, askingRecord, type AskingState } from "./asking.js";

const option = (label: string) => ({ label, detail: null, recommended: false });
const part = (question: string, ...labels: string[]) => ({ question, options: labels.map(option) });
const group = (title: string, ...parts: ReturnType<typeof part>[]): InterviewQuestionGroup => ({ title, parts });

const SIZE = part("How large is the board?", "Eight by eight", "Ten by ten");
const SIZE_IN_CELLS = part("How large is the board?", "64 cells", "100 cells");

describe("the asking record (D-117)", () => {
  it("hands every change on, and starts from what it is handed", () => {
    const kept: AskingState[] = [];
    const record = askingRecord(NOTHING_ASKED, (state) => kept.push(state));
    record.asked([group("Board", SIZE)]);
    record.heard({ type: "turn", text: "Ten by ten" });
    expect(kept.at(-1)).toEqual({ waiting: [], answered: [{ part: SIZE, answer: "Ten by ten" }] });

    const resumed = askingRecord(kept.at(-1)!, () => undefined);
    expect(resumed.repeats([group("Board", SIZE)])).toContain('was already answered "Ten by ten"');
  });

  it("counts two questions worded alike and offering other answers as two, each put more than once", () => {
    const record = askingRecord(NOTHING_ASKED, () => undefined);
    // Named by their answers too, since their wording alone names both.
    expect(
      record.repeats([group("Board", SIZE, SIZE_IN_CELLS), group("Again", SIZE, SIZE_IN_CELLS)]),
    ).toBe(
      'Nothing was put to the person, since "How large is the board?" (offering "Eight by eight" or ' +
        '"Ten by ten") and "How large is the board?" (offering "64 cells" or "100 cells") ' +
        "are put more than once in this call; ask again with each question once.",
    );
    // A detail or a recommendation worded otherwise is the same question.
    const again = { ...SIZE, options: [{ ...option("Eight by eight"), recommended: true }, option("Ten by ten")] };
    expect(record.repeats([group("Board", SIZE), group("Again", again)])).toBe(
      'Nothing was put to the person, since "How large is the board?" is put more than once in this ' +
        "call; ask again with each question once.",
    );
  });

  it("names a question waiting or answered by its answers where another in sight is worded alike", () => {
    const record = askingRecord(NOTHING_ASKED, () => undefined);
    record.asked([group("Board", SIZE)]);
    record.heard({ type: "turn", text: "Ten by ten" });
    record.asked([group("Cells", SIZE_IN_CELLS)]);
    expect(record.repeats([group("Board", SIZE, SIZE_IN_CELLS)])).toBe(
      'Nothing was put to the person, since "How large is the board?" (offering "64 cells" or "100 cells") ' +
        'is already asked and waiting on their answer and "How large is the board?" (offering ' +
        '"Eight by eight" or "Ten by ten") was already answered "Ten by ten"; wait for the answers still to ' +
        "come as their next turns, and take the ones given from the conversation rather than asking again.",
    );
    // Alone in sight, a question is named by its wording.
    const alone = askingRecord(NOTHING_ASKED, () => undefined);
    alone.asked([group("Board", SIZE)]);
    expect(alone.repeats([group("Board", SIZE)])).toBe(
      'Nothing was put to the person, since "How large is the board?" is already asked and waiting on ' +
        "their answer; wait for the answer to come as their next turn rather than asking again.",
    );
  });

  it("reads a turn the host marks by the mark, and the rest against the group in front", () => {
    const record = askingRecord(NOTHING_ASKED, () => undefined);
    record.asked([group("Board", SIZE)]);
    record.heard({ type: "turn", text: "Perbo: write it again, condensed.", asking: "kept" });
    expect(record.state().waiting).toHaveLength(1);
    record.heard({ type: "turn", text: "Ten by ten", asking: "ended" });
    expect(record.state()).toEqual(NOTHING_ASKED);
  });
});
