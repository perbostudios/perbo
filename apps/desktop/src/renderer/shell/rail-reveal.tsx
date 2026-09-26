import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../ui/index.js";
import { useCreate } from "./create.js";

/** How near the window's left edge, in pixels, the pointer brings the hidden rail out. */
const REVEAL_EDGE = 12;
/** How long the pointer may be off the revealed rail, crossing a gap or slipping past its edge, before it slides away. */
export const REVEAL_GRACE = 150;
/** How long the rail stays mounted once it starts sliding away: as long as the slower of the two slides (`--duration-fast`), so it never cuts one short. */
export const SLIDE_OUT = 250;

type Phase = "off" | "entering" | "on" | "leaving";

/**
 * The hidden rail, brought back by the pointer. While the toggle has the rail
 * hidden, the pointer coming within a few pixels of the window's left edge
 * slides the same rail in over the page, fully usable, and leaving the rail
 * slides it away again a beat later. The edge is read off where the pointer
 * moves rather than from an element there, so the page under it keeps every
 * click and drag that starts at its left edge. The Create picker it opened
 * holds it out while the picker is open. Nothing else reveals it: a shortcut
 * acting while the rail is hidden does what it does with the rail hidden. A
 * rail that slides away with focus inside it hands the focus to the sidebar
 * toggle, rather than dropping it on the page.
 */
export function RailReveal({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("off");
  const [edge, setEdge] = useState(false);
  const [over, setOver] = useState(false);
  const { isOpen: picking } = useCreate();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const moved = (event: PointerEvent): void => setEdge(event.clientX <= REVEAL_EDGE);
    const left = (): void => setEdge(false);
    document.addEventListener("pointermove", moved);
    document.documentElement.addEventListener("pointerleave", left);
    return () => {
      document.removeEventListener("pointermove", moved);
      document.documentElement.removeEventListener("pointerleave", left);
    };
  }, []);
  useEffect(() => {
    if (edge || over) {
      setPhase((current) => (current === "off" ? "entering" : current === "leaving" ? "on" : current));
      return undefined;
    }
    if (picking || phase === "off" || phase === "leaving") return undefined;
    const timer = setTimeout(() => setPhase("leaving"), REVEAL_GRACE);
    return () => clearTimeout(timer);
  }, [edge, over, picking, phase]);
  // Mounted off-screen, the rail's position is read once before it is moved,
  // so the browser has a place to slide it from.
  useLayoutEffect(() => {
    if (phase !== "entering") return;
    panel.current?.getBoundingClientRect();
    setPhase("on");
  }, [phase]);
  useEffect(() => {
    if (phase !== "leaving") return undefined;
    const timer = setTimeout(() => {
      if (panel.current?.contains(document.activeElement))
        document.querySelector<HTMLButtonElement>(".rail-toggle")?.focus();
      setPhase("off");
    }, SLIDE_OUT);
    return () => clearTimeout(timer);
  }, [phase]);
  if (phase === "off") return null;
  return (
    <div
      ref={panel}
      className={cx("rail-reveal", phase === "on" && "is-revealed")}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
    >
      {children}
    </div>
  );
}
