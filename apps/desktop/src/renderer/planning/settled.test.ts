// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { bridge } from "../workspace/index.js";
import { useSettled } from "./settled.js";
import type { Change, Job } from "../../shared/protocol.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const job = (id: string, state: Job["state"]): Job => ({
  id,
  repoId: "repo-1",
  key: "PRB-1",
  kind: "drift",
  label: "Read the plan against the spec",
  state,
  startedAt: "2026-09-25T10:00:00.000Z",
  endedAt: state === "running" ? null : "2026-09-25T10:00:01.000Z",
  log: "",
  error: null,
  resultKey: null,
  result: null,
});

/** The hook, over a bridge whose change stream the test sends into. */
function hooked(): { settled: (job: Job) => Promise<Job>; send: (change: Change) => void } {
  const listeners: ((change: Change) => void)[] = [];
  vi.spyOn(bridge, "subscribe").mockImplementation((listener) => {
    listeners.push(listener);
    return () => undefined;
  });
  const { result } = renderHook(() => useSettled());
  return { settled: result.current, send: (change) => listeners.forEach((listener) => listener(change)) };
}

const progress = (update: Job): Change => ({ kind: "progress", sequence: 1, job: update }) as Change;

/** Whether the promise has settled by the time everything queued has run. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

describe("the job a request started, once it has stopped running", () => {
  it("is the job itself where it has already stopped", async () => {
    const { settled } = hooked();
    const done = job("j-1", "completed");
    expect(await settled(done)).toBe(done);
  });

  it("waits for the change that says the job stopped, and answers with that change's job", async () => {
    const { settled, send } = hooked();
    const waiting = settled(job("j-1", "running"));
    // Still running, or another job stopping, answers nothing.
    send(progress(job("j-1", "running")));
    send(progress(job("j-2", "failed")));
    expect(await settledYet(waiting)).toBe(false);
    const stopped = { ...job("j-1", "completed"), result: { findings: [] } };
    send(progress(stopped));
    expect(await waiting).toEqual(stopped);
  });

  it("answers at once for a job whose stop arrived before it was asked about", async () => {
    const { settled, send } = hooked();
    const stopped = job("j-1", "failed");
    send(progress(stopped));
    // The request's own reply still says it was running.
    expect(await settled(job("j-1", "running"))).toEqual(stopped);
  });
});
