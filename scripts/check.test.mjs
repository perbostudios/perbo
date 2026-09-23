// scripts/check.mjs with its runner replaced, so these tests prove what the
// gate would run without running any of it: which stages, in what order, and
// the exact argv of every command.
//
//   node --test scripts/check.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CommandFailed,
  FILTERED_STAGES,
  PINNED_CORPUS_DIR,
  REPO_ROOT,
  STAGE_NAMES,
  ensurePinnedCorpus,
  filterPlan,
  parseArgs,
  readCorpusPin,
  resolveProtectedRange,
  runGate,
  selectStages,
  shellCommand,
  workspacePackages,
} from "./check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Records every call and returns whatever the test asked for, running nothing. */
function fakeRunner({ status = () => 0, stderr = () => "", capture = () => ({ status: 0, stdout: SHA, stderr: "" }) } = {}) {
  const calls = [];
  return {
    calls,
    runs: () => calls.filter((call) => call.kind === "run").map((call) => call.argv),
    run(argv, opts = {}) {
      calls.push({ kind: "run", argv, opts });
      return { status: status(argv), stderr: stderr(argv) };
    },
    capture(argv, opts = {}) {
      calls.push({ kind: "capture", argv, opts });
      return capture(argv);
    },
  };
}

/** runGate with nothing real behind it: no process starts and no path is touched. */
function gate(argv, overrides = {}) {
  const out = [];
  const err = [];
  const runner = overrides.runner ?? fakeRunner();
  const code = runGate(argv, {
    runner,
    env: {},
    exists: () => false,
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    ...overrides,
  });
  return { code, runner, out: out.join("\n"), err: err.join("\n") };
}

test("with no stage named, every stage runs in canonical order", () => {
  assert.deepEqual(selectStages([]), [
    "install",
    "build",
    "runtime",
    "code",
    "corpus",
    "validators",
    "protected-paths",
    "regression-dry-run",
  ]);
});

test("named stages run in canonical order, whatever order they were given in, and only once", () => {
  assert.deepEqual(selectStages(["validators", "build", "validators"]), ["build", "validators"]);
  assert.deepEqual(selectStages(["regression-dry-run", "install"]), ["install", "regression-dry-run"]);
});

test("an unknown stage exits 2 and prints the stages", () => {
  const { code, err, runner } = gate(["typecheque"]);
  assert.equal(code, 2);
  assert.match(err, /Unknown stage: typecheque/);
  for (const name of STAGE_NAMES) assert.ok(err.includes(name), `${name} is missing from the list`);
  assert.equal(runner.calls.length, 0);
});

test("--list prints one line per stage and runs nothing", () => {
  const { code, out, runner } = gate(["--list"]);
  assert.equal(code, 0);
  for (const name of STAGE_NAMES) assert.match(out, new RegExp(`^\\s+${name}\\s+\\S`, "m"));
  assert.equal(runner.calls.length, 0);
});

test("--filter expands to exactly three commands", () => {
  const { code, runner } = gate(["--filter", "@perbo/contracts"]);
  assert.equal(code, 0);
  assert.deepEqual(runner.runs(), [
    ["pnpm", "install", "--frozen-lockfile"],
    ["pnpm", "exec", "turbo", "run", "build", "--filter=@perbo/contracts..."],
    ["pnpm", "exec", "turbo", "run", "typecheck", "test", "lint", "--filter=@perbo/contracts"],
  ]);
  assert.deepEqual(
    filterPlan("@perbo/desktop").map((step) => step.stage),
    FILTERED_STAGES,
  );
});

test("--filter names the repository-wide stages it is skipping", () => {
  const { out } = gate(["--filter", "@perbo/contracts"]);
  for (const name of STAGE_NAMES.filter((stage) => !FILTERED_STAGES.includes(stage))) {
    assert.ok(out.includes(name), `${name} is not named as skipped`);
  }
});

test("an unknown package exits 2 and prints the workspace's packages", () => {
  const { code, err, runner } = gate(["--filter", "@perbo/nonesuch"]);
  assert.equal(code, 2);
  assert.match(err, /Unknown package: @perbo\/nonesuch/);
  assert.match(err, /@perbo\/contracts/);
  assert.equal(runner.calls.length, 0);
});

test("the workspace's packages are read from pnpm-workspace.yaml", () => {
  const packages = workspacePackages(REPO_ROOT);
  for (const name of ["@perbo/cli", "@perbo/desktop", "@perbo/review", "@perbo/tsconfig"]) {
    assert.ok(packages.includes(name), `${name} is missing`);
  }
});

test("every command reaches the runner as an argv array, never a shell string", () => {
  const { code, runner } = gate([]);
  assert.equal(code, 0);
  assert.ok(runner.calls.length > 0);
  for (const { argv } of runner.calls) {
    assert.ok(Array.isArray(argv), `not an array: ${JSON.stringify(argv)}`);
    assert.ok(argv.length >= 1);
    for (const word of argv) assert.equal(typeof word, "string");
    assert.ok(!/\s/.test(argv[0]), `the program is not a command line: ${argv[0]}`);
  }
});

test("neither script starts a process through a shell", () => {
  for (const name of ["check.mjs", "sync-protected-paths.mjs"]) {
    const source = readFileSync(join(HERE, name), "utf8");
    assert.doesNotMatch(source, /\bshell\s*:/, `${name} passes a shell option`);
    assert.doesNotMatch(source, /\bexecSync\s*\(/, `${name} calls execSync`);
    assert.doesNotMatch(source, /[^A-Za-z_]exec\s*\(/, `${name} calls exec`);
  }
});

test("a failing command names its stage and gives the gate its exit code", () => {
  const runner = fakeRunner({ status: (argv) => (argv.includes("build") ? 3 : 0) });
  const { code, err } = gate(["build"], { runner });
  assert.equal(code, 3);
  assert.match(err, /stage "build" failed/);
  assert.match(err, /pnpm exec turbo run build/);
});

test("a missing validator dependency prints the pip line before exiting", () => {
  const runner = fakeRunner({
    status: (argv) => (argv.includes("unittest") ? 1 : 0),
    stderr: () => "ModuleNotFoundError: No module named 'yaml'\n",
  });
  const { code, out } = gate(["validators"], { runner });
  assert.equal(code, 1);
  assert.match(out, /python3 -m pip install -r scripts\/requirements-validation\.txt/);
});

test("PERBO_PYTHON names the interpreter the validators run under", () => {
  const runner = fakeRunner();
  gate(["validators"], { runner, env: { PERBO_PYTHON: "/opt/venv/bin/python" } });
  assert.ok(runner.runs().some((argv) => argv[0] === "/opt/venv/bin/python"));
  assert.ok(!runner.runs().some((argv) => argv[0] === "python3"));
});

test("protected-paths has nothing to compare on main", () => {
  const runner = fakeRunner({
    capture: (argv) =>
      argv.includes("--abbrev-ref")
        ? { status: 0, stdout: "main\n", stderr: "" }
        : { status: 0, stdout: SHA, stderr: "" },
  });
  const { code, out } = gate(["protected-paths"], { runner });
  assert.equal(code, 0);
  assert.match(out, /nothing to compare — HEAD is on main/);
  assert.equal(runner.runs().length, 0);
});

test("protected-paths fails without a merge base, naming the fetch, and runs no check", () => {
  const runner = fakeRunner({
    capture: (argv) => {
      if (argv.includes("--abbrev-ref")) return { status: 0, stdout: "detached\n", stderr: "" };
      if (argv.includes("merge-base")) return { status: 128, stdout: "", stderr: "fatal\n" };
      return { status: 0, stdout: SHA, stderr: "" };
    },
  });
  const { code, err } = gate(["protected-paths"], { runner });
  assert.equal(code, 1);
  assert.match(err, /no merge base between origin\/main and HEAD/);
  assert.match(err, /git fetch origin main/);
  assert.equal(runner.runs().length, 0);
});

test("protected-paths passes the merge base and HEAD to the check", () => {
  const base = "1111111111111111111111111111111111111111";
  const runner = fakeRunner({
    capture: (argv) => {
      if (argv.includes("--abbrev-ref")) return { status: 0, stdout: "topic\n", stderr: "" };
      if (argv.includes("merge-base")) return { status: 0, stdout: `${base}\n`, stderr: "" };
      return { status: 0, stdout: `${SHA}\n`, stderr: "" };
    },
  });
  const { code, runner: used } = gate(["protected-paths"], { runner });
  assert.equal(code, 0);
  assert.deepEqual(used.runs(), [["node", ".github/scripts/protected-paths.mjs", base, SHA]]);
});

test("--base and --head override the range and skip git entirely", () => {
  const base = "aaaaaaa";
  const head = "bbbbbbb";
  const runner = fakeRunner();
  const { code } = gate(["protected-paths", "--base", base, "--head", head], { runner });
  assert.equal(code, 0);
  assert.deepEqual(runner.runs(), [["node", ".github/scripts/protected-paths.mjs", base, head]]);
  assert.equal(runner.calls.filter((call) => call.kind === "capture").length, 0);
});

test("a value flag given twice is refused rather than the last one winning", () => {
  assert.throws(
    () => parseArgs(["--filter", "@perbo/cli", "--filter", "@perbo/desktop"]),
    /--filter is given once; run the gate once per package/,
  );
  assert.throws(() => parseArgs(["--corpus", "a", "--corpus=b"]), /--corpus is given once/);
});

test("--base without --head, and a base that is not a SHA, are refused", () => {
  assert.equal(gate(["protected-paths", "--base", "aaaaaaa"]).code, 2);
  assert.equal(gate(["protected-paths", "--base", "origin/main", "--head", "HEAD"]).code, 2);
  assert.throws(() => parseArgs(["--base", "main", "--head", "abcdef1"]), /must be a commit SHA/);
});

test("resolveProtectedRange returns the given range untouched", () => {
  const range = resolveProtectedRange({
    options: { base: "abcdef1", head: "1234567" },
    capture: () => assert.fail("git must not be consulted when the range is given"),
  });
  assert.deepEqual(range, { base: "abcdef1", head: "1234567", nothingToCompare: null });
});

// --------------------------------------------------------------------------
// The pinned corpus. A temporary directory stands in for the repository, and
// the runner is fake, so nothing is cloned here.
// --------------------------------------------------------------------------

function pinnedRepo(pin) {
  const dir = mkdtempSync(join(tmpdir(), "perbo-check-pin-"));
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github", "corpus-pin.json"), JSON.stringify(pin, null, 2));
  return dir;
}

test("the corpus pin is read as a clone URL and a commit", () => {
  const dir = pinnedRepo({ repository: "https://github.com/example/corpus", commit: SHA });
  assert.deepEqual(readCorpusPin(dir), {
    repository: "https://github.com/example/corpus",
    commit: SHA,
    cloneUrl: "https://github.com/example/corpus.git",
  });
});

test("a pin whose commit or repository is not one is refused", () => {
  const badCommit = pinnedRepo({ repository: "https://github.com/example/corpus", commit: "main" });
  assert.throws(() => readCorpusPin(badCommit), /"commit" must be a commit SHA/);
  const badRepo = pinnedRepo({ repository: "git@github.com:example/corpus", commit: SHA });
  assert.throws(() => readCorpusPin(badRepo), /"repository" must be an https clone URL/);
  const absent = mkdtempSync(join(tmpdir(), "perbo-check-nopin-"));
  assert.throws(() => readCorpusPin(absent), /no corpus pin at/);
});

/** A context with the fake runner, for the stage-8 helper alone. */
function pinContext(dir, { exists, capture }) {
  const runner = fakeRunner({ capture });
  return {
    ctx: {
      repo: dir,
      exists,
      log: () => {},
      run: (argv) => {
        const result = runner.run(argv);
        if (result.status !== 0) throw new CommandFailed(argv, result.status);
        return result;
      },
      capture: (argv) => runner.capture(argv),
    },
    runner,
  };
}

test("an absent clone is cloned at the pinned commit", () => {
  const dir = pinnedRepo({ repository: "https://github.com/example/corpus", commit: SHA });
  const { ctx, runner } = pinContext(dir, { exists: () => false });
  const fixtures = ensurePinnedCorpus(ctx);
  assert.deepEqual(runner.runs(), [
    ["git", "clone", "--quiet", "https://github.com/example/corpus.git", PINNED_CORPUS_DIR],
    ["git", "-C", PINNED_CORPUS_DIR, "checkout", "--quiet", SHA],
  ]);
  assert.equal(fixtures, resolve(dir, PINNED_CORPUS_DIR, "fixtures"));
});

test("a clone that already carries the pinned commit is not fetched", () => {
  const dir = pinnedRepo({ repository: "https://github.com/example/corpus", commit: SHA });
  const { ctx, runner } = pinContext(dir, {
    exists: () => true,
    capture: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  ensurePinnedCorpus(ctx);
  assert.deepEqual(runner.runs(), [["git", "-C", PINNED_CORPUS_DIR, "checkout", "--quiet", SHA]]);
});

test("a clone missing the pinned commit is fetched first", () => {
  const dir = pinnedRepo({ repository: "https://github.com/example/corpus", commit: SHA });
  const { ctx, runner } = pinContext(dir, {
    exists: () => true,
    capture: () => ({ status: 1, stdout: "", stderr: "" }),
  });
  ensurePinnedCorpus(ctx);
  assert.deepEqual(runner.runs(), [
    ["git", "-C", PINNED_CORPUS_DIR, "fetch", "--quiet"],
    ["git", "-C", PINNED_CORPUS_DIR, "checkout", "--quiet", SHA],
  ]);
});

test("--corpus uses the clone it names and touches no git", () => {
  const runner = fakeRunner();
  const { code } = gate(["regression-dry-run", "--corpus", "/elsewhere/.corpus/fixtures"], { runner });
  assert.equal(code, 0);
  assert.deepEqual(runner.runs(), [
    [
      "node",
      "packages/evaluation/dist/main.js",
      "--suite",
      "regression",
      "--corpus",
      "/elsewhere/.corpus/fixtures",
    ],
  ]);
});

test("the dry run never asks the harness to spend", () => {
  const runner = fakeRunner();
  gate(["regression-dry-run", "--corpus", "/elsewhere/fixtures"], { runner });
  for (const argv of runner.runs()) assert.ok(!argv.includes("--run"), `--run reached ${argv.join(" ")}`);
});

test("a printed command is one a person could paste", () => {
  assert.equal(shellCommand(["pnpm", "exec", "turbo", "run", "build"]), "pnpm exec turbo run build");
  assert.equal(shellCommand(["node", "--test", "a b.mjs"]), "node --test 'a b.mjs'");
  assert.equal(shellCommand(["sh", "it's"]), "sh 'it'\\''s'");
});
