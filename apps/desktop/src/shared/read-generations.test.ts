import { describe, expect, it, vi } from "vitest";
import { ALL_SCOPE, READ_ATTEMPTS, ReadGenerations, SNAPSHOT_SCOPE } from "./read-generations.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * ADR-0034's rule, one case per way a read and an invalidation can overlap.
 * The read is held open, the invalidation lands while it is in flight, and
 * what comes back says whether the rule took the read again.
 */
const overlaps: { what: string; scope: string; invalidated: string | null; again: boolean }[] = [
  { what: "the scope being read", scope: "repo_a", invalidated: "repo_a", again: true },
  { what: "another scope", scope: "repo_a", invalidated: "repo_b", again: false },
  { what: "every scope", scope: "repo_a", invalidated: ALL_SCOPE, again: true },
  { what: "another scope, under the snapshot", scope: SNAPSHOT_SCOPE, invalidated: "repo_b", again: true },
  { what: "every scope, under the snapshot", scope: SNAPSHOT_SCOPE, invalidated: ALL_SCOPE, again: true },
  { what: "nothing", scope: "repo_a", invalidated: null, again: false },
];

describe("the guarded read", () => {
  it.each(overlaps)("takes the read again when $what was invalidated: $again", async ({ scope, invalidated, again }) => {
    const generations = new ReadGenerations();
    const held = deferred<string>();
    const load = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValue("fresh");
    const reading = generations.read(scope, load);
    if (invalidated !== null) generations.invalidate(invalidated);
    held.resolve("stale");
    expect(await reading).toBe(again ? "fresh" : "stale");
    expect(load).toHaveBeenCalledTimes(again ? 2 : 1);
  });

  it("takes a failed read again when an invalidation overlapped it", async () => {
    const generations = new ReadGenerations();
    const held = deferred<string>();
    const load = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValue("fresh");
    const reading = generations.read("repo_a", load);
    generations.invalidate("repo_a");
    held.reject(new Error("Repository unavailable"));
    expect(await reading).toBe("fresh");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("throws a failure that nothing overlapped", async () => {
    const generations = new ReadGenerations();
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("Repository unavailable"));
    await expect(generations.read("repo_a", load)).rejects.toThrow("Repository unavailable");
    expect(load).toHaveBeenCalledTimes(1);
  });

  /**
   * Records that move faster than they can be read never settle, so the rule
   * on its own would take the read again for as long as they kept moving. The
   * ceiling is what makes that a refusal a screen can show and a later refresh
   * can clear, rather than a read that never comes back.
   */
  it("refuses a read that every mutation overlaps", async () => {
    const generations = new ReadGenerations();
    let calls = 0;
    // Mutates for longer than the ceiling allows, then settles: an unbounded
    // rule reads the settled records and returns them.
    const load = async (): Promise<string> => {
      calls += 1;
      if (calls <= READ_ATTEMPTS + 5) generations.invalidate("repo_a");
      return "settled";
    };
    await expect(generations.read("repo_a", load)).rejects.toThrow(/changed while every attempt to read them/);
    expect(calls).toBe(READ_ATTEMPTS);
  });

  it("holds a scope's token still while another scope is invalidated", () => {
    const generations = new ReadGenerations();
    const before = generations.token("repo_a");
    generations.invalidate("repo_b");
    expect(generations.token("repo_a")).toBe(before);
    generations.invalidate("repo_a");
    expect(generations.token("repo_a")).not.toBe(before);
  });

  it("moves the snapshot's token on every invalidation", () => {
    const generations = new ReadGenerations();
    let token = generations.token(SNAPSHOT_SCOPE);
    for (const scope of ["repo_a", ALL_SCOPE, SNAPSHOT_SCOPE]) {
      generations.invalidate(scope);
      const moved = generations.token(SNAPSHOT_SCOPE);
      expect(moved).not.toBe(token);
      token = moved;
    }
  });
});
