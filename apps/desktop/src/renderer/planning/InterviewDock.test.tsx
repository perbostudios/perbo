// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { INTERVIEW_WROTE_THE_SPEC, RequestSchema, TYPED_TEXT_MAX_CHARS } from "../../shared/protocol.js";
import { typeInto } from "../../test-support/typing.js";
import {
  NoteLine,
  QuestionCard,
  ToolCard,
  askedSubjects,
  foldAllowList,
  handedOver,
  sayWorking,
  waitsOnWords,
} from "./InterviewDock.js";

afterEach(cleanup);

const css = readFileSync(`${import.meta.dirname}/../styles.css`, "utf8");
/** The first rule in the renderer's stylesheet with exactly this selector, up to its closing brace. */
const cssRule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

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

  it("says the turn is finishing under the note that hands the spec over", () => {
    // The spec is written and the note says so, and Generate plan waits for
    // the turn to end (D-102): the line under the note says it is still going.
    expect(
      sayWorking({ kind: "note", text: INTERVIEW_WROTE_THE_SPEC, notable: true } as never),
    ).toBe("Finishing this turn…");
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

  it("reads the note that hands the spec over as standing for the rest of its turn", () => {
    // From the note on, nothing the session says in that turn is shown and
    // the line under it says only that the turn is finishing (D-102); the
    // next turn starts over.
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

describe("the two answers every part carries", () => {
  const group = {
    title: "How the queue is split",
    parts: [
      {
        question: "Where does the split go?",
        options: [
          { label: "Split at the read", detail: null, recommended: true },
          { label: "Split at the write", detail: null, recommended: false },
        ],
      },
    ],
  };
  const card = () => {
    render(<QuestionCard group={group} number={1} of={1} standing="interview" busy={false} onSend={() => undefined} />);
    return within(screen.getByRole("group", { name: "How the queue is split" }));
  };
  const radio = (named: RegExp): HTMLInputElement => screen.getByRole("radio", { name: named });
  const answer = (named: RegExp): HTMLElement => radio(named).closest("label")!;

  it("draws each with the circle every answer carries, filled while it is the pick", () => {
    card();
    for (const named of [/Something else/, /Architect's call/, /Split at the read/]) {
      // The same radio as an offered answer's, drawn: none of them hidden.
      expect(radio(named).className, String(named)).toBe("");
      expect(answer(named).querySelector(".choice-heading > input[type=radio]")).toBe(radio(named));
    }
    expect(answer(/Architect's call/).classList.contains("choice--paired")).toBe(true);
    fireEvent.click(radio(/Architect's call/));
    expect(radio(/Architect's call/).checked).toBe(true);
    expect(answer(/Architect's call/).classList.contains("selected")).toBe(true);
    expect(radio(/Something else/).checked).toBe(false);
  });

  it("holds the person's own words to what a turn carries, where they are typed, and sends them whole without a refusal (D-NEW-nothing-shown-is-cut)", () => {
    const sent: string[] = [];
    render(
      <QuestionCard group={group} number={1} of={1} standing="interview" busy={false} onSend={(turn) => sent.push(turn)} />,
    );
    fireEvent.click(radio(/Something else/));
    const box = answer(/Something else/).querySelector("textarea")!;
    typeInto(box, "o".repeat(TYPED_TEXT_MAX_CHARS + 50));
    expect(box.value).toHaveLength(TYPED_TEXT_MAX_CHARS);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toEqual(["o".repeat(TYPED_TEXT_MAX_CHARS)]);
    expect(RequestSchema.safeParse({ kind: "interviewTurn", id: crypto.randomUUID(), text: sent[0] }).success).toBe(true);
  });

  it("holds a lettered part's own words to the room the group's one turn leaves, and sends the group without a refusal", () => {
    const two = {
      ...group,
      parts: [group.parts[0]!, { ...group.parts[0]!, question: "And where does the retry go?" }],
    };
    const sent: string[] = [];
    render(<QuestionCard group={two} number={1} of={1} standing="interview" busy={false} onSend={(turn) => sent.push(turn)} />);
    const parts = screen.getAllByRole("radio", { name: /Split at the read/ });
    fireEvent.click(parts[0]!);
    fireEvent.click(screen.getAllByRole("radio", { name: /Something else/ })[1]!);
    const box = screen.getByRole("textbox", { name: "Your own words for 1b" }) as HTMLTextAreaElement;
    typeInto(box, "o".repeat(TYPED_TEXT_MAX_CHARS + 50));
    // The first part's answer and the two letters take their share of the turn.
    const first = "a) Split at the read\nb) ";
    expect(box.value).toHaveLength(TYPED_TEXT_MAX_CHARS - first.length);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toEqual([first + box.value]);
    expect(sent[0]).toHaveLength(TYPED_TEXT_MAX_CHARS);
    expect(RequestSchema.safeParse({ kind: "interviewTurn", id: crypto.randomUUID(), text: sent[0] }).success).toBe(true);
  });

  it("takes a pick back when it is clicked again, the pair's as the offered ones'", () => {
    card();
    for (const named of [/Architect's call/, /Split at the write/]) {
      fireEvent.click(radio(named));
      expect(radio(named).checked, String(named)).toBe(true);
      fireEvent.click(radio(named));
      expect(radio(named).checked, String(named)).toBe(false);
      expect(answer(named).classList.contains("selected"), String(named)).toBe(false);
    }
  });

  it("keeps Something else picked while its box is typed in, takes it back only from the card around the box, and keeps the words", () => {
    const found = card();
    fireEvent.click(radio(/Something else/));
    const box = found.getByLabelText("Your own words") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "At the queue" } });
    // Picked, and seen to be, while it is typed in.
    expect(radio(/Something else/).checked).toBe(true);
    expect(answer(/Something else/).classList.contains("selected")).toBe(true);
    // A click in the box is the person typing, not a take-back.
    fireEvent.click(box);
    expect(found.getByLabelText("Your own words")).toBe(box);
    expect(radio(/Something else/).checked).toBe(true);
    // A click on the opened card around the box takes it back.
    fireEvent.click(answer(/Something else/));
    expect(found.queryByLabelText("Your own words")).toBeNull();
    expect(radio(/Something else/).checked).toBe(false);
    expect(answer(/Something else/).classList.contains("selected")).toBe(false);
    // And picked again, what was typed is there.
    fireEvent.click(radio(/Something else/));
    expect((found.getByLabelText("Your own words") as HTMLTextAreaElement).value).toBe("At the queue");
  });

  it("fits each half's circle and words between its borders from the narrowest dock up", () => {
    // Measured in the preview at the dock's 252px and 300px: the label's size
    // is the half's width less exactly what the rules below put around it.
    expect(cssRule(".choice--paired")).toContain("padding: 15px 6px;");
    expect(cssRule(".choice--paired .choice-heading")).toContain("gap: 5px;");
    expect(cssRule(".choice--paired input")).toContain("width: 15px;");
    expect(cssRule(".choice--paired input:checked")).toContain("width: 16px;");
    // Half the 6px gap, 2px of border a side once picked, 6px of padding a
    // side, the 15px circle and the 5px to the label.
    expect(cssRule(".choice--paired strong")).toContain(
      "font-size: min(calc(12.5px * var(--text-scale)), calc((50cqw - 3px - 4px - 12px - 15px - 5px) / 7.2));",
    );
    expect(cssRule(".choice-pair")).toContain("gap: 6px;");
  });

  it("gives the box one ink outline and nothing pulsing, the caret its only motion", () => {
    const found = card();
    fireEvent.click(radio(/Something else/));
    const box = found.getByLabelText("Your own words");
    // Empty, and waiting on the person's words: still no pulse on it.
    expect(box.className).toBe("");
    expect(cssRule(".asked-part .choice--custom textarea")).toContain("border: 1.5px solid var(--ink);");
    // The focus ring would be a second outline beside the border: focus
    // thickens the border itself instead, so a keyboard sees where it is.
    const focused = cssRule(".asked-part .choice--custom textarea:focus-visible");
    expect(focused).toContain("outline: none;");
    expect(focused).toContain("border-width: 2.5px;");
    expect(focused).not.toContain("box-shadow");
    expect(css).not.toContain("textarea.awaiting-words");
  });
});

describe("a refused call's card", () => {
  const refused = (detail: string) =>
    ({ kind: "tool", tool: "edit_plan", ok: false, detail, edit: null }) as const;
  const card = (line: Parameters<typeof ToolCard>[0]["line"]) => {
    render(<ToolCard line={line} edit={null} onUndo={null} undoable={null} busy={false} />);
    return document.querySelector(".tool-card") as HTMLElement;
  };

  it("says the first sentence of a longer reason in full, with the whole reason behind an i after it", () => {
    const detail =
      "node_404 is not in this plan, which has node_1 and node_2 and nothing else that an edge could be drawn to. " +
      "read_plan reads the nodes it has, and an edge may only join two of them.";
    const why = card(refused(detail)).querySelector(".tool-why") as HTMLElement;
    expect(why.firstChild?.textContent).toBe(
      "Refused: node_404 is not in this plan, which has node_1 and node_2 and nothing else that an edge could be drawn to.",
    );
    expect(within(why).getByRole("button", { name: "Why it was refused: Changing the plan" }).textContent).toBe("i");
    expect(within(why).getByRole("tooltip", { hidden: true }).textContent).toBe(detail);
  });

  it("puts no i under a reason that is one sentence", () => {
    const why = card(refused("node_404 is not in this plan.")).querySelector(".tool-why") as HTMLElement;
    expect(why.textContent).toBe("Refused: node_404 is not in this plan.");
    expect(within(why).queryByRole("button")).toBeNull();
  });

  it("keeps a call that worked to its one line", () => {
    const shown = card({ kind: "tool", tool: "read_plan", ok: true, detail: "Two nodes. One edge.", edit: null });
    expect(shown.querySelector(".tool-why")).toBeNull();
    expect([...shown.children].map((child) => child.className)).toEqual(["tool-head"]);
  });

  it("wraps the reason over the lines it needs rather than cutting it to one", () => {
    const rule = cssRule(".tool-why");
    for (const cut of ["nowrap", "ellipsis", "overflow: hidden"]) expect(rule).not.toContain(cut);
  });
});

describe("what the asked line says the questions are about", () => {
  // Nothing a person reads is cut mid-sentence: the line names whole titles
  // while they fit, counts the rest, and says the count alone where none fits.
  const long = (word: string): string => `${word} ${"and its many consequences ".repeat(3).trim()}`;
  it("names every title where they all fit", () => {
    expect(askedSubjects(["Scope"])).toBe("Scope");
    expect(askedSubjects(["Scope", "Rollout", "Tests"])).toBe("Scope, Rollout and Tests");
  });
  it("names the whole titles that fit and counts the rest, never cutting one", () => {
    const titles = [long("Scope"), long("Rollout"), long("Tests")];
    const said = askedSubjects(titles)!;
    expect(said).toBe(`${titles[0]} and 2 more`);
    expect(said.length).toBeLessThanOrEqual(120);
    expect(said).not.toContain("…");
    expect(askedSubjects([titles[0]!, "Rollout", "Tests", long("Data")])).toBe(`${titles[0]}, Rollout, Tests and 1 more`);
  });
  it("says nothing of the subject where not even the first title fits", () => {
    expect(askedSubjects(["x".repeat(121)])).toBeNull();
    expect(askedSubjects(["x".repeat(121), "Rollout"])).toBeNull();
    expect(askedSubjects([])).toBeNull();
  });
});

describe("a note about a tool's output (D-NEW-nothing-shown-is-cut)", () => {
  it("says what happened in its one sentence, with the whole output behind an i", () => {
    const stderr = "the provider said a great deal about why it would not serve this session. ".repeat(1_000).trim();
    render(<NoteLine line={{ kind: "note", text: "The chat stopped with code 2.", output: stderr }} />);
    const note = document.querySelector<HTMLElement>(".msg--note")!;
    expect(note.firstChild?.textContent).toBe("The chat stopped with code 2.");
    const hint = within(note).getByRole("button", { name: "What it said" });
    expect(hint.textContent).toBe("i");
    expect(within(note).getByRole("tooltip", { hidden: true }).textContent).toBe(stderr);
  });

  it("puts no i under a note with no output", () => {
    render(<NoteLine line={{ kind: "note", text: "Named specs/dark-mode-toggle from your first message." }} />);
    const note = document.querySelector<HTMLElement>(".msg--note")!;
    expect(note.textContent).toBe("Named specs/dark-mode-toggle from your first message.");
    expect(within(note).queryByRole("button")).toBeNull();
  });
});
