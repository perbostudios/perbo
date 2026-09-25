/**
 * An agent's own words as a run prints them while it works: one progress line
 * for each turn it speaks, marked with whose words they are, so the desktop's
 * Watch page shows them as they arrive (docs/15).
 *
 * A line is words to show and nothing else. It is flattened to one line, so no
 * part of it can pass for a progress line of the runner's own, and nothing that
 * reads one back takes it as an instruction, a stage or an action parameter
 * (ADR-0023). It is bounded, and the attempt's own records keep the whole turn.
 */
export const SPEAKERS = ["executor", "reviewer"] as const;
export type Speaker = (typeof SPEAKERS)[number];

/** The most characters of one turn's words a line carries. */
export const SPOKEN_LINE_CAP = 600;

const MARK = " says: ";

/**
 * `text` as one line: every run of whitespace and control characters folded
 * to one space, and trimmed, so nothing in it can start a line of its own.
 */
export function oneLine(text: string): string {
  return text.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

/**
 * The progress line that carries `words`, already redacted by the caller as
 * the attempt's records are: folded to {@link oneLine one line}, cut at the
 * cap. Null where nothing is left to say.
 */
export function spokenLine(speaker: Speaker, words: string): string | null {
  const flat = oneLine(words);
  if (flat === "") return null;
  const characters = [...flat];
  const said =
    characters.length > SPOKEN_LINE_CAP
      ? characters.slice(0, SPOKEN_LINE_CAP - 1).join("").trimEnd() + "…"
      : flat;
  return speaker + MARK + said;
}

/** Whose words a progress line carries, and the words; null for a line that is not an agent's words. */
export function readSpoken(line: string): { speaker: Speaker; words: string } | null {
  for (const speaker of SPEAKERS) {
    const mark = speaker + MARK;
    if (line.startsWith(mark)) return { speaker, words: line.slice(mark.length) };
  }
  return null;
}
