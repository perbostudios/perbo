import { cx } from "./cx.js";
/** The names still held as traced PNGs; everything drawn since is SVG. */
const PNG = new Set([
  "home",
  "folder",
  "settings",
  "alert",
  "approve",
  "locked",
  "prev",
  "next",
  "reject",
  "dots",
]);

/** The supplied artwork is the primary icon language. Callers give the control its accessible name. */
/** Every piece of supplied artwork, by what it is for. */
export type InkIconName =
  | "home"
  | "folder"
  | "settings"
  | "alert"
  | "approve"
  | "locked"
  | "prev"
  | "next"
  | "reject"
  | "dots"
  | "general"
  | "usage"
  | "connections"
  | "help"
  | "info"
  | "chat"
  | "play"
  | "skip-forward"
  | "document"
  | "add-circle"
  | "growth-chart"
  | "share"
  | "coffee-beans"
  | "clipboard"
  | "inbox";

export function InkIcon({
  name,
  size = 24,
  className,
}: {
  name: InkIconName;
  size?: number;
  className?: string;
}) {
  // The drawn set is SVG; what is left of the traced set is still PNG.
  const extension = name.endsWith(".png") ? "png" : PNG.has(name) ? "png" : "svg";
  return (
    <img
      className={cx("ink-icon", className)}
      src={`./brand/${name}.${extension}`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
