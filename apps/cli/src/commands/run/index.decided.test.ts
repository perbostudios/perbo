import { describe, expect, it } from "vitest";
import { transition, type Ticket } from "@perbo/contracts";
import type { TicketRunResult } from "@perbo/runner";
import { UnreachableStateError, applyObservedPath } from "../admit.js";
import { makeTicket } from "../../test-support/records.js";
import { observedPath, reopen } from "./index.js";

/**
 * D-132: a run that delivers on a
 * person's decisions executes and reviews nothing, so the ticket moves from
 * `provisioning` straight to `pr_open` — on that run's own row, and on no
 * other evidence.
 */

const AT = new Date("2026-09-24T12:00:00.000Z");

/** PRB-13 after its review stopped for a person, and the next run started. */
function provisioning(): Ticket {
  const stopped = makeTicket({
    key: "PRB-13",
    ticket_id: "ticket_prb13000001",
    repository_root: "/nowhere/repo",
    state: "changes_requested",
  });
  return transition(reopen(stopped, "new attempt after changes_requested"), "provisioning", "run started", AT);
}

const result = (over: Partial<TicketRunResult>): TicketRunResult =>
  ({
    rounds: [],
    outcome: "approved",
    detail: "",
    decided: [],
    ...over,
  }) as TicketRunResult;

describe("a delivery a person's decisions took", () => {
  it("moves the ticket from provisioning to pr_open, saying which decisions it rests on", () => {
    const moved = applyObservedPath(
      provisioning(),
      observedPath(
        result({
          decided: [
            {
              finding_key: "1".repeat(64),
              choice: "ship_as_is",
              review_id: null,
              note: "package-lock.json is authoritative",
              author: "Owen <owen@example.com>",
              decided_at: AT.toISOString(),
            },
          ],
        }),
      ),
      AT,
    );
    expect(moved.state).toBe("pr_open");
    const last = moved.history[moved.history.length - 1]!;
    expect(last.from).toBe("provisioning");
    expect(last.note).toContain("every finding the review routed to a person is decided");
    expect(last.note).toContain("111111111111");
  });

  it("is the only thing that takes that row: an approval with no round and no decision is refused", () => {
    expect(() => applyObservedPath(provisioning(), observedPath(result({})), AT)).toThrow(
      UnreachableStateError,
    );
    expect(() => transition(provisioning(), "pr_open", "a pull request is open", AT)).toThrow(
      /cannot move to pr_open/,
    );
  });
});
