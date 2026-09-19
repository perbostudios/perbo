import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseUnifiedDiff, type CheckResult } from "@perbo/contracts";
import { gitEnv, run } from "@perbo/workspace";
import { RUNTIME_FILES, type LoadedFixture } from "./corpus.js";
import { cachePathFor, clonePathFor } from "./prepare.js";

/**
 * Fail-first evidence for a pinned fixture (`perbo-corpus baseline`).
 *
 * A pinned fixture's `checks.json` records one run, at the head commit, so it
 * cannot show a test failing without the fix — and this repository's own
 * convention is that tests fail first. The reviewer asked for that evidence in
 * two of six `cln-016` reviews, correctly, and it will ask it of every pinned
 * fixture: the finding is a property of the derivation, not of any commit.
 *
 * The evidence is obtainable. Check out the base commit, apply only the test
 * files from the diff, and run the repository's own suite. What happens next is
 * the answer.
 */

/**
 * Test files, by the conventions of the repositories the corpus pins.
 *
 * Path segments and suffixes only — never a substring of a filename, which
 * would classify `latest.ts` as a test.
 */
const TEST_DIRECTORIES = new Set(["__tests__", "test", "tests", "spec", "__test__"]);
const TEST_SUFFIXES = [".test.", ".spec."];

export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => TEST_DIRECTORIES.has(segment))) return true;
  const file = segments[segments.length - 1] ?? "";
  if (TEST_SUFFIXES.some((suffix) => file.includes(suffix))) return true;
  return file.startsWith("test_") && file.endsWith(".py");
}

export interface PathSplit {
  tests: string[];
  source: string[];
}

export function splitTestPaths(diff: string): PathSplit {
  const split: PathSplit = { tests: [], source: [] };
  for (const file of parseUnifiedDiff(diff)) {
    (isTestPath(file.path) ? split.tests : split.source).push(file.path);
  }
  return split;
}

/** A suite that exits non-zero because it could not even load is weaker evidence. */
const COLLECTION_ERROR =
  /error during collection|ModuleNotFoundError|Cannot find module|No test files found|error TS\d+|SyntaxError/i;

/**
 * Read a baseline run, with `passed` meaning **the evidence was obtained**.
 *
 * The inversion is deliberate and is the whole reason this is a separate check
 * kind. For a baseline run the tests *failing* is the good outcome, and the
 * reviewer's prompt treats a failed check as a measurement that outranks it —
 * so a literal `status: "failed"` here would make it block a fixture for
 * having exactly the evidence it asked for. Encoding "the tests discriminate"
 * as `passed` keeps "passed is good" true of every check kind.
 */
export function baselineStatus(
  result: { code: number; output: string },
  where = "the base commit",
): {
  status: CheckResult["status"];
  summary: string;
  detail: string;
} {
  if (result.code === 0) {
    return {
      status: "failed",
      summary: `the change's own tests passed at ${where}`,
      detail:
        `The tests added or changed by this diff were applied to ${where} and passed ` +
        "against the unfixed code. They therefore do not discriminate: they would have passed " +
        "before the change and prove nothing about it.",
    };
  }
  const collection = COLLECTION_ERROR.test(result.output);
  return {
    status: "passed",
    summary: collection
      ? `the change's own tests could not load at ${where}`
      : `the change's own tests failed at ${where}`,
    detail: collection
      ? `The tests added or changed by this diff were applied to ${where} and the run ` +
        "ended in a collection or compile error rather than an assertion failure. That shows the " +
        "test file is new or references code the unchanged tree does not have — weaker evidence " +
        "than a failing assertion, and recorded as such."
      : `The tests added or changed by this diff were applied to ${where} and failed ` +
        "against the unfixed code, then passed with the change. They discriminate.",
  };
}

export interface BaselineResult {
  fixture_id: string;
  check: CheckResult | null;
  /** Why no check could be produced, when that is the answer. */
  skipped: string | null;
  duration_ms: number;
}

/**
 * Run the change's own tests against the base commit, in a throwaway worktree.
 *
 * The worktree is taken off the shared clone, so it costs one checkout and no
 * objects, and it is removed afterwards — the fixture's own prepared tree is
 * at the head commit and must stay there.
 */
export async function measureBaseline(args: {
  fixture: LoadedFixture;
  cacheRoot: string;
  onProgress?: (message: string) => void;
}): Promise<BaselineResult> {
  const pinned = args.fixture.fixture.pinned_repository;
  const id = args.fixture.fixture.id;
  const progress = args.onProgress ?? (() => undefined);
  const started = Date.now();
  const skip = (why: string): BaselineResult => ({
    fixture_id: id,
    check: null,
    skipped: why,
    duration_ms: Date.now() - started,
  });

  if (!pinned) return measureAuthoredBaseline(args.fixture, started);
  const split = splitTestPaths(args.fixture.diff);
  if (split.tests.length === 0) {
    return skip("the change adds or changes no test file, so there is no baseline to take");
  }

  const clone = clonePathFor(args.cacheRoot, pinned.url);
  if (!existsSync(join(clone, ".git"))) return skip("the repository is not prepared");
  const work = join(cachePathFor(args.cacheRoot, id), "baseline");
  mkdirSync(resolve(work, ".."), { recursive: true });

  const git = (argv: string[], cwd: string) =>
    run(["git", ...argv], { cwd, env: gitEnv(), timeoutMs: 600_000, maxOutputBytes: 32 * 1024 * 1024 });

  try {
    if (!existsSync(join(work, ".git"))) {
      progress(`worktree at ${pinned.base_commit.slice(0, 12)}`);
      const added = await git(["worktree", "add", "--detach", "--force", work, pinned.base_commit], clone);
      if (added.code !== 0) return skip(`could not check out the base commit: ${added.stderr.trim().slice(-200)}`);
    } else {
      await git(["checkout", "--detach", "--force", pinned.base_commit], work);
      await git(["clean", "-fdx", "--exclude=node_modules", "--exclude=.venv"], work);
    }

    progress(`apply ${split.tests.length} test file(s)`);
    const patch = await git(
      ["diff", "--no-color", `${pinned.base_commit}..${pinned.head_commit}`, "--", ...split.tests],
      work,
    );
    if (patch.code !== 0 || patch.stdout.trim().length === 0) {
      return skip("could not produce a test-only patch");
    }
    // Through a file rather than stdin: `run` is argv-only by design and does
    // not write to a child's input.
    const patchFile = join(cachePathFor(args.cacheRoot, id), "tests-only.patch");
    writeFileSync(patchFile, patch.stdout);
    const applied = await git(["apply", "--whitespace=nowarn", patchFile], work);
    if (applied.code !== 0) {
      return skip(`the test-only patch does not apply to the base commit: ${applied.stderr.trim().slice(-200)}`);
    }

    // The inherited environment, for the reasons recorded in `runnable.ts`.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const command of pinned.setup_commands) {
      progress(command[0] === "pnpm" && command[1] === "run" ? `${command[2]}` : "install");
      const step = await run([...command], { cwd: work, env, timeoutMs: 1_800_000 });
      if (step.code !== 0) {
        return skip(
          `the base commit fails \`${command.join(" ")}\`: ${step.stderr.trim().slice(-200)}`,
        );
      }
    }

    progress("run the suite without the fix");
    const test = await run([...pinned.verify_command], { cwd: work, env, timeoutMs: 1_800_000 });
    // A killed run has no exit code and is not evidence in either direction.
    if (test.code === null) return skip("the suite was killed at the base commit before it finished");
    const read = baselineStatus({ code: test.code, output: `${test.stdout}\n${test.stderr}` });

    return {
      fixture_id: id,
      check: {
        check_id: "check_baseline",
        name: "fail-first",
        kind: "regression-baseline",
        status: read.status,
        summary: read.summary,
        command: `${pinned.verify_command.join(" ")} (at ${pinned.base_commit.slice(0, 12)}, tests only)`,
        detail: `${read.detail} Test files applied: ${split.tests.join(", ")}.`,
        duration_ms: test.duration_ms ?? null,
        source: "file",
      },
      skipped: null,
      duration_ms: Date.now() - started,
    };
  } finally {
    await git(["worktree", "remove", "--force", work], clone).catch(() => undefined);
  }
}

/**
 * The authored branch of the same measurement (`SCP-110`'s open item, closed
 * once the second reason to run it arrived): stage the `before/` tree, copy in
 * the diff's test files from `after/`, and run the suite with the shared
 * runtime files. The result is printed, never written — appending a check to
 * an authored fixture's `checks.json` would change what the reviewer sees on
 * a scored fixture, which is a pre-registered correction, not a flag.
 */
async function measureAuthoredBaseline(
  fixture: LoadedFixture,
  started: number,
): Promise<BaselineResult> {
  const id = fixture.fixture.id;
  const skip = (why: string): BaselineResult => ({
    fixture_id: id,
    check: null,
    skipped: why,
    duration_ms: Date.now() - started,
  });

  const before = join(fixture.dir, "before");
  if (!existsSync(before)) return skip("no before/ tree to measure against");
  const split = splitTestPaths(fixture.diff);
  if (split.tests.length === 0) {
    return skip("the change adds or changes no test file, so there is no baseline to take");
  }

  const dir = mkdtempSync(join(tmpdir(), `perbo-baseline-${id}-`));
  try {
    cpSync(before, dir, { recursive: true });
    for (const test of split.tests) {
      const source = join(fixture.repoDir, test);
      // A test file the diff deletes has no after/ copy; the before tree's own
      // version is already staged and stands.
      if (!existsSync(source)) continue;
      mkdirSync(dirname(join(dir, test)), { recursive: true });
      cpSync(source, join(dir, test));
    }
    for (const file of RUNTIME_FILES) {
      if (!existsSync(join(dir, file))) cpSync(join(fixture.runtimeDir, file), join(dir, file));
    }

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      CI: "1",
    };
    const install = await run(
      ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"],
      { cwd: dir, env, timeoutMs: 300_000 },
    );
    if (install.code !== 0) return skip("the before tree does not install");
    const test = await run(["pnpm", "exec", "vitest", "run"], { cwd: dir, env, timeoutMs: 300_000 });
    if (test.code === null) return skip("the suite was killed at the before tree before it finished");
    const read = baselineStatus({ code: test.code, output: `${test.stdout}\n${test.stderr}` }, "the before tree");

    return {
      fixture_id: id,
      check: {
        check_id: "check_baseline",
        name: "fail-first",
        kind: "regression-baseline",
        status: read.status,
        summary: read.summary,
        command: "pnpm exec vitest run (before tree, after tests only)",
        detail: `${read.detail} Test files applied: ${split.tests.join(", ")}.`,
        duration_ms: test.duration_ms ?? null,
        source: "file",
      },
      skipped: null,
      duration_ms: Date.now() - started,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderBaselines(results: readonly BaselineResult[]): string {
  const lines = ["| Fixture | Fail-first | What happened |", "|---|---|---|"];
  for (const entry of results) {
    lines.push(
      `| \`${entry.fixture_id}\` | ${entry.check ? entry.check.status : "—"} | ` +
        `${entry.check ? entry.check.summary : entry.skipped} |`,
    );
  }
  const obtained = results.filter((entry) => entry.check?.status === "passed").length;
  lines.push(
    "",
    `**${obtained} of ${results.length}** carry evidence that their own tests fail without the change.`,
  );
  return lines.join("\n");
}
