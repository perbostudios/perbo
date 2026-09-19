import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORPUS_DIR_ENV,
  defaultCorpusDir,
  defaultSampleDir,
  packagedCorpusDir,
} from "../src/corpus.js";
import { corpus, corpusDir, loadCorpusFromDefaultDir } from "./corpus-present.js";
import { SAMPLE_IDS } from "./sample-fixtures.js";

/**
 * What the loader reads when the caller names no directory.
 *
 * It used to read the packaged corpus and nothing else, so a bare call was
 * invisible to `PERBO_EVAL_CORPUS_DIR` — the absence gate could point the
 * variable at nothing, watch the suites skip, and a bare call inside one of
 * them would still have opened the real corpus. That is the read this file
 * pins: with the override set the bare call goes where it points, and where it
 * points at nothing the call stops rather than falling back.
 *
 * The subject is the loader itself, so these run in any tree: the sample
 * fixtures travel with the harness, and the assertions that need the packaged
 * corpus say so instead of assuming it.
 */

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const MISSING_DIR = join(PACKAGE_ROOT, "corpus-that-is-not-here");

/** The packaged corpus as this run already loaded it, or nothing when it is not what was loaded. */
const packagedCorpus = corpusDir === packagedCorpusDir() ? corpus : [];

/** The fixture directories in `dir` — the loader's own first step over a corpus directory. */
function fixtureDirsOnDisk(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => statSync(join(dir, entry)).isDirectory())
    .sort();
}

/** Whether `path` is under `dir` — which directory a returned fixture actually came out of. */
function isInside(dir: string, path: string): boolean {
  const step = relative(dir, path);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

function ids(fixtures: ReadonlyArray<{ fixture: { id: string } }>): string[] {
  return fixtures.map((entry) => entry.fixture.id);
}

function caught(read: () => unknown): NodeJS.ErrnoException | undefined {
  try {
    read();
    return undefined;
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
}

describe(`the loader called with no directory resolves it from ${CORPUS_DIR_ENV}`, () => {
  const original = process.env[CORPUS_DIR_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[CORPUS_DIR_ENV];
    else process.env[CORPUS_DIR_ENV] = original;
  });

  it("stops on an override that names a directory which is not there", () => {
    expect(existsSync(MISSING_DIR), "the premise: that directory is not in this tree").toBe(false);
    process.env[CORPUS_DIR_ENV] = MISSING_DIR;

    const error = caught(loadCorpusFromDefaultDir);

    expect(error, "absence of the override's directory is refused, not ignored").toBeDefined();
    expect(error?.code).toBe("ENOENT");
    expect(error?.path, "and the directory it tried is the one the override names").toBe(
      MISSING_DIR,
    );
  });

  /**
   * The companion: the packaged corpus was sitting there, readable, while that
   * call failed. So the failure is not the packaged corpus being absent — the
   * call never looked at it.
   */
  it.runIf(existsSync(packagedCorpusDir()))(
    "and the packaged corpus, which it did not read, was readable at that moment",
    () => {
      process.env[CORPUS_DIR_ENV] = MISSING_DIR;
      const error = caught(loadCorpusFromDefaultDir);

      expect(fixtureDirsOnDisk(packagedCorpusDir()).length).toBeGreaterThan(0);
      expect(error?.path).not.toBe(packagedCorpusDir());
      expect(String(error?.message)).not.toContain(packagedCorpusDir());
    },
  );

  /**
   * The same rule read the other way: with the override on a directory that
   * *is* there, the bare call returns that directory's fixtures. Every fixture
   * it hands back came out of the override and none out of the packaged corpus
   * — which the sample's ids alone would not show, since the six published
   * fixtures are six of the corpus's own.
   */
  it("reads the fixtures of the directory the override names, and no others", () => {
    process.env[CORPUS_DIR_ENV] = defaultSampleDir();

    const loaded = loadCorpusFromDefaultDir();

    expect(ids(loaded)).toEqual([...SAMPLE_IDS]);
    expect(loaded.map((entry) => entry.dir).filter((dir) => !isInside(defaultSampleDir(), dir))).toEqual([]);
    expect(loaded.map((entry) => entry.dir).filter((dir) => isInside(packagedCorpusDir(), dir))).toEqual([]);
    if (packagedCorpus.length > 0) {
      expect(
        packagedCorpus.length,
        "the packaged corpus holds fixtures a read of it would have returned",
      ).toBeGreaterThan(loaded.length);
    }
  });

  it("resolves a relative override against the working directory", () => {
    process.env[CORPUS_DIR_ENV] = relative(process.cwd(), defaultSampleDir());

    expect(defaultCorpusDir()).toBe(defaultSampleDir());
    expect(ids(loadCorpusFromDefaultDir())).toEqual([...SAMPLE_IDS]);
  });

  it("falls back to the packaged corpus when the override is unset or blank", () => {
    delete process.env[CORPUS_DIR_ENV];
    expect(defaultCorpusDir()).toBe(packagedCorpusDir());

    process.env[CORPUS_DIR_ENV] = "   ";
    expect(defaultCorpusDir()).toBe(packagedCorpusDir());
  });

  it.runIf(packagedCorpus.length > 0)(
    "and reads it, when the override is unset and the corpus is in this tree",
    () => {
      delete process.env[CORPUS_DIR_ENV];

      expect(ids(loadCorpusFromDefaultDir())).toEqual(ids(packagedCorpus));
    },
  );
});
