import { cx } from "@perbo/ui";

/**
 * Line icons for planning's own controls, beside the inked artwork
 * `InkIcon` carries. Callers give the control its accessible name.
 *
 * Artwork has semantic names, here and in `InkIcon`; its navigation arrows
 * are used only for pagination. There are deliberately no generic icon
 * aliases: play, download and external links must not silently reuse the
 * next-page artwork.
 */
const PATHS = {
  create: (
    <>
      <path d="M12.1 3.3c4.9-.2 8.7 3.8 8.6 8.7-.1 4.8-3.9 8.8-8.7 8.7-4.9 0-8.8-3.9-8.7-8.8.1-4.8 3.9-8.5 8.8-8.6z" />
      <path d="M12 7.7v8.7M7.7 12.1h8.7" />
    </>
  ),
  spec: (
    <>
      <path d="M6.2 3.5h8.1l4 4v13.1H6z" />
      <path d="M14.1 3.7v3.9h4" />
      <path d="M8.9 11.3h6.6M8.9 14.3h6.3M8.9 17.3h4.1" />
    </>
  ),
  explorer: (
    <>
      <path d="M3.3 6.2a1.6 1.6 0 0 1 1.6-1.6h3.3l1.8 2h8.1a1.6 1.6 0 0 1 1.6 1.6v9.9a1.6 1.6 0 0 1-1.6 1.6H4.9a1.6 1.6 0 0 1-1.6-1.6z" />
      <path d="M8.4 11.4h7.2M8.4 14.7h4.6" />
    </>
  ),
  graph: (
    <>
      <path d="M3.6 8.2h5.1v7.6H3.6zM15.3 4.5h5.1v6.1h-5.1zM15.3 13.4h5.1v6.1h-5.1z" />
      <path d="M8.7 10.6h3.4a1.6 1.6 0 0 0 1.6-1.6v-1.4M8.7 13.4h3.4a1.6 1.6 0 0 1 1.6 1.6v1.4" />
    </>
  ),
  file: (
    <>
      <path d="M6.4 3.6h7.4l4 4v12.8H6.4z" />
      <path d="M13.6 3.8v3.9h3.9" />
    </>
  ),
  lock: (
    <>
      <path d="M5.6 10.6h12.8v9.1H5.6z" />
      <path d="M8.4 10.5V7.7a3.6 3.6 0 0 1 7.2 0v2.8" />
    </>
  ),
  impact: (
    <>
      <path d="M12 9.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z" />
      <path d="M7.8 7.6a6 6 0 0 0 0 8.8M16.2 16.4a6 6 0 0 0 0-8.8" />
      <path d="M4.6 4.5a10.4 10.4 0 0 0 0 15M19.4 19.5a10.4 10.4 0 0 0 0-15" />
    </>
  ),
  chevron: <path d="M9.4 5.8l6.2 6.2-6.2 6.2" />,
  // The two answers every question carries, whoever asked it: handing the
  // choice back, and answering in words of one's own.
  handOver: (
    <>
      <path d="M4.8 8.2h8.9a4.2 4.2 0 0 1 0 8.4H7.4" />
      <path d="M10.4 13.5 7.2 16.6l3.2 3.2" />
    </>
  ),
  ownWords: (
    <>
      <path d="M4.6 19.4l.8-3.6L15.6 5.4a1.9 1.9 0 0 1 2.7 0l.4.4a1.9 1.9 0 0 1 0 2.7L8.4 19.1z" />
      <path d="M14.3 6.8l3.2 3.2" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.9h15" />
      <path d="M6.6 6.9l.8 12.1a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.8-12.1" />
      <path d="M9.6 6.9V5.3a1.6 1.6 0 0 1 1.6-1.6h1.6a1.6 1.6 0 0 1 1.6 1.6v1.6" />
      <path d="M10.2 10.5v6.1M13.8 10.5v6.1" />
    </>
  ),
};
export type LineIconName = keyof typeof PATHS;

export function LineIcon({
  name,
  size = 16,
  strokeWidth = 1.6,
  className,
}: {
  name: LineIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      className={cx("line-icon", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
