import { useSyncExternalStore } from "react";

/**
 * How wide the interview dock is, dragged by the bar on its own edge and
 * remembered on this machine, as the rail's own choice is
 * ({@link ./rail-size.ts}).
 *
 * A width rather than a fraction: the dock holds a conversation, and a person
 * who has made it wide enough to read a question in has sized it against the
 * text rather than against the window.
 *
 * What a window this size can actually give it is {@link dockWidthLimit}, and
 * it is the only bound: the stylesheet states no width of its own, because a
 * second rule for the same thing is a rule the drag would stop agreeing with —
 * the edge would stand still under a pointer that was still moving.
 */
export const DEFAULT_DOCK_WIDTH = 300;
/** Narrow enough to put the chat out of the way, wide enough to still read it. */
export const MIN_DOCK_WIDTH = 252;
export const MAX_DOCK_WIDTH = 760;
/** What the pane beside it keeps, whatever the dock is dragged to. */
export const MIN_PANE_WIDTH = 360;
const KEY = "perbo:dock";
const listeners = new Set<() => void>();
let current: number = read();

function clamp(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DOCK_WIDTH;
  return Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, Math.round(width)));
}

function read(): number {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === null ? DEFAULT_DOCK_WIDTH : clamp(Number(stored));
  } catch {
    // A private window forgets the choice; the dock still opens at its own width.
    return DEFAULT_DOCK_WIDTH;
  }
}

/**
 * The widest the dock can be beside a pane this wide, which is what both the
 * drag and the layout are held to. Read from the room there is rather than
 * assumed, so a narrow window moves the stop rather than letting the edge run
 * past where the dock can actually go.
 */
export function dockWidthLimit(available: number): number {
  if (!Number.isFinite(available) || available <= 0) return MAX_DOCK_WIDTH;
  return Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, Math.round(available - MIN_PANE_WIDTH)));
}

export function setDockWidth(next: number | ((previous: number) => number)): void {
  current = clamp(typeof next === "function" ? next(current) : next);
  try {
    localStorage.setItem(KEY, String(current));
  } catch {
    // As above: the drag still applies for as long as the window is open.
  }
  for (const listener of listeners) listener();
}

/** Tests reset the remembered width between cases. */
export function resetDockWidth(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing remembered
  }
  current = read();
  for (const listener of listeners) listener();
}

export function useDockWidth(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
