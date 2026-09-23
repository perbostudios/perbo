import { isArchived } from "../../shared/archive.js";
import type { ProfileState } from "./store.js";

/**
 * The preferences a person set beside a ticket, keyed `repoId:key`: its title,
 * the models it drafts and runs with, and whether it has been filed. They are
 * this host's own, so they are dropped here rather than written to a repository.
 */
const entryKey = (repoId: string, key: string): string => repoId + ":" + key;

/**
 * Disconnecting a repository takes its tickets' preferences with it; a
 * reconnection gets a fresh id anyway.
 */
export function forgetRepository(state: ProfileState, repoId: string): void {
  state.repositories = state.repositories.filter((entry) => entry.id !== repoId);
  const prefix = repoId + ":";
  for (const entry of Object.keys(state.titles))
    if (entry.startsWith(prefix)) delete state.titles[entry];
  for (const entry of Object.keys(state.taskModels))
    if (entry.startsWith(prefix)) delete state.taskModels[entry];
  state.archived = state.archived.filter((entry) => !entry.startsWith(prefix));
  delete state.asks[repoId];
}

/** What a deleted contract leaves behind on this machine. */
export function forgetTicket(state: ProfileState, repoId: string, key: string): void {
  const entry = entryKey(repoId, key);
  delete state.titles[entry];
  delete state.taskModels[entry];
  state.archived = state.archived.filter((item) => item !== entry);
}

/**
 * This repository's unsent answer to "What do you want to build?", kept as the
 * person types it; an empty one removes it.
 */
export function saveAsk(state: ProfileState, repoId: string, text: string): void {
  if (text.length === 0) delete state.asks[repoId];
  else state.asks[repoId] = text;
}

/** Filing tickets away from Home by hand, or putting them back (S4). */
export function setArchived(
  state: ProfileState,
  repoId: string,
  keys: readonly string[],
  archived: boolean,
): void {
  const entries = keys.map((key) => entryKey(repoId, key));
  state.archived = archived
    ? [...new Set([...state.archived, ...entries])]
    : state.archived.filter((entry) => !entries.includes(entry));
}

/**
 * The planning sessions drafting this ticket, marked discarded in place: the
 * contract they edit has gone, so there is nothing for a resume to open.
 * Answers with the ids it marked, whose chats go with them.
 */
export function discardEditingFor(state: ProfileState, repoId: string, key: string): string[] {
  const marked: string[] = [];
  for (const session of state.editingSessions)
    if (session.repoId === repoId && session.key === key && session.phase !== "discarded") {
      session.phase = "discarded";
      session.resumeNew = false;
      session.revision++;
      marked.push(session.id);
    }
  return marked;
}

/**
 * The first complete listing after this preference arrived: what had already
 * finished is already filed (S4). Done once, and only over a listing with no
 * repository missing from it, so a repository that could not be read does not
 * leave its finished tickets on Home for good.
 */
export function seedArchived(
  state: ProfileState,
  tasks: readonly { repoId: string; ticket: { key: string; state: string } }[],
): boolean {
  if (state.archivedSeeded) return false;
  state.archived = [
    ...new Set([
      ...state.archived,
      ...tasks
        .filter((row) => isArchived(row.ticket.state))
        .map((row) => row.repoId + ":" + row.ticket.key),
    ]),
  ];
  state.archivedSeeded = true;
  return true;
}
