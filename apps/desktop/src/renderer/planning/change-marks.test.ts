import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkedCriterion } from "./ChangeMarks.js";
import { SpecReading } from "./SpecReading.js";
import {
  changeKey,
  criteriaChange,
  gatherAdded,
  markRun,
  placeRemovals,
  textMarks,
  wordDiff,
} from "./change-marks.js";

/** The diff joined back on each side: what a reader would see kept and added, and kept and removed. */
const after = (pieces: ReturnType<typeof wordDiff>): string =>
  pieces.flatMap((piece) => (piece.kind === "removed" ? [] : [piece.text])).join("");
const before = (pieces: ReturnType<typeof wordDiff>): string =>
  pieces.flatMap((piece) => (piece.kind === "added" ? [] : [piece.text])).join("");
/** The text of each piece of one kind, in order. */
const texts = (pieces: ReturnType<typeof wordDiff>, kind: "same" | "added" | "removed"): string[] =>
  pieces.filter((piece) => piece.kind === kind).map((piece) => piece.text);

describe("the marks on the last change (D-NEW-the-plan-answers-the-spec-and-says-so)", () => {
  it("diffs by word, keeps the joins exact, and collapses a changed phrase into one mark", () => {
    const pieces = wordDiff(
      "The person can choose Light or Dark, after a restart.",
      "The person can choose Light, Dark or System without a restart.",
    );
    // Both texts come back whole from the pieces, so nothing between the
    // words was dropped or doubled.
    expect(before(pieces)).toBe("The person can choose Light or Dark, after a restart.");
    expect(after(pieces)).toBe("The person can choose Light, Dark or System without a restart.");
    // No mark starts or ends inside a word: every piece's edges fall at a
    // word boundary of the text it is from.
    for (const side of [
      pieces.filter((piece) => piece.kind !== "removed"),
      pieces.filter((piece) => piece.kind !== "added"),
    ])
      for (let at = 1; at < side.length; at++) {
        const left = side[at - 1]!.text.at(-1)!;
        const right = side[at]!.text[0]!;
        // Two word characters on either side of a cut would be one word split.
        expect(/[\p{L}\p{N}_]/u.test(left) && /[\p{L}\p{N}_]/u.test(right)).toBe(false);
      }
    // Runs of one kind are one piece: no two neighbours share a kind — and
    // where a removal and an addition sit together, the removal is first.
    for (let at = 1; at < pieces.length; at++) {
      expect(pieces[at]!.kind).not.toBe(pieces[at - 1]!.kind);
      if (pieces[at]!.kind === "removed") expect(pieces[at - 1]!.kind).toBe("same");
    }
    // What came and what went, read off the pieces.
    expect(texts(pieces, "added").join("|")).toContain("System without");
    expect(texts(pieces, "removed").join("|")).toContain("after");
    // A one-word rewording is exactly four pieces, the old word before the new.
    expect(wordDiff("queue one email", "queue two email")).toEqual([
      { kind: "same", text: "queue " },
      { kind: "removed", text: "one" },
      { kind: "added", text: "two" },
      { kind: "same", text: " email" },
    ]);
  });

  it("marks a changed phrase as one change, rather than a word at a time with the spaces kept between", () => {
    // The spaces between the new words would each match a space in the old
    // text, leaving "the colour mode" as three marks with a struck word in
    // each gap; a run of changes with only whitespace kept between them is
    // one removal and one addition.
    const pieces = wordDiff(
      "The person can choose Light, Dark or System without a restart.",
      "A person can choose the colour mode.",
    );
    expect(pieces).toEqual([
      { kind: "removed", text: "The" },
      { kind: "added", text: "A" },
      { kind: "same", text: " person can choose " },
      { kind: "removed", text: "Light, Dark or System without a restart" },
      { kind: "added", text: "the colour mode" },
      { kind: "same", text: "." },
    ]);
    expect(before(pieces)).toBe("The person can choose Light, Dark or System without a restart.");
    expect(after(pieces)).toBe("A person can choose the colour mode.");
    // Words added ahead of a text that is otherwise kept are one mark, and
    // nothing is removed.
    expect(wordDiff("Text meets WCAG AA contrast.", "By hand: Text meets WCAG AA contrast.")).toEqual([
      { kind: "added", text: "By hand: " },
      { kind: "same", text: "Text meets WCAG AA contrast." },
    ]);
  });

  it("calls two equal texts all the same, and an empty side all added or all removed", () => {
    expect(wordDiff("a b", "a b")).toEqual([{ kind: "same", text: "a b" }]);
    expect(wordDiff("", "new words")).toEqual([{ kind: "added", text: "new words" }]);
    expect(wordDiff("old words", "")).toEqual([{ kind: "removed", text: "old words" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  it("marks an appended clause as added, with the punctuation it replaced removed", () => {
    const pieces = wordDiff("Text meets WCAG AA contrast.", "Text meets WCAG AA contrast., within 60 seconds");
    expect(texts(pieces, "added")).toEqual(["., within 60 seconds"]);
    expect(texts(pieces, "removed")).toEqual(["."]);
  });

  it("diffs the lines first, and marks only the sentences that changed in a long section", () => {
    // A section of the largest size the record allows, one sentence changed
    // at its top and one at its bottom: the lines that changed are the only
    // ones diffed by word, so the marks are those two sentences and nothing
    // between them is called replaced.
    const sentence = "The person can choose Light, Dark or System without a restart.";
    const line = (at: number): string => `${String(at)}. ${sentence} Text meets WCAG AA contrast.\n`;
    const middle = Array.from({ length: 130 }, (_each, at) => line(at)).join("");
    const before = `First: the rail follows the mode.\n${middle}Last: the terminal has a dark palette.`;
    const after = `First: the rail ignores the mode.\n${middle}Last: the terminal has a light palette.`;
    expect(before.length).toBeGreaterThan(12_000);
    const pieces = wordDiff(before, after);
    expect(texts(pieces, "removed")).toEqual(["follows", "dark"]);
    expect(texts(pieces, "added")).toEqual(["ignores", "light"]);
    // Everything else is kept, as itself.
    expect(texts(pieces, "same").join("")).toBe(
      `First: the rail  the mode.\n${middle}Last: the terminal has a  palette.`,
    );
    // A line that went whole and a line that came whole are marked whole,
    // and the lines that changed are paired in the order they stand.
    expect(wordDiff("one\ntwo\nthree\n", "one\nthree\n")).toEqual([
      { kind: "same", text: "one\n" },
      { kind: "removed", text: "two\n" },
      { kind: "same", text: "three\n" },
    ]);
    expect(wordDiff("one\ntwo\n", "one\ntwo\nthree\n")).toEqual([
      { kind: "same", text: "one\ntwo\n" },
      { kind: "added", text: "three\n" },
    ]);
    expect(wordDiff("a b\nc d\ne f\n", "a B\nc D\ne f\n")).toEqual([
      { kind: "same", text: "a " },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "\nc " },
      { kind: "removed", text: "d" },
      { kind: "added", text: "D" },
      { kind: "same", text: "\ne f\n" },
    ]);
  });

  it("gives both texts back whole from the pieces, whatever the texts", () => {
    // A small vocabulary, so the two sides share a lot and the pairing of
    // lines and of words is exercised rather than trivial.
    let seed = 20_260_921;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const words = ["the", "person", "can", "choose", "Light", "Dark", ",", ".", " ", "  ", "\n", "\n\n", "restart"];
    const text = (): string =>
      Array.from({ length: Math.floor(random() * 40) }, () => words[Math.floor(random() * words.length)]!).join(
        random() < 0.5 ? " " : "",
      );
    for (let round = 0; round < 300; round++) {
      const left = text();
      // The right side is the left with some words changed, or another text.
      const right =
        random() < 0.5
          ? text()
          : left
              .split(" ")
              .map((word) => (random() < 0.2 ? words[Math.floor(random() * words.length)]! : word))
              .join(" ");
      const pieces = wordDiff(left, right);
      expect(before(pieces), left).toBe(left);
      expect(after(pieces), right).toBe(right);
      for (let at = 1; at < pieces.length; at++) expect(pieces[at]!.kind).not.toBe(pieces[at - 1]!.kind);
    }
  });

  it("tells a reworded criterion from one added and one removed by its words, never by its id", () => {
    // The Plan pane's Next goes through `perbo edit --criterion`, which
    // numbers the criteria afresh: after deleting the second of three, the
    // third carries the second's id. By words, the survivors are unchanged
    // and the one that went is struck through.
    const [a, b, c] = ["The person can choose Light or Dark.", "Text meets WCAG AA contrast.", "The rail follows the mode."];
    const middleGone = criteriaChange(
      [{ id: "ac_1", text: a }, { id: "ac_2", text: b }, { id: "ac_3", text: c }],
      [{ id: "ac_1", text: a }, { id: "ac_2", text: c }],
    );
    expect(middleGone.of.get("ac_1")).toEqual({ kind: "unchanged" });
    expect(middleGone.of.get("ac_2")).toEqual({ kind: "unchanged" });
    expect([...middleGone.of.values()].some((change) => change.kind === "changed")).toBe(false);
    expect(middleGone.removed).toEqual([b]);
    // The last deleted: the first two unchanged, the last struck through.
    const lastGone = criteriaChange(
      [{ id: "ac_1", text: a }, { id: "ac_2", text: b }, { id: "ac_3", text: c }],
      [{ id: "ac_1", text: a }, { id: "ac_2", text: b }],
    );
    expect([...lastGone.of.values()]).toEqual([{ kind: "unchanged" }, { kind: "unchanged" }]);
    expect(lastGone.removed).toEqual([c]);
    // One reworded: exactly one change, with its diff, and nothing removed.
    const reworded = criteriaChange(
      [{ id: "ac_1", text: a }, { id: "ac_2", text: b }, { id: "ac_3", text: c }],
      [{ id: "ac_1", text: a }, { id: "ac_2", text: "Text meets WCAG AAA contrast." }, { id: "ac_3", text: c }],
    );
    expect(reworded.removed).toEqual([]);
    expect([...reworded.of.values()].filter((change) => change.kind === "changed")).toHaveLength(1);
    const change = reworded.of.get("ac_2");
    if (change?.kind !== "changed") throw new Error("reworded");
    expect(change.text).toBe("Text meets WCAG AAA contrast.");
    expect(after(change.diff)).toBe("Text meets WCAG AAA contrast.");
    expect(change.diff.some((piece) => piece.kind === "added" && piece.text === "AAA")).toBe(true);
    // The same words with the whitespace around them changed are unchanged.
    expect(criteriaChange([{ id: "ac_1", text: a }], [{ id: "ac_1", text: ` ${a} ` }]).of.get("ac_1")).toEqual({
      kind: "unchanged",
    });
    // One added at the end, whatever its id, and one taken away with the
    // rest reworded: the rewordings are paired in the order they stand, and
    // what is left over on either side came or went.
    expect(
      criteriaChange(
        [{ id: "ac_1", text: a }, { id: "ac_2", text: b }],
        [{ id: "ac_1", text: a }, { id: "ac_2", text: b }, { id: "ac_9", text: c }],
      ).of.get("ac_9"),
    ).toEqual({ kind: "added", text: c });
    const swept = criteriaChange(
      [{ id: "ac_1", text: a }, { id: "ac_2", text: b }, { id: "ac_3", text: c }],
      [{ id: "ac_1", text: "A person can choose the colour mode." }],
    );
    expect(swept.of.get("ac_1")?.kind).toBe("changed");
    expect(swept.removed).toEqual([b, c]);
  });

  it("keys a recorded change by when it was recorded and the words on each side, not by the object", () => {
    // A session read again hands over a fresh object for the same change,
    // and the panes diff once per change rather than once per read.
    const sections = { outcome: "", requirements: "- R1: one email.", no_gos: "", rabbit_holes: "", notes: "" };
    const change = {
      at: "2026-09-21T10:00:00.000Z",
      spec: { before: { ...sections, requirements: "" }, after: sections },
      plan: { before: { outcome: "One", criteria: [{ id: "ac_1", text: "a" }] }, after: { outcome: "One", criteria: [{ id: "ac_1", text: "b" }] } },
    };
    expect(changeKey(structuredClone(change))).toBe(changeKey(change));
    expect(changeKey({ ...change, at: "2026-09-21T10:00:01.000Z" })).not.toBe(changeKey(change));
    expect(changeKey({ ...change, spec: { ...change.spec, after: { ...sections, notes: "x" } } })).not.toBe(changeKey(change));
    expect(
      changeKey({ ...change, plan: { ...change.plan, after: { outcome: "One", criteria: [{ id: "ac_1", text: "c" }] } } }),
    ).not.toBe(changeKey(change));
    expect(changeKey({ ...change, spec: null })).not.toBe(changeKey(change));
    expect(changeKey(null)).toBeNull();
  });

  it("places a change in the after-text: added stretches by offset, removals where they stood", () => {
    const marks = textMarks("one two three", "one 2 three four");
    expect(marks.added).toEqual([
      { from: 4, to: 5 },
      { from: 11, to: 16 },
    ]);
    expect(marks.removed).toEqual([{ at: 4, text: "two" }]);
    // Whitespace alone that went is not a mark anybody could read.
    expect(textMarks("a  b", "a b").removed).toEqual([]);
  });

  it("splits a run where the marks fall and keeps every piece at its own source offset", () => {
    // A run that begins at 10 in its section, with an addition inside it and
    // a removal at the boundary of the addition.
    const pieces = markRun(
      { at: 10, text: "one 2 three" },
      [{ from: 14, to: 15 }],
      [{ at: 14, text: "two" }],
    );
    expect(pieces).toEqual([
      { kind: "text", text: "one ", at: 10 },
      { kind: "removed", text: "two", at: 14 },
      { kind: "added", text: "2", at: 14 },
      { kind: "text", text: " three", at: 15 },
    ]);
    // Joined, the run's own text is whole again.
    expect(pieces.flatMap((piece) => (piece.kind === "removed" ? [] : [piece.text])).join("")).toBe(
      "one 2 three",
    );
    // A run nothing touched is itself.
    expect(markRun({ at: 0, text: "plain" }, [{ from: 20, to: 25 }], [])).toEqual([
      { kind: "text", text: "plain", at: 0 },
    ]);
    // An addition that covers the whole run marks the whole run.
    expect(markRun({ at: 5, text: "new" }, [{ from: 0, to: 20 }], [])).toEqual([
      { kind: "added", text: "new", at: 5 },
    ]);
  });

  it("puts each removal in one run: the first that reaches it, or the last for one past every run", () => {
    const runs = [
      { at: 0, text: "first" },
      { at: 8, text: "second" },
    ];
    const placed = placeRemovals(runs, [
      { at: 3, text: "inside the first" },
      { at: 5, text: "at the end of the first" },
      { at: 6, text: "in the gap, drawn at the start of the second" },
      { at: 40, text: "after everything" },
    ]);
    expect(placed.get(0)).toEqual([
      { at: 3, text: "inside the first" },
      { at: 5, text: "at the end of the first" },
    ]);
    expect(placed.get(1)).toEqual([
      { at: 8, text: "in the gap, drawn at the start of the second" },
      { at: 14, text: "after everything" },
    ]);
    // No runs, nowhere to put anything.
    expect(placeRemovals([], [{ at: 0, text: "x" }]).size).toBe(0);
  });
});

describe("words added together are one highlight (D-NEW-the-plan-answers-the-spec-and-says-so)", () => {
  /** The text of every added mark in some markup, one entry a mark. */
  const addedIn = (html: string): string[] =>
    [...html.matchAll(/<mark class="change change--added"[^>]*>(.*?)<\/mark>/g)].map((match) =>
      match[1]!.replace(/<[^>]+>/g, ""),
    );

  it("gathers added pieces and the whitespace between them into one stretch, and stops at a removal", () => {
    const stretches = gatherAdded([
      { kind: "text", text: "Know" },
      { kind: "added", text: " Food" },
      { kind: "text", text: " " },
      { kind: "added", text: "and beast" },
      { kind: "text", text: " " },
      { kind: "text", text: "alone" },
      { kind: "added", text: "one" },
      { kind: "removed", text: "gone" },
      { kind: "added", text: "two" },
    ]);
    expect(
      stretches.map((stretch) => (stretch.added ? stretch.pieces.map((piece) => piece.text).join("") : null)),
    ).toEqual([null, " Food and beast", null, null, "one", null, "two"]);
  });

  it("draws an addition that crosses emphasis, code and a reference in the spec's reading as one mark", () => {
    const before = "Know how much is in play.";
    const after = "Know **Food**, *and* at `beast` @Alone how much is in play.";
    const html = renderToStaticMarkup(
      createElement(SpecReading, {
        value: after,
        label: "Spec Outcome",
        placeholder: "",
        known: new Set<string>(),
        marks: textMarks(before, after),
        onOpen: () => {},
      }),
    );
    // One highlight over the plain words, the strong word, the emphasis, the
    // code and the reference between them, rather than one per run with a
    // gap at every boundary.
    expect(addedIn(html)).toEqual([" Food, and at beast @Alone"]);
    // Each run inside it keeps its own class and its own source offset, and
    // is the mark's own child, which is what `.change--added > [data-run]`
    // reaches to give it the mark's green in place of its own colour and box.
    const inside = html.match(/<mark class="change change--added"[^>]*>(.*?)<\/mark>/)![1]!;
    expect(inside.replace(/<span data-at="\d+" data-run=""(?: class="[^"]*")?>[^<]*<\/span>/g, "")).toBe("");
    expect(inside).toContain('<span data-at="7" data-run="" class="spec-strong">Food</span>');
    expect(inside).toContain('<span data-at="16" data-run="" class="spec-em">and</span>');
    expect(inside).toContain('<span data-at="25" data-run="" class="spec-code">beast</span>');
    expect(inside).toContain('<span data-at="32" data-run="" class="sym sym--unknown">@Alone</span>');
  });

  it("draws added words a kept space apart on a criterion as one mark", () => {
    const text = "The colour mode is chosen.";
    const html = renderToStaticMarkup(
      createElement(MarkedCriterion, {
        text,
        change: {
          kind: "changed",
          text,
          diff: [
            { kind: "same", text: "The " },
            { kind: "added", text: "colour" },
            { kind: "same", text: " " },
            { kind: "added", text: "mode" },
            { kind: "same", text: " is chosen." },
          ],
        },
      }),
    );
    expect(addedIn(html)).toEqual(["colour mode"]);
  });
});
