import { describe, expect, it } from "vitest";
import { EXCLUSIVE_KINDS, PLANNING_KINDS, exclusiveJob, heldRepository, lane } from "../src/shared/jobs.js";

/**
 * The two lanes (D-101), and the rule that every command the host starts has a
 * place in one of them: a kind nobody has placed is exclusive by default, and
 * this list is where a new command has to be placed rather than inherit that.
 */
const HOST_KINDS = ["doctor", "draft", "admit", "edit", "graphEdit", "graphUndo", "sync", "principle", "verdict", "run", "decide"] as const;

describe("the two lanes", () => {
  it("place every command the host starts, and no kind in both", () => {
    const placed = new Set<string>([...PLANNING_KINDS, ...EXCLUSIVE_KINDS]);
    for (const kind of HOST_KINDS) expect(placed.has(kind), kind).toBe(true);
    for (const kind of PLANNING_KINDS) expect(EXCLUSIVE_KINDS as readonly string[]).not.toContain(kind);
    for (const kind of HOST_KINDS) expect(lane(kind)).toBe(PLANNING_KINDS.includes(kind as never) ? "planning" : "exclusive");
  });

  it("treat a kind nobody has placed as exclusive", () => {
    expect(lane("unplaced")).toBe("exclusive");
  });

  it("find the exclusive job in the way, and the commands holding a repository", () => {
    const jobs = [
      { id: "a", kind: "draft", state: "running", repoId: "r1" },
      { id: "b", kind: "run", state: "completed", repoId: "r1" },
      { id: "c", kind: "sync", state: "stopping", repoId: "r2" },
    ];
    expect(exclusiveJob(jobs)?.id).toBe("c");
    expect(heldRepository(jobs, "r1")).toBe(true);
    expect(heldRepository(jobs, "r2")).toBe(true);
    expect(heldRepository(jobs, "r3")).toBe(false);
  });
});
