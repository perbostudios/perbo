import { describe, expect, it } from "vitest";
import { formatDuration, formatHumanElapsed } from "./duration.js";

describe("formatDuration", () => {
  it("counts in milliseconds below a second, and in whole seconds above one", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(59_499)).toBe("59s");
    // Rounded, not truncated: half a second short of two is two seconds.
    expect(formatDuration(1_500)).toBe("2s");
    expect(formatDuration(59_500)).toBe("1m");
  });

  it("drops a unit that is zero, so a round value reads as one number", () => {
    expect(formatDuration(1_200_000)).toBe("20m");
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  it("names the smaller unit beside the larger one wherever there is a remainder", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });
});

describe("formatHumanElapsed", () => {
  it("takes the unit from the rounded value, so a rounded-up minute reads as one", () => {
    // 59.999 seconds rounds to 60.0, which nobody writes: it is one minute.
    expect(formatHumanElapsed(59_999)).toBe("1.0 minute");
    expect(formatHumanElapsed(3_599_999)).toBe("1.0 hour");
  });

  it("leaves values below the rounding boundaries in the unit they were in", () => {
    // Just under the seconds boundary: 59.949 still rounds to 59.9 seconds.
    expect(formatHumanElapsed(59_949)).toBe("59.9 seconds");
    expect(formatHumanElapsed(27_308)).toBe("27.3 seconds");
    expect(formatHumanElapsed(0)).toBe("0.0 seconds");
    // Just under the minutes boundary, and well under it.
    expect(formatHumanElapsed(3_593_999)).toBe("59.9 minutes");
    expect(formatHumanElapsed(90_000)).toBe("1.5 minutes");
    expect(formatHumanElapsed(60_000)).toBe("1.0 minute");
  });

  it("crosses each boundary exactly once, at the first value that rounds over it", () => {
    expect(formatHumanElapsed(59_950)).toBe("1.0 minute");
    expect(formatHumanElapsed(3_596_999)).toBe("59.9 minutes");
    expect(formatHumanElapsed(3_597_000)).toBe("1.0 hour");
  });

  it("keeps counting in hours above one, the largest unit it prints", () => {
    expect(formatHumanElapsed(3_600_000)).toBe("1.0 hour");
    expect(formatHumanElapsed(5_400_000)).toBe("1.5 hours");
    expect(formatHumanElapsed(86_400_000)).toBe("24.0 hours");
  });
});
