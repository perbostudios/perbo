import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretIndex, type CheckResult, type PlanNode } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS, scratchDirectories } from "@perbo/test-support";
import { runPinnedChecks, type PinnedCheck } from "./index.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * PRB-25's shape, replayed through the checks with real processes: a
 * repository whose one pinned unit check is `node --test`, run at the root,
 * over an app package whose test file is a `node:test` file. The narrowed
 * runs are `node --test`, Vitest is never spawned, and what the result says
 * — its status, command, summary and lines — is the pinned command's.
 *
 * A `vitest` that counts its calls sits on `PATH` and in the package's
 * `node_modules/.bin`, so a run aimed at Vitest by any route is seen.
 */

const PINNED: PinnedCheck[] = [
  {
    check_id: "check_unit",
    name: "tests",
    kind: "unit",
    command: ["node", "--test"],
    timeout_ms: 60_000,
    definition_path: null,
    origin: "configured",
  },
];

const NODES: PlanNode[] = [
  { id: "node_1", title: "server", criteria: ["ac_1"], paths: ["inspo/**"] },
];

const CHANGED = ["inspo/server.js", "inspo/test/app.test.js"];

/** A `node:test` file whose one case passes, fails, or fails only when run from inside the package. */
function nodeTestFile(verdict: "passes" | "fails" | "fails-in-package"): string {
  const assertion =
    verdict === "passes"
      ? "assert.equal(1 + 1, 2);"
      : verdict === "fails"
        ? "assert.equal(1 + 1, 3);"
        : 'assert.notEqual(require("node:path").basename(process.cwd()), "inspo");';
  return [
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    `test("adds", () => { ${assertion} });`,
    "",
  ].join("\n");
}

interface Fixture {
  worktree: string;
  env: NodeJS.ProcessEnv;
  vitestCalls: () => number;
  write: (verdict: "passes" | "fails" | "fails-in-package") => void;
}

function prb25(verdict: "passes" | "fails" | "fails-in-package"): Fixture {
  const worktree = scratch("perbo-prb25-");
  const inspo = join(worktree, "inspo");
  mkdirSync(join(inspo, "test"), { recursive: true });
  writeFileSync(join(inspo, "package.json"), JSON.stringify({ name: "inspo", scripts: { start: "node server.js" } }));
  writeFileSync(join(inspo, "server.js"), "module.exports = {};\n");
  const write = (next: "passes" | "fails" | "fails-in-package") =>
    writeFileSync(join(inspo, "test", "app.test.js"), nodeTestFile(next));
  write(verdict);

  const counter = join(scratch("perbo-prb25-vitest-"), "calls");
  const shim = [
    "#!/usr/bin/env node",
    'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
    `const counter = ${JSON.stringify(counter)};`,
    'writeFileSync(counter, String((existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1));',
    'console.log("FAIL  test/app.test.js [ test/app.test.js ]");',
    'console.log("Error: No test suite found in file test/app.test.js");',
    "process.exit(1);",
    "",
  ].join("\n");
  const pathBin = scratch("perbo-prb25-bin-");
  for (const bin of [pathBin, join(inspo, "node_modules", ".bin")]) {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "vitest"), shim, { mode: 0o755 });
  }
  return {
    worktree,
    env: { ...process.env, PATH: `${pathBin}${delimiter}${process.env.PATH ?? ""}` },
    vitestCalls: () => (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0),
    write,
  };
}

async function check(fixture: Fixture, progress: string[]): Promise<{ whole: CheckResult; node: CheckResult }> {
  const results = await runPinnedChecks({
    checks: PINNED,
    worktree: fixture.worktree,
    env: fixture.env,
    secrets: new SecretIndex(),
    nodes: NODES,
    changed_files: CHANGED,
    onProgress: (line) => progress.push(line),
  });
  expect(results).toHaveLength(2);
  return {
    whole: results.find((result) => result.node === undefined)!,
    node: results.find((result) => result.node?.node_id === "node_1")!,
  };
}

describe("a repository whose pinned unit check is `node --test`", () => {
  it("fails on the pinned command alone, with its lines, and never runs Vitest", async () => {
    const fixture = prb25("fails");
    const progress: string[] = [];
    const { whole, node } = await check(fixture, progress);

    expect(whole.status).toBe("failed");
    expect(whole.command).toBe("node --test");
    expect(whole.detail).toContain("2 !== 3");
    expect(whole.detail).not.toContain("vitest");
    expect(whole.detail).not.toContain("re-run");
    expect(whole.summary).not.toContain("vitest");
    // node --test's output names no file the parser reads, so the re-run is
    // the pinned command whole: never another runner.
    expect(whole.rerun?.scope).toBe("task");
    expect(whole.rerun?.command).toBe("node --test");
    expect(whole.rerun?.status).toBe("failed");

    // The node carries the pinned command's failure: what a finding quotes
    // for it is node --test's, word for word.
    expect(node.status).toBe("failed");
    expect(node.command).toBe("node --test");
    expect(node.summary).toBe(whole.summary);
    expect(node.detail).toBe(whole.detail);

    expect(fixture.vitestCalls()).toBe(0);
    expect(progress.join("\n")).not.toContain("vitest");
  }, SPAWN_TEST_TIMEOUT_MS);

  it("passes once the fix makes `node --test` pass, narrowing the node with node --test", async () => {
    const fixture = prb25("fails");
    expect((await check(fixture, [])).whole.status).toBe("failed");

    fixture.write("passes");
    const progress: string[] = [];
    const { whole, node } = await check(fixture, progress);

    expect(whole.status).toBe("passed");
    expect(whole.command).toBe("node --test");
    expect(node.status).toBe("passed");
    expect(node.node?.scope).toBe("files");
    expect(node.node?.paths).toEqual(["inspo/test/app.test.js"]);
    expect(node.command).toBe("node --test test/app.test.js");
    expect(fixture.vitestCalls()).toBe(0);
    expect(progress.join("\n")).not.toContain("vitest");
  }, SPAWN_TEST_TIMEOUT_MS);

  it("keeps a node's narrowed failure as evidence and leaves the check passed where `node --test` passed", async () => {
    // Passes from the root, where the pinned command runs; fails from inside
    // the package, where the node's narrowed run starts.
    const fixture = prb25("fails-in-package");
    const { whole, node } = await check(fixture, []);

    expect(whole.status).toBe("passed");
    expect(node.status).toBe("passed");
    expect(node.command).toBe("node --test test/app.test.js");
    expect(node.summary).toContain("the node's own run failed");
    expect(node.summary).toContain("node --test passed over the whole change");
    expect(node.rerun?.command).toBe("node --test test/app.test.js");
    expect(fixture.vitestCalls()).toBe(0);
  }, SPAWN_TEST_TIMEOUT_MS);
});
