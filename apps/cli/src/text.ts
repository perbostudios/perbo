/** Fixed-column text and colour, shared by every rendering this binary prints. */

export const WIDTH = 80;

const ANSI = {
  reset: "[0m",
  dim: "[38;5;242m",
  mid: "[38;5;247m",
  hi: "[97m",
  ok: "[38;5;71m",
  bad: "[38;5;167m",
  warn: "[38;5;179m",
  sect: "[38;5;245m",
} as const;

export type Style = keyof typeof ANSI;
export type Paint = (text: string, style: Style) => string;

const painted: Paint = (text, style) => `${ANSI[style]}${text}${ANSI.reset}`;
const plain: Paint = (text) => text;

/** The painter every rendering in this binary shares, so `inspect` reads like `review`. */
export const painter = (color: boolean): Paint => (color ? painted : plain);

/** Right-align `right` against the width, keeping at least two spaces between. */
export function spread(left: string, right: string, paint: Paint, style: Style): string {
  if (right === "") return left;
  const gap = Math.max(2, WIDTH - left.length - right.length);
  return left + " ".repeat(gap) + paint(right, style);
}

export function wrap(text: string, indent: number): string[] {
  const room = WIDTH - indent;
  const pad = " ".repeat(indent);
  const out: string[] = [];
  let line = "";
  // A token longer than the room is broken, so a path or a reference no
  // space ever splits still fits the column instead of running past it.
  const step = Math.max(1, room);
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      // By code point, so a character outside the basic plane is not cut in half.
      const chars = Array.from(word);
      const pieces: string[] = [];
      for (let at = 0; at < chars.length; at += step) pieces.push(chars.slice(at, at + step).join(""));
      return pieces;
    });
  for (const word of words) {
    if (line === "") {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= room) {
      line += ` ${word}`;
      continue;
    }
    out.push(pad + line);
    line = word;
  }
  if (line !== "") out.push(pad + line);
  return out;
}

export const pad = (text: string, width: number) =>
  text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);

/**
 * An identifier held to a fixed column: a rule id or a denial rule, which no
 * person reads as prose. Text a person reads is never clipped; it goes through
 * {@link fitted} or {@link labelled} instead (D-NEW-nothing-shown-is-cut).
 */
export const clip = (text: string, width: number) =>
  text.length <= Math.max(0, width) ? text : `${text.slice(0, Math.max(1, width - 1))}…`;

/**
 * A line as it is where it fits the width, and otherwise the same words
 * wrapped under `indent`: whole either way (D-NEW-nothing-shown-is-cut).
 */
export const fitted = (line: string, indent: number): string[] =>
  line.length <= WIDTH ? [line] : wrap(line, indent);

/**
 * A value after its label, on the label's line where the two fit the width,
 * and otherwise under it, wrapped: never cut (D-NEW-nothing-shown-is-cut).
 */
export function labelled(label: string, value: string, paint: Paint, style: Style, indent = 6): string[] {
  return label.length + value.length <= WIDTH
    ? [label + paint(value, style)]
    : [label.trimEnd(), ...wrap(value, indent).map((line) => paint(line, style))];
}
