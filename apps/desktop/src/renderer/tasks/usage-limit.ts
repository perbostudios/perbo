import { connectionName, type UsageLimitStop } from "@perbo/contracts/browser";

/**
 * How the desktop says a provider's usage limit that ended a run
 * (D-NEW-pass-a-limited-loop-on): whose connection it was, and the reset the
 * provider stated, in the zone it stated it in.
 */

/** The reset the provider stated, as a person reads it: in its own zone, the zone named after it. */
export function resetLabel(limit: Pick<UsageLimitStop, "until" | "zone">): string {
  try {
    const at = new Date(limit.until).toLocaleString("en-GB", {
      timeZone: limit.zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${at} (${limit.zone})`;
  } catch {
    // A zone this runtime does not know: the instant itself, which is exact.
    return `${limit.until} (${limit.zone})`;
  }
}

/** The role a limit stopped, as a sentence names it. */
const roleName = (limit: UsageLimitStop): string => (limit.role === "executor" ? "executor" : "reviewer");

/**
 * The one sentence the stopped page and the loop's ended card say of the
 * limit, and the fuller account behind it, every word from the records: the
 * connection, the role, the reset and the provider's own sentence.
 */
export function limitEnding(limit: UsageLimitStop): { sentence: string; detail: string } {
  const connection = connectionName(limit.provider);
  const sentence = limit.waited
    ? `${connection}, the ${roleName(limit)}'s connection, refused the review again after its usage limit reset ${resetLabel(limit)}.`
    : `${connection}, the ${roleName(limit)}'s connection, reached its usage limit, which the provider says resets ${resetLabel(limit)}.`;
  const work =
    limit.role === "executor"
      ? "The work the attempt had done is kept."
      : "The attempt finished its work, which is kept; no review judged it.";
  return {
    sentence,
    detail:
      `The provider answered: “${limit.quoted}” ${work} The run stopped rather than spend another ` +
      `${limit.role === "executor" ? "attempt" : "review"} against a limit still in force. A usage limit covers ` +
      `every model a connection runs, so the work carries on now on another connection, or on ${connection} ` +
      "once the limit has reset.",
  };
}
