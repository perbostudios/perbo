import { cx } from "./cx.js";
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
    | "connections";
  size?: number;
  className?: string;
}) {
  const extension = ["general", "usage", "connections"].includes(name) ? "svg" : "png";
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
