// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { INTERVIEW_WROTE_THE_SPEC } from "../../shared/protocol.js";
import { foldAllowList, handedOver, sayWorking, waitsOnWords } from "./InterviewDock.js";

describe("what the dock says the session is doing", () => {
  it("names the work in hand rather than calling every pause thinking", () => {
    // "Thinking…" is true of every pause and says nothing about any of them.
    expect(sayWorking({ kind: "tool", tool: "read_plan", ok: true, detail: "", edit: null } as never)).toBe(
      "Reading the plan…",
    );
    expect(sayWorking({ kind: "tool", tool: "edit_plan", ok: true, detail: "", edit: null } as never)).toBe(
      "Changing the plan…",
    );
    expect(sayWorking({ kind: "turn", text: "do it" } as never)).toBe("Reading what you said…");
    expect(sayWorking({ kind: "refused", tool: "Bash", rule: "r", target: null, reason: "x" } as never)).toBe(
      "Trying another way…",
    );
    expect(sayWorking(undefined)).toBe("Reading the repository…");
  });

  it("says nothing under the note that is already the whole status", () => {
    // The spec is written, the note says so and names the three ways on. A
    // line under it saying the session is working reads as more being owed
    // before the person may act, and nothing is: the spec is readable now
    // (D-102).
    expect(
      sayWorking({ kind: "note", text: INTERVIEW_WROTE_THE_SPEC, notable: true } as never),
    ).toBeNull();
    // Any other note is not that note, and the pause under it is still a
    // pause.
    expect(
      sayWorking({ kind: "note", text: "Writing the spec…" } as never),
    ).toBe("Thinking…");
  });

  it("says something for a tool it does not know, rather than its argument name", () => {
    // A tool added later reads as work rather than as nothing.
    expect(sayWorking({ kind: "tool", tool: "some_new_tool", ok: true, detail: "", edit: null } as never)).toBe(
      "Working…",
    );
    // And one that failed is being answered, not repeated.
    expect(sayWorking({ kind: "tool", tool: "edit_plan", ok: false, detail: "", edit: null } as never)).toBe(
      "Reading what came back…",
    );
  });
});

describe("a command the session may not run", () => {
  const refused = (n: number, rule: string) =>
    ({ n, at: "2026-01-01T00:00:00.000Z", line: { kind: "refused", tool: "Bash", rule, target: null, reason: "r" } }) as never;
  const said = (n: number) =>
    ({ n, at: "2026-01-01T00:00:00.000Z", line: { kind: "said", text: "hello" } }) as never;

  it("folds a run of them into one, because it is one thing that happened", () => {
    const folded = foldAllowList([
      refused(1, "command_allow_list"),
      refused(2, "command_allow_list"),
      refused(3, "command_allow_list"),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.tried).toBe(3);
  });

  it("folds every rule where nothing shows a write, not only the allow list", () => {
    // The runner's own rules split this way: a shape the guard cannot vouch
    // for is recorded and the attempt runs on, where a write rule ends it.
    for (const rule of ["command_allow_list", "unreadable_program", "unreadable_inline_program"])
      expect(foldAllowList([refused(1, rule)])[0]!.tried, rule).toBe(1);
  });

  it("keeps the card for every rule that does show a write", () => {
    // These are the ones a person should act on, and the red belongs to them.
    for (const rule of [
      "write_outside_worktree",
      "write_outside_scope",
      "write_prohibited_path",
      "command_deny_list",
      "git_credential_config",
    ])
      expect(foldAllowList([refused(1, rule)])[0]!.tried, rule).toBeUndefined();
  });

  it("keeps a refusal that matters as its own line, whatever it sits beside", () => {
    // A write it may not make is not the session finding the edge of what it
    // can read: it is the thing to act on, and it keeps its own card.
    const folded = foldAllowList([
      refused(1, "command_allow_list"),
      refused(2, "write_outside_scope"),
      refused(3, "command_allow_list"),
    ]);
    expect(folded.map((each) => each.tried)).toEqual([1, undefined, 1]);
  });

  it("does not fold across anything else, since those are separate events", () => {
    const folded = foldAllowList([
      refused(1, "command_allow_list"),
      said(2),
      refused(3, "command_allow_list"),
    ]);
    expect(folded).toHaveLength(3);
    expect(folded.map((each) => each.tried)).toEqual([1, undefined, 1]);
  });

  it("leaves a conversation with none of them alone", () => {
    expect(foldAllowList([said(1), said(2)]).map((each) => each.tried)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("the dock's answers, its status line and the interview behind the chat", () => {
  /** A line of a conversation, for reading one without a session. */
  const entry = (n: number, line: unknown) => ({ n, at: "2026-09-23T00:00:00.000Z", line }) as never;

  it("puts no line under the note that hands the spec over, for the rest of its turn", () => {
    // The note is the status for the rest of the turn it is said in,
    // whatever the session does after it (D-102); the next turn starts over.
    const turn = entry(1, { kind: "turn", text: "write it" });
    const note = entry(2, { kind: "note", text: INTERVIEW_WROTE_THE_SPEC, notable: true });
    const tool = entry(3, { kind: "tool", tool: "read_plan", ok: true, detail: "", edit: null });
    expect(handedOver([turn, note])).toBe(true);
    expect(handedOver([turn, note, tool])).toBe(true);
    expect(handedOver([turn, entry(2, { kind: "note", text: "Named specs/x." })])).toBe(false);
    expect(handedOver([turn, note, entry(4, { kind: "turn", text: "and more" })])).toBe(false);
  });

  it("reads what the conversation leaves to the person's words", () => {
    const turn = entry(1, { kind: "turn", text: "go on" });
    const said = (text: string) => entry(2, { kind: "said", text });
    // The first message, where nothing of the conversation was dropped.
    expect(waitsOnWords([], 0)).toBe(true);
    // A conversation cut to its last lines had a first message, dropped.
    expect(waitsOnWords([entry(401, { kind: "said", text: "Done." })], 400)).toBe(false);
    // A question, however it is closed.
    for (const text of ["Which one?", 'Which one?"', "Which one?)", "Which one?**", "Which one?”", "Which one? "])
      expect(waitsOnWords([turn, said(text)], 0), text).toBe(true);
    expect(waitsOnWords([turn, said("That is done.")], 0)).toBe(false);
    // Work after the question does not take it back; a note does.
    const tool = entry(3, { kind: "tool", tool: "read_plan", ok: true, detail: "", edit: null });
    expect(waitsOnWords([turn, said("Which one?"), tool], 0)).toBe(true);
    expect(waitsOnWords([turn, said("Which one?"), entry(3, { kind: "note", text: "The chat ended: gone." })], 0)).toBe(
      false,
    );
  });
});
