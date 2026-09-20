import { existsSync, lstatSync, rmSync } from "node:fs";
import type { Ticket } from "@perbo/contracts";
import { heldRepository } from "../../shared/jobs.js";
import { listBundles, readAttempts } from "../records.js";
import { bundlesPath, attemptsPath, ticketPath } from "../repository/layout.js";
import { discardEditingFor, forgetTicket } from "../profile/preferences.js";
import type { ProfileState, RegisteredRepository } from "../profile/store.js";
import type { Job } from "../../shared/protocol.js";

export interface DiscardDeps {
  tickets: { list(repo: RegisteredRepository): Promise<{ tickets: Ticket[] }> };
  profile: { state: ProfileState };
  liveJobs(): Job[];
}

/** The states a contract can still be deleted from: it has never run. */
const NEVER_RUN = ["draft", "specifying", "plan_review", "ready", "plan_invalid"];

/**
 * Delete a contract that has never run, with the records it owns.
 *
 * Evidence is never deleted: an attempt, a bundle or a pull request on record
 * keeps the ticket, whatever state it is in. The three files removed are the
 * ticket's own, and a path that is a link is left alone rather than followed.
 */
export async function discardTicket(
  deps: DiscardDeps,
  repo: RegisteredRepository,
  key: string,
): Promise<void> {
  if (heldRepository(deps.liveJobs(), repo.id))
    throw new Error(
      "Wait for the commands running in this repository to finish before deleting a contract.",
    );
  const ticket = (await deps.tickets.list(repo)).tickets.find((entry) => entry.key === key);
  if (!ticket) throw new Error("This task is no longer in the repository's ticket store.");
  if (!NEVER_RUN.includes(ticket.state))
    throw new Error(
      "Only a contract that has never run can be deleted. This one has moved past the contract stage.",
    );
  const attempts = readAttempts(attemptsPath(repo, ticket.ticket_id));
  const bundles = listBundles(bundlesPath(repo));
  if (
    attempts.attempts.length ||
    attempts.error ||
    bundles.some((bundle) => bundle.ticket_id === ticket.ticket_id)
  )
    throw new Error(
      "This contract has recorded attempts or evidence, so it stays. Only a never-run contract can be deleted.",
    );
  if (ticket.delivery.pull_request_url)
    throw new Error("This contract has a pull request on record, so it stays.");
  for (const suffix of [".json", ".contract.json", ".draft.json"] as const) {
    const path = ticketPath(repo, key, suffix);
    if (existsSync(path) && !lstatSync(path).isSymbolicLink()) rmSync(path);
  }
  forgetTicket(deps.profile.state, repo.id, key);
  discardEditingFor(deps.profile.state, repo.id, key);
}
