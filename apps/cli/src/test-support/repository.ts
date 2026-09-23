import { initRepository, type Repository } from "@perbo/test-support";

/**
 * The two repositories the CLI's suites point commands at.
 *
 * Both take the directory rather than choosing one, because a suite's paths are
 * part of what it asserts: a rendering wraps at eighty columns, a refusal quotes
 * a path back, and a fixture that picked its own directory would move both.
 */

/** A repository with nothing in it but one commit, for a command that only needs a checkout. */
export function emptyRepository(dir: string): Repository {
  return initRepository(dir);
}

/** What `npmRepository` writes beside the defaults. */
export interface NpmRepositoryOptions {
  /** Keys merged into `package.json` over the defaults, `scripts` included. */
  readonly manifest?: Readonly<Record<string, unknown>>;
  /** Whether `package-lock.json` is there. Default true. */
  readonly lockfile?: boolean;
  /** Further files, keyed by POSIX relative path. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * An npm package with a test script, its lockfile and one source file: what a
 * run needs before it can install anything, derive a check or name a base.
 */
export function npmRepository(dir: string, options: NpmRepositoryOptions = {}): Repository {
  return initRepository(dir, {
    files: {
      "package.json": `${JSON.stringify(
        {
          name: "fixture",
          private: true,
          scripts: { test: 'node -e "process.exit(0)"' },
          ...options.manifest,
        },
        null,
        2,
      )}\n`,
      ...(options.lockfile === false
        ? {}
        : {
            "package-lock.json": `${JSON.stringify(
              { name: "fixture", lockfileVersion: 3, packages: {} },
              null,
              2,
            )}\n`,
          }),
      "src/index.ts": "export const version = 1;\n",
      ...options.files,
    },
  });
}
