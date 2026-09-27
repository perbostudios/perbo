/** The most characters a ticket's name has, however it was named (D-127). */
export const TICKET_NAME_CAP = 60;

/**
 * Whether two ticket names are the same name to a person scanning the board:
 * equal once case is ignored and every run of whitespace is one space
 * (D-127). `ticketName` in `@perbo/planning`, which `perbo admit` and the
 * desktop's sample host name a ticket with, uses it to keep a name off one the
 * board already carries.
 */
export function sameName(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

const fold = (name: string): string => name.replace(/\s+/g, " ").trim().toLowerCase();
