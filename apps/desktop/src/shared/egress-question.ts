import { readEgressQuestion, readEgressSettled, type EgressQuestion } from "@perbo/contracts/browser";

/** The question a run is waiting on, as its output printed it: the key, the host and the whole command. */
export type AskedEgress = Pick<EgressQuestion, "key" | "host" | "command">;

/**
 * The question a run's output shows it waiting on, or null where it waits on
 * none (D-137): the last question it printed that no
 * later line settled. Read from the runner's own two lines and nothing else;
 * the command is shown as data and never becomes an action parameter, and the
 * press sends the key back and nothing more (ADR-0023).
 */
export function pendingEgressQuestion(log: string): AskedEgress | null {
  let pending: AskedEgress | null = null;
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    const asked = readEgressQuestion(line);
    if (asked !== null) {
      pending = asked;
      continue;
    }
    const settled = readEgressSettled(line);
    if (settled !== null && pending?.key === settled.key) pending = null;
  }
  return pending;
}
