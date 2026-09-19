import { z } from "zod";

/**
 * The standing prohibited list: paths this repository refuses a write to for
 * every ticket, whichever contract is running (D-105).
 *
 * It is a repository agreement, so it lives in `.perbo/config.json` beside the
 * checks and the limits rather than in any one contract. Admission folds it
 * into each new ticket's `paths_prohibited`, and the runner's guard reads it
 * again at run time, so an entry added after a ticket was admitted still holds
 * for that ticket's runs.
 *
 * The key is the contract's own name for the same idea. It is not a judging
 * path (D-045): an approved scope may name a path the list prohibits — the
 * write is what is refused, not the scope.
 */
export const STANDING_PROHIBITED_KEY = "paths_prohibited";

/** What a bare glob's source reads as: a person wrote it into the file. */
export const STANDING_BY_HAND = "written in .perbo/config.json";

export const StandingProhibitedEntrySchema = z.strictObject({
  path: z.string().trim().min(1).max(300),
  /**
   * The planning session whose explorer added the entry. Null for one written
   * by hand or by another machine, which the explorer shows locked: a person
   * removes it where they wrote it.
   */
  draft: z.string().trim().min(1).max(100).nullable().default(null),
  /** What is shown beside the entry: the ticket it was added from, or where else it came from. */
  source: z.string().trim().min(1).max(200),
  added_at: z.string().datetime().nullable().default(null),
});
export type StandingProhibitedEntry = z.infer<typeof StandingProhibitedEntrySchema>;

/** A hand-written file holds bare globs; the explorer writes the entries. Both parse. */
export const StandingProhibitedSchema = z
  .array(
    z.union([
      StandingProhibitedEntrySchema,
      z
        .string()
        .trim()
        .min(1)
        .max(300)
        .transform((path) => ({ path, draft: null, source: STANDING_BY_HAND, added_at: null })),
    ]),
  )
  .max(200);

/**
 * The list a configuration declares. A key holding something this cannot read
 * prohibits nothing rather than refusing the run: the same reading a config key
 * that judges nothing gets, and the guard still has the contract's own list.
 */
export function readStandingProhibited(config: unknown): StandingProhibitedEntry[] {
  if (config === null || typeof config !== "object") return [];
  const parsed = StandingProhibitedSchema.safeParse(
    (config as Record<string, unknown>)[STANDING_PROHIBITED_KEY],
  );
  return parsed.success ? parsed.data : [];
}

/** The glob a marked path is written as: a directory covers what is under it, a file is itself. */
export const standingGlob = (path: string): string => (path.endsWith("/") ? `${path}**` : path);
