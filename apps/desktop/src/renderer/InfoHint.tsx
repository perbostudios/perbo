import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cx } from "@perbo/ui";

/** How far the panel sits from the dot, and how much window it leaves at the edges. */
const GAP = 6;
const EDGE = 8;

/**
 * What a card says when it is asked: the detail behind an `i`, so the card
 * itself carries only what has to be read.
 *
 * The panel is positioned against the window rather than against the card,
 * because the chat it sits in scrolls — an absolutely placed panel is clipped
 * by that scroll, and the wider a line of detail is the more of it goes. Fixed
 * placement escapes the clip; the position is worked out when it opens and
 * again when the chat moves under it.
 *
 * Hover is not the whole of it. It opens on focus as well, because a person
 * moving through the chat by keyboard has the same question as one moving
 * through it by pointer, and Escape closes it without moving the focus off
 * what they were reading. The pointer handlers are on the wrapper rather than
 * on the dot, so a pointer travelling to the panel to scroll it or select from
 * it does not close the thing it is travelling to.
 *
 * The text is in the document rather than drawn on demand, so a screen reader
 * reaches it through `aria-describedby` whether or not it is on screen. A
 * `title` attribute would do none of this: it waits a second, it cannot be
 * styled, it is unreachable by keyboard, and it truncates.
 */
export function InfoHint({
  text,
  label = "More about this",
  className,
}: {
  text: string;
  /** What the control is called, where "More about this" is not specific enough. */
  label?: string;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);
  const dot = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLSpanElement>(null);

  const place = useCallback(() => {
    const anchor = dot.current?.getBoundingClientRect();
    if (anchor === undefined) return;
    const width = Math.min(360, window.innerWidth - EDGE * 2);
    const panel = body.current?.getBoundingClientRect().height ?? 0;
    // Below the dot where there is room for it, above where there is not.
    const under = anchor.bottom + GAP;
    const top = under + panel > window.innerHeight - EDGE ? anchor.top - GAP - panel : under;
    // Right-aligned to the dot, then held inside the window rather than run off
    // either edge — the dock it hangs from can be narrower than the panel.
    const right = Math.min(window.innerWidth - EDGE, anchor.right);
    setAt({
      top: Math.max(EDGE, top),
      left: Math.max(EDGE, right - width),
      width,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    // The chat scrolls under it and the window moves around it; either leaves
    // the panel pointing at nothing, so it follows or it goes.
    const again = (): void => place();
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    return () => {
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
    };
  }, [open, place]);

  if (text.trim().length === 0) return null;
  return (
    <span
      className={cx("info-hint", className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        ref={dot}
        type="button"
        className="info-hint-dot"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Tapping is a pointer's way of asking, and a touch that cannot hover
        // has no other one.
        onClick={() => setOpen((shown) => !shown)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          setOpen(false);
          event.stopPropagation();
        }}
      >
        i
      </button>
      <span
        ref={body}
        id={id}
        role="tooltip"
        className={cx("info-hint-body", open && "info-hint-body--open")}
        style={at === null ? undefined : { top: at.top, left: at.left, width: at.width }}
      >
        {text}
      </span>
    </span>
  );
}
