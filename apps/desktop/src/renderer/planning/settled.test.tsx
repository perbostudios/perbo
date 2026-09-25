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

const job = (state: Job["state"], id = "job-1"): Job => ({
  id,
  repoId: "repo-1",
  key: "PRB-1",
  resultKey: null,
  kind: "drift",
  label: "Read the plan against the spec",
  state,
  startedAt: "2026-09-25T10:00:00.000Z",
  endedAt: state === "running" ? null : "2026-09-25T10:00:05.000Z",
  log: "",
  error: null,
  result: null,
});

/** The hook over a bridge whose changes this test sends. */
function settledOver() {
  let listener: (change: Change) => void = () => undefined;
  vi.spyOn(bridge, "subscribe").mockImplementation((heard) => {
    listener = heard;
    return () => undefined;
  });
  const { result } = renderHook(() => useSettled());
  const send = (update: Job): void => listener({ kind: "progress", sequence: 1, job: update } as Change);
  return { settled: result.current, send };
}

describe("the job a request started, once it has stopped running", () => {
  it("answers a job that has already stopped at once", async () => {
    const { settled } = settledOver();
    await expect(settled(job("completed"))).resolves.toMatchObject({ state: "completed" });
  });

  it("waits for a running job to stop, and answers with how it stopped", async () => {
    const { settled, send } = settledOver();
    let answer: Job | null = null;
    void settled(job("running")).then((done) => (answer = done));
    send(job("running"));
    await Promise.resolve();
    expect(answer).toBeNull();
    // Another job stopping is not this one.
    send(job("failed", "job-2"));
    await Promise.resolve();
    expect(answer).toBeNull();
    send(job("failed"));
    await vi.waitFor(() => expect(answer).toMatchObject({ id: "job-1", state: "failed" }));
  });

  it("answers a job whose stop was heard before it was asked about", async () => {
    const { settled, send } = settledOver();
    send(job("cancelled"));
    await expect(settled(job("running"))).resolves.toMatchObject({ state: "cancelled" });
  });
});
