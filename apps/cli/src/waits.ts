import type { Scheduling, Wait } from "@perbo/contracts";

/**
 * The one line that says why a ticket waits, in the words `perbo list`, the
 * queue's own output and the desktop all print: what it waits on, and the fact
 * that decided it — a dependency's state, or the paths the ticket ahead holds.
 */
export function describeWaits(waits: readonly Wait[]): string {
  if (waits.length === 0) return "waits on nothing";
  return `waits on ${waits.map(describeWait).join("; ")}`;
}

/**
 * The queue's whole reading of a ticket, for `list`: why it waits, and — for
 * an open pull request — a re-level that did not level it and is not tried
 * again until the base moves.
 */
export function describeScheduling(scheduling: Scheduling, state: string): string | null {
  const parts: string[] = [];
  if (state === "blocked") parts.push(describeWaits(scheduling.waits_on));
  if (scheduling.reconciliation !== null) {
    const why = scheduling.reconciliation.reason === null ? "" : `: ${scheduling.reconciliation.reason}`;
    parts.push(
      `re-level did not level the branch at ${scheduling.reconciliation.base_tip.slice(0, 12)} ` +
        `(exit ${scheduling.reconciliation.exit_code}${why}); tried again once the base moves`,
    );
  }
  return parts.length === 0 ? null : parts.join("; ");
}

function describeWait(wait: Wait): string {
  if (wait.reason === "depends_on") {
    return `${wait.key} (depends_on: ${wait.state ?? "not in this store"})`;
  }
  return `${wait.key} (scope overlap: ${wait.paths.join(", ")})`;
}
