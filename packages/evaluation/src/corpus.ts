import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CheckResultsFileSchema,
  PlanContractSchema,
  parseUnifiedDiff,
  type CheckResult,
  type PlanContract,
} from "@perbo/contracts";
import { FixtureSchema, type Fixture } from "./fixture.js";

export interface LoadedFixture {
  fixture: Fixture;
  /**
   * True when the change is a real merged commit and `repoDir`/`diff` come from
   * a prepared cache rather than from the fixture directory. A pinned fixture
   * that has not been prepared is **not silently reviewable**: `prepared` is
   * false and the harness refuses it, because reviewing an absent repository
   * would produce a confident verdict about nothing.
   */
  pinned: boolean;
  prepared: boolean;
  /** The four files that make a fixture tree runnable. Shared, never copied in. */
  runtimeDir: string;
  contract: PlanContract;
  checks: CheckResult[];
  diff: string;
  /** Where the diff lives on disk, which is what the harness passes to the CLI. */
  diffPath: string;
  /** The post-change working tree. This is what `--repo` points at. */
  repoDir: string;
  dir: string;
}

/**
 * The variable that moves the corpus directory.
 *
 * Set it, and every read that names no directory of its own — a bare
 * `loadCorpus()`, the CLI without `--corpus` — reads what it names instead of
 * the corpus packaged beside this file. It exists so absence is observable:
 * `test/corpus-absence.test.ts` points it at a directory that is not there and
 * proves the corpus suites skip rather than fail, without deleting anything
 * here.
 */
export const CORPUS_DIR_ENV = "PERBO_EVAL_CORPUS_DIR";

/**
 * The corpus that ships in the package.
 *
 * `dist/corpus.js` sits one directory below the package root, and `corpus/` is
 * a sibling of `dist/`, so the path is the same whether this runs from source
 * or from the build output.
 */
export function packagedCorpusDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "corpus", "fixtures");
}

/**
 * The directory a corpus read that names none of its own uses: the override
 * when `PERBO_EVAL_CORPUS_DIR` is set to something other than whitespace,
 * otherwise the packaged corpus. A relative override is resolved against the
 * working directory, like every other path a caller hands this package.
 *
 * Whether that directory exists is not asked here, and an override naming a
 * directory that is not there does **not** fall back to the packaged corpus:
 * `loadCorpus` throws naming it. A typo in the override that quietly measured
 * the 108 fixtures the reader meant to replace would be worse than a stop, and
 * a caller that has something to do about absence — skipping, in this package's
 * suites — checks for the directory first (`test/corpus-present.ts`).
 */
export function defaultCorpusDir(): string {
  const override = process.env[CORPUS_DIR_ENV];
  if (override !== undefined && override.trim() !== "") return resolve(override);
  return packagedCorpusDir();
}

/**
 * The handful of fixtures published with the harness itself.
 *
 * The corpus is closed (D-075) and the harness is open, so a tree that carries
 * the harness and no corpus still has something to run end to end. Six
 * fixtures, all of them already public; `sample/README.md` names their source
 * and licence. Pass it as `--corpus` — it is an ordinary fixture directory.
 */
export function defaultSampleDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "sample", "fixtures");
}

/**
 * The runtime files that belong to a fixture directory.
 *
 * Derived from the fixture's own root rather than fixed at `corpus/`, so a
 * fixture loaded out of `sample/fixtures` finds `sample/runtime` and the two
 * sets stay self-contained.
 */
export function runtimeDirFor(fixtureDir: string): string {
  return resolve(fixtureDir, "..", "..", "runtime");
}

/**
 * The files copied into a fixture tree to make it runnable. They are a
 * repository's own manifests, so they are committed as part of the constructed
 * repository rather than materialized — materialisation is for untracked files.
 */
export const RUNTIME_FILES = [
  ".gitignore",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Where a pinned fixture's clone and computed diff live. Never checked in.
 *
 * Anchored to this file rather than to `process.cwd()`, so a test run from the
 * package directory and a CLI run from the repository root find the same cache.
 */
export function defaultCacheDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", ".local", "corpus-cache");
}

export function loadFixture(dir: string, cacheDir = defaultCacheDir()): LoadedFixture {
  const fixture = FixtureSchema.parse(readJson(join(dir, "fixture.json")));
  const contract = PlanContractSchema.parse(readJson(join(dir, "contract.json")));
  const checks = CheckResultsFileSchema.parse(readJson(join(dir, "checks.json")));

  if (fixture.pinned_repository) {
    const cached = join(cacheDir, fixture.id);
    const repoDir = join(cached, "repo");
    const diffPath = join(cached, "change.diff");
    const prepared = existsSync(join(repoDir, ".git")) && existsSync(diffPath);
    return {
      fixture,
      contract,
      checks,
      diff: prepared ? readFileSync(diffPath, "utf8") : "",
      diffPath,
      repoDir,
      dir,
      runtimeDir: runtimeDirFor(dir),
      pinned: true,
      prepared,
    };
  }

  return {
    fixture,
    contract,
    checks,
    diff: readFileSync(join(dir, "change.diff"), "utf8"),
    diffPath: join(dir, "change.diff"),
    repoDir: join(dir, "after"),
    dir,
    runtimeDir: runtimeDirFor(dir),
    pinned: false,
    prepared: true,
  };
}

/**
 * Every fixture directly under `corpusDir`, in id order.
 *
 * Called with no argument the directory is `defaultCorpusDir()`: the override
 * when it is set, else the packaged corpus. A directory that is not there
 * throws — an `ENOENT` naming that directory — whether it was passed or
 * defaulted, so the two spellings of the same read cannot disagree about what
 * absence means.
 */
export function loadCorpus(corpusDir = defaultCorpusDir(), cacheDir = defaultCacheDir()): LoadedFixture[] {
  return readdirSync(corpusDir)
    .filter((entry) => statSync(join(corpusDir, entry)).isDirectory())
    .sort()
    .map((entry) => loadFixture(join(corpusDir, entry), cacheDir));
}

/**
 * What the anchoring check could not verify on this machine, or null.
 *
 * A pinned fixture computes its diff from a clone that is not checked in, so on
 * a machine that has never run `prepare` — including CI, which cannot clone
 * 800 MB to assert a path — its file anchors cannot be checked. Skipping that
 * is correct; skipping it silently is not, so this is the sentence a green run
 * prints. Returned rather than written, so a test can assert it names every
 * fixture it stands for.
 */
/**
 * Whether a fixture's file anchor names a locus that exists: a file the change
 * touches, or a file in the fixture's own tree.
 *
 * The second half is there for the `unstated_regression` class, which D-053
 * defines as a change that satisfies its criterion and breaks something the
 * criterion never mentioned — and what it breaks is routinely in a file the
 * diff does not touch. `reg-008` is the case: the widened location override is
 * in the change and the semicolon it injects into a `prettier-ignore`d node
 * appears in `src/language-js/print/ignored.js`, which is not. The reviewer
 * reads the tree as well as the diff, so a finding there is a real locus.
 *
 * A typo is still refused, because it is in neither set.
 *
 * One function with two callers on purpose: the reachability suite and the
 * corpus suite both assert this rule, and two implementations of it would
 * agree until the day they did not.
 */
export function anchorFileIsReal(entry: LoadedFixture, file: string): boolean {
  if (entry.diff !== "" && parseUnifiedDiff(entry.diff).some((change) => change.path === file)) {
    return true;
  }
  return existsSync(join(entry.repoDir, file));
}

export function anchoringNote(corpus: readonly LoadedFixture[]): string | null {
  const unprepared = corpus.filter((entry) => entry.pinned && !entry.prepared);
  if (unprepared.length === 0) return null;
  return (
    `note: ${unprepared.length} of ${corpus.length} fixtures pin a repository that has not been ` +
    `cloned, so their file anchors were not checked. Run ` +
    "`node packages/evaluation/dist/main.js prepare` to check them: " +
    unprepared.map((entry) => entry.fixture.id).join(", ")
  );
}

/** The three-letter fixture id prefix each class must use. */
export const CLASS_PREFIX = {
  requirement_omission: "req",
  verification_defect: "ver",
  security_introduction: "sec",
  migration_hazard: "mig",
  scope_escape: "scp",
  adversarial_context: "adv",
  unstated_regression: "reg",
  clean: "cln",
} as const;
