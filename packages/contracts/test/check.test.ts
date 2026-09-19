import { describe, expect, it } from "vitest";
import { CheckResultSchema, CheckResultsFileSchema, checksForNode, wholeChangeChecks } from "../src/check.js";

/** A check record as written before the re-run fields existed. */
const OLDER_RECORD = {
  check_id: "check_unit",
  name: "unit",
  kind: "unit",
  status: "failed",
  summary: "run failed: command exited (1)",
  command: "pnpm exec turbo run test",
  detail: "ERROR run failed: command exited (1)",
  duration_ms: 1200,
  source: "file",
};

describe("the check record's re-run fields", () => {
  it("leaves an older record parseable and its new fields absent", () => {
    const parsed = CheckResultSchema.parse(OLDER_RECORD);
    expect(parsed.failing_tests).toBeUndefined();
    expect(parsed.reruns).toBeUndefined();
    expect(parsed.flaky).toBeUndefined();
    expect(parsed.rerun).toBeUndefined();
  });

  it("carries the failing tests, the re-run count and the flake", () => {
    const parsed = CheckResultSchema.parse({
      ...OLDER_RECORD,
      status: "passed",
      failing_tests: ["apps/cli/test/x.test.ts > suite > case"],
      reruns: 1,
      flaky: true,
      rerun: {
        command: "pnpm exec vitest run test/x.test.ts",
        scope: "files",
        note: null,
        status: "passed",
        summary: "Tests  143 passed (143)",
        failing_tests: [],
        duration_ms: 900,
      },
    });
    expect(parsed.failing_tests).toEqual(["apps/cli/test/x.test.ts > suite > case"]);
    expect(parsed.reruns).toBe(1);
    expect(parsed.flaky).toBe(true);
    expect(parsed.rerun?.scope).toBe("files");
    expect(parsed.rerun?.status).toBe("passed");
  });

  it("keeps both runs' failing tests when the failure reproduced", () => {
    const parsed = CheckResultSchema.parse({
      ...OLDER_RECORD,
      failing_tests: ["apps/cli/test/x.test.ts > suite > case"],
      reruns: 1,
      flaky: false,
      rerun: {
        command: "pnpm exec turbo run test",
        scope: "task",
        note: "no failing test names were parsed from the check's output",
        status: "failed",
        summary: "Tests  1 failed | 142 passed (143)",
        failing_tests: ["apps/cli/test/x.test.ts > suite > case"],
        duration_ms: 900,
      },
    });
    expect(parsed.status).toBe("failed");
    expect(parsed.rerun?.failing_tests).toEqual(parsed.failing_tests);
    expect(parsed.rerun?.note).toContain("no failing test names");
  });
});

describe("the temporary directory a check ran under", () => {
  it("is absent on a record written before the field existed", () => {
    expect(CheckResultSchema.parse(OLDER_RECORD).tmpdir).toBeUndefined();
  });

  it("carries the directory, and null when the runner had none to give", () => {
    expect(CheckResultSchema.parse({ ...OLDER_RECORD, tmpdir: "/var/folders/9k/T" }).tmpdir).toBe(
      "/var/folders/9k/T",
    );
    expect(CheckResultSchema.parse({ ...OLDER_RECORD, tmpdir: null }).tmpdir).toBeNull();
  });
});

/**
 * The node a result belongs to (D-107).
 *
 * A graphed ticket runs each pinned check once over the whole change and once
 * per node. A whole-change result carries no node, which is what every result
 * on a flat plan is, and both shapes have to read back out of one file.
 */
describe("the node a check result belongs to", () => {
  it("is absent on a whole-change result", () => {
    expect(CheckResultSchema.parse(OLDER_RECORD).node).toBeUndefined();
  });

  it("carries the node, the paths the run was narrowed to, the scope and the note", () => {
    const parsed = CheckResultSchema.parse({
      ...OLDER_RECORD,
      status: "passed",
      command: "pnpm exec vitest run test/send.test.ts",
      node: {
        node_id: "node_queue",
        paths: ["packages/queue/test/send.test.ts"],
        scope: "files",
        note: null,
      },
    });
    expect(parsed.node?.node_id).toBe("node_queue");
    expect(parsed.node?.paths).toEqual(["packages/queue/test/send.test.ts"]);
    expect(parsed.node?.scope).toBe("files");
    expect(parsed.node?.note).toBeNull();
  });

  it("says why a node's run was not narrowed, with no paths to show for it", () => {
    const parsed = CheckResultSchema.parse({
      ...OLDER_RECORD,
      node: {
        node_id: "node_reports",
        paths: [],
        scope: "task",
        note: "no changed test file inside the node's paths",
      },
    });
    expect(parsed.node?.scope).toBe("task");
    expect(parsed.node?.paths).toEqual([]);
    expect(parsed.node?.note).toContain("no changed test file");
  });

  it("holds a narrowed run to its paths and a whole-command run to its reason", () => {
    // A narrowed run names at least one path and carries no note.
    expect(() =>
      CheckResultSchema.parse({
        ...OLDER_RECORD,
        node: { node_id: "node_queue", paths: [], scope: "files", note: null },
      }),
    ).toThrow();
    expect(() =>
      CheckResultSchema.parse({
        ...OLDER_RECORD,
        node: { node_id: "node_queue", paths: ["packages/queue/test/send.test.ts"], scope: "files", note: "why" },
      }),
    ).toThrow();
    // A whole-command run says why it was not narrowed and names no path.
    expect(() =>
      CheckResultSchema.parse({
        ...OLDER_RECORD,
        node: { node_id: "node_queue", paths: [], scope: "task", note: null },
      }),
    ).toThrow();
    expect(() =>
      CheckResultSchema.parse({
        ...OLDER_RECORD,
        node: { node_id: "node_queue", paths: ["packages/queue/test/send.test.ts"], scope: "task", note: "why" },
      }),
    ).toThrow();
  });

  it("refuses a node id that is not one, and a field the record does not declare", () => {
    expect(() =>
      CheckResultSchema.parse({
        ...OLDER_RECORD,
        node: { node_id: "queue", paths: [], scope: "task", note: null },
      }),
    ).toThrow(/node id/);
    expect(() =>
      CheckResultSchema.parse({
        ...OLDER_RECORD,
        node: { node_id: "node_queue", paths: [], scope: "task", note: null, title: "Queue" },
      }),
    ).toThrow();
  });
});

describe("reading a results file back", () => {
  const whole = { ...OLDER_RECORD, check_id: "check_unit" };
  const perNode = {
    ...OLDER_RECORD,
    check_id: "check_unit",
    node: { node_id: "node_queue", paths: [], scope: "task" as const, note: "no test file" },
  };

  it("takes a file holding both shapes, under either top-level form", () => {
    expect(CheckResultsFileSchema.parse([whole, perNode])).toHaveLength(2);
    expect(CheckResultsFileSchema.parse({ checks: [whole, perNode] })).toHaveLength(2);
  });

  it("gives the whole-change results alone to what judges the change", () => {
    const parsed = CheckResultsFileSchema.parse([whole, perNode]);
    const judging = wholeChangeChecks(parsed);
    expect(judging).toHaveLength(1);
    expect(judging[0]!.node).toBeUndefined();
  });
});

/**
 * The results one node's review reads (D-107): that node's own, and nothing
 * else — not the whole-change result, and not another node's.
 */
describe("checksForNode", () => {
  const whole = { ...OLDER_RECORD, check_id: "check_unit" };
  const nodeA = {
    ...OLDER_RECORD,
    check_id: "check_unit",
    node: { node_id: "node_a", paths: [], scope: "task" as const, note: "no test file" },
  };
  const nodeB = {
    ...OLDER_RECORD,
    check_id: "check_unit",
    node: { node_id: "node_b", paths: [], scope: "task" as const, note: "no test file" },
  };

  it("returns only the named node's results, excluding the whole-change result and every other node's", () => {
    const parsed = CheckResultsFileSchema.parse([whole, nodeA, nodeB]);
    const forA = checksForNode(parsed, "node_a");
    expect(forA).toHaveLength(1);
    expect(forA[0]!.node?.node_id).toBe("node_a");
  });

  it("returns nothing for a node with no results", () => {
    const parsed = CheckResultsFileSchema.parse([whole, nodeA]);
    expect(checksForNode(parsed, "node_c")).toEqual([]);
  });
});
