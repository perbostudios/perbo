import { useEffect, useRef, useState } from "react";
import { cx } from "@perbo/ui";
import {
  DEFAULT_ASKED_HEIGHT,
  MIN_ASKED_HEIGHT,
  setAskedHeight,
} from "../shell/asked-size.js";

/** What an arrow key moves the edge by, and what Shift and an arrow move it by. */
const STEP = 16;
const STRIDE = 64;

/**
 * The bar on the question card's top edge, dragged to set how tall it is.
 *
 * The card is under the conversation, so its height is the distance from the
 * pointer to the bottom of the dock: read at the moment of the move rather
 * than from where the drag began, which keeps the bar under the pointer
 * however far it has travelled.
 *
 * The same control the dock's own edge has ({@link ./DockHandle.tsx}), turned
 * on its side: one bar between two things, dragged to say which gets the room.
 */
export function AskedHandle({ height, limit }: { height: number; limit: number }) {
  const holding = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const release = (pointerId: number): void => {
    if (holding.current !== pointerId) return;
    holding.current = null;
    setDragging(false);
    try {
      bar.current?.releasePointerCapture(pointerId);
    } catch {
      // nothing held
    }
  };

  // The end of a drag wherever it happens, as the dock's edge does it: without
  // this a pointer released outside the window leaves the bar following it.
  useEffect(() => {
    if (!dragging) return;
    const done = (event: PointerEvent): void => release(event.pointerId);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
    return () => {
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
    };
  });

  // The card sits above the composer, so what the drag sets is the distance
  // from the pointer down to the card's own bottom.
  const heightFrom = (clientY: number): number => {
    const bottom = bar.current?.parentElement?.getBoundingClientRect().bottom ?? window.innerHeight;
    return Math.max(MIN_ASKED_HEIGHT, Math.min(limit, bottom - clientY));
  };

  return (
    <div
      ref={bar}
      className={cx("asked-handle", dragging && "asked-handle--dragging")}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the questions"
      aria-valuemin={MIN_ASKED_HEIGHT}
      aria-valuemax={limit}
      aria-valuenow={height}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0 || holding.current !== null) return;
        event.preventDefault();
        bar.current?.focus();
        holding.current = event.pointerId;
        setDragging(true);
        try {
          bar.current?.setPointerCapture(event.pointerId);
        } catch {
          // The window listener above is what ends it without capture.
        }
      }}
      onPointerMove={(event) => {
        if (holding.current !== event.pointerId) return;
        setAskedHeight(heightFrom(event.clientY));
      }}
      onPointerUp={(event) => release(event.pointerId)}
      onLostPointerCapture={(event) => release(event.pointerId)}
      onDoubleClick={() => setAskedHeight(DEFAULT_ASKED_HEIGHT)}
      onKeyDown={(event) => {
        const by = event.shiftKey ? STRIDE : STEP;
        // Up makes it taller: the card is below, so its edge moving up is the
        // card growing.
        if (event.key === "ArrowUp") setAskedHeight(Math.min(limit, height + by));
        else if (event.key === "ArrowDown") setAskedHeight(Math.max(MIN_ASKED_HEIGHT, height - by));
        else if (event.key === "Home") setAskedHeight(DEFAULT_ASKED_HEIGHT);
        else return;
        event.preventDefault();
      }}
    >
      <span className="asked-handle-grip" aria-hidden="true" />
    </div>
  );
}
