import { EXECUTOR_ACCOUNT_MAX_CHARS } from "@perbo/contracts";

/**
 * The executor's own account of its change (D-092).
 *
 * Every attempt is asked to end its final message with the files it touched
 * and why, the tests it wrote and what it verified, under the heading below.
 * The next remediation round of the same ticket is briefed with it instead of
 * re-reading the repository to close findings that already name a file and a
 * line — a round cost $7 to $15 and 150 to 220 iterations without it, nearly
 * the initial build.
 *
 * Nothing here invents an account. A final message the heading is absent from
 * is taken whole, because it is still the executor's own words; a message that
 * is empty, or that says nothing after the heading, is null.
 */

const ACCOUNT_TITLE = "Account of this change";

export const EXECUTOR_ACCOUNT_HEADING = `## ${ACCOUNT_TITLE}`;

/**
 * The heading as written back, at any level: the brief asks for `##` and a
 * model that writes `#` or `###` has still answered it. Built from the same
 * title the brief interpolates, so the two cannot drift apart.
 */
const HEADING_LINE = new RegExp(`^[ \\t]*#{1,6}[ \\t]*${ACCOUNT_TITLE}[ \\t]*$`, "gim");

/**
 * Appended where the account is longer than the record's cap, so a reader —
 * and the round that is briefed with it — can tell a short account from a
 * truncated one.
 */
const TRUNCATED = "\n… (account truncated)";

export function executorAccount(final: string | null | undefined): string | null {
  if (typeof final !== "string") return null;
  // The last heading, not the first: an account that quotes the brief's own
  // instruction is followed by the account it introduces.
  let after = -1;
  for (const match of final.matchAll(HEADING_LINE)) after = match.index + match[0].length;
  const text = (after >= 0 ? final.slice(after) : final).trim();
  if (text.length === 0) return null;
  if (text.length <= EXECUTOR_ACCOUNT_MAX_CHARS) return text;
  return text.slice(0, EXECUTOR_ACCOUNT_MAX_CHARS - TRUNCATED.length) + TRUNCATED;
}
