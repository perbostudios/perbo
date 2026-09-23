import { existsSync, lstatSync, rmSync } from "node:fs";
import type { Ticket } from "@perbo/contracts";
import { heldRepository } from "../../shared/jobs.js";
import { listBundles } from "../records.js";
import { attemptsPath, bundleManifestPath, bundlesPath, ticketPath } from "../repository/layout.js";
import { discardEditingFor, forgetTicket } from "../profile/preferences.js";
import type { ProfileState, RegisteredRepository } from "../profile/store.js";
import type { Job } from "../../shared/protocol.js";

export interface DiscardDeps {
  tickets: { list(repo: RegisteredRepository): Promise<{ tickets: Ticket[] }> };
  profile: { state: ProfileState };
  liveJobs(): Job[];
}

/**
 * Delete a piece of work, with everything it carries, and answer with the
 * reason it stays where it does.
 *
 * A piece of work is deleted whole at every stage, the loop included, and the
 * evidence goes with it (D-129): the ticket, its
 * contract, its draft, its approach, the reading of its plan against its spec,
 * the attempts it recorded and the bundles those attempts sealed. Keeping the
 * record of a run nobody wants any more is keeping a row on the board that the
 * person has already said is over. A path that is a link is left alone rather
 * than followed.
 *
 * One stage holds: a ticket at `pr_open` has a pull request on GitHub, which
 * is a record this machine does not own. Deleting the ticket would leave it
 * standing with nothing here to read it against, so the pull request is closed
 * or merged first and the delete is offered again after that.
 *
 * The reason is answered rather than thrown, because there are two callers
 * with two different needs: deleting work outright says the reason to the
 * person, and throwing away the planning that drafted it takes the ticket
 * along only where it can, and keeps going where it cannot.
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
  // The one stage a delete does not reach: the pull request is on GitHub and
  // this machine does not own it, so taking the ticket would leave it open
  // with nothing here to read it against.
  if (ticket.state === "pr_open")
    return (
      `${key} has a pull request open, and that is a record this machine does not own. Close ` +
      "or merge it on GitHub first, then delete the work."
    );
  const remove = (path: string): void => {
    if (existsSync(path) && !lstatSync(path).isSymbolicLink()) rmSync(path);
  };
  // The verdict the plan was last read against its spec with goes too: it is
  // about this plan, and a key is never handed out again, so once the ticket is
  // gone it names nothing.
  for (const suffix of [".json", ".contract.json", ".draft.json", ".approach.json", ".drift.json"] as const)
    remove(ticketPath(repo, key, suffix));
  // The attempts this ticket recorded, and the bundles they sealed. The objects
  // under `bundles/objects` stay: they are content-addressed and one of them
  // can be the bytes another ticket's bundle names, so deleting them would take
  // evidence this delete was never asked about.
  remove(attemptsPath(repo, ticket.ticket_id));
  // Each bundle by the file its manifest was read from: a path built from the
  // recorded `bundle_id` would be a path built out of repository content, and
  // content names whatever it likes.
  for (const bundle of listBundles(bundlesPath(repo)))
    if (bundle.ticket_id === ticket.ticket_id) remove(bundleManifestPath(repo, bundle.file));
  forgetTicket(deps.profile.state, repo.id, key);
  discardEditingFor(deps.profile.state, repo.id, key);
  return null;
}
