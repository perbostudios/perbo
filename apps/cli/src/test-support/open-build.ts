import { execFileSync, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { describe, it } from "vitest";
import { PACKAGE_ROOT, REPO_ROOT } from "./paths.js";

/**
 * The build `apps/cli` ships, as the release scripts produce it.
 *
 * These tests assert over the artefact a user would install — the compiled
 * entry point and the single-file bundle `tooling/package/bundle.mjs` writes —
 * rather than over the source that is meant to produce it. A module that
 * reaches the bundle by a path nobody wrote down still shows up here.
 */

/** Where the compiled tree is published from, in the paths these tests assert on. */
const PUBLISHED_DIST = join("apps", "cli", "dist");

/** esbuild's record of what went into a bundle, keyed by path relative to the repository root. */
export interface BundleMetafile {
  inputs: Record<string, unknown>;
}

interface Bundler {
  ROOT: string;
  CLI_ENTRY_POINT: string;
  bundleCli(options: {
    entry: string;
    outfile: string;
    absWorkingDir: string;
  }): Promise<BundleMetafile>;
}

/** Every directory a test run staged, so it can take them away again. */
const staged: string[] = [];

/** Remove what this run staged: the compiled tree and every bundle built from it. */
export function removeStagedBundles(): void {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
}

let compiled: string | undefined;

/**
 * `apps/cli`, compiled into a directory belonging to this test run.
 *
 * Never `apps/cli/dist`. That directory is shared with every other thing that
 * builds this package, and deciding whether it is current from mtimes is
 * exactly the check that passes for a stale tree — a branch switch rewrites
 * source mtimes, `turbo` writes dist on its own schedule, and a deleted module
 * leaves its compiled output behind. So the tests compile once per test
 * process, from the sources in the working tree, into a fresh `mkdtemp`, and
 * throw it away at the end.
 *
 * The directory is made *under the package* rather than under the system
 * temporary directory, because what is compiled has to keep working: the
 * entry points resolve `@perbo/*` through `apps/cli/node_modules` and read the
 * version from `../package.json`, and both answers are only right for a
 * directory one level below `apps/cli`. `.gitignore` keeps it out of the tree.
 */
export function buildCli(): string {
  if (compiled !== undefined) return compiled;
  const out = realpathSync(mkdtempSync(join(PACKAGE_ROOT, ".test-dist-")));
  staged.push(out);
  execFileSync(join(PACKAGE_ROOT, "node_modules", ".bin", "tsc"), [
    "-p",
    // The build config, not `tsconfig.json`: that one typechecks the tests and
    // emits nothing, and these tests need the compiled entry points.
    "tsconfig.build.json",
    "--outDir",
    out,
  ], {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
  });
  compiled = out;
  return out;
}

export interface Bundle {
  /** The single `.mjs` file the release script writes. */
  file: string;
  /** Everything esbuild resolved into it, relative to the repository root. */
  modules: string[];
  /** The bundle's own bytes. */
  text: string;
}

/**
 * Build the CLI bundle with the release script's own bundler, into a directory
 * of this test run's own.
 *
 * The entry point is the compiled file the release script names, taken out of
 * this run's own compiled tree — so what is bundled is what was just built
 * from the working tree, and the coupling to `bundle.mjs` stays: a renamed
 * entry point fails here rather than silently bundling the old one.
 */
export async function bundleBuild(): Promise<Bundle> {
  const bundler = (await import(join(REPO_ROOT, "tooling", "package", "bundle.mjs"))) as Bundler;
  const dist = buildCli();
  const entry = join(dist, basename(bundler.CLI_ENTRY_POINT));
  // `realpathSync`, because the confinement tests hand these paths to Node's
  // permission model: it matches on the resolved path, and a temporary
  // directory reached through a symlinked `/tmp` would be denied at the first
  // component rather than allowed at the last.
  const install = realpathSync(mkdtempSync(join(tmpdir(), "perbo-bundle-")));
  staged.push(install);
  const file = join(install, "bin", "perbo.mjs");
  const metafile = await bundler.bundleCli({ entry, outfile: file, absWorkingDir: bundler.ROOT });
  // Staged as the release script stages it: the binary reports its version from
  // the manifest one directory up from where it runs, so a bundle without one
  // beside it is not the artefact a user would install.
  writeFileSync(
    join(install, "package.json"),
    readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  // esbuild names its inputs by where they were on this run's disk. The staged
  // directory is this run's alone, so it is reported under the path the release
  // build publishes from — the assertions are about which module went in, not
  // about where a test happened to put it.
  const from = `${relative(REPO_ROOT, dist)}/`;
  const modules = Object.keys(metafile.inputs)
    .map((path) => (path.startsWith(from) ? join(PUBLISHED_DIST, path.slice(from.length)) : path))
    .sort();
  return { file, modules, text: readFileSync(file, "utf8") };
}

/**
 * How this Node spells the permission model, or `null` where it has none.
 *
 * Decided from the running Node's major version and nowhere else: `--permission`
 * from Node 23, `--experimental-permission` on the Node 22 this workspace's
 * `engines` floor at, and no permission model at all below that. Asking the
 * runtime by trying a flag reads the answer off an exit code that a dozen other
 * things also produce, and gives a different answer on a machine whose
 * temporary directory it could not stat.
 */
export function permissionFlag(): string | null {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 23) return "--permission";
  if (major === 22) return "--experimental-permission";
  return null;
}

/** Why a suite that needs the permission model is not run on this Node. */
export const NO_PERMISSION_MODEL_REASON =
  `Node ${process.versions.node} has no permission model (it arrived in Node 22 as ` +
  "--experimental-permission); the confinement these suites assert cannot be enforced here";

/**
 * `describe.sequential`, replaced by one skipped test saying why, on a Node
 * with no permission model. The factory is not run at all in that case, as in
 * `packages/evaluation/test/corpus-present.ts`: a suite that reads the missing
 * thing while collecting would throw before a skip could apply.
 *
 * Sequential rather than plain `describe`: every confined test spawns the one
 * bundle `beforeAll` built for the file, so the tests reading it are pinned to
 * run one after another rather than left to whatever vitest's default would do.
 */
export function describeConfined(name: string, factory: () => void): void {
  if (permissionFlag() !== null) {
    describe.sequential(name, factory);
    return;
  }
  describe(name, () => {
    it.skip(`skipped: ${NO_PERMISSION_MODEL_REASON}`, () => undefined);
  });
}

/**
 * How long one spawn of a built entry point is given before it is killed.
 *
 * A cold Node start on a machine that is also running a loop attempt and a
 * second gate (SCP-191's ten-run measurement) is seconds, not milliseconds —
 * but a `--help` or `--version` invocation that is still running after 20s is
 * not slow, it is hung (on stdin, most often: SCP-191 was opened after a
 * five-second vitest default made exactly that call look like a defect in
 * what it tested). 20s is generous against the first and still bounded
 * against the second.
 */
export const SPAWN_DEADLINE_MS = 20_000;

/**
 * `spawnSync` against a built entry point, with the deadline above and the
 * process's own stdin closed off (nothing here is interactive, and an entry
 * point that unexpectedly tried to read from an inherited stdin is exactly
 * the kind of hang the deadline exists to catch instead of waiting on).
 *
 * An ordinary non-zero exit is not a failure here — callers assert on `status`
 * themselves — but a kill from the deadline or a spawn that never started is:
 * both throw, naming what the process last wrote to stdout and stderr so the
 * failure says what it was doing rather than just that it did not finish.
 */
export function spawnBuilt(
  argv: readonly string[],
  options: Omit<SpawnSyncOptions, "encoding"> = {},
): { status: number | null; stdout: string; stderr: string } {
  const deadline = options.timeout ?? SPAWN_DEADLINE_MS;
  const result = spawnSync(process.execPath, [...argv], {
    stdio: ["ignore", "pipe", "pipe"],
    killSignal: "SIGKILL",
    ...options,
    timeout: deadline,
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  // Checked before `result.error`: a kill from the deadline sets both, and
  // Node's own message for that case ("ETIMEDOUT") is less useful than naming
  // the deadline that fired. A signal with no `error` (an external kill) is
  // the same story and gets the same message; a spawn that never started at
  // all — the ENOENT case — sets `error` alone and falls through to it.
  if (result.signal) {
    throw new Error(
      `${[process.execPath, ...argv].join(" ")} did not exit within ${deadline}ms and was ` +
        `killed by ${result.signal}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  if (result.error) {
    throw new Error(
      `${[process.execPath, ...argv].join(" ")} failed to spawn: ${result.error.message}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  return { status: result.status, stdout, stderr };
}
