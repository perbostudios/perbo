import { cx } from "@perbo/ui";
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
export function InkIcon({
  name,
  size = 24,
  className,
}: {
  name:
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
    | "skip-forward";
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
