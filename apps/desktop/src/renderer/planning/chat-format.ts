import { inlineRuns, type InlineRun } from "./spec-format.js";

/**
 * A chat message read as the small Markdown the sessions write in: bold,
 * italic and code inside a line ({@link inlineRuns}, the spec's own reader of
 * them), and paragraphs, line breaks, lists and fenced code between lines.
 *
 * Nothing else is read. A `#` line is a heading at the chat's own size, drawn
 * bold, because the dock is a column of short turns and not a document; a link,
 * an image, a quote, a rule or a tag is the characters it was written in. Every piece
 * is text for the renderer to put in a text node, so what a model writes can
 * mark words and never markup.
 */

/** One line of a message, as the stretches its marks cut it into. */
export type ChatLine = InlineRun[];

/** One list item: its lines, and the lists indented under it. */
export interface ChatItem {
  lines: ChatLine[];
  lists: ChatList[];
}

export interface ChatList {
  kind: "list";
  ordered: boolean;
  /** The number the first item was written with, which the list counts on from. */
  start: number;
  items: ChatItem[];
}

export type ChatBlock =
  | { kind: "heading"; runs: ChatLine }
  /** Fenced code: its lines as written, nothing inside read as a mark. */
  | { kind: "code"; text: string }
  | { kind: "paragraph"; lines: ChatLine[] }
  | ChatList;

const HEADING = /^#{1,6}\s+(.*)$/;
/** A fence's opening line: three backticks or more, and a language word or nothing. */
const FENCE = /^(`{3,})[^`]*$/;
/** A list line: a bullet in any of Markdown's three characters, or a number and a dot or bracket. */
const ITEM = /^(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/**
 * A message's text as the blocks it is written in.
 *
 * A fence is read first and holds every line up to the one that closes it, so
 * nothing inside it is a list or a mark; it ends the paragraph or the list it
 * follows, and a list after it counts on from its own first number.
 *
 * A blank line ends a paragraph but not a list, since a model often spaces its
 * items apart and they are still one list; a line at the margin after a blank
 * ends it. A list line indented past the list it follows starts a list under
 * that list's last item, and an ordinary line inside a list continues its last
 * item.
 */
export function chatBlocks(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let paragraph: ChatLine[] | null = null;
  /** The lists still open, outermost first, each with the indent of its items. */
  let open: { indent: number; list: ChatList }[] = [];
  let afterBlank = false;

  const lastItem = (): ChatItem => {
    const items = open[open.length - 1]!.list.items;
    return items[items.length - 1]!;
  };

  /** The fence open, with the backticks that close it and the indent its lines are written at. */
  let fence: { close: string; indent: number; lines: string[] } | null = null;

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const body = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (fence !== null) {
      if (body.startsWith(fence.close) && /^`+$/.test(body)) {
        blocks.push({ kind: "code", text: fence.lines.join("\n") });
        fence = null;
      } else fence.lines.push(raw.slice(Math.min(indent, fence.indent)));
      continue;
    }
    const opening = FENCE.exec(body);
    if (opening !== null) {
      paragraph = null;
      open = [];
      fence = { close: opening[1]!, indent, lines: [] };
      afterBlank = false;
      continue;
    }
    if (body.length === 0) {
      paragraph = null;
      afterBlank = true;
      continue;
    }
    const heading = HEADING.exec(body);
    if (heading !== null) {
      paragraph = null;
      open = [];
      blocks.push({ kind: "heading", runs: inlineRuns(heading[1]!) });
      afterBlank = false;
      continue;
    }
    const item = ITEM.exec(body);
    if (item !== null) {
      paragraph = null;
      const ordered = item[2] !== undefined;
      while (open.length > 0 && open[open.length - 1]!.indent > indent) open.pop();
      const top = open[open.length - 1];
      if (top !== undefined && top.indent === indent && top.list.ordered !== ordered) open.pop();
      const entry: ChatItem = { lines: [inlineRuns(item[3]!)], lists: [] };
      const same = open[open.length - 1];
      if (same !== undefined && same.indent === indent) same.list.items.push(entry);
      else {
        const list: ChatList = { kind: "list", ordered, start: ordered ? Number(item[2]) : 1, items: [entry] };
        if (open.length > 0) lastItem().lists.push(list);
        else blocks.push(list);
        open.push({ indent, list });
      }
      afterBlank = false;
      continue;
    }
    if (open.length > 0 && (!afterBlank || indent > 0)) {
      lastItem().lines.push(inlineRuns(body));
      afterBlank = false;
      continue;
    }
    open = [];
    if (paragraph === null) {
      paragraph = [];
      blocks.push({ kind: "paragraph", lines: paragraph });
    }
    paragraph.push(inlineRuns(body));
    afterBlank = false;
  }
  // A fence the message never closed runs to its end, as it does in Markdown.
  if (fence !== null) blocks.push({ kind: "code", text: fence.lines.join("\n") });
  return blocks;
}
