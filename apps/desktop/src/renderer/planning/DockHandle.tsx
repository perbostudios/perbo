import { useEffect, useRef, useState } from "react";
import { cx } from "../ui/index.js";
import {
  DEFAULT_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
  setDockWidth,
} from "../shell/dock-size.js";

/** What an arrow key moves the edge by, and what Shift and an arrow move it by. */
const STEP = 16;
const STRIDE = 64;

/**
 * The bar between the pane and the interview, dragged to set how wide the
 * interview is.
 *
 * The dock is on the right, so the width is the distance from the pointer to
 * the window's right edge: read at the moment of the move rather than from
 * where the drag began, which keeps the bar under the pointer however far it
 * has travelled and however the window has been resized meanwhile.
 *
 * It is a `separator` the keyboard can reach, because a person who cannot hold
 * a pointer down still has a chat to make room for: the arrows move it, and
 * Home returns it to the width it opens at, as double-clicking does.
 */
export function DockHandle({ width, limit }: { width: number; limit: number }) {
  // Whether the edge is held is a ref as well as state: the state draws it, and
  // the ref answers the very next move. A move can arrive before React has
  // re-rendered, and a guard read out of the render closure would still say the
  // edge was free and drop that move.
  const holding = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const release = (pointerId: number): void => {
    if (holding.current !== pointerId) return;
    holding.current = null;
    setDragging(false);
    // jsdom has no pointer capture, and a capture already lost throws.
    try {
      bar.current?.releasePointerCapture(pointerId);
    } catch {
      // nothing held
    }
  };
  // The dock is on the right, so the width is the distance to the window's
  // right edge, held to what a window this size can give it.
  // The end of a drag, wherever it happens. With pointer capture every event
  // comes back here; without it — a browser that refused the capture, a pointer
  // released outside the window — nothing else would ever clear `holding`, and
  // the edge would follow the pointer for the life of the pane.
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

  const widthFrom = (clientX: number): number =>
    Math.max(MIN_DOCK_WIDTH, Math.min(limit, window.innerWidth - clientX));
  return (
    <div
      ref={bar}
      className={cx("dock-handle", dragging && "dock-handle--dragging")}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the interview"
      aria-valuemin={MIN_DOCK_WIDTH}
      aria-valuemax={limit}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        // The primary button only: a right-click here is the window's own menu.
        // One pointer owns the edge: a second arriving mid-drag is not a
        // second drag, and must not be able to end the first one.
        if (event.button !== 0 || holding.current !== null) return;
        // The default action would both select the text under the pointer and
        // focus this bar; the selection is what we do not want, so focus is
        // taken back by hand for the keyboard that follows a click.
        event.preventDefault();
        bar.current?.focus();
        holding.current = event.pointerId;
        setDragging(true);
        try {
          bar.current?.setPointerCapture(event.pointerId);
        } catch {
          // Without capture the pointer's own events stop at this bar's edge,
          // which is what the window listener below is for.
        }
      }}
      onPointerMove={(event) => {
        if (holding.current !== event.pointerId) return;
        setDockWidth(widthFrom(event.clientX));
      }}
      onPointerUp={(event) => release(event.pointerId)}
      // A capture lost to anything else — a window that went away underneath
      // it, another gesture — ends the drag rather than leaving the bar held.
      onLostPointerCapture={(event) => release(event.pointerId)}
      onDoubleClick={() => setDockWidth(DEFAULT_DOCK_WIDTH)}
      onKeyDown={(event) => {
        const by = event.shiftKey ? STRIDE : STEP;
        // Left widens: the dock is on the right, so its edge moving left is
        // the dock growing.
        if (event.key === "ArrowLeft") setDockWidth(Math.min(limit, width + by));
        else if (event.key === "ArrowRight") setDockWidth(Math.max(MIN_DOCK_WIDTH, width - by));
        else if (event.key === "Home") setDockWidth(DEFAULT_DOCK_WIDTH);
        else return;
        event.preventDefault();
      }}
    >
      <span className="dock-handle-grip" aria-hidden="true" />
    </div>
  );
}
