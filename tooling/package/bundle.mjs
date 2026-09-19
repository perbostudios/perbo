#!/usr/bin/env node
// The single-file CLI bundle: every workspace package and every third-party
// dependency inlined into one `.mjs`, with only Node's own modules left
// external, so the file runs on its own with no `node_modules` beside it.
//
// Two callers, one bundle: `pack.mjs` stages it into the design-partner tarball,
// and a corpus `--run` builds one into its own output directory at run
// start and spawns that copy for every fixture, so a rebuild of the tree during
// a run cannot change what is being measured.
//
// Usable as a module — `import { bundleCli } from "./bundle.mjs"` — and as a
// command, in two forms: `node bundle.mjs --entry <file> --outfile <file>` for
// one bundle anywhere, and `node bundle.mjs --package`, which `apps/cli`'s own
// `build` runs to produce every file its manifest publishes: the binaries its
// `bin` names and the library entry its `main` and `exports` name.

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** The repository root, from this file's own location. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The one entry point `apps/cli` builds: every command, and what the tarball and a corpus run spawn. */
export const CLI_ENTRY_POINT = join("apps", "cli", "dist", "main.js");

/**
 * The file `apps/cli`'s `bin` names, built from the entry point above.
 *
 * A bundle rather than the compiled entry point beside it because a `bin` has
 * to work where the package is *installed*, and there the workspace packages
 * it imports do not exist: `@perbo/contracts` and the rest are never
 * published, so a tarball whose binary imported them by name would install and
 * then fail on its first line. Bundling is what makes `apps/cli` packable at
 * all — the archive `pack.mjs` builds has always been one file for the same
 * reason, and this is that file, built by the package's own `build` so that the
 * manifest never names a binary the build did not produce.
 *
 * Beside the compiled entry point rather than in a `bin/` of its own, because
 * the CLI reads its own version from `../package.json` — one directory above
 * the file that is running. That holds for `dist/perbo.js` both here and in an
 * installed package, and it is the same arrangement `pack.mjs` stages the
 * archive in; a nested directory would have put the binary one level too deep
 * and left `--version` reading a file that is not there.
 */
export const CLI_BIN = join("apps", "cli", "dist", "perbo.js");

/**
 * The library entry `apps/cli`'s `main` and `exports` name, and the compiled
 * module it is built from.
 *
 * Bundled for the same reason the binaries are, and it is the same reason twice:
 * an installed `@perbo/cli` has no `@perbo/contracts` beside it, so the
 * compiled `dist/index.js` — which is `export *` over modules that import the
 * workspace by name — resolves nothing once it leaves this repository. A
 * manifest may not name an entry point that only works where it was built, so
 * the published one is this bundle and `dist/index.js` stays what it is: the
 * compiled tree, for the workspace that has the packages linked.
 *
 * A separate file rather than `dist/index.js` rewritten in place, because
 * esbuild will not read and write one path, and because the compiled tree is
 * what the other tests and `packages/evaluation` read.
 */
export const CLI_LIBRARY = {
  entry: join("apps", "cli", "dist", "index.js"),
  outfile: join("apps", "cli", "dist", "index.bundle.js"),
};

/**
 * The runner's write-guard hook: the compiled module it is built from, and the
 * name it is staged under.
 *
 * Claude Code runs it before every tool call that can write, and the runner
 * spawns it as `node <guard-hook.js> <directory>` looking for it beside the
 * module that is running — so a build carries it beside its binary or its
 * `run` stops at the first tool call.
 *
 * Bundled rather than copied, for the reason the binaries are: the compiled
 * file imports the runner's own modules and the workspace packages behind them,
 * and none of those exist where the binary is installed.
 */
export const GUARD_HOOK_ENTRY = join("packages", "runner", "dist", "guard-hook.js");
export const GUARD_HOOK_FILE = "guard-hook.js";

/**
 * Bundle the write-guard hook into `beside`, the directory a binary was
 * written to.
 *
 * `root` is the built tree the hook is read from, and it defaults to this
 * repository rather than following a caller's output root: `bundleCliPackage`
 * lays a package out under a root of its own, and there is no
 * `packages/runner` under it.
 */
export async function bundleGuardHook({ beside, root = ROOT }) {
  const entry = join(root, GUARD_HOOK_ENTRY);
  if (!existsSync(entry)) {
    throw new Error(`${entry} is not compiled: build @perbo/runner before staging a binary`);
  }
  return bundleCli({ entry, outfile: join(beside, GUARD_HOOK_FILE), absWorkingDir: root });
}

/**
 * Every file `apps/cli`'s manifest publishes, built from the compiled entry
 * point beside it, and the paths of the ones that were built.
 *
 * An entry point that is not there is skipped rather than failing, so this runs
 * against a partially compiled tree — a `--filter`ed build, or one of the test
 * suites that compiles `apps/cli` on its own into a directory of its own —
 * without demanding a whole workspace build first.
 */
export async function bundleCliPackage({ root = ROOT } = {}) {
  const built = [];
  const entry = join(root, CLI_ENTRY_POINT);
  if (existsSync(entry)) {
    const target = join(root, CLI_BIN);
    await bundleCli({ entry, outfile: target, absWorkingDir: root });
    // Executable, because that is what a `bin` is. npm and pnpm both set the
    // bit when they link one, but a file run straight out of the build tree —
    // `apps/cli/dist/bin/perbo --version` — has only what was written here.
    chmodSync(target, 0o755);
    built.push(target);
    // The hook is written beside the binary, where the runner looks for it.
    const beside = dirname(target);
    await bundleGuardHook({ beside });
    built.push(join(beside, GUARD_HOOK_FILE));
  }
  const library = join(root, CLI_LIBRARY.entry);
  if (existsSync(library)) {
    const target = join(root, CLI_LIBRARY.outfile);
    // Not chmodded: a library is imported, not run.
    await bundleCli({ entry: library, outfile: target, absWorkingDir: root });
    built.push(target);
  }
  return built;
}

/** The CLI's own manifest is the only release-version source. */
export function readVersion() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "apps", "cli", "package.json"), "utf8"));
  const version = manifest.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`apps/cli/package.json has no usable version: ${JSON.stringify(version)}`);
  }
  return version;
}

/** Package names behind a bundle's inputs, for a closing summary. */
export function bundledPackages(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf("node_modules/");
    if (at !== -1) {
      const [scopeOrName, name] = input.slice(at + "node_modules/".length).split("/");
      names.add(scopeOrName.startsWith("@") ? `${scopeOrName}/${name}` : scopeOrName);
      continue;
    }
    const [top, dir] = input.split("/");
    if (top === "packages" || top === "apps") names.add(`@perbo/${dir}`);
  }
  return [...names].sort();
}

/**
 * Node's own modules, in both spellings, stay external. Everything else — the
 * workspace packages and every third-party dependency — is bundled.
 */
export const NODE_BUILTINS = builtinModules.flatMap((module) =>
  module.startsWith("node:") ? [module] : [module, `node:${module}`],
);

/**
 * The Claude Agent SDK, which `perbo interview` runs the person's session
 * through (D-102), stays external.
 *
 * `interview.ts` imports it when a session is actually started, and says what
 * to install when it is not there; inlining it would carry a megabyte and a half
 * of it into every binary. The session runs the person's own Claude Code, which
 * the interview names to the SDK by path (`pathToClaudeCodeExecutable`), not the
 * copy the published package carries as a per-platform optional dependency.
 */
export const EXTERNAL_PACKAGES = ["@anthropic-ai/claude-agent-sdk"];

// What a CommonJS dependency has in scope and an ES module does not. The
// output is ESM, so each of these is a free variable that throws on the line
// that reads it — at run time, in whichever branch reaches it first, which is
// why they are supplied here rather than waited for.
//
// `require`: a bundled dependency may call it through a pattern esbuild cannot
// resolve statically, and esbuild's shim for that call uses a `require` in
// scope when one exists and throws when none does.
//
// `__filename` and `__dirname`: the TypeScript compiler reads both while it
// starts, to decide whether the file system is case-sensitive and to find its
// own directory. In a bundle they name the bundle, which is the true answer to
// both questions about the file that is running.
const BANNER = [
  'import { createRequire as __perboCreateRequire } from "node:module";',
  'import { dirname as __perboDirname } from "node:path";',
  'import { fileURLToPath as __perboFileURLToPath } from "node:url";',
  "const require = __perboCreateRequire(import.meta.url);",
  "const __filename = __perboFileURLToPath(import.meta.url);",
  "const __dirname = __perboDirname(__filename);",
].join("\n");

/**
 * Bundle `entry` and everything it imports into `outfile`.
 *
 * Returns esbuild's metafile, which names every input that went in — `pack.mjs`
 * reads it to list the packages the archive carries.
 */
export async function bundleCli({ entry, outfile, absWorkingDir = process.cwd() }) {
  const target = resolve(absWorkingDir, outfile);
  mkdirSync(dirname(target), { recursive: true });
  const { metafile } = await build({
    absWorkingDir,
    entryPoints: [resolve(absWorkingDir, entry)],
    outfile: target,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: [...NODE_BUILTINS, ...EXTERNAL_PACKAGES],
    banner: { js: BANNER },
    legalComments: "inline",
    metafile: true,
    logLevel: "warning",
  });
  return metafile;
}

/** Whether the module at `url` is the program, or something that imported it. */
export function invokedDirectly(url) {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(argv1) === real(fileURLToPath(url));
}

if (invokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = (flag) => {
    const index = args.indexOf(flag);
    if (index === -1 || args[index + 1] === undefined) {
      throw new Error(`bundle.mjs needs ${flag} <file>`);
    }
    return args[index + 1];
  };
  try {
    if (args.includes("--package")) await bundleCliPackage();
    else await bundleCli({ entry: at("--entry"), outfile: at("--outfile") });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
