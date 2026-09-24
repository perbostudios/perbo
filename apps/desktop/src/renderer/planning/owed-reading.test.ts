import { describe, expect, it } from "vitest";
import { EVERY_PROBLEM_RESOLVED } from "../../shared/protocol.js";
import type { InterviewEntry } from "../../shared/protocol.js";
import { owedReading } from "./owed-reading.js";

/** A minute past ten on one morning, so each line's time reads as its minute. */
const at = (minute: number): string => new Date(Date.UTC(2026, 8, 24, 10, minute)).toISOString();
const entry = (n: number, minute: number, line: InterviewEntry["line"]): InterviewEntry => ({
  n,
  at: at(minute),
  line,
});
const turn = (n: number, minute: number): InterviewEntry => entry(n, minute, { kind: "turn", text: "Keep it" });
const said = (n: number, minute: number): InterviewEntry => entry(n, minute, { kind: "said", text: "Done." });
const problemCard = (n: number, minute: number): InterviewEntry =>
  entry(n, minute, {
    kind: "asked",
    groups: [
      {
        title: null,
        parts: [
          {
            question: "Which holds?",
            options: [
              { label: "The spec", detail: null, recommended: true },
              { label: "The plan", detail: null, recommended: false },
            ],
          },
        ],
      },
    ],
    drift: { open: 1 },
  });
const resolvedNote = (n: number, minute: number): InterviewEntry =>
  entry(n, minute, { kind: "note", text: EVERY_PROBLEM_RESOLVED, notable: true });
const reading = (minute: number) => ({ startedAt: at(minute) });
const recorded = { drift: { open: [], resolved: false }, running: true };

describe("the reading a turn is owed (D-128)", () => {
  it("owes nothing before the person has taken a turn", () => {
    expect(owedReading([said(1, 1)], recorded, null)).toEqual({ turn: null, appliedAt: null, owed: false });
  });

  it("bounds a turn with nothing after it by the turn itself", () => {
    const found = owedReading([said(1, 1), turn(2, 3)], recorded, reading(2));
    expect(found).toEqual({ turn: 2, appliedAt: Date.parse(at(3)), owed: true });
  });

  it("bounds a turn by the interview's last line after it", () => {
    const found = owedReading([turn(1, 1), said(2, 4), said(3, 6)], recorded, null);
    expect(found).toEqual({ turn: 1, appliedAt: Date.parse(at(6)), owed: true });
  });

  it("does not move the bound for the lines a reading puts as it lands", () => {
    const conversation = [turn(1, 1), said(2, 4), problemCard(3, 7), resolvedNote(4, 8)];
    expect(owedReading(conversation, recorded, null).appliedAt).toBe(Date.parse(at(4)));
    // The reading that put them started after the interview's last line: it is the turn's.
    expect(owedReading(conversation, recorded, reading(5)).owed).toBe(false);
    // Any other note is the interview's own, and moves it.
    const ended = entry(5, 9, { kind: "note", text: "The chat ended: you stopped it." });
    expect(owedReading([...conversation, ended], recorded, null).appliedAt).toBe(Date.parse(at(9)));
  });

  it("still owes a reading where the newest started under the turn, before it was applied", () => {
    expect(owedReading([turn(1, 1), said(2, 4)], recorded, reading(2)).owed).toBe(true);
  });

  it("owes nothing once the newest reading started at or after the turn was applied", () => {
    const conversation = [turn(1, 1), said(2, 4)];
    expect(owedReading(conversation, recorded, reading(4)).owed).toBe(false);
    expect(owedReading(conversation, recorded, reading(5)).owed).toBe(false);
  });

  it("owes nothing where the session records no problems, or the interview is not running", () => {
    const conversation = [turn(1, 1), said(2, 4)];
    expect(owedReading(conversation, { drift: null, running: true }, null).owed).toBe(false);
    expect(owedReading(conversation, { drift: undefined, running: true }, null).owed).toBe(false);
    expect(owedReading(conversation, { ...recorded, running: false }, null).owed).toBe(false);
  });
});
