import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCli, removeStagedBundles } from "../src/test-support/built-cli.js";
import { PACKAGE_ROOT, REPO_ROOT } from "../src/test-support/paths.js";

/**
 * `apps/cli` is a package somebody can install (ADR-0032).
 *
 * It was marked `private` and its `bin` named `./dist/main.js`, a file whose
 * every import was a workspace package that is not published — so the manifest
 * described a binary that could not be packed, and could not have run if it
 * had been. Both halves are asserted here over the real artefacts: the files
 * the release bundler builds from the manifest's own entry points, the tarball
 * `npm pack` makes of them, and that tarball installed into an empty directory
 * outside this checkout, where nothing this repository holds is reachable.
 *
 * Nothing here writes to `apps/cli/dist`. That directory is the shared build
 * output — other suites in this package spawn the binaries in it, and the whole
 * workspace's `turbo run build` owns it — so a test that rebuilt it would be
 * rewriting the artefact its neighbours are reading while they read it. The
 * package is staged instead: compiled by `buildCli()` into this run's own
 * directory, bundled into a tree shaped like the repository, and packed from
 * there. What is packed is the authored manifest, byte for byte.
 */

const manifestPath = join(PACKAGE_ROOT, "package.json");

interface Manifest {
  private?: unknown;
  name: string;
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  files?: string[];
  exports?: Record<string, Record<string, string>>;
  dependencies?: Record<string, string>;
  version: string;
}

const manifest = (): Manifest => JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

/** Everything a bundle of ours must not still be importing by name once installed. */
const UNPUBLISHED_IMPORT = /^\s*(?:import|export)\s[^;]*from\s*"(?:@perbo\/|zod)/m;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "perbo-packaging-")));

/** Directories staged under the package (see `.gitignore`), removed with it. */
const underPackage: string[] = [];

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const dir of underPackage.splice(0)) rmSync(dir, { recursive: true, force: true });
  removeStagedBundles();
});

/**
 * How long the staging and the install are each given. Both are cold: the
 * staging is a `tsc` over the whole package plus the bundles the manifest
 * names, and the install unpacks a multi-megabyte tarball. Minutes are wrong
 * and seconds are too few.
 */
const DEADLINE_MS = 300_000;

interface Staged {
  /** The package root as `npm pack` sees it: the manifest, and `dist` beside it. */
  root: string;
  /** Every file the release bundler reported building, relative to {@link root}. */
  built: string[];
}

/**
 * The package built the way its own `build` builds it, into a directory of this
 * run's own.
 *
 * The bundling is the release bundler's `bundleCliPackage`, called on a root
 * this test made — the same function `apps/cli`'s `build` script runs, so the
 * files it writes are the files a build writes, and a bundler that stopped
 * producing one of them fails here rather than being described correctly by a
 * test that never ran it.
 *
 * The staged root is `<scratch>/apps/cli`, mirroring the repository, because
 * that is what `bundleCliPackage` lays its outputs out under; and the scratch
 * is made *under this package* so the compiled entry points still resolve
 * `@perbo/*` and `zod` through `apps/cli/node_modules` while they are bundled.
 */
async function stagePackage(): Promise<Staged> {
  const scratchRoot = realpathSync(mkdtempSync(join(PACKAGE_ROOT, ".test-dist-pack-")));
  underPackage.push(scratchRoot);
  const root = join(scratchRoot, "apps", "cli");
  mkdirSync(root, { recursive: true });
  // The compiled tree this run made from the working sources, where the
  // bundler's entry points (`dist/main.js`, `dist/index.js`) are.
  cpSync(buildCli(), join(root, "dist"), { recursive: true });
  const bundler = (await import(join(REPO_ROOT, "tooling", "package", "bundle.mjs"))) as {
    bundleCliPackage(options: { root: string }): Promise<string[]>;
  };
  const built = await bundler.bundleCliPackage({ root: scratchRoot });
  copyFileSync(manifestPath, join(root, "package.json"));
  return { root, built: built.map((path) => relative(root, path)) };
}

/** One staging for the file: three bundles and a `tsc` are not run twice. */
let staging: Promise<Staged> | undefined;
const staged = (): Promise<Staged> => (staging ??= stagePackage());

describe("the CLI package's manifest", () => {
  let built: Staged;
  beforeAll(async () => {
    built = await staged();
  }, DEADLINE_MS);

  it("is not private", () => {
    expect(manifest().private).toBeUndefined();
  });

  it("names binaries that exist after a build", () => {
    const bin = manifest().bin ?? {};
    expect(Object.keys(bin)).toContain("perbo");
    for (const [name, target] of Object.entries(bin)) {
      expect(isAbsolute(target)).toBe(false);
      const path = join(built.root, target);
      expect(existsSync(path), `${name} -> ${target} does not exist after a build`).toBe(true);
      // A `bin` is executed, so it needs the line that says what executes it.
      expect(readFileSync(path, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });

  it("publishes every file the build produced, and produces every one it publishes", () => {
    // The manifest and the bundler are one artefact described twice. Rather
    // than reading either one's source for the other's names, this compares
    // what the bundler *wrote* against what the manifest *publishes*: a file
    // the bundler stopped emitting, or one nobody builds, is a difference
    // between these two sets.
    const strip = (target: string): string => target.replace(/^\.\//, "");
    expect([...built.built].sort()).toEqual([...new Set((manifest().files ?? []).map(strip))].sort());
    // The entry points are a subset of it: `files` also carries the write-guard
    // hook, which nothing imports and no `bin` names — the runner spawns it.
    const named = [
      ...Object.values(manifest().bin ?? {}),
      ...(manifest().main === undefined ? [] : [manifest().main as string]),
    ].map(strip);
    for (const target of named) expect(built.built).toContain(target);
  });

  it("publishes only files that carry their own dependencies", () => {
    // The workspace packages are never published, so anything that still
    // imported one by name would install and then fail on its first line. The
    // check is on the artefacts, and on all of them: the binaries, the library
    // entry, and every other file `files` would put in the tarball.
    for (const target of built.built) {
      expect(readFileSync(join(built.root, target), "utf8")).not.toMatch(UNPUBLISHED_IMPORT);
    }
    for (const entry of manifest().files ?? []) {
      expect(entry.endsWith("/"), `${entry} publishes a directory of compiled modules`).toBe(false);
      expect(built.built, `${entry} is published but nothing builds it`).toContain(entry);
    }
  });

  it("declares no dependency that would have to be installed beside it", () => {
    expect(Object.keys(manifest().dependencies ?? {})).toEqual([]);
  });
});

/** One pack and install: the archive that was made, and where it was installed. */
interface Installed {
  /** The `.tgz` `npm pack` wrote. */
  tarball: string;
  /** The empty package it was installed into. */
  into: string;
}

describe("the CLI package, packed and installed", () => {
  let built: Staged;
  beforeAll(async () => {
    built = await staged();
  }, DEADLINE_MS);

  /**
   * The package packed and installed into an empty directory with nothing of
   * this repository above it: the install has to bring everything, because
   * there is nothing here to fall back to.
   */
  const install = (): Installed => {
    const packed = join(scratch, "tarball");
    mkdirSync(packed, { recursive: true });
    execFileSync("npm", ["pack", "--pack-destination", packed], {
      cwd: built.root,
      // Piped, not inherited: a failure throws with the output attached, and a
      // success has nothing to say that belongs in a test run's log.
      stdio: "pipe",
      timeout: DEADLINE_MS,
    });
    const [tarball] = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
    expect(tarball, "npm pack wrote no tarball").toBeDefined();

    const into = join(scratch, "install");
    mkdirSync(into, { recursive: true });
    writeFileSync(
      join(into, "package.json"),
      `${JSON.stringify({ name: "perbo-install-probe", version: "0.0.0", private: true }, null, 2)}\n`,
    );
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--ignore-scripts",
        join(packed, tarball as string),
      ],
      { cwd: into, stdio: "pipe", timeout: DEADLINE_MS },
    );
    return { into, tarball: join(packed, tarball as string) };
  };

  /** One pack and one install for the file; the tests below read the same one. */
  let installed: Installed | undefined;
  const installation = (): Installed => (installed ??= install());

  it("installs an `perbo` that runs outside this checkout", () => {
    const { into } = installation();
    const executable = join(into, "node_modules", ".bin", "perbo");
    expect(existsSync(executable), `${executable} was not installed`).toBe(true);

    const run = spawnSync(executable, ["--version"], {
      cwd: into,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEADLINE_MS,
    });
    expect(`${run.stdout}${run.stderr}`).toContain(manifest().version);
    expect(run.status, `--version wrote: ${run.stdout}${run.stderr}`).toBe(0);
  }, DEADLINE_MS);

  it("installs a library entry that resolves everything it imports", () => {
    // The manifest's `main` and `exports` are an offer to import the package,
    // and the packages behind that offer are never published — so the entry
    // has to be one that needs none of them. Importing it from the install is
    // the whole of that claim: a bare `@perbo/…` left anywhere in its module
    // graph is a resolution failure here.
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const cli = await import("@perbo/cli"); process.stdout.write(cli.VERSION);',
      ],
      {
        cwd: installation().into,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEADLINE_MS,
      },
    );
    expect(imported.status, `importing @perbo/cli wrote: ${imported.stderr}`).toBe(0);
    expect(imported.stdout).toBe(manifest().version);
  }, DEADLINE_MS);

  it("packs the runner's write-guard hook beside the binary", () => {
    // What an attempt's PreToolUse decision runs. The runner looks for it beside
    // the module that is running, so a tarball without it installs a CLI whose
    // `run` stops at `executing` with the hook's absence as a stack trace.
    const entries = execFileSync("tar", ["-tzf", installation().tarball], {
      encoding: "utf8",
      timeout: DEADLINE_MS,
    })
      .trim()
      .split("\n");
    expect(entries).toContain("package/dist/guard-hook.js");
    expect(entries).toContain("package/dist/perbo.js");
  }, DEADLINE_MS);

  it("installs a write-guard hook that runs on its own and refuses a write outside the worktree", () => {
    // Spawned as the runner spawns it — `node <hook> <guard directory>`, the
    // call on stdin — from the install, where nothing this repository holds is
    // reachable. A hook that still imported a workspace package by name would
    // fail to load here, and a hook that loaded but could not judge would
    // answer something other than a refusal naming the path.
    const hook = join(installation().into, "node_modules", "@perbo", "cli", "dist", "guard-hook.js");
    expect(existsSync(hook), `${hook} was not installed`).toBe(true);

    const worktree = join(scratch, "guarded-worktree");
    const guard = join(scratch, "guard");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(guard, { recursive: true });
    writeFileSync(
      join(guard, "state.json"),
      JSON.stringify({
        root: worktree,
        tmpdir: null,
        cwd: worktree,
        paths_allowed: [],
        allow_list: [],
        deny_list: [],
      }),
    );
    writeFileSync(join(guard, "decisions.jsonl"), "");

    const outside = join(scratch, "outside-the-worktree.txt");
    const ran = spawnSync(process.execPath, [hook, guard], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_use_id: "toolu_installed_probe",
        tool_input: { file_path: outside },
      }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: DEADLINE_MS,
    });
    expect(ran.stderr, "the hook wrote to stderr").toBe("");
    expect(ran.status, `the hook wrote: ${ran.stdout}`).toBe(0);
    const answer = JSON.parse(ran.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(answer.hookSpecificOutput.permissionDecisionReason).toContain(outside);
  }, DEADLINE_MS);

  it("installs nothing that could not run there", () => {
    const dir = join(installation().into, "node_modules", "@perbo", "cli");
    const shipped = readdirSync(join(dir, "dist"));
    expect(shipped.length).toBeGreaterThan(0);
    for (const name of shipped) {
      expect(
        readFileSync(join(dir, "dist", name), "utf8"),
        `${name} was installed and imports a package that is not published`,
      ).not.toMatch(UNPUBLISHED_IMPORT);
    }
  }, DEADLINE_MS);
});
