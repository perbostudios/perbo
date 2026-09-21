import { describe, expect, it } from "vitest";
import { timeAgo } from "../src/renderer/time-ago.js";

/**
 * How long ago a recorded moment was, for a person reading a list. The clock
 * is a parameter so a case says what "now" is rather than racing the machine's.
 */
describe("how long ago a recorded moment was", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");
  const ago = (milliseconds: number): string =>
    timeAgo(new Date(now - milliseconds).toISOString(), now);

  it("says just now under a minute", () => {
    expect(ago(0)).toBe("Just now");
    expect(ago(59_000)).toBe("Just now");
  });

  it("counts minutes, then hours", () => {
    expect(ago(5 * 60_000)).toBe("5m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(59 * 60_000)).toBe("59m ago");
  });

  it("gives a date once it is more than a day old", () => {
    const value = new Date(now - 3 * 86_400_000);
    expect(timeAgo(value.toISOString(), now)).toBe(
      value.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });

  /** A record written by a machine whose clock is ahead is not in the future. */
  it("reads a moment ahead of the clock as just now", () => {
    expect(ago(-86_400_000)).toBe("Just now");
  });
});
