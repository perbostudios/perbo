/**
 * How long ago a recorded moment was, in the words a list uses: minutes, then
 * hours, then the date. `now` is a parameter so a caller can say which clock
 * it is reading against.
 */
export function timeAgo(value: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60_000));
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(value).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
}
