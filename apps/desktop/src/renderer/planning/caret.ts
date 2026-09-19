/**
 * Where a caret sits inside a textarea, in the textarea's own box.
 *
 * A textarea reports no geometry for a position inside it, so the text up to
 * that position is laid out a second time in a hidden element copying the
 * textarea's box and font, and the span that follows it is measured. Every
 * property that changes where a line breaks has to be copied or the second
 * layout wraps somewhere the first one did not, and the answer is a line out.
 *
 * The answer is relative to the textarea's padding box and does not account for
 * scrolling, because the field the Spec pane measures grows to its content and
 * never scrolls.
 */
const COPIED = [
  "boxSizing",
  "width",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textTransform",
  "textIndent",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "overflowWrap",
  "wordBreak",
  "whiteSpace",
  "tabSize",
] as const satisfies readonly (keyof CSSStyleDeclaration)[];

export interface CaretPoint {
  x: number;
  y: number;
  /** One line's height, so a popup can sit under the line rather than over it. */
  line: number;
}

export function caretPoint(field: HTMLTextAreaElement, position: number): CaretPoint {
  const style = getComputedStyle(field);
  const mirror = document.createElement("div");
  for (const property of COPIED) mirror.style[property] = style[property] as string;
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    top: "0",
    left: "-9999px",
  });
  mirror.textContent = field.value.slice(0, position);
  const after = document.createElement("span");
  // Something has to be in the span or it has no box; what follows the caret
  // is the honest filler, and a full stop stands in at the end of the text.
  after.textContent = field.value.slice(position) || ".";
  mirror.appendChild(after);
  document.body.appendChild(mirror);
  const point = {
    x: after.offsetLeft,
    y: after.offsetTop,
    // The span holds everything after the caret, so its own height is the rest
    // of the text and not one line: the line comes from the style, and from the
    // font where `line-height` is `normal` and reports no length.
    line: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 0,
  };
  document.body.removeChild(mirror);
  return point;
}
