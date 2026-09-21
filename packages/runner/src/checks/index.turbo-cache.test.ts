import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SecretIndex } from "@perbo/contracts";
import { runPinnedChecks } from "./index.js";
import { scratchDirectories } from "@perbo/test-support";
import { initRepository } from "@perbo/test-support";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A check runs on the attempt's tree, never on turbo's cache.
 *
 * turbo hashes the inputs a package declares. A suite that reads anything else
 * — the repository's own committed tree, a file a sibling package owns — is
 * outside that hash, so a second run over a tree that has since broken is a
 * cache hit: turbo replays the first run's logs and its exit code, and the
 * check is reported passed without having run. A check reported as passed must
 * have run on the tree it is judging.
 *
 * The repository below is exactly that shape, and it is real: a turbo pipeline,
 * a package whose `test` task reads a file the package does not declare, and
 * the turbo binary this workspace installs. Nothing about the caching is
 * doubled, because the claim is about what turbo does.
 */

/** How long one case is given: two turbo runs, each spawning a package manager. */
const TURBO_TEST_TIMEOUT_MS = 120_000;

/** The timeout a check in these fixtures is run under; well above two turbo runs. */
const CHECK_TIMEOUT_MS = 60_000;

/**
 * The turbo this workspace installs, from the nearest `node_modules/.bin` above
 * this file.
 *
 * Absent is a failure rather than a skip: every claim in this file is about
 * what turbo does with its cache, and a silent skip would be the same defect
 * one level up — a check that reports success without having run.
 */
function turboBinary(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", "turbo");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "no node_modules/.bin/turbo above this file: install the workspace before running this suite",
      );
    }
    dir = parent;
  }
}

const write = (root: string, path: string, contents: string): void => {
  const file = join(root, ...path.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
};

/**
 * A turbo repository whose one package's `test` task reads `shared/value.txt`,
 * which lives outside the package and is therefore outside the task's inputs.
 *
 * Committed, and with `.turbo/` ignored: turbo hashes a package from git, so a
 * repository whose own run leaves untracked log files behind hashes differently
 * every time and never reaches a cache hit — which would make the case below
 * pass for the wrong reason.
 */
function turboRepository(prefix: string): { dir: string; shared: string } {
  const dir = scratch(prefix);
  write(dir, "package.json", `${JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@9.15.9" }, null, 2)}\n`);
  write(dir, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(dir, ".gitignore", ".turbo/\nnode_modules/\n");
  write(dir, "turbo.json", `${JSON.stringify({ tasks: { test: {} } }, null, 2)}\n`);
  write(
    dir,
    "packages/a/package.json",
    `${JSON.stringify({ name: "a", version: "0.0.0", scripts: { test: "node test.mjs" } }, null, 2)}\n`,
  );
  write(
    dir,
    "packages/a/test.mjs",
    [
      'import { readFileSync } from "node:fs";',
      'const value = readFileSync(new URL("../../shared/value.txt", import.meta.url), "utf8").trim();',
      "console.log(`shared/value.txt says ${value}`);",
      'if (value !== "ok") { console.log("FAIL  shared/value.txt is not ok"); process.exit(1); }',
      "",
    ].join("\n"),
  );
  write(dir, "shared/value.txt", "ok\n");
  initRepository(dir, { message: "first" });
  return { dir, shared: join(dir, "shared", "value.txt") };
}

/** The pinned check that repository is judged by: turbo, run over its one task. */
const turboCheck = (): Parameters<typeof runPinnedChecks>[0]["checks"] => [
  {
    check_id: "check_unit",
    name: "unit",
    // `other` rather than `unit`: the re-run a failed unit check earns is a
    // second question this file is not asking, and it would put a vitest
    // resolution in the middle of a claim about turbo's cache.
    kind: "other",
    command: [turboBinary(), "run", "test"],
    timeout_ms: CHECK_TIMEOUT_MS,
    definition_path: "turbo.json",
    origin: "configured",
  },
];

const runOnce = (worktree: string) =>
  runPinnedChecks({
    checks: turboCheck(),
    worktree,
    env: process.env,
    secrets: new SecretIndex(),
  });

describe("a check whose command runs turbo", () => {
  it(
    "fails on a tree that has broken, where turbo's cache would have replayed a pass",
    async () => {
      const repo = turboRepository("perbo-turbo-cache-");

      const [first] = await runOnce(repo.dir);
      expect(first!.status).toBe("passed");

      // The tree the second run judges is broken, and the break is outside the
      // package's declared inputs — which is the whole of the defect: the hash
      // turbo computes is unchanged.
      writeFileSync(repo.shared, "broken\n");

      const [second] = await runOnce(repo.dir);
      expect(second!.status).toBe("failed");
      expect(second!.detail).toContain("shared/value.txt says broken");
    },
    TURBO_TEST_TIMEOUT_MS,
  );

  it(
    "records the argv it ran, with the flag that ignores the cache on it",
    async () => {
      const repo = turboRepository("perbo-turbo-argv-");

      const [result] = await runOnce(repo.dir);

      // The record says what ran. A recorded command without the flag would
      // describe a run nobody made.
      expect(result!.command).toContain("turbo run test");
      expect(result!.command).toContain("--force");
    },
    TURBO_TEST_TIMEOUT_MS,
  );
});

describe("every check, whatever its command", () => {
  it(
    "runs with TURBO_FORCE set, so a turbo under the command is uncached too",
    async () => {
      const worktree = scratch("perbo-turbo-env-");
      const script = join(worktree, "report-env.mjs");
      writeFileSync(
        script,
        'console.log(`TURBO_FORCE=${process.env.TURBO_FORCE ?? "(unset)"}`);\n',
      );

      const [result] = await runPinnedChecks({
        checks: [
          {
            check_id: "check_lint",
            name: "lint",
            kind: "lint",
            // Not turbo, and not a package script: the environment is what
            // reaches a turbo the argv cannot see.
            command: ["node", script],
            timeout_ms: CHECK_TIMEOUT_MS,
            definition_path: null,
            origin: "configured",
          },
        ],
        worktree,
        env: process.env,
        secrets: new SecretIndex(),
      });

      expect(result!.status).toBe("passed");
      expect(result!.detail).toContain("TURBO_FORCE=true");
      // An argv that runs no turbo is passed through untouched.
      expect(result!.command).toBe(`node ${script}`);
    },
    TURBO_TEST_TIMEOUT_MS,
  );
});
