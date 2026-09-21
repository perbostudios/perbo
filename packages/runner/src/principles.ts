import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRINCIPLES_FILENAME, STORE_DIRNAME } from "@perbo/contracts";

/**
 * The product-principles ratchet (D-065 option 3).
 *
 * Every time a person answers a question no practice could — for this
 * repository, something like "does `perbo list` show finished tickets by
 * default?" — the answer is recorded here and consulted by every later brief,
 * so the same question is never asked twice and the category of things that
 * must stop for a person shrinks by accumulation. Each repository the runner
 * works on has its own file, because product answers belong to products.
 *
 * The file lives in the ticket store (`.perbo/principles.md`) and is written
 * only by a person, through `perbo principle add`: the runner's prohibited
 * paths already refuse the agent every write under `.perbo/**`, so the
 * executor consults principles it can never author. It reaches the brief as
 * data, with a standing instruction that principles resolve what unspecified
 * behaviour should do and never widen scope, weaken security, or excuse a
 * failing check.
 *
 * `@perbo/contracts` declares the file's name, and `perbo principle add`
 * reaches it through this package's entry.
 */
export { PRINCIPLES_FILENAME };

/**
 * The most principle text a brief will carry. Every byte here is repeated in
 * every round of every attempt, so an unbounded file is an unbounded cost —
 * and, for a maliciously committed one, an unbounded injection surface.
 */
export const PRINCIPLES_MAX_BYTES = 16_384;

export function readPrinciplesFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return null;
  if (Buffer.byteLength(text, "utf8") <= PRINCIPLES_MAX_BYTES) return text;
  // Cut on bytes, then drop the replacement character a cut inside a
  // multi-byte sequence leaves behind, so the brief never carries a torn glyph.
  const cut = new TextDecoder("utf-8")
    .decode(Buffer.from(text, "utf8").subarray(0, PRINCIPLES_MAX_BYTES))
    .replace(/�$/, "");
  return `${cut}\n\n(truncated: the principles file exceeds ${PRINCIPLES_MAX_BYTES} bytes; trim it)`;
}

export function readPrinciples(repositoryRoot: string, storeDirname = STORE_DIRNAME): string | null {
  return readPrinciplesFile(join(repositoryRoot, storeDirname, PRINCIPLES_FILENAME));
}
