/**
 * Every command this binary carries.
 *
 * Its own module, importing nothing: the table, the entry point and the
 * diagnostic all name the set, and a list that sat inside one command would
 * make that command everything else's dependency.
 */
export const COMMAND_NAMES = [
  "doctor",
  "baseline",
  "review",
  "inspect",
  "verdict",
  "run",
  "admit",
  "approve",
  "edit",
  "list",
  "sync",
  "serve",
  "mcp",
  "agent",
  "interview",
  "stops",
  "escapes",
  "principle",
  "index",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];
