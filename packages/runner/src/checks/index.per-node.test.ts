import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretIndex, type CheckResult, type PlanNode } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";
import { runPinnedChecks, type PinnedCheck } from "./index.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The pinned checks run once per node of an execution graph (D-107, SCP-352),
 * narrowed to that node's paths as a failed check's re-run is narrowed to the
 * files that own it.
 *
 * The fixture is shaped like this repository: the pinned unit check is a
 * wrapper (`pnpm run test`) whose root script stands in for the whole suite,
 * and each package's own `test` script is `vitest run`, so the narrow form is
 * `pnpm exec vitest run <files>` in the package that owns them. Each package
 * has a `vitest` of its own on `node_modules/.bin` — a real binary that `pnpm
 * exec` really resolves and really answers, printing the markers a test runner
 * prints. What these drive is therefore the spawned command and its output,
 * not a stand-in for either.
 */

/** The passing and failing forms of the stand-in test runner. */
function vitestShim(dir: string, verdict: "passes" | "fails"): void {
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const counter = join(dir, "vitest-calls");
  writeFileSync(
    join(bin, "vitest"),
    [
      "#!/usr/bin/env node",
      'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
      `const counter = ${JSON.stringify(counter)};`,
      'const seen = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;',
      "writeFileSync(counter, String(seen + 1));",
      "const files = process.argv.slice(3);",
      `const fails = ${verdict === "fails"};`,
      "for (const file of files) {",
      '  console.log(fails ? `FAIL  ${file} > suite > case` : ` ✓ ${file} (1 test) 2ms`);',
      "}",
      "console.log(` Test Files  ${fails ? '1 failed' : files.length + ' passed'} (${files.length})`);",
      "console.log(` Tests  ${fails ? '1 failed' : files.length + ' passed'} (${files.length})`);",
      "process.exit(fails ? 1 : 0);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** How many times that package's stand-in runner was invoked. */
const vitestCalls = (dir: string): number => {
  const counter = join(dir, "vitest-calls");
  return existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
};

interface Fixture {
  worktree: string;
  /** Every path the sealed change set holds. */
  changed_files: string[];
  packageDir: (name: string) => string;
}

/**
 * A worktree shaped like this repository: two workspace packages, each with a
 * source file and a test file the change touched.
 */
function graphedWorktree(
  verdicts: { queue: "passes" | "fails"; reports: "passes" | "fails" },
  whole: "passes" | "fails" = "passes",
): Fixture {
  const worktree = scratch("perbo-node-checks-");
  writeFileSync(
    join(worktree, "package.json"),
    JSON.stringify({
      name: "root",
      private: true,
      scripts: {
        test:
          whole === "passes"
            ? `node -e "process.exit(0)"`
            : `node -e "console.log('whole-suite-failure-line');process.exit(1)"`,
      },
    }),
  );
  for (const [name, verdict] of Object.entries(verdicts)) {
    const dir = join(worktree, "packages", name);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: `@fixture/${name}`, scripts: { test: "vitest run" } }),
    );
    writeFileSync(join(dir, "src", `${name}.ts`), `export const ${name} = 1;\n`);
    writeFileSync(join(dir, "test", `${name}.test.ts`), "export {};\n");
    vitestShim(dir, verdict as "passes" | "fails");
  }
  return {
    worktree,
    changed_files: [
      "packages/queue/src/queue.ts",
      "packages/queue/test/queue.test.ts",
      "packages/reports/src/reports.ts",
      "packages/reports/test/reports.test.ts",
    ],
    packageDir: (name) => join(worktree, "packages", name),
  };
}

/** The pinned unit check: a wrapper that runs each package's `test` script. */
const WHOLE = ["pnpm", "run", "test"];

const pinned = (kind: PinnedCheck["kind"], command: readonly string[]): PinnedCheck[] => [
  {
    check_id: `check_${kind}`,
    name: kind,
    kind,
    command: [...command],
    timeout_ms: 30_000,
    definition_path: null,
    origin: "configured",
  },
];

const node = (id: string, paths: string[]): PlanNode => ({
  id,
  title: id,
  criteria: ["ac_1"],
  paths,
});

const forNode = (results: readonly CheckResult[], id: string): CheckResult[] =>
  results.filter((result) => result.node?.node_id === id);

const wholeChange = (results: readonly CheckResult[]): CheckResult[] =>
  results.filter((result) => result.node === undefined);

describe("a graphed ticket's pinned checks", () => {
  it("runs each check once per node, narrowed to that node's changed test files", async () => {
    const fixture = graphedWorktree({ queue: "passes", reports: "passes" });

    const results = await runPinnedChecks({
      checks: pinned("unit", WHOLE),
      worktree: fixture.worktree,
      env: process.env,
      secrets: new SecretIndex(),
      nodes: [node("node_queue", ["packages/queue/**"]), node("node_reports", ["packages/reports/**"])],
      changed_files: fixture.changed_files,
    });

    // One whole-change result, exactly as a flat plan records, and one per node.
    expect(results).toHaveLength(3);
    expect(wholeChange(results)).toHaveLength(1);

    const queue = forNode(results, "node_queue")[0]!;
    expect(queue.check_id).toBe("check_unit");
    expect(queue.name).toBe("unit");
    expect(queue.status).toBe("passed");
    expect(queue.node?.scope).toBe("files");
    expect(queue.node?.paths).toEqual(["packages/queue/test/queue.test.ts"]);
    expect(queue.node?.note).toBeNull();
    expect(queue.command).toBe("pnpm exec vitest run test/queue.test.ts");

    const reports = forNode(results, "node_reports")[0]!;
    expect(reports.status).toBe("passed");
    expect(reports.node?.paths).toEqual(["packages/reports/test/reports.test.ts"]);
    expect(reports.command).toBe("pnpm exec vitest run test/reports.test.ts");

    // Each node's narrowed run reached the package that owns its files, and
    // only that one: a node whose run had leaked into the other package would
    // have called the other package's runner too.
    expect(vitestCalls(fixture.packageDir("queue"))).toBe(1);
    expect(vitestCalls(fixture.packageDir("reports"))).toBe(1);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("runs a check it cannot narrow once over the change for the node, and says why", async () => {
    const fixture = graphedWorktree({ queue: "passes", reports: "passes" });

    const results = await runPinnedChecks({
      checks: [...pinned("unit", WHOLE), ...pinned("lint", ["node", "-e", "process.exit(0)"])],
      worktree: fixture.worktree,
      env: process.env,
      secrets: new SecretIndex(),
      nodes: [
        node("node_queue", ["packages/queue/**"]),
        // Only a source file of the change is inside this one, so there is no
        // test file for the narrow form to be told to run.
        node("node_sources", ["packages/reports/src/**"]),
      ],
      changed_files: fixture.changed_files,
    });

    // A check that does not narrow carries the whole-change result for the
    // node: the whole command is not run again per node.
    const wholeLint = wholeChange(results).find((result) => result.kind === "lint")!;
    const lint = forNode(results, "node_queue").find((result) => result.kind === "lint")!;
    expect(lint.node?.scope).toBe("task");
    expect(lint.node?.paths).toEqual([]);
    expect(lint.node?.note).toContain("lint");
    expect(lint.command).toBe("node -e process.exit(0)");
    expect({ ...lint, node: undefined }).toEqual({ ...wholeLint, node: undefined });

    const sources = forNode(results, "node_sources").find((result) => result.kind === "unit")!;
    expect(sources.node?.scope).toBe("task");
    expect(sources.node?.paths).toEqual([]);
    expect(sources.node?.note).toContain("test file");
    expect(sources.command).toBe(WHOLE.join(" "));

    // The un-narrowable runs never reached a package's own runner.
    expect(vitestCalls(fixture.packageDir("reports"))).toBe(0);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("keeps a node's failed narrowed run as evidence and never turns the check red where the pinned command passed", async () => {
    const fixture = graphedWorktree({ queue: "passes", reports: "fails" });

    const results = await runPinnedChecks({
      checks: pinned("unit", WHOLE),
      worktree: fixture.worktree,
      env: process.env,
      secrets: new SecretIndex(),
      // The failing node runs first, so a node reached after it proves the
      // failure did not stop the rest.
      nodes: [node("node_reports", ["packages/reports/**"]), node("node_queue", ["packages/queue/**"])],
      changed_files: fixture.changed_files,
    });

    expect(results).toHaveLength(3);

    // Only the pinned command can fail the check: it passed over the whole
    // change, so the node's result passed, and its summary says what the
    // node's own run measured and which command judged.
    const reports = forNode(results, "node_reports")[0]!;
    expect(reports.status).toBe("passed");
    expect(reports.summary).toContain("the node's own run failed");
    expect(reports.summary).toContain("pnpm run test passed over the whole change");
    expect(reports.command).toBe("pnpm exec vitest run test/reports.test.ts");
    expect(reports.failing_tests?.join("\n")).toContain("packages/reports/test/reports.test.ts");
    // A failed narrowed node run is run once more, the same files in the same
    // package: a node result that did not reproduce is as misleading as a
    // whole-change one that did not.
    expect(reports.reruns).toBe(1);
    expect(reports.rerun?.scope).toBe("files");
    expect(reports.flaky).toBe(false);
    expect(vitestCalls(fixture.packageDir("reports"))).toBe(2);

    const queue = forNode(results, "node_queue")[0]!;
    expect(queue.status).toBe("passed");
    expect(vitestCalls(fixture.packageDir("queue"))).toBe(1);

    // What gates is untouched: the whole-change run passed, was not re-run,
    // and carries no node.
    const whole = wholeChange(results)[0]!;
    expect(whole.status).toBe("passed");
    expect(whole.reruns).toBe(0);
    expect(whole.rerun).toBeNull();
    expect(whole.node).toBeUndefined();
  }, SPAWN_TEST_TIMEOUT_MS);

  it("runs every package step of a node's narrowed run, and records a failure across them", async () => {
    const fixture = graphedWorktree({ queue: "fails", reports: "passes" });

    const results = await runPinnedChecks({
      checks: pinned("unit", WHOLE),
      worktree: fixture.worktree,
      env: process.env,
      secrets: new SecretIndex(),
      // One node over both packages: two steps, the first of which fails.
      nodes: [node("node_all", ["packages/**"])],
      changed_files: fixture.changed_files,
    });

    const all = forNode(results, "node_all")[0]!;
    expect(all.status).toBe("passed");
    // The record's summary is the failing step's, not the passing step's after it.
    expect(all.summary).toMatch(/the node's own run failed \(.*failed/);
    expect(all.rerun?.summary).toMatch(/failed/);
    expect(all.node?.paths).toEqual([
      "packages/queue/test/queue.test.ts",
      "packages/reports/test/reports.test.ts",
    ]);
    // The second package's step ran although the first had failed, so the
    // recorded paths are what actually ran: once in the run, once in the re-run.
    expect(vitestCalls(fixture.packageDir("queue"))).toBe(2);
    expect(vitestCalls(fixture.packageDir("reports"))).toBe(2);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("narrows only to what the narrow form runs: a vitest test file, wherever it sits", async () => {
    const fixture = graphedWorktree({ queue: "passes", reports: "passes" });
    mkdirSync(join(fixture.packageDir("queue"), "__tests__"), { recursive: true });
    writeFileSync(join(fixture.packageDir("queue"), "__tests__", "queue.test.ts"), "export {};\n");
    writeFileSync(join(fixture.packageDir("queue"), "__tests__", "helpers.ts"), "export {};\n");
    writeFileSync(join(fixture.packageDir("reports"), "test", "test_api.py"), "");

    const results = await runPinnedChecks({
      checks: pinned("unit", WHOLE),
      worktree: fixture.worktree,
      env: process.env,
      secrets: new SecretIndex(),
      nodes: [node("node_queue", ["packages/queue/**"]), node("node_py", ["packages/reports/test/test_api.py"])],
      changed_files: [
        ...fixture.changed_files,
        "packages/queue/__tests__/queue.test.ts",
        "packages/queue/__tests__/helpers.ts",
        "packages/reports/test/test_api.py",
      ],
    });

    // A test file under __tests__ narrows; a helper beside it does not.
    const queue = forNode(results, "node_queue")[0]!;
    expect(queue.node?.scope).toBe("files");
    expect(queue.node?.paths).toEqual([
      "packages/queue/test/queue.test.ts",
      "packages/queue/__tests__/queue.test.ts",
    ]);
    expect(queue.command).toBe("pnpm exec vitest run test/queue.test.ts __tests__/queue.test.ts");

    // A test for another runner is not handed to vitest: the node carries the
    // whole-change result.
    const py = forNode(results, "node_py")[0]!;
    expect(py.node?.scope).toBe("task");
    expect(py.node?.note).toContain("the check's runner collects");
    expect(py.command).toBe(WHOLE.join(" "));
  }, SPAWN_TEST_TIMEOUT_MS);

  it("carries the pinned command's failure to every node, its lines included, and runs nothing narrowed", async () => {
    const fixture = graphedWorktree({ queue: "passes", reports: "passes" }, "fails");

    const results = await runPinnedChecks({
      checks: pinned("unit", WHOLE),
      worktree: fixture.worktree,
      env: process.env,
      secrets: new SecretIndex(),
      nodes: [node("node_queue", ["packages/queue/**"]), node("node_reports", ["packages/reports/**"])],
      changed_files: fixture.changed_files,
    });

    const whole = wholeChange(results)[0]!;
    expect(whole.status).toBe("failed");
    expect(whole.command).toBe(WHOLE.join(" "));
    expect(whole.detail).toContain("whole-suite-failure-line");
    for (const id of ["node_queue", "node_reports"]) {
      const carried = forNode(results, id)[0]!;
      expect(carried.status).toBe("failed");
      expect(carried.command).toBe(WHOLE.join(" "));
      expect(carried.summary).toBe(whole.summary);
      expect(carried.detail).toBe(whole.detail);
      expect(carried.node?.scope).toBe("task");
      expect(carried.node?.note).toContain("did not pass over the whole change");
    }
    // The packages' passing runners were never asked, so nothing narrowed can
    // stand beside the pinned command's failure.
    expect(vitestCalls(fixture.packageDir("queue"))).toBe(0);
    expect(vitestCalls(fixture.packageDir("reports"))).toBe(0);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("records nothing for a node on a flat plan", async () => {
    const fixture = graphedWorktree({ queue: "passes", reports: "passes" });

    const results = await runPinnedChecks({
      checks: pinned("unit", WHOLE),
      worktree: fixture.worktree,
      env: process.env,
      secrets: new SecretIndex(),
      changed_files: fixture.changed_files,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.node).toBeUndefined();
    expect(vitestCalls(fixture.packageDir("queue"))).toBe(0);
  }, SPAWN_TEST_TIMEOUT_MS);
});
