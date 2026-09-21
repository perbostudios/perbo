import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { matchesAny } from "@perbo/contracts";

/**
 * Reading a test runner's own output, and turning what it names into a second
 * run of the same tests.
 *
 * Every value here comes from the bytes the runner captured from a process it
 * started. Nothing the model produced reaches it, and the paths that become
 * argv are validated against the worktree before they do: relative, no `..`,
 * not a flag, and present on disk.
 */

/** ANSI colour, which a test runner writes and a stored record should not keep. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * `<package>:<task>: ` — the prefix turbo puts in front of every line a task
 * writes. Its package name is how a file path relative to a package root is
 * attributed to the package that printed it.
 */
const TURBO_PREFIX = /^(@?[A-Za-z0-9._/-]+):([A-Za-z0-9:._-]+):\s?/;

/** ` FAIL  <file> > <suite> > <case>` — vitest's failed-test block. */
const FAIL_MARKER = /^FAIL\s+(\S+)(?:\s*>\s*(.+))?$/;

/** ` ❯ <file> (3 tests | 1 failed)` — the file a following `×` line belongs to. */
const FILE_MARKER = /^❯\s+(\S+\.[cm]?[jt]sx?)\s*\(/;

/** ` × <case>` — one failed case, under the file marker above. */
const CASE_MARKER = /^[×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/;

/** `Test Files  1 failed | 12 passed (13)` and its `Tests` twin. */
const SUMMARY_MARKER = /^(Test Files|Tests)\s+\d/;

/** The failure evidence worth keeping beside the names. */
const EVIDENCE_MARKER =
  /(^|\s)(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError)\b|^Error:|\bError:\s|\bTest timed out\b|\bTimed out\b/;

export interface FailingTest {
  /** The turbo task package the line came from; `null` for un-prefixed output. */
  package_name: string | null;
  /** The test file exactly as the runner printed it, relative to its package. */
  file: string;
  /** `suite > case`, when the marker carried one. */
  name: string | null;
}

export interface TestOutput {
  failing: FailingTest[];
  /** The failure lines: `FAIL`, `×`, the assertion, the timeout. */
  evidence: string[];
  /** Each package's `Test Files` and `Tests` totals. */
  summary: string[];
}

/** One line, stripped of colour and of the turbo prefix that carried it. */
interface Stripped {
  package_name: string | null;
  text: string;
}

function strip(line: string): Stripped {
  const plain = line.replace(ANSI, "").replace(/\s+$/, "");
  const prefixed = TURBO_PREFIX.exec(plain);
  if (!prefixed) return { package_name: null, text: plain.trim() };
  return { package_name: prefixed[1] ?? null, text: plain.slice(prefixed[0].length).trim() };
}

const looksLikeTestFile = (candidate: string): boolean =>
  /\.[cm]?[jt]sx?$/.test(candidate) && !candidate.includes("://");

/**
 * The failing tests a run named, and the lines that say so.
 *
 * `FAIL` is the canonical marker and carries the file and the whole test path.
 * A bare `×` case is taken only for a file no `FAIL` line named, which is the
 * reporter that prints the tree without the failed-test block.
 */
export function parseTestOutput(text: string): TestOutput {
  const evidence: string[] = [];
  const summary: string[] = [];
  const fromFail: FailingTest[] = [];
  const fromCase: FailingTest[] = [];
  /** The most recent `❯ <file>` line, per package: what a bare `×` belongs to. */
  const currentFile = new Map<string | null, string>();

  for (const raw of text.split("\n")) {
    const { package_name, text: line } = strip(raw);
    if (line.length === 0) continue;

    if (SUMMARY_MARKER.test(line)) {
      summary.push(line);
      continue;
    }

    const file = FILE_MARKER.exec(line);
    if (file?.[1] !== undefined) {
      currentFile.set(package_name, file[1]);
      if (/\bfailed\b/.test(line)) evidence.push(line);
      continue;
    }

    const failed = FAIL_MARKER.exec(line);
    if (failed?.[1] !== undefined && looksLikeTestFile(failed[1])) {
      fromFail.push({ package_name, file: failed[1], name: failed[2]?.trim() || null });
      evidence.push(line);
      continue;
    }

    const one = CASE_MARKER.exec(line);
    if (one?.[1] !== undefined) {
      const owner = currentFile.get(package_name);
      if (owner !== undefined) fromCase.push({ package_name, file: owner, name: one[1].trim() });
      evidence.push(line);
      continue;
    }

    if (EVIDENCE_MARKER.test(line)) evidence.push(line);
  }

  const named = new Set(fromFail.map((entry) => `${entry.package_name ?? ""}|${entry.file}`));
  const failing = [
    ...fromFail,
    ...fromCase.filter((entry) => !named.has(`${entry.package_name ?? ""}|${entry.file}`)),
  ];
  return { failing, evidence, summary: dedupe(summary) };
}

const dedupe = (lines: string[]): string[] => [...new Set(lines)];

export interface ResolvedFailure extends FailingTest {
  /** The package's directory inside the worktree, when the name resolves to one. */
  package_dir: string | null;
  /** The file's path from the worktree root, when it exists there. */
  worktree_path: string | null;
  /** Safe to put in argv: relative, inside its package, and on disk. */
  rerunnable: boolean;
  /** What the record shows: the path it could establish, plus the test name. */
  label: string;
}

/**
 * Every workspace package in a worktree, by name.
 *
 * Read from the worktree's own `package.json` files rather than from the
 * captured output, so a package name in that output can only ever select a
 * directory this found — it can never name one.
 */
function workspacePackages(worktree: string): Map<string, string> {
  const found = new Map<string, string>();
  const add = (dir: string): void => {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      const name = (parsed as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0 && !found.has(name)) found.set(name, dir);
    } catch {
      // A manifest this cannot read names no package.
    }
  };

  const children = (dir: string): string[] => {
    try {
      return readdirSync(dir)
        .filter((entry) => !entry.startsWith(".") && entry !== "node_modules")
        .map((entry) => join(dir, entry))
        .filter((path) => {
          try {
            return statSync(path).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  };

  // Two levels: the root, and the `apps/*` / `packages/*` shape a pnpm
  // workspace uses. Deeper than that is a dependency, not a workspace member.
  add(worktree);
  for (const group of children(worktree)) {
    add(group);
    for (const member of children(group)) add(member);
  }
  return found;
}

/**
 * A path from captured output, made safe to put in argv — or refused.
 *
 * Relative, no `..` segment, not readable as an option, and present under the
 * directory it claims to be in. A path that fails any of those is not passed
 * to a process; it stays on the record as a name and nothing more.
 */
function safeRelativePath(candidate: string, root: string): string | null {
  if (candidate.length === 0 || candidate.startsWith("-")) return null;
  if (isAbsolute(candidate)) return null;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(candidate)) return null;
  const normalized = normalize(candidate);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) return null;
  const absolute = join(root, normalized);
  const inside = relative(root, absolute);
  if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) return null;
  if (!existsSync(absolute)) return null;
  return normalized;
}

/** Where each named failure lives in this worktree, and whether it can be re-run. */
export function resolveFailures(
  failing: readonly FailingTest[],
  worktree: string,
): ResolvedFailure[] {
  const packages = workspacePackages(worktree);
  return failing.map((failure) => {
    const dir = failure.package_name === null ? worktree : (packages.get(failure.package_name) ?? null);
    const safe = dir === null ? null : safeRelativePath(failure.file, dir);
    const worktree_path =
      dir === null || safe === null ? null : relative(worktree, join(dir, safe)).split(sep).join("/");
    const shown =
      worktree_path ??
      (failure.package_name === null ? failure.file : `${failure.package_name} ${failure.file}`);
    return {
      ...failure,
      package_dir: dir,
      worktree_path,
      rerunnable: safe !== null,
      label: failure.name === null ? shown : `${shown} > ${failure.name}`,
    };
  });
}

export interface RerunStep {
  argv: string[];
  cwd: string;
}

export interface RerunPlan {
  steps: RerunStep[];
  /** `files` — only the failing tests ran; `task` — the whole check ran again. */
  scope: "files" | "task";
  /** Why the re-run was not narrowed to the failing files. `null` when it was. */
  note: string | null;
}

/**
 * What to run again, once, to find out whether the failure reproduces.
 *
 * The narrow form runs the failing files in the package that owns them. It
 * needs a package this worktree has and files this worktree holds; without
 * either, the whole check runs again and the record says which was missing —
 * a re-run of the wrong thing would answer a question nobody asked.
 */
export function planRerun(args: {
  command: readonly string[];
  worktree: string;
  resolved: readonly ResolvedFailure[];
}): RerunPlan {
  const whole = (note: string): RerunPlan => ({
    steps: [{ argv: [...args.command], cwd: args.worktree }],
    scope: "task",
    note,
  });

  if (args.resolved.length === 0) {
    return whole("no failing test names were parsed from the check's output");
  }

  const byPackage = new Map<string, string[]>();
  for (const failure of args.resolved) {
    if (!failure.rerunnable || failure.package_dir === null || failure.worktree_path === null) continue;
    const files = byPackage.get(failure.package_dir) ?? [];
    const file = relative(failure.package_dir, join(args.worktree, failure.worktree_path))
      .split(sep)
      .join("/");
    if (!files.includes(file)) files.push(file);
    byPackage.set(failure.package_dir, files);
  }

  if (byPackage.size === 0) {
    const named = [...new Set(args.resolved.map((failure) => failure.package_name ?? "(no package)"))];
    return whole(
      `the failing tests could not be attributed to a package in the worktree: ${named.join(", ")}`,
    );
  }

  return {
    steps: [...byPackage].map(([cwd, files]) => narrowedStep(cwd, files)),
    scope: "files",
    note: null,
  };
}

/** The narrow form: vitest, told exactly which files to run, and nothing else. */
const VITEST_RUN = ["pnpm", "exec", "vitest", "run"] as const;

/** That form, aimed at one package: the only place the argv is composed. */
const narrowedStep = (cwd: string, files: readonly string[]): RerunStep => ({
  argv: [...VITEST_RUN, ...files],
  cwd,
});

/**
 * A file the narrow form can be told to run: what vitest itself collects,
 * `*.test.*` and `*.spec.*` on a JavaScript or TypeScript extension. A test
 * under a `test/` folder without that suffix, a helper beside the tests, or a
 * test for another runner is not one, and a node whose changed tests are only
 * those runs the check's whole command instead.
 */
const TEST_FILE = /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/;

export interface NodeRunPlan extends RerunPlan {
  /** The worktree-relative files the run was narrowed to; empty for `task`. */
  files: string[];
}

/**
 * What one node of an execution graph runs a check as (D-107).
 *
 * The narrow form is the failed check's re-run: the test files in the package
 * that owns them, run as that package's own vitest invocation. What differs is
 * where the files come from — the sealed change set, filtered to the node's
 * paths, rather than a runner's own report of what failed. Without a changed
 * test file inside those paths, or with none this worktree can place in a
 * package and find on disk, the check's whole command runs for the node
 * instead and the note says which: a narrowed run of the wrong files would
 * answer a question nobody asked.
 */
export function planNodeRun(args: {
  command: readonly string[];
  worktree: string;
  paths: readonly string[];
  changed_files: readonly string[];
}): NodeRunPlan {
  const whole = (note: string): NodeRunPlan => ({
    steps: [{ argv: [...args.command], cwd: args.worktree }],
    scope: "task",
    note,
    files: [],
  });

  const inside = args.changed_files.filter((file) => matchesAny(file, args.paths));
  const tests = inside.filter((file) => TEST_FILE.test(file));
  if (tests.length === 0) {
    return whole(
      inside.length === 0
        ? "the change touched no file inside the node's paths"
        : "no changed file inside the node's paths is a test file the narrow form runs",
    );
  }

  const directories = [...workspacePackages(args.worktree).values()];
  const byPackage = new Map<string, string[]>();
  const placed: string[] = [];
  for (const file of tests) {
    const dir = owningPackage(file, args.worktree, directories);
    if (dir === null) continue;
    const inPackage = safeRelativePath(
      relative(dir, join(args.worktree, file)).split(sep).join("/"),
      dir,
    );
    if (inPackage === null) continue;
    const files = byPackage.get(dir) ?? [];
    if (!files.includes(inPackage)) {
      files.push(inPackage);
      placed.push(file);
    }
    byPackage.set(dir, files);
  }

  if (byPackage.size === 0) {
    return whole(
      "the node's changed test files are in no package of this worktree, or are no longer " +
        `on disk: ${tests.join(", ")}`,
    );
  }

  return {
    steps: [...byPackage].map(([cwd, files]) => narrowedStep(cwd, files)),
    scope: "files",
    note: null,
    files: placed,
  };
}

/** The deepest workspace package a worktree-relative path lies inside. */
function owningPackage(
  file: string,
  worktree: string,
  directories: readonly string[],
): string | null {
  const absolute = join(worktree, file);
  let owner: string | null = null;
  for (const dir of directories) {
    const inside = relative(dir, absolute);
    if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) continue;
    if (owner === null || dir.length > owner.length) owner = dir;
  }
  return owner;
}
