import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@perbo/workspace";
import { RUNTIME_FILES, defaultCacheDir, type LoadedFixture } from "./corpus.js";
import { cachePathFor } from "./prepare.js";
import type { FixtureRuntime } from "./fixture.js";

/**
 * Can a fixture's own tree be run? (`perbo-corpus runnable`)
 *
 * Stage 2 found that this is the corpus's binding constraint on anything
 * involving an executor: an agent asked to close a finding cannot check its own
 * work without a suite, and a reviewer given no check results has nothing to
 * ground `directly_verified` in. So this measures it, per fixture, and the
 * measurement is written back into `fixture.json` rather than asserted.
 *
 * The trees are never edited. `corpus/runtime/` supplies four files — a
 * `package.json` with vitest, typescript and `@types/node` (so the declared
 * `tsc --noEmit` check is actually runnable against a tree, node builtins
 * included), a lockfile, a tsconfig and a vitest config whose one piece of
 * cleverness resolves `@fixture/<name>` without a workspace. A
 * fixture that already has one of those four keeps its own; that is why
 * `cln-003`, whose stub lockfile is the whole point of the fixture, cannot
 * install.
 */

export interface RunnableResult {
  fixture_id: string;
  runtime: FixtureRuntime;
  install_ms: number;
  test_ms: number;
}

const strip = (text: string) => text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

/**
 * The reason, not the last line — pnpm's tail is often a Node deprecation
 * warning — and the two lines that say it whole (D-NEW-nothing-shown-is-cut).
 */
export function installFailure(stderr: string, stdout: string): string {
  const lines = strip(`${stderr}\n${stdout}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("(Use `node") &&
        !/DeprecationWarning|ExperimentalWarning/.test(line),
    );
  const named = lines.find((line) => /ERR_PNPM|Failure reason|^ERROR\b|specifiers in the lockfile/.test(line));
  const detail = lines[lines.indexOf(named ?? "") + 1];
  return [named ?? lines[lines.length - 1] ?? "install failed", detail]
    .filter(Boolean)
    .join(" — ");
}

/**
 * A summary the runner itself reported as wholly passing.
 *
 * Used only to decide whether a killed process had already succeeded, never to
 * override a reported failure.
 */
const PASSING_SUMMARY =
  /Test Files\s+\d+ passed[^\n]*\n\s*Tests\s+\d+ passed|^\s*\d+ passed(?:, \d+ skipped)?\s*$/m;

/** Two runners, because a pinned fixture's repository chooses its own. */
function summarise(output: string): string {
  const clean = strip(output);
  const files = /Test Files\s+(.*)/.exec(clean)?.[1]?.trim();
  const tests = /Tests\s{2,}(.*)/.exec(clean)?.[1]?.trim();
  if (files) return `${tests ?? "no tests"} in ${files}`;

  // pytest's own tally, in either of the shapes its reporters produce.
  const pytest =
    /^=+ (.*(?:passed|failed|error).*) =+$/m.exec(clean)?.[1]?.trim() ??
    /^\s*(\d+ (?:passed|failed).*)$/m.exec(clean)?.[1]?.trim();
  if (pytest) return pytest;

  return "no test runner output was recognised";
}

/** Build the fixture's `after/` tree plus the runtime, install, and run it. */
/**
 * A pinned fixture is run in its prepared clone, with its own declared
 * commands.
 *
 * Its tree is not in this repository and the shared runtime files do not apply
 * to it — `pnpm exec vitest run` means nothing to a Python repository. The
 * commands come from the fixture rather than from a guess, which is also what
 * makes the status in its `checks.json` reproducible by someone else.
 */
async function measurePinned(
  fixture: LoadedFixture,
  cacheRoot: string,
): Promise<RunnableResult> {
  const pinned = fixture.fixture.pinned_repository!;
  const dir = join(cachePathFor(cacheRoot, fixture.fixture.id), "repo");
  if (!existsSync(dir)) {
    return {
      fixture_id: fixture.fixture.id,
      runtime: {
        status: "not_installable",
        note: `not prepared: run \`perbo-corpus prepare --filter ${fixture.fixture.id}\` first`,
      },
      install_ms: 0,
      test_ms: 0,
    };
  }

  // The inherited environment, unmodified.
  //
  // Both of the obvious touches turned out to measure this harness rather than
  // the repository. The scrubbed environment the corpus's own fixtures get
  // belongs to the runner, which hands an environment to an agent; and `CI=1`
  // makes pydantic run its suite in threads, where a test that deliberately
  // recurses to the limit overflows a thread stack and takes the process with
  // it. Both produced `suite_fails` on a suite that passes.
  const env: NodeJS.ProcessEnv = { ...process.env };
  // In order, and the first failure stops: a build that runs against a failed
  // install measures nothing.
  let setupMs = 0;
  for (const command of pinned.setup_commands) {
    const step = await run([...command], { cwd: dir, env, timeoutMs: 1_800_000 });
    setupMs += step.duration_ms;
    if (step.code !== 0) {
      return {
        fixture_id: fixture.fixture.id,
        runtime: {
          status: "not_installable",
          note: `\`${command.join(" ")}\`: ${installFailure(step.stderr, step.stdout)}`,
        },
        install_ms: setupMs,
        test_ms: 0,
      };
    }
  }
  // Five minutes, not thirty: a suite that has reported its result and not
  // exited should be cut short rather than waited out.
  const test = await run([...pinned.verify_command], { cwd: dir, env, timeoutMs: 300_000 });
  const output = `${test.stdout}\n${test.stderr}`;
  const note = summarise(output);

  // The exit code is not the last word when the runner does not produce one.
  // vite's vitest prints a complete passing summary and then never exits, so
  // the process has to be killed and returns 137 — reading that as
  // `suite_fails` would record a failure for a suite that passed. What is
  // recorded is what the runner reported, with the hang stated alongside it.
  const passedButHung = test.timed_out && PASSING_SUMMARY.test(output);
  return {
    fixture_id: fixture.fixture.id,
    runtime: {
      status: passedButHung || test.code === 0 ? "runs" : "suite_fails",
      note: passedButHung ? `${note} (the runner did not exit; killed at the timeout)` : note,
    },
    install_ms: setupMs,
    test_ms: test.duration_ms,
  };
}

export async function measureRunnable(
  fixture: LoadedFixture,
  options: { keep?: boolean; cacheRoot?: string } = {},
): Promise<RunnableResult> {
  if (fixture.fixture.pinned_repository !== null) {
    return measurePinned(fixture, options.cacheRoot ?? defaultCacheDir());
  }
  const dir = mkdtempSync(join(tmpdir(), `perbo-runnable-${fixture.fixture.id}-`));
  mkdirSync(dir, { recursive: true });
  cpSync(fixture.repoDir, dir, { recursive: true });
  for (const file of RUNTIME_FILES) {
    // A fixture that ships its own manifest keeps it. `cln-003`'s stub lockfile
    // is the fixture, so overwriting it would delete what is being measured.
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
  if (install.code !== 0) {
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
    return {
      fixture_id: fixture.fixture.id,
      runtime: { status: "not_installable", note: installFailure(install.stderr, install.stdout) },
      install_ms: install.duration_ms,
      test_ms: 0,
    };
  }

  const test = await run(["pnpm", "exec", "vitest", "run"], { cwd: dir, env, timeoutMs: 300_000 });
  const note = summarise(`${test.stdout}\n${test.stderr}`);
  const status: FixtureRuntime["status"] =
    note === "vitest reported no test files" ? "no_tests" : test.code === 0 ? "runs" : "suite_fails";

  if (!options.keep) rmSync(dir, { recursive: true, force: true });
  return {
    fixture_id: fixture.fixture.id,
    runtime: { status, note },
    install_ms: install.duration_ms,
    test_ms: test.duration_ms,
  };
}

export function renderRunnable(results: readonly RunnableResult[]): string {
  const lines: string[] = [];
  lines.push("| Fixture | Status | What its own suite reports | install | test |");
  lines.push("|---|---|---|---|---|");
  for (const result of results) {
    lines.push(
      `| \`${result.fixture_id}\` | ${result.runtime.status} | ${result.runtime.note} | ` +
        `${(result.install_ms / 1000).toFixed(1)}s | ${(result.test_ms / 1000).toFixed(1)}s |`,
    );
  }
  lines.push("");
  const count = (status: FixtureRuntime["status"]) =>
    results.filter((result) => result.runtime.status === status).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  lines.push(
    `**${count("runs")} of ${results.length} run green.** ` +
      `${plural(count("suite_fails"), "has a suite that fails", "have suites that fail")}, ` +
      `${plural(count("no_tests"), "carries no tests at all", "carry no tests at all")}, ` +
      `and ${plural(count("not_installable"), "cannot install", "cannot install")}.`,
  );
  return lines.join("\n");
}
