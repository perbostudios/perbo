import { useSyncExternalStore } from "react";

/** The rail is the prototype's icon column; the toggle beside the traffic lights opens or closes it, and the choice is remembered on this machine. */
export const RAIL_WIDTH = 66;
export interface RailSize {
  collapsed: boolean;
}
const KEY = "perbo:rail";
const listeners = new Set<() => void>();
let current: RailSize = read();
function read(): RailSize {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<RailSize> | null;
    return { collapsed: parsed?.collapsed === true };
  } catch {
    return { collapsed: false };
  }
}
export function setRailSize(next: RailSize | ((previous: RailSize) => RailSize)): void {
  current = typeof next === "function" ? next(current) : next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // A private window forgets the choice; the pane still works.
  }
  for (const listener of listeners) listener();
}
/** Tests reset the remembered choice between cases. */
export function resetRailSize(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing remembered
  }
  current = read();
  for (const listener of listeners) listener();
}
export function useRailSize(): RailSize {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
