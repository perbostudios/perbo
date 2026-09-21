import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretIndex } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";
import { CHECK_DETAIL_MAX_CHARS, runPinnedChecks } from "../src/checks/index.js";
import { parseTestOutput, planRerun, resolveFailures } from "../src/checks/internal/rerun.js";

const scratch = scratchDirectories("perbo-runner-");

const ESC = String.fromCharCode(27);
const red = (text: string) => `${ESC}[31m${text}${ESC}[39m`;
const dim = (text: string) => `${ESC}[2m${text}${ESC}[22m`;

/**
 * One turbo task's vitest output, with the colour a terminal reporter writes
 * and the `<package>:<task>:` prefix turbo puts in front of every line.
 */
const FAILING_STDOUT = [
  "@perbo/cli:test: cache bypass, force executing 557b8c0864df9f45",
  "@perbo/cli:test: ",
  "@perbo/cli:test: > @perbo/cli@0.1.1 test /repo/apps/cli",
  "@perbo/cli:test: > vitest run",
  "@perbo/cli:test: ",
  `@perbo/cli:test:  ${red("❯")} test/x.test.ts ${dim("(")}2 tests | ${red("1 failed")}${dim(")")} 58ms`,
  `@perbo/cli:test: ${red("     × case")} 5ms`,
  "@perbo/cli:test: ",
  `@perbo/cli:test: ${red("⎯⎯⎯")} Failed Tests 1 ${red("⎯⎯⎯")}`,
  "@perbo/cli:test: ",
  `@perbo/cli:test: ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m test/x.test.ts${dim(" > ")}suite${dim(" > ")}case`,
  `@perbo/cli:test: ${red("AssertionError: expected 1 to be 2 // Object.is equality")}`,
  "@perbo/cli:test: ",
  `@perbo/cli:test: ${dim(" Test Files ")} ${red("1 failed")}${dim(" | ")}12 passed (13)`,
  `@perbo/cli:test: ${dim("      Tests ")} ${red("1 failed")}${dim(" | ")}142 passed (143)`,
].join("\n");

/** What turbo writes to stderr — and all the record used to keep. */
const FAILING_STDERR = [
  "• turbo 2.10.12",
  "@perbo/cli#test:  ERROR  command (/repo/apps/cli) pnpm run test exited (1)",
  " ERROR  run failed: command  exited (1)",
].join("\n");

const PASSING_STDOUT = [
  "@perbo/cli:test:  ✓ test/x.test.ts (2 tests) 12ms",
  "@perbo/cli:test:  Test Files  13 passed (13)",
  "@perbo/cli:test:       Tests  143 passed (143)",
].join("\n");

describe("parsing a test runner's own output", () => {
  it("names the failing test from the FAIL marker, with its file and its case", () => {
    const parsed = parseTestOutput(`${FAILING_STDOUT}\n${FAILING_STDERR}`);
    expect(parsed.failing).toEqual([
      { package_name: "@perbo/cli", file: "test/x.test.ts", name: "suite > case" },
    ]);
  });

  it("keeps the FAIL line, the assertion and both summary lines as evidence", () => {
    const parsed = parseTestOutput(FAILING_STDOUT);
    const joined = [...parsed.evidence, ...parsed.summary].join("\n");
    expect(joined).toContain("FAIL  test/x.test.ts > suite > case");
    expect(joined).toContain("AssertionError: expected 1 to be 2");
    expect(joined).toContain("Test Files  1 failed | 12 passed (13)");
    expect(joined).toContain("Tests  1 failed | 142 passed (143)");
    // Colour is a terminal artefact and never reaches the record.
    expect(joined).not.toContain(ESC);
  });

  it("takes a bare × case under the file that owns it when no FAIL block was printed", () => {
    const parsed = parseTestOutput(
      [
        " ❯ test/timing.test.ts (3 tests | 1 failed) 5001ms",
        "   × admits a ticket synchronously 5000ms",
        "     → Test timed out in 5000ms.",
        " Tests  1 failed | 2 passed (3)",
      ].join("\n"),
    );
    expect(parsed.failing).toEqual([
      { package_name: null, file: "test/timing.test.ts", name: "admits a ticket synchronously" },
    ]);
    expect(parsed.evidence.join("\n")).toContain("Test timed out in 5000ms");
  });

  it("names nothing when the output carries no test-runner markers", () => {
    const parsed = parseTestOutput("ERROR run failed: command exited (1)");
    expect(parsed.failing).toEqual([]);
    expect(parsed.summary).toEqual([]);
  });
});

/** A worktree shaped like this repository: one workspace package under apps/. */
function workspaceFixture(): string {
  const root = scratch("perbo-rerun-");
  mkdirSync(join(root, "apps", "cli", "test"), { recursive: true });
  writeFileSync(
    join(root, "apps", "cli", "package.json"),
    JSON.stringify({ name: "@perbo/cli", scripts: { test: "vitest run" } }),
  );
  writeFileSync(join(root, "apps", "cli", "test", "x.test.ts"), "// a test\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
  return root;
}

const TURBO_TEST = ["pnpm", "exec", "turbo", "run", "test"];

describe("planning the re-run", () => {
  it("runs only the failing files, in the package that owns them", () => {
    const worktree = workspaceFixture();
    const resolved = resolveFailures(
      [{ package_name: "@perbo/cli", file: "test/x.test.ts", name: "suite > case" }],
      worktree,
    );
    expect(resolved[0]!.label).toBe("apps/cli/test/x.test.ts > suite > case");
    expect(resolved[0]!.rerunnable).toBe(true);

    const plan = planRerun({ command: TURBO_TEST, worktree, resolved });
    expect(plan.scope).toBe("files");
    expect(plan.note).toBeNull();
    expect(plan.steps).toEqual([
      { argv: ["pnpm", "exec", "vitest", "run", "test/x.test.ts"], cwd: join(worktree, "apps", "cli") },
    ]);
  });

  it("refuses a path that escapes the package, is absolute, or reads as a flag", () => {
    const worktree = workspaceFixture();
    const resolved = resolveFailures(
      [
        { package_name: "@perbo/cli", file: "../../../../etc/passwd", name: null },
        { package_name: "@perbo/cli", file: "/etc/shadow", name: null },
        { package_name: "@perbo/cli", file: "--reporter=./evil.js", name: null },
        { package_name: "@perbo/cli", file: "test/absent.test.ts", name: null },
      ],
      worktree,
    );
    for (const failure of resolved) expect(failure.rerunnable).toBe(false);

    const plan = planRerun({ command: TURBO_TEST, worktree, resolved });
    expect(plan.scope).toBe("task");
    expect(plan.steps).toEqual([{ argv: TURBO_TEST, cwd: worktree }]);
    expect(plan.note).toContain("could not be attributed");
  });

  it("falls back to the whole task when the output named no test at all", () => {
    const worktree = workspaceFixture();
    const plan = planRerun({ command: TURBO_TEST, worktree, resolved: [] });
    expect(plan.scope).toBe("task");
    expect(plan.steps).toEqual([{ argv: TURBO_TEST, cwd: worktree }]);
    expect(plan.note).toContain("no failing test names");
  });

  it("groups the files of one package into a single re-run", () => {
    const worktree = workspaceFixture();
    writeFileSync(join(worktree, "apps", "cli", "test", "y.test.ts"), "// another\n");
    const resolved = resolveFailures(
      [
        { package_name: "@perbo/cli", file: "test/x.test.ts", name: "suite > one" },
        { package_name: "@perbo/cli", file: "test/x.test.ts", name: "suite > two" },
        { package_name: "@perbo/cli", file: "test/y.test.ts", name: null },
      ],
      worktree,
    );
    const plan = planRerun({ command: TURBO_TEST, worktree, resolved });
    expect(plan.steps).toEqual([
      {
        argv: ["pnpm", "exec", "vitest", "run", "test/x.test.ts", "test/y.test.ts"],
        cwd: join(worktree, "apps", "cli"),
      },
    ]);
  });
});

/**
 * A stand-in for the pinned unit check: it prints vitest-shaped output and
 * decides its exit code from a counter on disk, so the first call and the
 * re-run can differ.
 */
function fakeUnitCheck(mode: "flaky" | "reproduces" | "unnamed"): {
  command: string[];
  calls: () => number;
} {
  const dir = scratch("perbo-fake-check-");
  const counter = join(dir, "calls");
  const script = join(dir, "check.cjs");
  writeFileSync(
    script,
    [
      'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
      `const counter = ${JSON.stringify(counter)};`,
      `const mode = ${JSON.stringify(mode)};`,
      'const calls = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;',
      "writeFileSync(counter, String(calls + 1));",
      'if (mode === "flaky" && calls > 0) {',
      `  process.stdout.write(${JSON.stringify(`${PASSING_STDOUT}\n`)});`,
      "  process.exit(0);",
      "}",
      'if (mode === "unnamed") {',
      '  process.stdout.write("turbo 2.10.12\\n" + "filler line\\n".repeat(400));',
      `  process.stderr.write(${JSON.stringify(`${FAILING_STDERR}\n`)});`,
      "  process.exit(1);",
      "}",
      // The names sit near the top and thousands of lines of noise follow, so a
      // record that keeps only the tail of the log keeps nothing that names them.
      `process.stdout.write(${JSON.stringify(`${FAILING_STDOUT}\n`)} + "filler line\\n".repeat(1000));`,
      `process.stderr.write(${JSON.stringify(`${FAILING_STDERR}\n`)});`,
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  return {
    command: ["node", script],
    calls: () => (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0),
  };
}

const pinned = (command: string[], kind: "unit" | "lint" = "unit") => [
  {
    check_id: kind === "unit" ? "check_unit" : "check_lint",
    name: kind,
    kind,
    command,
    timeout_ms: 30_000,
    definition_path: null,
    origin: "configured" as const,
  },
];

/**
 * The re-runs below reach the whole-task fallback: the fixture worktree holds
 * no workspace package by the name the output carries, which is the honest
 * result of a stand-in command that prints another repository's paths.
 */
describe("a failing unit check re-runs once before it closes the gate", () => {
  it("records the flake and leaves the check passed", async () => {
    const check = fakeUnitCheck("flaky");
    const results = await runPinnedChecks({
      checks: pinned(check.command),
      worktree: scratch("perbo-wt-"),
      env: process.env,
      secrets: new SecretIndex(),
    });

    const unit = results[0]!;
    expect(unit.status).toBe("passed");
    expect(unit.flaky).toBe(true);
    expect(unit.reruns).toBe(1);
    expect(unit.failing_tests).toEqual(["@perbo/cli test/x.test.ts > suite > case"]);
    expect(unit.rerun?.status).toBe("passed");
    expect(unit.rerun?.failing_tests).toEqual([]);
    expect(check.calls()).toBe(2);
  });

  it("keeps the check failed, with both runs' lists, when the failure reproduces", async () => {
    const check = fakeUnitCheck("reproduces");
    const results = await runPinnedChecks({
      checks: pinned(check.command),
      worktree: scratch("perbo-wt-"),
      env: process.env,
      secrets: new SecretIndex(),
    });

    const unit = results[0]!;
    expect(unit.status).toBe("failed");
    expect(unit.flaky).toBe(false);
    expect(unit.reruns).toBe(1);
    expect(unit.failing_tests).toEqual(["@perbo/cli test/x.test.ts > suite > case"]);
    expect(unit.rerun?.failing_tests).toEqual(["@perbo/cli test/x.test.ts > suite > case"]);
    expect(check.calls()).toBe(2);
  });

  it("keeps the FAIL line and the Tests summary in a capped detail", async () => {
    const check = fakeUnitCheck("reproduces");
    const results = await runPinnedChecks({
      checks: pinned(check.command),
      worktree: scratch("perbo-wt-"),
      env: process.env,
      secrets: new SecretIndex(),
    });

    const detail = results[0]!.detail ?? "";
    expect(detail).toContain("FAIL  test/x.test.ts > suite > case");
    expect(detail).toContain("Tests  1 failed | 142 passed (143)");
    expect(detail.length).toBeLessThanOrEqual(CHECK_DETAIL_MAX_CHARS);
    expect(detail.length).toBeGreaterThan(200);
  });

  it("re-runs the whole task, and says so, when the output named no test", async () => {
    const check = fakeUnitCheck("unnamed");
    const results = await runPinnedChecks({
      checks: pinned(check.command),
      worktree: scratch("perbo-wt-"),
      env: process.env,
      secrets: new SecretIndex(),
    });

    const unit = results[0]!;
    expect(unit.status).toBe("failed");
    expect(unit.failing_tests).toEqual([]);
    expect(unit.reruns).toBe(1);
    expect(unit.rerun?.scope).toBe("task");
    expect(unit.rerun?.note).toContain("no failing test names");
    expect(unit.rerun?.command).toBe(check.command.join(" "));
    expect(check.calls()).toBe(2);
  });

  it("leaves a check of another kind alone", async () => {
    const check = fakeUnitCheck("flaky");
    const results = await runPinnedChecks({
      checks: pinned(check.command, "lint"),
      worktree: scratch("perbo-wt-"),
      env: process.env,
      secrets: new SecretIndex(),
    });

    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.reruns).toBe(0);
    expect(results[0]!.rerun).toBeNull();
    expect(check.calls()).toBe(1);
  });

  it("runs the checks one at a time, and the re-run after all of them", async () => {
    const order: string[] = [];
    const failing = fakeUnitCheck("flaky");
    await runPinnedChecks({
      checks: [
        ...pinned(failing.command),
        {
          check_id: "check_lint",
          name: "lint",
          kind: "lint" as const,
          command: ["node", "-e", "process.exit(0)"],
          timeout_ms: 30_000,
          definition_path: null,
          origin: "configured" as const,
        },
      ],
      worktree: scratch("perbo-wt-"),
      env: process.env,
      secrets: new SecretIndex(),
      onProgress: (message) => order.push(message),
    });

    const unit = order.findIndex((line) => line.startsWith("check unit"));
    const lint = order.findIndex((line) => line.startsWith("check lint"));
    const rerun = order.findIndex((line) => line.startsWith("re-run unit"));
    expect(unit).toBeGreaterThanOrEqual(0);
    expect(unit).toBeLessThan(lint);
    expect(lint).toBeLessThan(rerun);
  });
}, SPAWN_TEST_TIMEOUT_MS);
