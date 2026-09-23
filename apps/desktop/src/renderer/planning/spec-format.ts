import { markSpecSymbols } from "@perbo/planning/browser";

/**
 * A spec section read as the shapes it was written in, for the view a person
 * reads rather than the one they type in.
 *
 * The file is Markdown and stays Markdown: this turns the marks a person typed
 * into what they meant — a heading, a list, a requirement's id — and nothing
 * else. It invents no emphasis. A highlight here is one the text asked for, so
 * what stands out on the page is what the writer made stand out, and a reader
 * who takes the colour as meaning is right to.
 *
 * Every run carries `at`, its offset in the section's own text, because a click
 * on the reading view opens the editor at the word that was clicked
 * ({@link ./SpecSection.tsx}). Nothing here rewrites text to make that true:
 * every `text` is a slice of the input, so `at` is simply where it was cut
 * from, and an offset cannot drift from the thing it points at.
 */

/** One stretch of a line, and what the writer marked it as. */
export interface SpecRun {
  /** Whether this is an `@Symbol` reference or ordinary words. */
  kind: "text" | "symbol";
  /** The mark the writer put around it, where there is one. */
  mark: "code" | "strong" | "emphasis" | null;
  /** What is shown, with the marking characters taken off. */
  text: string;
  /** Where `text` begins in the section's own text. */
  at: number;
}

/** One line of a list, with the requirement id it carries where it has one. */
export interface SpecItem {
  /** `R1` and so on, where the line begins with one; null everywhere else. */
  id: string | null;
  runs: SpecRun[];
  /** Where the line's own words begin, for a click that lands beside them. */
  at: number;
}

export type SpecBlock =
  | { kind: "heading"; level: number; runs: SpecRun[]; at: number }
  | { kind: "list"; items: SpecItem[]; at: number }
  | { kind: "paragraph"; runs: SpecRun[]; at: number };

/**
 * A heading inside a section, from three hashes down.
 *
 * Not one or two, because those are the spec file's own delimiters: a line at
 * either depth is written back as a requirement rather than a heading
 * (`@perbo/planning`'s `SECTION_HEADING`), and a view that drew it as a heading
 * would promise an arrangement the next save does not keep.
 */
const HEADING = /^(#{3,6})\s+(.*)$/;
/**
 * A bullet, in the two characters the spec's own reader accepts.
 *
 * `@perbo/planning` matches `/^[-*]\s+/` and nothing else, so a line led by
 * `+`, a bullet character or a number is not a list item to the file: it is
 * text, and is saved with that character inside it. Drawing it as a bullet here
 * would hide a character the person is about to find in their spec.
 */
const BULLET = /^[-*]\s+(.*)$/;
/** The id the spec gives a requirement when it is saved (D-103). */
const REQUIREMENT = /^(R[1-9]\d*):\s*(.*)$/;
/**
 * Inline marks, in the order they bind: a code span is literal, so it is taken
 * first and nothing inside it is read as a mark; `**` before `*`, so the longer
 * mark is never read as two of the shorter one.
 */
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;

/** How deep a heading inside a section may look, whatever depth it claims. */
const TOP = 2;
const BOTTOM = 4;

/**
 * A line's marks, and the `@Symbol` references inside each of them.
 *
 * The marks are found first and the references inside each stretch second, so a
 * reference keeps its own mark wherever it sits — inside backticks, inside
 * bold, or on its own — and a mark whose span crosses a reference is still a
 * mark. Doing it the other way round cuts `**a @B c**` into three pieces, none
 * of which holds a whole `**\u2026**`, and the person is left reading their own
 * asterisks.
 *
 * References come from the same function the editor's backdrop uses, so the two
 * views never disagree about what a reference is.
 */
function runsOf(text: string, from: number): SpecRun[] {
  const runs: SpecRun[] = [];
  /** One stretch under one mark, split again into its references and its prose. */
  const under = (body: string, at: number, mark: SpecRun["mark"]): void => {
    let cursor = at;
    for (const run of markSpecSymbols(body)) {
      if (run.text.length > 0) {
        runs.push({
          kind: run.name === null ? "text" : "symbol",
          mark,
          text: run.text,
          at: cursor,
        });
      }
      cursor += run.text.length;
    }
  };
  INLINE.lastIndex = 0;
  let plain = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    if (match.index > plain) under(text.slice(plain, match.index), from + plain, null);
    const [inner, mark] =
      match[1] !== undefined
        ? ([match[1], "code"] as const)
        : match[2] !== undefined
          ? ([match[2], "strong"] as const)
          : ([match[3]!, "emphasis"] as const);
    // Past the opening mark, so the offset is the first character shown.
    under(inner, from + match.index + match[0].indexOf(inner), mark);
    plain = match.index + match[0].length;
  }
  if (plain < text.length) under(text.slice(plain), from + plain, null);
  return runs;
}

/**
 * One list line, with whatever leads it taken off and remembered.
 *
 * Each capture is a suffix of what it was cut from, so the difference in length
 * is how far along the line its text starts — no counting of the marks
 * themselves, which is how a line that spaced them differently still lands on
 * the right character.
 */
function itemOf(body: string, from: number): SpecItem {
  const requirement = REQUIREMENT.exec(body);
  const shown = requirement === null ? body : requirement[2]!;
  const at = from + (body.length - shown.length);
  return { id: requirement?.[1] ?? null, runs: runsOf(shown, at), at };
}

/**
 * A section's text as the blocks it is written in.
 *
 * Consecutive list lines are one list, so the bullets line up under each other
 * and a blank line between two of them is what starts a second. A run of
 * ordinary lines is one paragraph, kept as the one slice of the source it came
 * from: its own line breaks and all, because they were typed into a box that
 * wraps by itself, so a break in one is a break the person put there.
 */
export function specBlocks(text: string): SpecBlock[] {
  const blocks: SpecBlock[] = [];
  let items: SpecItem[] | null = null;
  let itemsAt = 0;
  /** The open paragraph as a stretch of the source: where it starts and ends. */
  let paragraph: { from: number; to: number } | null = null;
  let at = 0;

  const endList = (): void => {
    if (items !== null && items.length > 0) blocks.push({ kind: "list", items, at: itemsAt });
    items = null;
  };
  const endParagraph = (): void => {
    if (paragraph !== null) {
      const body = text.slice(paragraph.from, paragraph.to);
      blocks.push({ kind: "paragraph", runs: runsOf(body, paragraph.from), at: paragraph.from });
    }
    paragraph = null;
  };

  for (const line of text.split("\n")) {
    const start = at;
    at += line.length + 1;
    const trimmed = line.trim();
    // Where the line's own words begin, so a click on an indented line lands on
    // a word rather than in the space before it.
    const from = start + (line.length - line.trimStart().length);
    if (trimmed.length === 0) {
      endList();
      endParagraph();
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading !== null) {
      endList();
      endParagraph();
      const body = heading[2]!;
      blocks.push({
        kind: "heading",
        level: Math.min(BOTTOM, Math.max(TOP, heading[1]!.length - 1)),
        runs: runsOf(body, from + (trimmed.length - body.length)),
        at: from,
      });
      continue;
    }
    const bullet = BULLET.exec(trimmed);
    if (bullet !== null) {
      endParagraph();
      const body = bullet[1]!;
      if (items === null) {
        items = [];
        itemsAt = from;
      }
      items.push(itemOf(body, from + (trimmed.length - body.length)));
      continue;
    }
    endList();
    if (paragraph === null) paragraph = { from, to: from };
    paragraph.to = from + trimmed.length;
  }
  endList();
  endParagraph();
  return blocks;
}
