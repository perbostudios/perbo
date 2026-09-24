import type { ProfileState } from "./store.js";

/**
 * The preferences a person set beside a ticket, keyed `repoId:key`: its title,
 * the models it drafts and runs with, whether it has been filed and when its
 * page was last opened. They are
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
  for (const entry of Object.keys(state.lastOpened))
    if (entry.startsWith(prefix)) delete state.lastOpened[entry];
  delete state.asks[repoId];
}

/** What a deleted contract leaves behind on this machine. */
export function forgetTicket(state: ProfileState, repoId: string, key: string): void {
  const entry = entryKey(repoId, key);
  delete state.titles[entry];
  delete state.taskModels[entry];
  state.archived = state.archived.filter((item) => item !== entry);
  delete state.lastOpened[entry];
}

/** A ticket's page opened now, which is what orders Home within each colour. */
export function recordOpened(state: ProfileState, repoId: string, key: string, at: Date): void {
  state.lastOpened[entryKey(repoId, key)] = at.toISOString();
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
