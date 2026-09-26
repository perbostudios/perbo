import { describe, expect, it } from "vitest";
import { READING_RETRY_PAUSES_MS, untilItRuns } from "./reading-retry.js";

/**
 * A reading of the plan against its spec that does not run is tried again
 * before the page is told (D-NEW-basic-and-epic-flows): three retries, after
 * 2, 4 and 8 seconds.
 */
describe("a reading tried until it runs", () => {
  it("pauses 2, 4 and 8 seconds between four tries", () => {
    expect(READING_RETRY_PAUSES_MS).toEqual([2_000, 4_000, 8_000]);
  });

  it("throws the last failure once every try has failed, having paused before each retry", async () => {
    const paused: number[] = [];
    let tries = 0;
    await expect(
      untilItRuns(
        () => {
          tries += 1;
          throw new Error(`try ${tries} failed`);
        },
        async (ms) => {
          paused.push(ms);
        },
      ),
    ).rejects.toThrow("try 4 failed");
    expect(tries).toBe(4);
    expect(paused).toEqual([2_000, 4_000, 8_000]);
  });

  it("returns what a later try gives, with no pause after it", async () => {
    const paused: number[] = [];
    let tries = 0;
    const got = await untilItRuns(
      async () => {
        tries += 1;
        if (tries === 1) throw new Error("the network dropped");
        return "a verdict";
      },
      async (ms) => {
        paused.push(ms);
      },
    );
    expect(got).toBe("a verdict");
    expect(tries).toBe(2);
    expect(paused).toEqual([2_000]);
  });

  it("stops retrying once stopped, with the failure it had", async () => {
    let tries = 0;
    let stop = false;
    await expect(
      untilItRuns(
        () => {
          tries += 1;
          throw new Error("cancelled");
        },
        async () => {
          stop = true;
        },
        () => stop,
      ),
    ).rejects.toThrow("cancelled");
    expect(tries).toBe(1);
  });
});
