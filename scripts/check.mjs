#!/usr/bin/env node
// The gate: the one list of what a change passes before it merges, as a single
// executable.
//
//   node scripts/check.mjs                            every stage, in order
//   node scripts/check.mjs code validators            those stages, in canonical order
//   node scripts/check.mjs --list                     the stages, one line each
//   node scripts/check.mjs --filter @perbo/review    one package's build, typecheck, test and lint
//
// `.github/workflows/build.yml` runs these same stages, one step per stage, so
// the Actions page names the stage that failed and a contributor runs locally
// what CI runs.
//
// Every command is an argv array handed to `spawnSync`: never a shell string,
// so nothing is word-split or expanded on the way to the process. Four values
// reach a command from the command line: `--base` and `--head`, checked against
// a SHA pattern first; `--filter`, checked against the workspace's own package
// names first; and `--corpus`, a path.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Where stage 8 keeps its clone of the pinned corpus. Ignored by git. */
export const PINNED_CORPUS_DIR = ".local/plantedbugs";

/** A command exited non-zero. The driver turns this into the gate's exit code. */
export class CommandFailed extends Error {
  constructor(argv, code, stderr = "") {
    super(`exit code ${code}: ${shellCommand(argv)}`);
    this.name = "CommandFailed";
    this.argv = argv;
    this.code = code;
    this.stderr = stderr;
  }
}

/** The command line was wrong. Exits 2, with the list of what was expected. */
export class UsageError extends Error {
  constructor(message, detail = "") {
    super(message);
    this.name = "UsageError";
    this.detail = detail;
  }
}

/** An argv array as a line a person can paste into a shell. */
export function shellCommand(argv) {
  return argv
    .map((value) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}

// --------------------------------------------------------------------------
// The stages
// --------------------------------------------------------------------------

// Reports every unparseable file rather than stopping at the first, and names
// it with an Actions annotation so the run points at the file.
const YAML_PARSE = `import pathlib, sys, yaml
failed = False
for path in sorted(pathlib.Path(".github").rglob("*.y*ml")):
    try:
        yaml.safe_load(path.read_text())
    except Exception as exc:
        print(f"::error file={path}::{exc}")
        failed = True
sys.exit(1 if failed else 0)
`;

export const STAGES = [
  {
    name: "install",
    summary: "the lockfile's dependencies, exactly",
    run(ctx) {
      ctx.run(["pnpm", "install", "--frozen-lockfile"]);
    },
  },
  {
    name: "build",
    summary: "every package, leaves included — the corpus stage runs the built binary",
    run(ctx) {
      ctx.run(["pnpm", "exec", "turbo", "run", "build"]);
    },
  },
  {
    name: "runtime",
    summary: "the desktop's CLI on the Node inside Electron, with the Agent SDK beside it",
    run(ctx) {
      ctx.run(["node", "apps/desktop/scripts/check-runtime.mjs"]);
    },
  },
  {
    name: "code",
    summary: "typecheck, test and lint across the workspace",
    run(ctx) {
      ctx.run(["pnpm", "exec", "turbo", "run", "typecheck", "test", "lint"]);
    },
  },
  {
    name: "corpus",
    summary: "every fixture is well formed and its committed diff is what its trees produce",
    run(ctx) {
      // Reaches no provider and spends nothing: `--run` is the flag that would.
      ctx.run(["node", "packages/evaluation/dist/main.js"]);
      ctx.run(["node", "packages/evaluation/scripts/build-diffs.mjs"]);
      ctx.run(["git", "diff", "--exit-code", "--", "packages/evaluation/corpus"]);
    },
  },
  {
    name: "validators",
    summary: "the documentation, diagram and fixture validators, and their own tests",
    run(ctx) {
      const python = ctx.python;
      try {
        ctx.run([python, "-m", "unittest", "discover", "-s", "scripts", "-p", "test_*.py"], {
          captureStderr: true,
        });
      } catch (error) {
        if (error instanceof CommandFailed && error.stderr.includes("ModuleNotFoundError")) {
          ctx.log(
            `\nA validator dependency is missing:\n\n    ${python} -m pip install -r scripts/requirements-validation.txt\n`,
          );
        }
        throw error;
      }
      ctx.run([python, "scripts/validate_docs.py"]);
      ctx.run([python, "scripts/validate_diagrams.py"]);
      ctx.run([python, "scripts/validate_fixture_diffs.py"]);
      ctx.run([python, "-c", YAML_PARSE]);
      ctx.run(["node", "--test", "scripts/check.test.mjs", "scripts/sync-protected-paths.test.mjs"]);
      ctx.run(["node", "scripts/sync-protected-paths.mjs", "--check"]);
    },
  },
  {
    name: "protected-paths",
    summary: "no file that judges a change is edited by the change under review",
    run(ctx) {
      const { base, head, nothingToCompare, error } = resolveProtectedRange(ctx);
      if (error) throw new Error(error);
      if (nothingToCompare) {
        ctx.log(`protected-paths: nothing to compare — ${nothingToCompare}; the check needs a pull request.`);
        return;
      }
      ctx.run(["node", ".github/scripts/protected-paths.mjs", base, head]);
    },
  },
  {
    name: "regression-dry-run",
    summary: "the regression suite's thirty fixture ids resolve against the pinned corpus",
    run(ctx) {
      const corpus = ctx.options.corpus
        ? resolve(ctx.repo, ctx.options.corpus)
        : ensurePinnedCorpus(ctx);
      // A dry run: it resolves ids, reaches no provider and spends nothing.
      // `--run` is the flag that spends, and this stage never passes it.
      ctx.run(["node", "packages/evaluation/dist/main.js", "--suite", "regression", "--corpus", corpus]);
    },
  },
];

export const STAGE_NAMES = STAGES.map((stage) => stage.name);

/** The stages `--filter` keeps, narrowed to one package; everything else is repository-wide. */
export const FILTERED_STAGES = ["install", "build", "code"];

// --------------------------------------------------------------------------
// Stage 7: which two commits
// --------------------------------------------------------------------------

/**
 * The commit range `protected-paths.mjs` is given.
 *
 * `--base` and `--head` are what CI passes, from the pull request event's own
 * payload. Without them the range is the merge base with `origin/main` and the
 * commit at HEAD, which is what a contributor's branch means by "this change".
 * On `main` there is no change under review and the check has nothing to say.
 * A checkout with no merge base — `origin/main` not fetched, or a shallow
 * clone — is a gate that cannot run, and the stage fails naming the fetch
 * rather than passing a change it never looked at.
 */
export function resolveProtectedRange(ctx) {
  const { base, head } = ctx.options;
  if (base && head) return { base, head, nothingToCompare: null };

  const branch = ctx.capture(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status === 0 && branch.stdout.trim() === "main") {
    return { nothingToCompare: "HEAD is on main" };
  }
  const mergeBase = ctx.capture(["git", "merge-base", "origin/main", "HEAD"]);
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    return {
      error:
        "no merge base between origin/main and HEAD, so the protected-paths check cannot run; " +
        "fetch it first: git fetch origin main",
    };
  }
  const headSha = ctx.capture(["git", "rev-parse", "HEAD"]);
  if (headSha.status !== 0 || !headSha.stdout.trim()) {
    return { error: "no commit at HEAD, so the protected-paths check cannot run" };
  }
  return { base: mergeBase.stdout.trim(), head: headSha.stdout.trim(), nothingToCompare: null };
}

// --------------------------------------------------------------------------
// Stage 8: the pinned corpus
// --------------------------------------------------------------------------

/** The repository and commit `.github/corpus-pin.json` names, checked before either is used. */
export function readCorpusPin(repo) {
  const path = resolve(repo, ".github", "corpus-pin.json");
  if (!existsSync(path)) throw new Error(`no corpus pin at ${path}`);
  const pin = JSON.parse(readFileSync(path, "utf8"));
  if (typeof pin.repository !== "string" || !/^https:\/\/[\w.-]+\/[\w.\-/]+$/.test(pin.repository)) {
    throw new Error(`${path}: "repository" must be an https clone URL`);
  }
  if (typeof pin.commit !== "string" || !SHA_RE.test(pin.commit)) {
    throw new Error(`${path}: "commit" must be a commit SHA`);
  }
  return { repository: pin.repository, commit: pin.commit, cloneUrl: `${pin.repository}.git` };
}

/**
 * `.local/plantedbugs` as a clone of the pinned repository at the pinned commit,
 * and the fixtures directory inside it. Fetches only when the pinned commit is
 * not already in the clone, so a second run of this stage touches no network.
 */
export function ensurePinnedCorpus(ctx) {
  const pin = readCorpusPin(ctx.repo);
  const dir = resolve(ctx.repo, PINNED_CORPUS_DIR);
  if (!ctx.exists(dir)) {
    ctx.run(["git", "clone", "--quiet", pin.cloneUrl, PINNED_CORPUS_DIR]);
  } else {
    const present = ctx.capture([
      "git",
      "-C",
      PINNED_CORPUS_DIR,
      "cat-file",
      "-e",
      `${pin.commit}^{commit}`,
    ]);
    if (present.status !== 0) ctx.run(["git", "-C", PINNED_CORPUS_DIR, "fetch", "--quiet"]);
  }
  ctx.run(["git", "-C", PINNED_CORPUS_DIR, "checkout", "--quiet", pin.commit]);
  return join(dir, "fixtures");
}

// --------------------------------------------------------------------------
// Selection
// --------------------------------------------------------------------------

/** The named stages in canonical order, deduplicated; every stage when none are named. */
export function selectStages(names) {
  if (names.length === 0) return [...STAGE_NAMES];
  const unknown = names.filter((name) => !STAGE_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown stage: ${unknown.join(", ")}`, stageHelp());
  }
  return STAGE_NAMES.filter((name) => names.includes(name));
}

export function stageList() {
  const width = Math.max(...STAGE_NAMES.map((name) => name.length));
  return STAGES.map((stage) => `  ${stage.name.padEnd(width)}  ${stage.summary}`).join("\n");
}

/** The stage list under a heading, which is what a rejected command line is answered with. */
function stageHelp() {
  return `Stages:\n${stageList()}`;
}

/**
 * The workspace's package names, for checking `--filter`. Read from
 * `pnpm-workspace.yaml` rather than hard-coded; only the `<dir>/*` glob shape
 * that file uses is understood, and any other glob is ignored.
 */
export function workspacePackages(repo) {
  const workspacePath = resolve(repo, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) return [];
  const names = [];
  let inPackages = false;
  for (const line of readFileSync(workspacePath, "utf8").split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    if (!inPackages) continue;
    const entry = line.match(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/);
    if (!entry) continue;
    const glob = entry[1].match(/^([\w.-]+)\/\*$/);
    if (!glob) continue;
    const base = resolve(repo, glob[1]);
    if (!existsSync(base)) continue;
    for (const dirent of readdirSync(base, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const manifest = join(base, dirent.name, "package.json");
      if (!existsSync(manifest)) continue;
      const name = JSON.parse(readFileSync(manifest, "utf8")).name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names.sort();
}

/** The three commands `--filter <package>` runs, each tagged with the stage it stands for. */
export function filterPlan(pkg) {
  return [
    { stage: "install", argv: ["pnpm", "install", "--frozen-lockfile"] },
    { stage: "build", argv: ["pnpm", "exec", "turbo", "run", "build", `--filter=${pkg}...`] },
    {
      stage: "code",
      argv: ["pnpm", "exec", "turbo", "run", "typecheck", "test", "lint", `--filter=${pkg}`],
    },
  ];
}

// --------------------------------------------------------------------------
// The command line
// --------------------------------------------------------------------------

export function parseArgs(argv) {
  const stages = [];
  const options = { list: false, help: false, filter: null, base: null, head: null, corpus: null };
  const takesValue = new Set(["--filter", "--base", "--head", "--corpus"]);

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inline = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const at = arg.indexOf("=");
      inline = arg.slice(at + 1);
      arg = arg.slice(0, at);
    }
    if (arg === "--list") {
      options.list = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (takesValue.has(arg)) {
      const value = inline ?? argv[(i += 1)];
      if (value === undefined) throw new UsageError(`${arg} needs a value`, stageHelp());
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown flag: ${arg}`, stageHelp());
    } else {
      stages.push(arg);
    }
  }

  if ((options.base === null) !== (options.head === null)) {
    throw new UsageError("--base and --head are given together or not at all", stageHelp());
  }
  for (const flag of ["base", "head"]) {
    if (options[flag] !== null && !SHA_RE.test(options[flag])) {
      throw new UsageError(`--${flag} must be a commit SHA, got ${JSON.stringify(options[flag])}`);
    }
  }
  return { stages, options };
}

// --------------------------------------------------------------------------
// Running
// --------------------------------------------------------------------------

/**
 * The only thing here that starts a process, and it takes an argv array. No
 * caller can hand it a shell string, so there is no command line for an
 * argument to be word-split or expanded into.
 */
export function createRunner({ repo }) {
  return {
    run(argv, { env, captureStderr = false } = {}) {
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd: repo,
        stdio: captureStderr ? ["inherit", "inherit", "pipe"] : "inherit",
        env: env ? { ...process.env, ...env } : process.env,
      });
      const stderr = result.stderr ? result.stderr.toString() : "";
      if (stderr) process.stderr.write(stderr);
      if (result.error) throw result.error;
      return { status: result.status ?? 1, stderr };
    },
    capture(argv, { env } = {}) {
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd: repo,
        encoding: "utf8",
        env: env ? { ...process.env, ...env } : process.env,
      });
      if (result.error && result.error.code === "ENOENT") return { status: 127, stdout: "", stderr: "" };
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
  };
}

function makeContext({ repo, runner, log, python, options, exists }) {
  return {
    repo,
    python,
    options,
    exists,
    log,
    run(argv, opts = {}) {
      log(`$ ${shellCommand(argv)}`);
      const result = runner.run(argv, opts);
      if (result.status !== 0) throw new CommandFailed(argv, result.status, result.stderr ?? "");
      return result;
    },
    capture(argv, opts = {}) {
      log(`$ ${shellCommand(argv)}`);
      return runner.capture(argv, opts);
    },
  };
}

/** Runs the gate and returns the process exit code. */
export function runGate(argv, overrides = {}) {
  const {
    repo = REPO_ROOT,
    env = process.env,
    log = (line) => console.log(line),
    logError = (line) => console.error(line),
    exists = existsSync,
  } = overrides;

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    logError(error.message);
    if (error.detail) logError(`\n${error.detail}`);
    return 2;
  }
  const { stages: named, options } = parsed;

  if (options.help) {
    log("Usage: node scripts/check.mjs [<stage>...] [--filter <package>] [--base <sha> --head <sha>] [--corpus <path>]");
    log(`\nStages:\n${stageList()}`);
    return 0;
  }
  if (options.list) {
    log(stageList());
    return 0;
  }

  const runner = overrides.runner ?? createRunner({ repo });
  const python = env.PERBO_PYTHON || "python3";
  const ctx = makeContext({ repo, runner, log, python, options, exists });

  let plan;
  try {
    plan = options.filter ? planFilter(repo, options.filter, named) : planStages(named);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    logError(error.message);
    if (error.detail) logError(`\n${error.detail}`);
    return 2;
  }

  for (const skipped of plan.skipped ?? []) log(skipped);

  for (const step of plan.steps) {
    log(`\n==> ${step.stage}`);
    try {
      step.run(ctx);
    } catch (error) {
      if (error instanceof CommandFailed) {
        logError(`\ncheck: stage "${step.stage}" failed`);
        logError(`  $ ${shellCommand(error.argv)}`);
        logError(`  exit code ${error.code}`);
        return error.code;
      }
      logError(`\ncheck: stage "${step.stage}" failed: ${error.message}`);
      return 1;
    }
  }
  log(`\ncheck: ${plan.steps.length} stage(s) passed — ${plan.steps.map((s) => s.stage).join(", ")}`);
  return 0;
}

function planStages(named) {
  const chosen = selectStages(named);
  return {
    steps: chosen.map((name) => {
      const stage = STAGES.find((candidate) => candidate.name === name);
      return { stage: name, run: (ctx) => stage.run(ctx) };
    }),
  };
}

function planFilter(repo, pkg, named) {
  if (named.length > 0) {
    throw new UsageError("--filter runs its own three stages; do not name stages beside it", stageHelp());
  }
  const packages = workspacePackages(repo);
  if (!packages.includes(pkg)) {
    throw new UsageError(`Unknown package: ${pkg}`, `Packages:\n${packages.map((n) => `  ${n}`).join("\n")}`);
  }
  const skippedStages = STAGE_NAMES.filter((name) => !FILTERED_STAGES.includes(name));
  return {
    skipped: [
      `--filter ${pkg}: skipping the repository-wide stages — ${skippedStages.join(", ")}.`,
    ],
    steps: filterPlan(pkg).map(({ stage, argv }) => ({ stage, run: (ctx) => ctx.run(argv) })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runGate(process.argv.slice(2));
}
