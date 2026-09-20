import { describe, expect, it } from "vitest";
import { SuspendDetector } from "./suspend.js";
import { allocatePortRange, databaseSchemaFor, portFree } from "./ports.js";

describe("SuspendDetector", () => {
  it("reads a very late tick as the host having slept", () => {
    let now = 1_000_000;
    const seen: number[] = [];
    const detector = new SuspendDetector((event) => seen.push(event.gap_ms), 5_000, 60_000, () => now);

    now += 5_000;
    expect(detector.tick()).toBeNull();

    now += 400_000;
    const event = detector.tick();
    expect(event?.gap_ms).toBe(400_000);
    expect(seen).toEqual([400_000]);
  });

  it("reports the first suspend once, not on every subsequent tick", () => {
    let now = 0;
    const seen: number[] = [];
    const detector = new SuspendDetector((event) => seen.push(event.gap_ms), 5_000, 60_000, () => now);
    now += 200_000;
    detector.tick();
    now += 200_000;
    detector.tick();
    expect(seen).toHaveLength(1);
    expect(detector.stop()?.gap_ms).toBe(200_000);
  });

  it("does not mistake a busy scheduler for a suspend", () => {
    let now = 0;
    const detector = new SuspendDetector(() => undefined, 5_000, 60_000, () => now);
    now += 40_000;
    expect(detector.tick()).toBeNull();
  });
});

describe("port allocation", () => {
  it("hands out a contiguous free range", async () => {
    const range = await allocatePortRange({ size: 3, base: 45_000 });
    expect(range.size).toBe(3);
    expect(range.end - range.start).toBe(2);
    for (let port = range.start; port <= range.end; port += 1) {
      expect(await portFree(port)).toBe(true);
    }
  });

  it("derives a database schema name that is safe to interpolate", () => {
    expect(databaseSchemaFor("ayo_", "att_1;DROP SCHEMA public")).toBe("ayo_att_1_drop_schema_public");
  });
});

describe("port ranges under concurrency", () => {
  it("avoids a range another live attempt holds", async () => {
    // Probing cannot see this: nothing is bound until the repository's own
    // services start, so two attempts probing at once are both told the same
    // range is free. Two concurrent attempts measured on 2026-08-27 were both
    // handed 41000-41009 for exactly that reason.
    const first = await allocatePortRange({ size: 4, base: 46_000 });
    const second = await allocatePortRange({ size: 4, base: 46_000, avoid: [first] });

    expect(second.start).toBeGreaterThan(first.end);
    expect(second.size).toBe(4);
  });

  it("steps past several held ranges rather than one", async () => {
    const held = [
      { start: 47_000, end: 47_003 },
      { start: 47_004, end: 47_007 },
    ];
    const range = await allocatePortRange({ size: 4, base: 47_000, avoid: held });
    expect(range.start).toBe(47_008);
  });
});
