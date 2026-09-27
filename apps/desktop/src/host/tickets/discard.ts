import { existsSync, lstatSync, rmSync } from "node:fs";
import type { Ticket } from "@perbo/contracts";
import { heldTicket } from "../../shared/jobs.js";
import {
  DELETE_TICKET_GONE,
  DELETE_WAITS_FOR_TICKET_COMMAND,
  deletePullRequestOpen,
  pullRequestOpen,
} from "../../shared/discard.js";
import { listBundles } from "../records.js";
import { attemptsPath, bundleManifestPath, bundlesPath, ticketPath } from "../repository/layout.js";
import { discardEditingFor, forgetTicket } from "../profile/preferences.js";
import type { ProfileState, RegisteredRepository } from "../profile/store.js";
import type { Job } from "../../shared/protocol.js";

export interface DiscardDeps {
  tickets: { list(repo: RegisteredRepository): Promise<{ tickets: Ticket[] }> };
  profile: { state: ProfileState };
  liveJobs(): Job[];
  /**
   * Stop the chats of these plannings and settle once each child has exited,
   * so no turn is still in flight when the delete removes what it writes.
   */
  stopChats(ids: readonly string[]): Promise<void>;
}

/**
 * Delete a piece of work, with everything it carries, and answer with the
 * reason it stays where it does.
 *
 * A piece of work is deleted whole at every stage, the loop included, and the
 * evidence goes with it (D-129): the ticket, its contract, its draft, its
 * approach, the reading of its plan against its spec, the answers offered to
 * its review's findings, the attempts it recorded and the bundles those
 * attempts sealed. Keeping the record of a run nobody wants any more is
 * keeping a row on the board that the person has already said is over. A path
 * that is a link is left alone rather than followed.
 *
 * A command running for this ticket holds it, because that command writes
 * what the delete removes; a command running for another ticket in the same
 * repository does not, since it writes none of this one's records. One stage
 * holds: a ticket whose pull request is open (`pullRequestOpen`) has a record
 * on GitHub this machine does not own. Deleting the ticket would leave it
 * standing with nothing here to read it against, so the pull request is closed
 * or merged first and the delete is offered again after that.
 *
 * The reason is answered rather than thrown, because the callers differ in
 * which reasons are theirs to say: deleting work outright says every one, and
 * throwing away the planning that drafted it says each that leaves the work
 * standing, but not a ticket already gone, which leaves nothing to delete.
 */
export async function discardTicket(
  deps: DiscardDeps,
  repo: RegisteredRepository,
  key: string,
): Promise<string | null> {
  if (heldTicket(deps.liveJobs(), repo.id, key)) return DELETE_WAITS_FOR_TICKET_COMMAND;
  const ticket = (await deps.tickets.list(repo)).tickets.find((entry) => entry.key === key);
  if (!ticket) return DELETE_TICKET_GONE;
  // The one stage a delete does not reach: the pull request is on GitHub and
  // this machine does not own it, so taking the ticket would leave it open
  // with nothing here to read it against — at `pr_open`, and wherever the
  // delivery record says it is open, as after an escalated run that published.
  if (pullRequestOpen(ticket)) return deletePullRequestOpen(ticket);
  // A planning discarded here takes its chat with it (D-102), and nothing is
  // removed until that chat has gone: a turn in flight finishes after its
  // stdin closes, writing the spec back and running `perbo edit` against this
  // ticket, so a file taken from under it is a turn that fails half-written
  // and a folder taken from under it is written again.
  await deps.stopChats(discardEditingFor(deps.profile.state, repo.id, key));
  const remove = (path: string): void => {
    if (existsSync(path) && !lstatSync(path).isSymbolicLink()) rmSync(path);
  };
  // The verdict the plan was last read against its spec with goes too, and the
  // answers the Architect offered to its review's findings: each is about this
  // ticket, and a key is never handed out again, so once the ticket is gone it
  // names nothing.
  for (const suffix of [".json", ".contract.json", ".draft.json", ".approach.json", ".drift.json", ".options.json"] as const)
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
  return null;
}
