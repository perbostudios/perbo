/**
 * Whether two ticket names are the same name to a person scanning the board:
 * equal once case is ignored and every run of whitespace is one space
 * (D-NEW-a-ticket-is-named-apart-from-its-board). `perbo admit` and the
 * desktop's preview use it to keep a name off one the board already carries.
 */
export function sameName(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

const fold = (name: string): string => name.replace(/\s+/g, " ").trim().toLowerCase();
