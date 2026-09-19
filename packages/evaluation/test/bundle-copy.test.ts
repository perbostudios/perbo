import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertBundleToolchain, captureExecutedBundle } from "../src/bundle.js";
import { main } from "../src/main.js";
import { sampleDir } from "./sample-fixtures.js";
import { describeWhen } from "./corpus-present.js";

/**
 * The reviewer a corpus run executes is a copy the run took of it, not the
 * file it was started from.
 *
 * A rebuild during the stage-3 dogfood run replaced `apps/cli/dist/main.js`
 * mid-flight and lost 206 of 270 reviews. Everything here is measured on what
 * the spawned processes actually did: the stand-in reviewer records its own
 * argv and the SHA-256 of the file it is executing, and — on its first review —
 * overwrites the source it was built from with a program that cannot produce an
 * artifact. If the run were still spawning the source, the reviews after the
 * first would be that program.
 */

// Real path, not the symlinked spelling of it: what a spawned process reports
// as `process.argv[1]`, and what module resolution reports for a file it found,
// are both resolved, and the assertions below compare against them.
const here = dirname(fileURLToPath(import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "perbo-bundle-copy-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const digestOf = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * How long one `--version` spawn of a real entry point is given before it is
 * killed. `check.unit_flaky` was raised on this file's tests at AYO-30 (#325)
 * when the merge-up gate's default five-second vitest timeout hit a cold
 * spawn on a machine also running a loop attempt and a second gate; 20s is
 * generous against that and still bounded against a genuine hang.
 */
const SPAWN_DEADLINE_MS = 20_000;

/**
 * `spawnSync` with the deadline above, closing off stdin (nothing spawned
 * here is interactive) and naming what the process wrote to stdout and
 * stderr in the error when it is killed by the deadline or never starts at
 * all, so a hang fails by naming what the process last said rather than by
 * vitest's own generic timeout message.
 */
function spawnVersion(argv: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SPAWN_DEADLINE_MS,
    killSignal: "SIGKILL",
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  // Checked before `result.error`: a kill from the deadline sets both, and
  // Node's own message for that ("ETIMEDOUT") is less useful than naming the
  // deadline that fired. A spawn that never started at all — ENOENT — sets
  // `error` alone and falls through to it below.
  if (result.signal) {
    throw new Error(
      `${argv.join(" ")} did not exit within ${SPAWN_DEADLINE_MS}ms and was killed by ` +
        `${result.signal}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  if (result.error) {
    throw new Error(
      `${argv.join(" ")} failed to spawn: ${result.error.message}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  return { status: result.status, stdout, stderr };
}

/** One line per spawn, written by the stand-in before it can fail. */
interface Spawn {
  fixture_id: string;
  argv: string[];
  executed_sha256: string;
  poisoned: boolean;
}

const spawns = (logPath: string): Spawn[] =>
  readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Spawn);

/**
 * What the source becomes the moment the first review starts: a reviewer that
 * logs the fact it ran and dies without an artifact. Nothing in the run may
 * execute it.
 */
function poison(logPath: string): string {
  return `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  fixture_id: "swapped-in-reviewer",
  argv: process.argv,
  executed_sha256: "",
  poisoned: true,
}) + "\\n");
process.exit(1);
`;
}

/**
 * A stand-in reviewer that answers every review with a valid artifact, records
 * what it was spawned as, and swaps its own source out from under the run.
 */
function writeSwappingStub(args: { source: string; log: string }): void {
  writeFileSync(
    args.source,
    `import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const at = (flag) => argv[argv.indexOf(flag) + 1];
const contract = JSON.parse(readFileSync(at("--contract"), "utf8"));
const dir = at("--contract").replace(/\\/contract\\.json$/, "");
const fixture = JSON.parse(readFileSync(dir + "/fixture.json", "utf8"));

// Written before anything else can fail, and it names the file this process is
// running: process.argv[1] is what was spawned, whatever the harness believes.
appendFileSync(
  ${JSON.stringify(args.log)},
  JSON.stringify({
    fixture_id: fixture.id,
    argv: process.argv,
    executed_sha256: createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"),
    poisoned: false,
  }) + "\\n",
);

// The swap the run has to survive, made while the run is in flight.
writeFileSync(${JSON.stringify(args.source)}, ${JSON.stringify(poison(args.log))});

const artifact = {
  schema_version: 1,
  review_id: "rev_" + Math.random().toString(16).slice(2, 10),
  resumed_from: null,
  created_at: new Date(0).toISOString(),
  target: { type: "changeset", id: "cs_stub", base_commit: contract.base.base_commit, head_commit: "d4e5f6a" },
  plan_id: contract.plan_id,
  plan_version: contract.version,
  planned_risk: contract.level,
  actual_risk: contract.level,
  escalated: false,
  independence: {
    context_builder: "reviewer_v1",
    executor_narrative_visible: false,
    executor_transcript_visible: false,
    separate_process: true,
    model_family: "same",
    grounded_in: [],
  },
  context_manifest: [],
  checks: [],
  overrides: [],
  coverage: (contract.acceptance_criteria ?? []).map((c) => ({
    criterion_id: c.id,
    status: "met",
    verification_strength: "directly_verified",
    evidence: null,
    note: null,
  })),
  findings: [],
  scope_deviation: {
    files_outside_scope: [],
    files_in_prohibited_paths: [],
    files_exempt_as_generated: [],
    within_expansion_budget: true,
    expansion_budget_files: contract.scope.expansion_budget_files,
  },
  decision: "approve",
  confidence: 0.9,
  cost_micros: 1000,
  latency_ms: 1000,
  model: {
    provider: "stub",
    model_id: "stub",
    prompt_version: "reviewer_v1",
    input_tokens: 1,
    output_tokens: 1,
    cost_basis: "transport_reported",
  },
  error: null,
};
process.stdout.write(JSON.stringify(artifact));
`,
  );
}

/** Runs the command with stdout and stderr captured rather than printed. */
async function run(argv: string[], cliPath: string): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  const code = await main(["--corpus", sampleDir, ...argv], { cliPath });
  return { code, err: err.join("") };
}

describe("a corpus run spawns the copy it took at run start", () => {
  const out = join(scratch, "swap-run");
  const log = join(scratch, "swap-spawns.log");
  const source = join(scratch, "reviewer-source.mjs");
  const copy = join(out, "bin", "perbo.mjs");
  let code = -1;

  beforeAll(async () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(log, "");
    writeSwappingStub({ source, log });
    // Two fixtures, two repeats: four reviews, of which only the first sees the
    // source as it was when the run started.
    ({ code } = await run(
      [
        "--run",
        "--repeats",
        "2",
        "--concurrency",
        "1",
        "--filter",
        "req-001,sec-006",
        "--provider",
        "claude-cli",
        "--out",
        out,
      ],
      source,
    ));
  // Four full reviews through `main`, each spawning the run's own copy of the
  // stand-in reviewer; 180s covers that under the loaded-machine load SCP-191
  // measures, with a wide margin over the handful of seconds this run takes
  // on an idle machine.
  }, 180_000);

  it("runs every fixture and repeat against the run-start copy, through a mid-run swap", () => {
    expect(code).toBe(0);

    // The swap happened: the source on disk is no longer the reviewer the run
    // was started with, and nothing that ran was it.
    expect(readFileSync(source, "utf8")).toContain("swapped-in-reviewer");
    expect(digestOf(source)).not.toBe(digestOf(copy));

    const launched = spawns(log);
    expect(launched).toHaveLength(4);
    expect(launched.filter((spawn) => spawn.poisoned)).toHaveLength(0);
    expect(launched.map((spawn) => spawn.fixture_id.slice(0, 7)).sort()).toEqual([
      "req-001",
      "req-001",
      "sec-006",
      "sec-006",
    ]);

    const digest = digestOf(copy);
    for (const spawn of launched) {
      expect(spawn.executed_sha256, `${spawn.fixture_id} ran the run-start copy`).toBe(digest);
      expect(spawn.argv[1]).toBe(copy);
      expect(spawn.argv.some((entry) => entry.includes("apps/cli/dist/main.js"))).toBe(false);
      expect(spawn.argv.some((entry) => entry === source)).toBe(false);
    }
  });

  it("records the executed copy's digest and size in the manifest and prints it in the report", () => {
    const manifest = JSON.parse(readFileSync(join(out, "run-manifest.json"), "utf8")) as {
      executed_bundle_sha256: string;
      executed_bundle_bytes: number;
    };
    expect(manifest.executed_bundle_sha256).toBe(digestOf(copy));
    expect(manifest.executed_bundle_bytes).toBe(statSync(copy).size);

    const report = readFileSync(join(out, "report.md"), "utf8");
    expect(report).toContain(digestOf(copy));
    // In the header, above every number the run produced.
    expect(report.split("\n")[0]).toContain(`sha256:${digestOf(copy)}`);
  });
});

/**
 * The bundler a run needs is the repository's own, and a run that cannot reach
 * it stops. What it must not do is stop for the wrong reason, or against the
 * wrong file: this package can sit inside somebody else's pnpm workspace, whose
 * root is not a checkout of this repository and whose `tooling/` is not ours.
 */
describe("finding the bundler a run builds its copy with", () => {
  const layout = (name: string, options: { nestedMarker: boolean; esbuild: boolean }) => {
    const root = join(scratch, name);
    mkdirSync(join(root, "tooling", "package"), { recursive: true });
    writeFileSync(join(root, "tooling", "package", "bundle.mjs"), "// a bundler\n");
    const installed = join(root, "node_modules", "@perbo", "evaluation", "dist");
    mkdirSync(installed, { recursive: true });
    if (options.nestedMarker) {
      // A workspace marker between the module and the repository root — the
      // thing the search must walk straight past.
      writeFileSync(join(root, "node_modules", "@perbo", "pnpm-workspace.yaml"), "packages: []\n");
    }
    if (options.esbuild) {
      const esbuild = join(root, "node_modules", "esbuild");
      mkdirSync(esbuild, { recursive: true });
      writeFileSync(
        join(esbuild, "package.json"),
        JSON.stringify({ name: "esbuild", version: "0.0.0", main: "index.js" }),
      );
      writeFileSync(join(esbuild, "index.js"), "module.exports = {};\n");
    }
    return { root, installed };
  };

  it("uses the repository's own, not the first workspace root above the module", () => {
    const { root, installed } = layout("nested-workspace", {
      nestedMarker: true,
      esbuild: true,
    });
    const toolchain = assertBundleToolchain(installed);
    expect(toolchain.script).toBe(join(root, "tooling", "package", "bundle.mjs"));
    expect(toolchain.esbuild).toBe(join(root, "node_modules", "esbuild", "index.js"));
  });

  it("names the bundler, and the checkout it lives in, when there is none above", () => {
    const stranded = join(scratch, "no-repository", "deep", "dist");
    mkdirSync(stranded, { recursive: true });
    // A workspace marker that is not this repository is not a bundler.
    writeFileSync(join(scratch, "no-repository", "pnpm-workspace.yaml"), "packages: []\n");

    // The boundary is the one this test built, not an assumption about where
    // the host's temporary directory sits: `stopAt` is what makes "there is
    // none above" a statement about the layout rather than about the machine.
    const bounded = () => assertBundleToolchain(stranded, { stopAt: scratch });
    expect(bounded).toThrow(/tooling\/package\/bundle\.mjs/);
    expect(bounded).toThrow(/checkout of the repository/);
  });

  it("stops at that boundary when the temporary directory is inside a checkout", () => {
    // What the runner's loop looks like: `TMPDIR` under a worktree that
    // carries this repository's own bundler.
    const { root } = layout("host-checkout", { nestedMarker: false, esbuild: true });
    const hostTmp = join(root, "tmp");
    mkdirSync(hostTmp, { recursive: true });
    vi.stubEnv("TMPDIR", hostTmp);
    const inside = realpathSync(mkdtempSync(join(tmpdir(), "perbo-inside-checkout-")));
    const stranded = join(inside, "no-repository", "deep", "dist");
    mkdirSync(stranded, { recursive: true });

    // Unbounded, the walk climbs out of the temporary directory and finds the
    // checkout's bundler, so nothing under it can mean "no repository above".
    expect(assertBundleToolchain(stranded).script).toBe(
      join(root, "tooling", "package", "bundle.mjs"),
    );
    expect(() => assertBundleToolchain(stranded, { stopAt: inside })).toThrow(
      /checkout of the repository/,
    );
  });

  it("names esbuild, and how to install it, when the bundler has none", () => {
    const { installed } = layout("no-esbuild", { nestedMarker: false, esbuild: false });
    expect(() => assertBundleToolchain(installed)).toThrow(/esbuild/);
    expect(() => assertBundleToolchain(installed)).toThrow(/pnpm install/);
  });

  it("resolves this checkout's bundler and esbuild by default", () => {
    const toolchain = assertBundleToolchain();
    expect(toolchain.script.endsWith(join("tooling", "package", "bundle.mjs"))).toBe(true);
    expect(existsSync(toolchain.script)).toBe(true);
    expect(existsSync(toolchain.esbuild)).toBe(true);
  });
});

describe("a run with no bundle to copy is refused before anything is spawned", () => {
  it("names the missing reviewer, exits non-zero and reviews nothing", async () => {
    const out = join(scratch, "missing-run");
    const missing = join(scratch, "never-built", "main.js");

    const { code, err } = await run(
      [
        "--run",
        "--repeats",
        "1",
        "--concurrency",
        "1",
        "--filter",
        "req-001,sec-006",
        "--provider",
        "claude-cli",
        "--out",
        out,
      ],
      missing,
    );

    expect(code).not.toBe(0);
    expect(err).toContain(missing);
    expect(err).toContain("no CLI entry point");
    // Nothing was reviewed: a spawned fixture writes an artifact, and the run
    // loop writes runs.json whatever the reviews did.
    expect(existsSync(join(out, "artifacts"))).toBe(false);
    expect(existsSync(join(out, "runs.json"))).toBe(false);
    expect(existsSync(join(out, "bin", "perbo.mjs"))).toBe(false);
  }, 60_000);

  it("refuses a reviewer that cannot be read as a program rather than falling back to it", async () => {
    const out = join(scratch, "unreadable-run");
    // Present, and not a file the bundler can read: the failure is loud rather
    // than a silent return to spawning the tree's own copy.
    const unreadable = join(scratch, "not-a-program");
    mkdirSync(unreadable, { recursive: true });

    const { code, err } = await run(
      [
        "--run",
        "--repeats",
        "1",
        "--concurrency",
        "1",
        "--filter",
        "req-001",
        "--provider",
        "claude-cli",
        "--out",
        out,
      ],
      unreadable,
    );

    expect(code).not.toBe(0);
    expect(err).toContain(unreadable);
    expect(err).toContain("reviewer bundle");
    expect(existsSync(join(out, "runs.json"))).toBe(false);
  }, 60_000);
});

/**
 * The real `perbo` binary, if this tree has built one that starts: this
 * package's tests can run before `apps/cli` is built, so the suite below waits
 * on the binary rather than on a flag somebody has to remember to turn off.
 */
const CLI_ENTRY = resolve(here, "..", "..", "..", "apps", "cli", "dist", "main.js");
// Gates a `describe` below rather than running inside a test, so a hang here
// is bounded by this spawn's own deadline rather than by any vitest timeout —
// nothing at collection time can apply one.
const cliStarts = existsSync(CLI_ENTRY) && spawnVersion([CLI_ENTRY, "--version"]).status === 0;

const describeWithRealCli = describeWhen(
  cliStarts,
  `${CLI_ENTRY} is not a program that starts in this tree`,
);

describeWithRealCli("the copy a run spawns can start", () => {
  // The five-second default vitest timeout hit exactly this test during the
  // SCP-161 merge-up gate (a cold spawn beside a loop attempt and a second
  // gate); two spawns plus the bundle build comfortably fit in 30s.
  it("bundles the real CLI entry point and the copy answers --version like the source", () => {
    const entry = CLI_ENTRY;
    expect(existsSync(entry), `${entry} is built before this test runs`).toBe(true);
    const out = join(scratch, "real-copy");
    mkdirSync(out, { recursive: true });
    const bundle = captureExecutedBundle({ entry, outDir: out });
    expect(existsSync(join(out, "package.json"))).toBe(true);
    const copy = spawnVersion([bundle.path, "--version"]);
    const source = spawnVersion([entry, "--version"]);
    expect(copy.status, copy.stderr).toBe(0);
    // `--version` answers on stderr, and the answer must be a version, not two
    // empty streams agreeing with each other.
    expect(source.stderr).toMatch(/^perbo \d+\.\d+\.\d+/);
    expect(copy.stderr).toBe(source.stderr);
  }, 30_000);
});
