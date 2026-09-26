import { EVERY_PROBLEM_RESOLVED, type InterviewEntry, type Job } from "../../shared/protocol.js";

/** What {@link owedReading} finds of the person's last turn. */
export interface OwedReading {
  /** The line number of the person's last turn, or null where there is none. */
  turn: number | null;
  /** When that turn was applied, in epoch milliseconds, or null where there is no turn. */
  appliedAt: number | null;
  owed: boolean;
}

/**
 * Whether the person's last turn is still owed a reading of the plan against
 * the spec (D-128), the rule the Problems page's wait on an answer holds to.
 *
 * A turn that ends with problems on the record is owed a reading, which the
 * host starts once the turn has ended and it has read the ticket, so for that
 * round trip the job is not yet in the list. A reading an earlier turn asked
 * for can also start after the turn is sent and before it is applied, and it
 * never sees the turn. So the turn is taken as applied at the last line it led
 * to — the turn itself, or the interview's last line after it — and is owed
 * until the newest reading started at or after that line, which only the
 * reading the turn owes can have done. The lines a reading puts as it lands,
 * a problem's card and the note saying every problem is resolved, are the
 * reading's and not the turn's, and do not move the bound.
 *
 * Owed only while the session records a problem open, since the host reads
 * again after a turn only while one is (D-128), and only while the interview
 * runs.
 */
export function owedReading(
  conversation: readonly InterviewEntry[],
  session: { drift: { open: readonly unknown[] } | null; running: boolean },
  newest: Pick<Job, "startedAt"> | null,
): OwedReading {
  const last = conversation.findLastIndex((entry) => entry.line.kind === "turn");
  if (last < 0) return { turn: null, appliedAt: null, owed: false };
  const appliedAt = Date.parse(
    conversation.slice(last).findLast((entry) => !putByReading(entry.line))!.at,
  );
  const owed =
    session.drift !== null &&
    session.drift.open.length > 0 &&
    session.running &&
    !(newest !== null && Date.parse(newest.startedAt) >= appliedAt);
  return { turn: conversation[last]!.n, appliedAt, owed };
}

/**
 * Whether a line is one a reading puts as it lands, rather than one the
 * interview put for a turn: a problem's card, or the note saying every
 * problem is resolved (`ContractEditing.landDrift` in the shared contract
 * editing).
 */
function putByReading(line: InterviewEntry["line"]): boolean {
  return (line.kind === "asked" && line.drift !== undefined) || (line.kind === "note" && line.text === EVERY_PROBLEM_RESOLVED);
}
