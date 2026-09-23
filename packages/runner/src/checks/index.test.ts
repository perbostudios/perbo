import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretIndex } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { runPinnedChecks } from "./index.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The quarantine list `runPinnedChecks` reads (SCP-246).
 *
 * A unit check whose failing tests are all named on the list is a known,
 * ticketed debt rather than new evidence against the change: the gate does
 * not close on it, and the record says which test and why. A failure the
 * list does not name behaves exactly as it did before the list existed.
 */

/** A "unit" check that always fails, naming one test file that exists on disk. */
function failingUnitCheck(worktree: string): {
  checks: Parameters<typeof runPinnedChecks>[0]["checks"];
} {
  mkdirSync(join(worktree, "test"), { recursive: true });
  writeFileSync(join(worktree, "test", "flaky.test.ts"), "export {};\n");
  const script = join(worktree, "check.mjs");
  writeFileSync(
    script,
    [
      "console.log('FAIL  test/flaky.test.ts > a suite > a case');",
      "console.log('Test Files  1 failed (1)');",
      "console.log('Tests  1 failed (1)');",
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  return {
    checks: [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        command: ["node", script],
        // The re-run below is real — `pnpm exec vitest` resolving against a
        // worktree with no package of its own — so this gives it room to
        // report "no package found" rather than being cut off mid-resolution.
        timeout_ms: 30_000,
        definition_path: null,
        origin: "configured",
      },
    ],
  };
}

describe("a quarantined test", () => {
  it("does not close the gate, and is reported by name and ticket", async () => {
    const worktree = scratch("perbo-checks-quarantined-");
    const { checks } = failingUnitCheck(worktree);

    const [result] = await runPinnedChecks({
      checks,
      worktree,
      env: process.env,
      secrets: new SecretIndex(),
      quarantine: [
        {
          test: "test/flaky.test.ts",
          reason: "fails under a loaded machine",
          ticket: "SCP-246",
        },
      ],
    });

    expect(result!.status).toBe("passed");
    expect(result!.flaky).toBe(false);
    expect(result!.summary).toContain("quarantined");
    expect(result!.summary).toContain("test/flaky.test.ts");
    expect(result!.summary).toContain("SCP-246");
    expect(result!.failing_tests?.some((name) => name.includes("test/flaky.test.ts"))).toBe(true);
  }, 30_000);
});

describe("a failing test off the quarantine list", () => {
  it("closes the gate, as it does today", async () => {
    const worktree = scratch("perbo-checks-unquarantined-");
    const { checks } = failingUnitCheck(worktree);

    const [result] = await runPinnedChecks({
      checks,
      worktree,
      env: process.env,
      secrets: new SecretIndex(),
      // An entry for a different file changes nothing for this one.
      quarantine: [{ test: "test/other.test.ts", reason: "unrelated", ticket: "SCP-1" }],
    });

    expect(result!.status).toBe("failed");
    expect(result!.flaky).toBe(false);
    expect(result!.summary).not.toContain("quarantined");
  }, 30_000);
});

/**
 * A "unit" check that always fails without naming any test file at all — a
 * build error, a bare non-zero exit, anything a test runner's own markers
 * cannot be found in. `resolveFailures` produces nothing to match against a
 * quarantine entry.
 */
function unresolvableUnitCheck(worktree: string): {
  checks: Parameters<typeof runPinnedChecks>[0]["checks"];
} {
  const script = join(worktree, "check.mjs");
  writeFileSync(
    script,
    ["console.error('boom: nothing a test runner would recognise');", "process.exit(1);", ""].join(
      "\n",
    ),
  );
  return {
    checks: [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        command: ["node", script],
        timeout_ms: 10_000,
        definition_path: null,
        origin: "configured",
      },
    ],
  };
}

describe("a failure that named no test file", () => {
  it("closes the gate rather than reporting an empty quarantine entry", async () => {
    const worktree = scratch("perbo-checks-unresolvable-");
    const { checks } = unresolvableUnitCheck(worktree);

    const [result] = await runPinnedChecks({
      checks,
      worktree,
      env: process.env,
      secrets: new SecretIndex(),
      // Non-empty and irrelevant: with no failing test resolved, there is
      // nothing here for the match to reach.
      quarantine: [{ test: "test/somewhere-else.test.ts", reason: "unrelated", ticket: "SCP-1" }],
    });

    expect(result!.status).toBe("failed");
    expect(result!.flaky).toBe(false);
    // The regression this pins: with no failing test parsed, an empty match
    // must not read as "every failing test matched" and report a quarantine
    // entry with nothing in it.
    expect(result!.summary).not.toContain("quarantined");
  }, 15_000);
});

