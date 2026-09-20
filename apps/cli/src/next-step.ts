/**
 * What a command tells a terminal to do next, and how to find it again.
 *
 * Every command closes by naming the one after it, indented under a line that
 * introduces it. That is right where it is read — at a terminal, by whoever
 * typed the command. It is wrong in the app, where approving, editing and
 * running are buttons and nothing is typed at all.
 *
 * `perbo interview` relays these reports to a session whose client may be
 * either, and a tool's result reaches the person nearly word for word, so the
 * interview has to be able to take this block back out. It can only do that
 * exactly while the introducing lines live in one place, which is why they are
 * here rather than written out at each command.
 *
 * Finding the block by shape instead — an indented line beginning `perbo` —
 * looks equivalent and is not. A report carries text the person and the model
 * wrote: `perbo admit` prints the spec's No-Gos at an indent, so a No-Go
 * reading "perbo run must not be called from the worker" would be taken for an
 * instruction, and everything after it cut away. Among the things after it is
 * the count of instructions the source text aimed at the drafter — so the one
 * document a report exists to warn about could suppress the warning.
 */

/** The lines that introduce a block of commands, in the words each command uses. */
export const NEXT_STEPS = [
  "Read it once more, then approve it:",
  "Read the contract, then approve it:",
  "The model drafted this; nothing runs until you approve it. Edit anything, then approve:",
  "Approved. The contract is immutable from here.",
] as const;

const introduces = (line: string): boolean =>
  (NEXT_STEPS as readonly string[]).includes(line.trim());

/**
 * A report with the blocks telling a terminal what to type taken out of it.
 *
 * Only a block: the introducing line and the commands indented under it, which
 * ends at the first line that is neither. Everything around it is kept, wherever
 * it sits — the node pages a first draft writes are printed after the block,
 * not before it, and they are the only report of where D-103's pages landed.
 */
export function withoutNextStep(text: string): string {
  // Applied to a refusal as well as to a report that worked, though no refusal
  // the commands can currently produce carries one of these blocks: a refusal
  // throws, and what the interview relays is the error's own sentence. It is
  // put on both paths because the two are one seam — a command's text reaching
  // a session whose client may be the app — and a refusal that later closes
  // with a next step would otherwise arrive as an instruction to leave it.
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    if (!introduces(lines[at]!)) {
      kept.push(lines[at]!);
      continue;
    }
    while (at + 1 < lines.length && /^\s+perbo\s/.test(lines[at + 1]!)) at += 1;
  }
  return kept.join("\n").trimEnd();
}
