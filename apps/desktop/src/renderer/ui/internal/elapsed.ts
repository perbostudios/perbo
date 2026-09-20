import { useEffect, useState } from "react";

/** Elapsed time of something that started at `since`, ticking once a second while it runs. */
export function useElapsed(
  since: string | null | undefined,
  running: boolean,
): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!since) return null;
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
}
