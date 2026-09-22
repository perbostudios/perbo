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
 * Delete a contract that has never run, with the records it owns, and answer
 * with the reason it stays where it does.
 *
 * Evidence is never deleted: an attempt, a bundle or a pull request on record
 * keeps the ticket, whatever state it is in. The three files removed are the
 * ticket's own, and a path that is a link is left alone rather than followed.
 *
 * The reason is answered rather than thrown, because there are two callers
 * with two different needs: deleting a contract outright says the reason to
 * the person, and throwing away the planning that drafted it takes the ticket
 * along only where it can and carries on where it cannot — a ticket whose
 * loop has run is work, not a draft.
 */
export async function discardTicket(
  deps: DiscardDeps,
  repo: RegisteredRepository,
  key: string,
): Promise<string | null> {
  if (heldRepository(deps.liveJobs(), repo.id))
    return "Wait for the commands running in this repository to finish before deleting a contract.";
  const ticket = (await deps.tickets.list(repo)).tickets.find((entry) => entry.key === key);
  if (!ticket) return "This task is no longer in the repository's ticket store.";
  if (!NEVER_RUN.includes(ticket.state))
    return "Only a contract that has never run can be deleted. This one has moved past the contract stage.";
  const attempts = readAttempts(attemptsPath(repo, ticket.ticket_id));
  const bundles = listBundles(bundlesPath(repo));
  if (
    attempts.attempts.length ||
    attempts.error ||
    bundles.some((bundle) => bundle.ticket_id === ticket.ticket_id)
  )
    return "This contract has recorded attempts or evidence, so it stays. Only a never-run contract can be deleted.";
  if (ticket.delivery.pull_request_url)
    return "This contract has a pull request on record, so it stays.";
  for (const suffix of [".json", ".contract.json", ".draft.json"] as const) {
    const path = ticketPath(repo, key, suffix);
    if (existsSync(path) && !lstatSync(path).isSymbolicLink()) rmSync(path);
  }
  forgetTicket(deps.profile.state, repo.id, key);
  discardEditingFor(deps.profile.state, repo.id, key);
  return null;
}
