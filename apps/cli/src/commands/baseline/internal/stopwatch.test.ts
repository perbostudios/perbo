import { describe, expect, it } from "vitest";
import {
  BASELINE_COMPARISON_MINIMUM,
  BaselineFileSchema,
  BaselineStateError,
  EMPTY_BASELINE_FILE,
  abandonBaseline,
  baselineElapsedMs,
  openBaseline,
  pauseBaseline,
  resumeBaseline,
  startBaseline,
  stopBaseline,
  summarizeBaseline,
  type BaselineFile,
} from "./stopwatch.js";

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe("baseline transitions", () => {
  it("starts one entry, and only one at a time", () => {
    const file = startBaseline(EMPTY_BASELINE_FILE, { title: "A", now: at(0), ticketsExist: false });
    expect(BaselineFileSchema.parse(file)).toEqual(file);
    expect(openBaseline(file)?.title).toBe("A");
    expect(file.captured_before_first_use).toBe(true);
    expect(() => startBaseline(file, { title: "B", now: at(1), ticketsExist: false })).toThrow(
      BaselineStateError,
    );
    expect(() => startBaseline(file, { title: "B", now: at(1), ticketsExist: false })).toThrow(/"A"/);
  });

  it("records a late capture and never forgets it", () => {
    let file = startBaseline(EMPTY_BASELINE_FILE, { title: "A", now: at(0), ticketsExist: true });
    expect(file.captured_before_first_use).toBe(false);
    file = stopBaseline(file, { now: at(5) });
    file = startBaseline(file, { title: "B", now: at(6), ticketsExist: false });
    expect(file.captured_before_first_use).toBe(false);
  });

  it("subtracts every pause from the reading", () => {
    let file = startBaseline(EMPTY_BASELINE_FILE, { title: "A", now: at(0), ticketsExist: false });
    file = pauseBaseline(file, at(10));
    expect(openBaseline(file)?.paused_at).toBe(at(10).toISOString());
    // Read mid-pause: the open pause is excluded too.
    expect(baselineElapsedMs(openBaseline(file)!, at(14))).toBe(10 * 60_000);
    file = resumeBaseline(file, at(15));
    expect(openBaseline(file)).toMatchObject({ paused_at: null, paused_ms: 5 * 60_000 });
    file = pauseBaseline(file, at(30));
    file = resumeBaseline(file, at(32));
    file = stopBaseline(file, { now: at(60), pull_request_url: "https://x/pull/1", note: "n" });
    expect(file.entries[0]).toMatchObject({
      ended_at: at(60).toISOString(),
      paused_ms: 7 * 60_000,
      elapsed_ms: 53 * 60_000,
      outcome: "completed",
      pull_request_url: "https://x/pull/1",
      note: "n",
    });
    expect(openBaseline(file)).toBeNull();
  });

  it("closes an open pause on stop and on abandon", () => {
    let file = startBaseline(EMPTY_BASELINE_FILE, { title: "A", now: at(0), ticketsExist: false });
    file = pauseBaseline(file, at(20));
    const stopped = stopBaseline(file, { now: at(30) });
    expect(stopped.entries[0]).toMatchObject({ paused_at: null, paused_ms: 10 * 60_000, elapsed_ms: 20 * 60_000 });
    const abandoned = abandonBaseline(file, { now: at(30), reason: "blocked" });
    expect(abandoned.entries[0]).toMatchObject({
      paused_at: null,
      paused_ms: 10 * 60_000,
      elapsed_ms: 20 * 60_000,
      outcome: "abandoned",
      note: "blocked",
      pull_request_url: null,
    });
  });

  it("refuses a transition with nothing to apply it to", () => {
    expect(() => pauseBaseline(EMPTY_BASELINE_FILE, at(0))).toThrow(/nothing to pause/);
    expect(() => resumeBaseline(EMPTY_BASELINE_FILE, at(0))).toThrow(/nothing to resume/);
    expect(() => stopBaseline(EMPTY_BASELINE_FILE, { now: at(0) })).toThrow(/nothing to stop/);
    expect(() => abandonBaseline(EMPTY_BASELINE_FILE, { now: at(0) })).toThrow(/nothing to abandon/);
    const open = startBaseline(EMPTY_BASELINE_FILE, { title: "A", now: at(0), ticketsExist: false });
    expect(() => resumeBaseline(open, at(1))).toThrow(/not paused/);
    expect(() => pauseBaseline(pauseBaseline(open, at(1)), at(2))).toThrow(/already paused/);
  });

  it("does not let a clock that went backwards produce a negative reading", () => {
    let file = startBaseline(EMPTY_BASELINE_FILE, { title: "A", now: at(10), ticketsExist: false });
    file = stopBaseline(file, { now: at(5) });
    expect(file.entries[0]!.elapsed_ms).toBe(0);
  });
});

describe("baseline summary", () => {
  const completed = (minutes: number[]): BaselineFile =>
    minutes.reduce<BaselineFile>((file, m, index) => {
      const started = startBaseline(file, { title: `T${index}`, now: at(index * 100), ticketsExist: false });
      return stopBaseline(started, { now: at(index * 100 + m) });
    }, EMPTY_BASELINE_FILE);

  it("takes the median and the nearest-rank p90 over completed entries only", () => {
    let file = completed([10, 40, 20, 30]);
    file = startBaseline(file, { title: "abandoned", now: at(1000), ticketsExist: false });
    file = abandonBaseline(file, { now: at(1090) });
    file = startBaseline(file, { title: "open", now: at(2000), ticketsExist: false });
    expect(summarizeBaseline(file)).toEqual({
      entries: 6,
      completed: 4,
      abandoned: 1,
      open: 1,
      median_elapsed_ms: 25 * 60_000,
      p90_elapsed_ms: 40 * 60_000,
      short_of_comparison: BASELINE_COMPARISON_MINIMUM - 4,
    });
    expect(summarizeBaseline(completed([7, 9, 8]))).toMatchObject({
      median_elapsed_ms: 8 * 60_000,
      p90_elapsed_ms: 9 * 60_000,
    });
  });

  it("has no median below one entry and stops asking for more at ten", () => {
    expect(summarizeBaseline(EMPTY_BASELINE_FILE)).toMatchObject({
      median_elapsed_ms: null,
      p90_elapsed_ms: null,
      short_of_comparison: BASELINE_COMPARISON_MINIMUM,
    });
    expect(summarizeBaseline(completed(Array.from({ length: 10 }, (_, i) => i + 1))).short_of_comparison).toBe(0);
  });
});
