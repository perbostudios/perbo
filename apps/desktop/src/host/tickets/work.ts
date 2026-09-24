import { existsSync, lstatSync, rmSync } from "node:fs";
import type { Ticket } from "@perbo/contracts";
import { specFolder } from "../repository/config.js";
import { safePath } from "../repository/paths.js";
import { specSlugOf } from "../../shared/spec-slug.js";
import { ANOTHER_PLANNING_HOLDS } from "../../shared/discard.js";
import { SPEC_SLUG } from "../../shared/protocol.js";
import type { Changes } from "../changes.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { WorkspaceReads } from "../workspace-reads.js";
import type { EditingSession } from "../../shared/protocol.js";

/**
 * What deleting a piece of work needs of the rest of the host: the planning,
 * the ticket drafted from its spec, and the spec they came from are one thing,
 * and deleting it deletes all three (D-129).
 */
export interface WorkDeps {
  tickets: { list(repo: RegisteredRepository): Promise<{ tickets: Ticket[] }> };
  reads: Pick<WorkspaceReads, "invalidate">;
  changes: Pick<Changes, "changed">;
  repository(id: string): RegisteredRepository;
  /** Every planning this host keeps, live or not. */
  sessions(): readonly EditingSession[];
  /** Delete a ticket and what it carries, answering with why it stays where it does. */
  discard(repo: RegisteredRepository, key: string): Promise<string | null>;
}

/**
 * The ticket in `plan_review` that admission recorded being drafted from this
 * spec, by key. One spec has one such ticket (D-103), so where the count is
 * anything but one there is nothing to be sure of, and the answer is null
 * rather than a guess.
 *
 * The ticket may have been admitted outside this host — at the command line —
 * so nothing has told the cached listing that the folder moved. It is read
 * again, or this looks for a ticket in a list taken before it existed.
 */
export async function draftedFrom(
  deps: Pick<WorkDeps, "tickets" | "reads">,
  repo: RegisteredRepository,
  slug: string,
): Promise<string | null> {
  deps.reads.invalidate(repo.id);
  const folder = specFolder(repo);
  const mine = (await deps.tickets.list(repo)).tickets.filter(
    (ticket) => ticket.state === "plan_review" && specSlugOf(ticket.admission.spec?.path, folder) === slug,
  );
  return mine.length === 1 ? mine[0]!.key : null;
}

/**
 * Delete the plan_review ticket drafted from this spec, where there is one.
 *
 * The planning being thrown away is the row that stood for this work, so the
 * work goes with it — ticket and all — whether or not the session ever took
 * the ticket onto itself (D-101, D-103). Reads the records rather than
 * trusting a recorded string, exactly as {@link removeSpecFolder} does.
 *
 * Says why it refused, or null where it deleted or found nothing: the caller
 * uses it to decide whether the spec may go too.
 */
export async function deleteDraftedFromSpec(
  deps: WorkDeps,
  repoId: string,
  slug: string,
  except: string,
): Promise<string | null> {
  try {
    const repo = deps.repository(repoId);
    const key = await draftedFrom(deps, repo, slug);
    if (key === null) return null;
    // Another planning curating this work — by the spec it writes or by the
    // ticket it holds — is the one to throw it away. A session can hold the
    // ticket without holding the slug, so both are asked.
    const held = deps
      .sessions()
      .some(
        (entry) =>
          entry.id !== except &&
          entry.repoId === repoId &&
          (entry.specSlug === slug || entry.key === key) &&
          entry.phase !== "discarded",
      );
    if (held) return ANOTHER_PLANNING_HOLDS;
    return await deps.discard(repo, key);
  } catch {
    // Nothing readable is nothing to delete, and the planning has gone either
    // way.
    return null;
  }
}

/**
 * Take the spec folder with the work it described.
 *
 * Deleting a piece of work deletes all of it — the planning, the ticket it
 * drafted, and the spec they came from. Writing left behind puts a row back
 * in the picker under the same title the moment the delete finishes, which
 * reads as the delete having made a copy of the thing it removed.
 *
 * The slug is held to one folder name and nothing else. It reaches here from an
 * admission record, which is a file in the repository rather than anything
 * this process wrote, and `safePath` alone does not make it safe: it refuses a
 * path that lands outside the repository, and `..` lands back inside it.
 * `specs/../..` is the repository root, and this call ends in
 * `rmSync(recursive)`. One segment, matching the same pattern the folder
 * listing accepts, is the whole of what may be deleted here.
 *
 * Left where something else still names it: another planning writing the same
 * file, or another ticket drafted from it. That is somebody else's work and
 * this delete was never asked about it.
 *
 * Says whether the folder went, and never throws: the planning and the ticket
 * are already gone by the time this runs, and a failure here is a folder left
 * behind rather than a delete to be taken back.
 */
export async function removeSpecFolder(
  deps: WorkDeps,
  repoId: string,
  slug: string,
  except: { sessionId: string | null; claims: string | null },
): Promise<boolean> {
  try {
    if (!SPEC_SLUG.test(slug)) return false;
    const repo = deps.repository(repoId);
    const folder = specFolder(repo);
    const held = deps
      .sessions()
      .some(
        (session) =>
          session.id !== except.sessionId &&
          session.repoId === repoId &&
          session.specSlug === slug &&
          session.phase !== "discarded",
      );
    if (held) return false;
    // Read from disk rather than from the listing taken before the ticket was
    // deleted, so a ticket that has gone is gone here too. No ticket is
    // excused: one still on disk is one that still names this file, whether or
    // not the caller meant to delete it — a delete that was refused, or skipped
    // for work this planning did not do, leaves the plan standing, and a plan
    // is read against the spec it names (D-103).
    deps.reads.invalidate(repoId);
    const tickets = (await deps.tickets.list(repo)).tickets;
    if (tickets.some((ticket) => specSlugOf(ticket.admission.spec?.path, folder) === slug)) return false;
    // And where the planning held a ticket, the folder that ticket names must
    // be the one being deleted. A session's slug can be filled in from an
    // admission record written under a different spec folder, and `specs/foo`
    // is then an unrelated spec of the same name.
    if (except.claims !== null) {
      const mine = tickets.find((ticket) => ticket.key === except.claims);
      if (mine !== undefined && specSlugOf(mine.admission.spec?.path, folder) !== slug) return false;
    }
    const at = safePath(repo, ...`${folder}/${slug}`.split("/"));
    if (!existsSync(at)) return true;
    // What a link points at is not this repository's to delete.
    if (lstatSync(at).isSymbolicLink()) return false;
    rmSync(at, { recursive: true, force: true });
    deps.changes.changed(true, { kind: "records", repoId, key: null });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a spec no planning and no ticket stands on: one the picker offers
 * because nothing names it.
 */
export async function deleteSpec(deps: WorkDeps, repoId: string, slug: string): Promise<null> {
  const repo = deps.repository(repoId);
  const folder = specFolder(repo);
  const at = safePath(repo, ...`${folder}/${slug}`.split("/"));
  // A ticket drafted from this spec is judged stale against these bytes
  // (D-103), so deleting them would leave it unreadable as current for ever.
  const ticket = (await deps.tickets.list(repo)).tickets.find(
    (each) => specSlugOf(each.admission.spec?.path, folder) === slug,
  );
  if (ticket !== undefined)
    throw new Error(
      `${ticket.key} was drafted from this spec, and a plan is read against the spec it names. ` +
        "Delete that contract first, and the spec is yours to delete.",
    );
  const drafted = deps
    .sessions()
    .find(
      (session) =>
        session.repoId === repoId && session.specSlug === slug && session.phase !== "discarded",
    );
  if (drafted !== undefined)
    throw new Error(
      "A planning is writing this spec. Throw that planning away first, and the spec is yours " +
        "to delete.",
    );
  if (!existsSync(at)) return null;
  if (lstatSync(at).isSymbolicLink())
    throw new Error(
      "That spec folder is a link, and what it points at is not this repository's to delete.",
    );
  rmSync(at, { recursive: true, force: true });
  deps.changes.changed(true, { kind: "records", repoId, key: null });
  return null;
}
