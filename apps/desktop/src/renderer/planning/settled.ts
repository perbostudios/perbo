import { useCallback, useEffect, useRef } from "react";
import { bridge } from "../workspace/index.js";
import { isLive } from "../../shared/jobs.js";
import type { Change, Job } from "../../shared/protocol.js";

/** The job a request started, once it has stopped running. */
export function useSettled(): (job: Job) => Promise<Job> {
  const done = useRef(new Map<string, Job>());
  const waiting = useRef(new Map<string, (job: Job) => void>());
  useEffect(
    () =>
      bridge.subscribe((change: Change) => {
        const job = "job" in change ? change.job : undefined;
        if (!job || isLive(job)) return;
        done.current.set(job.id, job as Job);
        waiting.current.get(job.id)?.(job as Job);
        waiting.current.delete(job.id);
      }),
    [],
  );
  return useCallback((job: Job) => {
    if (!isLive(job)) return Promise.resolve(job);
    const already = done.current.get(job.id);
    if (already) return Promise.resolve(already);
    return new Promise<Job>((resolve) => waiting.current.set(job.id, resolve));
  }, []);
}
