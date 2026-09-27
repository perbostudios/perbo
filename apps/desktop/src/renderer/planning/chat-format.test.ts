import { describe, expect, it } from "vitest";
import { chatBlocks, type ChatBlock, type ChatLine } from "./chat-format.js";

/** A line's words with its marks named, so a test reads as the message does. */
const words = (line: ChatLine): string =>
  line.map((run) => (run.mark === null ? run.text : `<${run.mark}>${run.text}`)).join("");

/** The blocks as a short outline: what kind each is, and its lines' words. */
function outline(blocks: ChatBlock[]): unknown[] {
  return blocks.map((block) =>
    block.kind === "heading"
      ? { heading: words(block.runs) }
      : block.kind === "code"
        ? { code: block.text }
        : block.kind === "paragraph"
          ? { paragraph: block.lines.map(words) }
          : listOutline(block),
  );
}
function listOutline(list: Extract<ChatBlock, { kind: "list" }>): unknown {
  return {
    [list.ordered ? `ol@${list.start}` : "ul"]: list.items.map((item) =>
      item.lists.length === 0 ? item.lines.map(words) : [item.lines.map(words), item.lists.map(listOutline)],
    ),
  };
}

describe("a chat message read as blocks", () => {
  it("keeps a numbered list spaced apart as one list", () => {
    expect(outline(chatBlocks("1. one\n\n2. two\n\n3. three"))).toEqual([{ "ol@1": [["one"], ["two"], ["three"]] }]);
  });

  it("counts on from the number the list was written with", () => {
    expect(outline(chatBlocks("3) three\n4) four"))).toEqual([{ "ol@3": [["three"], ["four"]] }]);
  });

  it("ends a list at a line on the margin after a blank line, and not before one", () => {
    expect(outline(chatBlocks("- a\n  still a\nand a\n\nAfter."))).toEqual([
      { ul: [["a", "still a", "and a"]] },
      { paragraph: ["After."] },
    ]);
    // Indented past a blank line, it is still the item's.
    expect(outline(chatBlocks("- a\n\n  more of a\n\nAfter."))).toEqual([
      { ul: [["a", "more of a"]] },
      { paragraph: ["After."] },
    ]);
  });

  it("puts an indented list under the item it follows", () => {
    expect(outline(chatBlocks("1. **Read**\n   - the spec\n   * the plan\n2. Write"))).toEqual([
      { "ol@1": [[["<strong>Read"], [{ ul: [["the spec"], ["the plan"]] }]], ["Write"]] },
    ]);
  });

  it("starts a new list where the kind changes at the same depth", () => {
    expect(outline(chatBlocks("- a\n+ b\n1. c"))).toEqual([{ ul: [["a"], ["b"]] }, { "ol@1": [["c"]] }]);
  });

  it("reads a line of hashes as a heading at any depth, and one without a space as words", () => {
    expect(outline(chatBlocks("# Top\n###### Deep *one*\n#hashtag"))).toEqual([
      { heading: "Top" },
      { heading: "Deep <emphasis>one" },
      { paragraph: ["#hashtag"] },
    ]);
  });

  it("keeps a paragraph's own line breaks and splits paragraphs at a blank line", () => {
    expect(outline(chatBlocks("one\r\ntwo `x`\n\n\nthree"))).toEqual([
      { paragraph: ["one", "two <code>x"] },
      { paragraph: ["three"] },
    ]);
    // A line ended by a carriage return alone is a line, and a fence written
    // with them holds none of them.
    expect(outline(chatBlocks("one\rtwo"))).toEqual([{ paragraph: ["one", "two"] }]);
    expect(outline(chatBlocks("```\r\nls\r\n```"))).toEqual([{ code: "ls" }]);
  });

  it("holds a fence's lines as written, with or without a language word, marks and lists included", () => {
    expect(
      outline(chatBlocks("Run it:\n```ts\nconst a = **b**;\n\n  - not a list\n```\nThen `check`.\n```\n# not a heading\n````"))
    ).toEqual([
      { paragraph: ["Run it:"] },
      { code: "const a = **b**;\n\n  - not a list" },
      { paragraph: ["Then <code>check."] },
      { code: "# not a heading" },
    ]);
  });

  it("closes a fence only with as many backticks as opened it, and runs an unclosed one to the end", () => {
    expect(outline(chatBlocks("````\n```\ninner\n```\n````"))).toEqual([{ code: "```\ninner\n```" }]);
    expect(outline(chatBlocks("```sh\nls\n\nrm"))).toEqual([{ code: "ls\n\nrm" }]);
  });

  it("ends a list at a fence and counts the list after it on from its own number", () => {
    expect(outline(chatBlocks("1. one\n   ```\n   code\n     deeper\n   ```\n2. two"))).toEqual([
      { "ol@1": [["one"]] },
      { code: "code\n  deeper" },
      { "ol@2": [["two"]] },
    ]);
  });

  it("reads backticks that close on the same line as words, not a fence", () => {
    expect(outline(chatBlocks("```inline```\nnext"))).toEqual([{ paragraph: ["``<code>inline``", "next"] }]);
  });

  it("reads _word_ as emphasis and leaves snake_case alone", () => {
    expect(outline(chatBlocks("An _honest_ run_id and __init__"))).toEqual([
      { paragraph: ["An <emphasis>honest run_id and __init__"] },
    ]);
  });

  it("leaves a quote and a rule as the characters they are", () => {
    expect(outline(chatBlocks("> quoted\n---"))).toEqual([{ paragraph: ["> quoted", "---"] }]);
  });

  it("reads emphasis at the start of a line as emphasis, not as a bullet", () => {
    expect(outline(chatBlocks("*Note* this\n**Bold** too"))).toEqual([
      { paragraph: ["<emphasis>Note this", "<strong>Bold too"] },
    ]);
  });
});
