import { describe, expect, it } from "vitest";
import { SIZE_THRESHOLDS, planSizeCounts, sizeEstimate } from "../src/size.js";

describe("the size estimate", () => {
  it("is S at the smallest bound: one node, four criteria, ten files, one package", () => {
    const size = sizeEstimate({ nodes: 1, criteria: 4, files: 10, packages: 1 });
    expect(size.name).toBe("S");
    expect(size.counts).toEqual({ nodes: 1, criteria: 4, files: 10, packages: 1 });
  });

  it("takes the largest size any one count reaches", () => {
    expect(sizeEstimate({ nodes: 1, criteria: 5, files: 10, packages: 1 }).name).toBe("M");
    expect(sizeEstimate({ nodes: 1, criteria: 4, files: 26, packages: 1 }).name).toBe("L");
    expect(sizeEstimate({ nodes: 1, criteria: 4, files: 10, packages: 4 }).name).toBe("XL");
    expect(sizeEstimate({ nodes: 7, criteria: 4, files: 10, packages: 1 }).name).toBe("XL");
  });

  it("names the counts that set it", () => {
    const size = sizeEstimate({ nodes: 6, criteria: 12, files: 29, packages: 1 });
    expect(size.name).toBe("L");
    expect(size.drivers).toEqual(["nodes", "criteria", "files"]);
  });

  it("crosses each band exactly where D-104 puts it", () => {
    expect(SIZE_THRESHOLDS).toEqual([
      { name: "S", nodes: 1, criteria: 4, files: 10, packages: 1 },
      { name: "M", nodes: 3, criteria: 10, files: 25, packages: 2 },
      { name: "L", nodes: 6, criteria: 20, files: 50, packages: 3 },
    ]);
    expect(sizeEstimate({ nodes: 3, criteria: 10, files: 25, packages: 2 }).name).toBe("M");
    expect(sizeEstimate({ nodes: 6, criteria: 20, files: 50, packages: 3 }).name).toBe("L");
    expect(sizeEstimate({ nodes: 6, criteria: 21, files: 50, packages: 3 }).name).toBe("XL");
  });

  it("forecasts nothing: it reports the counts it was given and no cost or time", () => {
    const size = sizeEstimate({ nodes: 2, criteria: 8, files: 20, packages: 2 });
    expect(Object.keys(size).sort()).toEqual(["counts", "drivers", "name"]);
  });
});

describe("the counts a plan's size comes from", () => {
  const tracked = [
    "packages/queue/src/send.ts",
    "packages/queue/src/retry.ts",
    "packages/queue/test/send.test.ts",
    "packages/reports/src/daily.ts",
    "packages/auth/src/signup.ts",
    "docs/04-ticket-workspace-and-review.md",
    "pnpm-lock.yaml",
  ];

  it("counts the tracked files the nodes' paths reach, and the packages they fall in", () => {
    expect(
      planSizeCounts({
        nodes: [{ paths: ["packages/queue/src/**"] }, { paths: ["packages/reports/**"] }],
        criteria: 6,
        paths_allowed: ["packages/**"],
        paths_prohibited: [],
        trackedFiles: tracked,
      }),
    ).toEqual({ nodes: 2, criteria: 6, files: 3, packages: 2 });
  });

  it("leaves out a prohibited path, whatever a node's globs reach", () => {
    expect(
      planSizeCounts({
        nodes: [{ paths: ["packages/queue/**"] }],
        criteria: 2,
        paths_allowed: ["packages/**"],
        paths_prohibited: ["**/test/**"],
        trackedFiles: tracked,
      }),
    ).toEqual({ nodes: 1, criteria: 2, files: 2, packages: 1 });
  });

  it("counts a flat plan as one node, over the scope it allows", () => {
    expect(
      planSizeCounts({
        nodes: [],
        criteria: 3,
        paths_allowed: ["packages/queue/**", "packages/auth/**"],
        paths_prohibited: [],
        trackedFiles: tracked,
      }),
    ).toEqual({ nodes: 1, criteria: 3, files: 4, packages: 2 });
  });
});
