import { useSyncExternalStore } from "react";

/**
 * How tall the question card is, dragged by the bar on its top edge and
 * remembered on this machine, as the dock's own width is
 * ({@link ./dock-size.ts}).
 *
 * A height rather than a share of the dock: what the card has to hold is a
 * question and its answers, and a person who has made it tall enough to read
 * two answers at once has sized it against those, not against the window. It
 * does not grow on its own — a long group scrolls inside it, and the box that
 * opens under it takes its room from the conversation above rather than from
 * the answers.
 */
export const DEFAULT_ASKED_HEIGHT = 300;
/** Tall enough for a question and an answer; short enough to leave a chat. */
export const MIN_ASKED_HEIGHT = 140;
export const MAX_ASKED_HEIGHT = 720;

const KEY = "perbo:asked";
const listeners = new Set<() => void>();
let current: number = read();

function clamp(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_ASKED_HEIGHT;
  return Math.min(MAX_ASKED_HEIGHT, Math.max(MIN_ASKED_HEIGHT, Math.round(height)));
}

function read(): number {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === null ? DEFAULT_ASKED_HEIGHT : clamp(Number(stored));
  } catch {
    // A private window forgets the choice; the card still opens at its own size.
    return DEFAULT_ASKED_HEIGHT;
  }
}

/**
 * The tallest the card can be in a dock this tall, so the conversation above it
 * is not driven out of the window. Read from the room there is rather than
 * assumed, as the dock's own limit is.
 */
export function askedHeightLimit(available: number): number {
  if (!Number.isFinite(available) || available <= 0) return MAX_ASKED_HEIGHT;
  return Math.max(MIN_ASKED_HEIGHT, Math.min(MAX_ASKED_HEIGHT, Math.round(available)));
}

export function setAskedHeight(next: number | ((previous: number) => number)): void {
  current = clamp(typeof next === "function" ? next(current) : next);
  try {
    localStorage.setItem(KEY, String(current));
  } catch {
    // As above: the drag still applies while the window is open.
  }
  for (const listener of listeners) listener();
}

/** Tests reset the remembered height between cases. */
export function resetAskedHeight(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing remembered
  }
  current = read();
  for (const listener of listeners) listener();
}

export function useAskedHeight(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
