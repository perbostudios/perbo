import { describe, expect, it } from "vitest";
import { specBlocks, type SpecBlock, type SpecRun } from "../src/renderer/planning/spec-format.js";

/**
 * The reading view's parse of a spec section.
 *
 * Two things are asked of it everywhere. It shows what the writer marked and
 * nothing else — no emphasis invented from words, because a colour a reader
 * cannot trust is worse than none. And every run says where it came from, so a
 * click on the page opens the editor at the character under the pointer; that
 * only holds while each run's text is a slice of the input at its own offset,
 * which is what most of these check.
 */

/** Every run of every block, which is what the offsets are checked against. */
function runsIn(blocks: SpecBlock[]): SpecRun[] {
  return blocks.flatMap((block) =>
    block.kind === "list" ? block.items.flatMap((item) => item.runs) : block.runs,
  );
}

/** The one thing that must hold of every parse, whatever the text. */
function everyRunPointsAtItself(text: string): void {
  for (const run of runsIn(specBlocks(text))) {
    expect(text.slice(run.at, run.at + run.text.length)).toBe(run.text);
  }
}

describe("a spec section read as blocks", () => {
  it("gives a requirement its id and drops the id from the words", () => {
    const text = "- R1: The app is a single file at `screentime/index.html`.";
    const blocks = specBlocks(text);
    expect(blocks).toHaveLength(1);
    const [block] = blocks as [SpecBlock];
    if (block.kind !== "list") throw new Error("a bullet is a list");
    expect(block.items[0]!.id).toBe("R1");
    expect(block.items[0]!.runs.map((run) => run.text).join("")).toBe(
      "The app is a single file at screentime/index.html.",
    );
    everyRunPointsAtItself(text);
  });

  it("keeps consecutive bullets in one list and starts a second after a blank line", () => {
    const text = "- R1: one\n- R2: two\n\n- R3: three";
    const blocks = specBlocks(text);
    expect(blocks.map((block) => block.kind)).toEqual(["list", "list"]);
    const [first, second] = blocks as [SpecBlock, SpecBlock];
    if (first.kind !== "list" || second.kind !== "list") throw new Error("both are lists");
    expect(first.items.map((item) => item.id)).toEqual(["R1", "R2"]);
    expect(second.items.map((item) => item.id)).toEqual(["R3"]);
    everyRunPointsAtItself(text);
  });

  it("reads a heading inside a section without letting it claim a bigger one", () => {
    const blocks = specBlocks("### The page\n\n- R1: one");
    const [heading] = blocks as [SpecBlock];
    if (heading.kind !== "heading") throw new Error("three hashes is a heading");
    expect(heading.level).toBe(2);
    expect(heading.runs.map((run) => run.text).join("")).toBe("The page");
  });

  it("holds a deeper heading to the bottom of the range", () => {
    const blocks = specBlocks("###### deep");
    const [heading] = blocks as [SpecBlock];
    if (heading.kind !== "heading") throw new Error("six hashes is a heading");
    expect(heading.level).toBe(4);
  });

  // `#` and `##` are the spec file's own delimiters. A line at either depth is
  // saved as a requirement, not a heading, so drawing it as one here would
  // promise an arrangement the next save does not keep.
  it.each(["# Rendering", "## Rendering"])("does not read %s as a heading", (line) => {
    const blocks = specBlocks(`${line}\n\n- R1: one`);
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "list"]);
    expect(blocks[0]!.kind === "paragraph" && blocks[0]!.runs[0]!.text).toBe(line);
  });

  // The file's own reader takes `-` and `*` and nothing else, so a line led by
  // anything else is text and keeps that character when it is saved.
  it.each(["+ plus", "\u2022 dot", "1. numbered", "2) also numbered"])(
    "does not read %s as a bullet, because the file does not either",
    (line) => {
      const [block] = specBlocks(line) as [SpecBlock];
      expect(block.kind).toBe("paragraph");
      expect(block.kind === "paragraph" && block.runs.map((run) => run.text).join("")).toBe(line);
    },
  );

  it("marks a reference inside bold as both, rather than losing the bold to it", () => {
    const text = "It is **always @VisibleTime, never the timer**.";
    const runs = runsIn(specBlocks(text));
    const strong = runs.filter((run) => run.mark === "strong");
    expect(strong.map((run) => run.text).join("")).toBe("always @VisibleTime, never the timer");
    // The reference keeps its own marking inside the bold.
    expect(strong.filter((run) => run.kind === "symbol").map((run) => run.text)).toEqual([
      "@VisibleTime",
    ]);
    // And the asterisks are gone rather than left on the page.
    expect(runs.some((run) => run.text.includes("**"))).toBe(false);
    everyRunPointsAtItself(text);
  });

  it("marks code, strong and emphasis, and takes their marks off", () => {
    const text = "A `file://` URL is **never** fetched, only *opened*.";
    const [block] = specBlocks(text) as [SpecBlock];
    if (block.kind !== "paragraph") throw new Error("prose is a paragraph");
    expect(block.runs.filter((run) => run.mark === "code").map((run) => run.text)).toEqual([
      "file://",
    ]);
    expect(block.runs.filter((run) => run.mark === "strong").map((run) => run.text)).toEqual([
      "never",
    ]);
    expect(block.runs.filter((run) => run.mark === "emphasis").map((run) => run.text)).toEqual([
      "opened",
    ]);
    everyRunPointsAtItself(text);
  });

  it("reads ** as one mark rather than two of the shorter one", () => {
    const [block] = specBlocks("**Day Total**") as [SpecBlock];
    if (block.kind !== "paragraph") throw new Error("prose is a paragraph");
    expect(block.runs).toEqual([{ kind: "text", mark: "strong", text: "Day Total", at: 2 }]);
  });

  it("leaves a mark inside a code span alone", () => {
    const text = "`a * b ** c`";
    const [block] = specBlocks(text) as [SpecBlock];
    if (block.kind !== "paragraph") throw new Error("prose is a paragraph");
    expect(block.runs).toEqual([{ kind: "text", mark: "code", text: "a * b ** c", at: 1 }]);
    everyRunPointsAtItself(text);
  });

  it("marks an @Symbol as the editor's own backdrop marks it", () => {
    const text = "It replaces @SpecPane, not `@SpecPane`.";
    const symbols = runsIn(specBlocks(text)).filter((run) => run.kind === "symbol");
    // Both, because the editor marks a reference inside backticks too: the two
    // views never disagree about what a reference is.
    expect(symbols.map((run) => run.text)).toEqual(["@SpecPane", "@SpecPane"]);
    everyRunPointsAtItself(text);
  });

  it("invents no emphasis from words the writer did not mark", () => {
    const text = "The app must never write outside its scope.";
    const [block] = specBlocks(text) as [SpecBlock];
    if (block.kind !== "paragraph") throw new Error("prose is a paragraph");
    expect(block.runs.every((run) => run.kind === "text")).toBe(true);
  });

  it("keeps a paragraph's own line breaks", () => {
    const text = "one\ntwo";
    const [block] = specBlocks(text) as [SpecBlock];
    if (block.kind !== "paragraph") throw new Error("prose is a paragraph");
    expect(block.runs.map((run) => run.text).join("")).toBe("one\ntwo");
    everyRunPointsAtItself(text);
  });

  it("points every run at itself through a section written with all of it at once", () => {
    everyRunPointsAtItself(
      [
        "### The page",
        "",
        "- R1: The app is a single new file at `screentime/index.html`.",
        "- R2: Opening it shows a **working** tracker — no server, no *build step*.",
        "",
        "### Measuring",
        "",
        "  - R6: It counts @VisibleTime only while the page is visible.",
        "- R7: **@VisibleTime and `now()`** together.",
        "",
        "Anything else goes here,",
        "over two lines.",
        "",
        "* a starred one",
      ].join("\n"),
    );
  });

  it("reads nothing out of nothing", () => {
    expect(specBlocks("")).toEqual([]);
    expect(specBlocks("\n\n  \n")).toEqual([]);
  });
});
