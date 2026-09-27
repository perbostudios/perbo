/**
 * An agent's own words as a run prints them while it works: one progress line
 * for each turn it speaks, marked with whose words they are, so the desktop's
 * Watch page shows them as they arrive (docs/15).
 *
 * A line carries the whole turn, as the attempt's records keep it. Its line
 * breaks and every other control character are escaped, so the turn is one
 * physical line: no part of it can pass for a progress line of the runner's
 * own, a relay that reads the output line by line carries it whole, and
 * nothing that reads one back takes it as an instruction, a stage or an action
 * parameter (ADR-0023). {@link readSpoken} restores the words exactly.
 */
export const SPEAKERS = ["executor", "reviewer"] as const;
export type Speaker = (typeof SPEAKERS)[number];

const MARK = " says: ";

/**
 * `text` as one line: every run of whitespace and control characters folded
 * to one space, and trimmed, so nothing in it can start a line of its own.
 */
export function oneLine(text: string): string {
  return text.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

const ESCAPES: Record<string, string> = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const UNESCAPES: Record<string, string> = { "\\": "\\", n: "\n", r: "\r", t: "\t" };

/** `text` with its backslashes, control characters and line and paragraph separators escaped: one physical line. */
function escaped(text: string): string {
  return text.replace(
    /[\\\p{Cc}\u2028\u2029]/gu,
    (character) => ESCAPES[character] ?? "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** What {@link escaped} escaped, restored. */
function unescaped(text: string): string {
  return text.replace(/\\(?:([\\nrt])|u([0-9a-f]{4}))/g, (_, named: string | undefined, code: string | undefined) =>
    named !== undefined ? UNESCAPES[named]! : String.fromCharCode(Number.parseInt(code!, 16)),
  );
}

/**
 * The progress line that carries `words`, already redacted by the caller as
 * the attempt's records are: the whole turn, trimmed, on one physical line.
 * Null where nothing is left to say.
 */
export function spokenLine(speaker: Speaker, words: string): string | null {
  const said = words.trim();
  if (said === "") return null;
  return speaker + MARK + escaped(said);
}

/** Whose words a progress line carries, and the words as they were said; null for a line that is not an agent's words. */
export function readSpoken(line: string): { speaker: Speaker; words: string } | null {
  for (const speaker of SPEAKERS) {
    const mark = speaker + MARK;
    if (line.startsWith(mark)) return { speaker, words: unescaped(line.slice(mark.length)) };
  }
  return null;
}
