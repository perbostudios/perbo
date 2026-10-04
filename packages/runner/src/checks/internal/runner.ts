import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/**
 * Which test runner a pinned command runs, and the narrow form that aims that
 * runner at files.
 *
 * A narrowed run — a failed check's re-run, or one node's run (D-107) — asks
 * the check's own runner about fewer files. Run through another runner it
 * answers a question nobody asked, so a command whose runner is not in the
 * table below is not narrowed: the pinned command runs whole instead.
 *
 * The reading is deterministic and uses nothing a model produced (ADR-0023):
 * the pinned argv where it names its runner, and otherwise, for a wrapper that
 * runs a package script, that script as the owning package's own
 * `package.json` declares it.
 */

/** The runners a narrowed run can be aimed at: these two, and no others. */
export type TestRunner = "vitest" | "node-test";

interface NarrowForm {
  /** The argv the files are appended to, run in the package that owns them. */
  argv: readonly string[];
  /**
   * A file the runner collects on its own, read relative to the package the
   * run starts in: a changed file this does not match is not handed to it.
   */
  testFile: RegExp;
}

const NARROW_FORMS: Readonly<Record<TestRunner, NarrowForm>> = {
  vitest: {
    argv: ["pnpm", "exec", "vitest", "run"],
    // `*.test.*` and `*.spec.*` on a JavaScript or TypeScript extension.
    testFile: /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/,
  },
  "node-test": {
    argv: ["node", "--test"],
    // `node --test`'s own default patterns: `*.test.*`, `*-test.*`,
    // `*_test.*`, `test-*.*`, `test.*`, and every file under a `test`
    // directory, on a JavaScript or TypeScript extension.
    testFile:
      /((^|\/)([^/]+[.\-_]test|test-[^/]+|test)\.[cm]?[jt]s$)|((^|\/)test\/([^/]+\/)*[^/]+\.[cm]?[jt]s$)/,
  },
};

/** The one place a narrowed argv is composed: the runner's form, then the files. */
export function narrowedArgv(runner: TestRunner, files: readonly string[]): string[] {
  return [...NARROW_FORMS[runner].argv, ...files];
}

/** Whether the runner collects this package-relative path as a test file. */
export function isTestFile(runner: TestRunner, packagePath: string): boolean {
  return NARROW_FORMS[runner].testFile.test(packagePath);
}

/**
 * The words a package manager puts in front of a binary it runs out of the
 * workspace. A token that is not one of these before the program means the
 * program is something else, and what that something does with its arguments
 * is not for this to guess.
 */
const LAUNCHERS: ReadonlySet<string> = new Set([
  "pnpm",
  "pnpx",
  "npm",
  "npx",
  "yarn",
  "bun",
  "bunx",
  "exec",
  "dlx",
  "x",
  "-s",
  "--silent",
]);

/** Where `turbo run` starts in this argv, or `null` if the command is not one. */
export function turboRunAt(command: readonly string[]): number | null {
  const at = command.findIndex((token) => basename(token) === "turbo");
  if (at === -1 || command[at + 1] !== "run") return null;
  return command.slice(0, at).every((token) => LAUNCHERS.has(token)) ? at : null;
}

/**
 * The runner an argv names itself, past the launchers in front of it:
 * `vitest`, or `node` given `--test` among its own options. `null` for
 * anything else, a wrapper included.
 */
export function runnerNamedBy(argv: readonly string[]): TestRunner | null {
  const at = argv.findIndex((token) => !LAUNCHERS.has(token));
  if (at === -1) return null;
  const program = basename(argv[at]!);
  if (program === "vitest") return "vitest";
  if (program !== "node") return null;
  for (const token of argv.slice(at + 1)) {
    if (!token.startsWith("-")) return null;
    if (token === "--test") return "node-test";
  }
  return null;
}

/** The package managers whose `test` and `run <script>` run a package script. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(["pnpm", "npm", "yarn"]);

/**
 * The package script a wrapper runs in each package it reaches — `turbo run
 * <task>`, `<manager> test`, `<manager> run <script>` — or `null` where the
 * argv is not one, or runs more than one task.
 */
function wrappedScript(argv: readonly string[]): string | null {
  const turbo = turboRunAt(argv);
  if (turbo !== null) {
    const passthrough = argv.indexOf("--", turbo);
    const tasks = argv
      .slice(turbo + 2, passthrough === -1 ? argv.length : passthrough)
      .filter((token) => !token.startsWith("-"));
    return tasks.length === 1 ? tasks[0]! : null;
  }
  if (!SCRIPT_RUNNERS.has(argv[0] ?? "")) return null;
  const rest = argv.slice(1).filter((token) => token !== "-s" && token !== "--silent");
  if (rest[0] === "test") return "test";
  if ((rest[0] === "run" || rest[0] === "run-script") && rest[1] !== undefined && !rest[1].startsWith("-")) {
    return rest[1];
  }
  return null;
}

/** A script `package.json` declares, or `null` where it declares none. */
function packageScript(packageDir: string, script: string): string | null {
  const manifest = join(packageDir, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return null;
    const value = (scripts as Record<string, unknown>)[script];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The runner a package script runs: one command, read as argv after any
 * leading `NAME=value` assignments. A script that chains, pipes, redirects or
 * substitutes is more than one command, and runs no runner this can name.
 */
function scriptRunner(script: string): TestRunner | null {
  if (/[;&|<>`$()]/.test(script)) return null;
  const tokens = script.trim().split(/\s+/).filter((token) => token.length > 0);
  const start = tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return start === -1 ? null : runnerNamedBy(tokens.slice(start));
}

/** What a pinned command runs in one package: a runner with a narrow form, or why there is none. */
export type RunnerReading = { runner: TestRunner; note: null } | { runner: null; note: string };

const NO_FORM = "the check's runner has no narrow form";

/**
 * The runner the pinned command runs in the package at `packageDir`: the one
 * its argv names, or, for a wrapper, the one the package's own script for
 * that wrapper runs. Anything else has no narrow form, and the note says why.
 */
export function runnerIn(args: {
  command: readonly string[];
  packageDir: string;
  worktree: string;
}): RunnerReading {
  const named = runnerNamedBy(args.command);
  if (named !== null) return { runner: named, note: null };
  const script = wrappedScript(args.command);
  if (script === null) {
    return { runner: null, note: `${NO_FORM}: \`${args.command.join(" ")}\` runs neither vitest nor node --test` };
  }
  const where = relative(args.worktree, args.packageDir).split(sep).join("/") || ".";
  const text = packageScript(args.packageDir, script);
  if (text === null) {
    return { runner: null, note: `${NO_FORM}: the package at ${where} declares no \`${script}\` script` };
  }
  const runner = scriptRunner(text);
  return runner !== null
    ? { runner, note: null }
    : {
        runner: null,
        note: `${NO_FORM}: the \`${script}\` script of the package at ${where} runs neither vitest nor node --test`,
      };
}
