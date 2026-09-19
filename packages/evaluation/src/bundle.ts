import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The reviewer the run executes, taken once, before the first fixture.
 *
 * A corpus run used to spawn `apps/cli/dist/main.js` out of the tree it was
 * also being edited in. A rebuild during a run replaced it mid-flight and cost
 * 206 of 270 runs, about $12 and forty minutes. Detecting the
 * damage afterwards was the first fix; this is the one that prevents it.
 *
 * The snapshot is a *bundle* rather than a copied file because copying the
 * entry point alone would prevent nothing: `main.js` imports `./run.js` and
 * `@perbo/contracts`, and both resolve back into the tree being rebuilt. Only
 * a single file with every workspace package and dependency inlined is
 * genuinely detached from it, which is what `tooling/package/bundle.mjs`
 * builds — the same bundle the design-partner tarball ships.
 */
export interface ExecutedBundle {
  /** The file every review in the run is spawned against. */
  path: string;
  /** SHA-256 of that file as it sits on disk. */
  sha256: string;
  /** Its size in bytes, as it sits on disk. */
  bytes: number;
  /** The entry point it was built from, which is not executed. */
  source: string;
}

/** `<out>/bin/perbo.mjs`: the run's own copy, beside the run's own results. */
export const BUNDLE_DIRNAME = "bin";
export const BUNDLE_FILENAME = "perbo.mjs";

/** `tooling/package/bundle.mjs`, relative to a checkout of this repository. */
const BUNDLER_RELATIVE_PATH = join("tooling", "package", "bundle.mjs");

/**
 * The corpus harness bundles the reviewer with the repository's own bundler,
 * and so it runs from a checkout of the repository.
 *
 * That is a real constraint and it is stated rather than worked around. It is
 * also the smaller half of one this package already has: `defaultCacheDir()`
 * puts prepared repositories in `<repo>/.local/corpus-cache`, and a manifest
 * whose `source_commit` is absent — which is every run made outside a git
 * checkout — is refused as a gate source. What must never happen instead is a
 * run that cannot bundle quietly spawning the entry point out of the tree: that
 * is the swap this mechanism exists to prevent, and it would come back on the
 * one machine where the bundler was missing.
 *
 * The bundler is found by looking for *the bundler*, walking up from this
 * module, rather than for a workspace marker: an installed copy of this package
 * inside somebody else's pnpm workspace would find their `pnpm-workspace.yaml`
 * and then report a missing file under their root, which describes the wrong
 * problem.
 *
 * `stopAt` bounds the walk: it is checked like any other directory and the
 * search ends there rather than at the file system root. A caller that built a
 * directory tree and wants to know whether *that tree* holds a bundler says so
 * with it, instead of relying on where the tree happens to sit.
 */
function findBundlerScript(from: string, stopAt?: string): string | null {
  const stop = stopAt === undefined ? null : resolve(stopAt);
  let directory = resolve(from);
  for (;;) {
    const script = join(directory, BUNDLER_RELATIVE_PATH);
    if (existsSync(script)) return script;
    if (directory === stop) return null;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** The bundler script and the esbuild install it will use. */
export interface BundleToolchain {
  /** `tooling/package/bundle.mjs`, spawned with the current `node`. */
  script: string;
  /** The esbuild entry point resolvable from that script. */
  esbuild: string;
}


/**
 * The CLI reads its version from the `package.json` one directory above its
 * entry point at load, so a copy under `<outDir>/bin/` needs one at
 * `<outDir>/package.json` or it exits before it can review anything. The
 * version is the source package's own and nothing else from it is carried. A
 * source with no manifest beside it — a stand-in reviewer in a test, which reads
 * none — gets none; whether the copy of the real CLI starts is proven by
 * running it, not by this function.
 */
function stageManifestBeside(entry: string, copy: string): void {
  const source = join(dirname(entry), "..", "package.json");
  if (!existsSync(source)) return;
  let version: string;
  try {
    const parsed = JSON.parse(readFileSync(source, "utf8")) as { version?: unknown };
    if (typeof parsed.version !== "string" || parsed.version.length === 0) {
      throw new Error("no version field");
    }
    version = parsed.version;
  } catch (error) {
    throw new Error(
      `the reviewer bundle copy cannot start without the CLI's version, and ${source} could not ` +
        `supply it: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  writeFileSync(
    join(dirname(dirname(copy)), "package.json"),
    `${JSON.stringify({ name: "perbo", version, private: true, type: "module" }, null, 2)}\n`,
  );
}

/**
 * Refuse, before a run starts, a machine that cannot build the bundle.
 *
 * Both halves are checked here rather than being read out of the bundler's
 * stderr, because both have an instruction attached: check out the repository,
 * or install its dependencies. The bundler is spawned rather than imported —
 * esbuild is a dependency of `@perbo/package` and not of this one, and a
 * corpus run has no business pulling a bundler into its own process — so this
 * is also where a missing esbuild is a sentence rather than a stack trace from
 * a child process.
 *
 * `from` is where the search for the bundler starts; this module's own
 * directory, which is the answer for every caller outside a test of the search
 * itself. `options.stopAt` bounds it, for a caller that knows which directory
 * the answer has to be found under.
 */
export function assertBundleToolchain(
  from = dirname(fileURLToPath(import.meta.url)),
  options: { stopAt?: string } = {},
): BundleToolchain {
  const script = findBundlerScript(from, options.stopAt);
  if (script === null) {
    throw new Error(
      `the reviewer bundle cannot be built: no ${BUNDLER_RELATIVE_PATH} above ${resolve(from)}. ` +
        "A corpus run bundles the reviewer with the repository's own bundler, so it runs " +
        "from a checkout of the repository rather than from an installed copy of this package.",
    );
  }
  const esbuild = findEsbuild(dirname(script));
  if (esbuild === null) {
    throw new Error(
      `the reviewer bundle cannot be built: ${script} has no esbuild to bundle with. ` +
        "Install the workspace's dependencies (`pnpm install`) before running the corpus.",
    );
  }
  return { script, esbuild };
}

/**
 * The esbuild entry point the bundler script would load: the first
 * `node_modules/esbuild` at or above the script's directory, read from the
 * file system rather than through `require.resolve`, whose answer under a test
 * runner is the runner's own resolution and not the script's.
 */
function findEsbuild(from: string): string | null {
  let directory = resolve(from);
  for (;;) {
    const pkg = join(directory, "node_modules", "esbuild", "package.json");
    if (existsSync(pkg)) {
      let main = "index.js";
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { main?: unknown };
        if (typeof parsed.main === "string" && parsed.main.length > 0) main = parsed.main;
      } catch {
        // An unreadable manifest is still an install; the default entry stands.
      }
      return join(dirname(pkg), main);
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Refuse an entry point that cannot be bundled, by name, and return it
 * resolved.
 *
 * Separate from the build because a run has to be able to ask the question
 * before it records anything about itself: a run whose reviewer is not there
 * must stop while it has still spawned nothing and spent nothing.
 */
export function assertBundleSource(entry: string): string {
  const resolved = resolve(entry);
  if (!existsSync(resolved)) {
    throw new Error(
      `the reviewer bundle cannot be built: no CLI entry point at ${resolved}. ` +
        "Build the workspace (`pnpm build`) before running the corpus.",
    );
  }
  if (!statSync(resolved).isFile()) {
    throw new Error(`the reviewer bundle cannot be built: ${resolved} is not a file`);
  }
  try {
    accessSync(resolved, constants.R_OK);
  } catch {
    throw new Error(`the reviewer bundle cannot be built: ${resolved} is not readable`);
  }
  return resolved;
}

/**
 * Build the run's own single-file copy of the reviewer into `<outDir>/bin/`,
 * and fingerprint it.
 *
 * Every failure here is thrown, never absorbed: falling back to the entry point
 * in the tree would restore exactly the hazard this exists to remove, and it
 * would do it silently, on the one run nobody was watching.
 */
export function captureExecutedBundle(args: { entry: string; outDir: string }): ExecutedBundle {
  const entry = assertBundleSource(args.entry);
  const toolchain = assertBundleToolchain();
  const path = join(resolve(args.outDir), BUNDLE_DIRNAME, BUNDLE_FILENAME);
  try {
    execFileSync(process.execPath, [toolchain.script, "--entry", entry, "--outfile", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const detail = (failure.stderr ?? "").trim() || (failure.message ?? "the bundler failed");
    throw new Error(`the reviewer bundle could not be built from ${entry}: ${detail}`, {
      cause: error,
    });
  }
  if (!existsSync(path)) {
    throw new Error(`the reviewer bundle could not be built from ${entry}: nothing written to ${path}`);
  }
  const contents = readFileSync(path);
  if (contents.byteLength === 0) {
    throw new Error(`the reviewer bundle built from ${entry} is empty: ${path}`);
  }
  // Executable in its own right, so the copy can be run by hand from the
  // results directory to reproduce what the run measured.
  chmodSync(path, 0o755);
  stageManifestBeside(entry, path);
  return {
    path,
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: statSync(path).size,
    source: entry,
  };
}
