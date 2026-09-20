import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Who a fixture's commits are by.
 *
 * One identity across every package, set both in the environment and in each
 * repository's own config, so a fixture never depends on the person's global
 * Git configuration and never reads it.
 */
const IDENTITY = { name: "test", email: "test@example.com" } as const;

/**
 * The environment fixture git runs under.
 *
 * `PATH` and `HOME` are read on every call, so a fake binary a test has just
 * put on `PATH` is the one git finds. Nothing else comes from `process.env`,
 * which is the point: an inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_OBJECT_DIRECTORY` or `GIT_COMMON_DIR` silently redirects a fixture into
 * whatever repository the outer process was talking about — including, when the
 * outer process is a Perbo run, the checkout under review.
 *
 * The global and system configuration files are read from `/dev/null`, so the
 * machine's aliases, hooks, default branch and signing settings do not reach
 * the fixture. `extra` goes on top, for the test that means to set one.
 */
export function gitEnvironment(
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
}

/** What a repository holds before its first commit. */
export interface RepositoryOptions {
  /**
   * Files written before the first commit, keyed by POSIX relative path;
   * parent directories are created. They are written after `copyFrom`, so a
   * path in both is the one named here.
   */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * A directory whose contents are copied in as the working tree. It is a
   * working tree, not a repository: the repository is the one initialised here.
   */
  readonly copyFrom?: string;
  /** The branch the first commit is on. Default `main`. */
  readonly branch?: string;
  /** The first commit's subject. Default `base`. */
  readonly message?: string;
  /** Repository-local configuration, set before the first commit. */
  readonly config?: Readonly<Record<string, string>>;
}

/** A repository a test can read, commit to and point the product at. */
export interface Repository {
  /** Where it is, as the caller wrote it. */
  readonly dir: string;
  /** HEAD after the first commit. */
  readonly head: string;
  /** `git -C dir <args>` under `gitEnvironment()`; its stdout. */
  git(...args: string[]): string;
  /** Write `files`, stage everything, commit; the new HEAD. */
  commit(
    files: Readonly<Record<string, string>>,
    message: string,
    options?: { at?: string },
  ): string;
}

function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, ...relative.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/**
 * A repository at `dir`, with one commit in it.
 *
 * `dir` is created if it is not there and is never chosen here, so a caller
 * that needs a particular path — a nested one, a long one, one with a space in
 * it — gets exactly that path.
 *
 * The identity and `commit.gpgsign false` are written into the repository's own
 * config as well as passed in the environment, because the product is what
 * commits here next and it runs git with the person's environment: on a machine
 * that signs commits with a key this process cannot unlock, a fixture without
 * the local setting fails inside product code rather than in the test.
 */
export function initRepository(dir: string, options: RepositoryOptions = {}): Repository {
  const branch = options.branch ?? "main";
  mkdirSync(dir, { recursive: true });

  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnvironment() });

  git("init", "-q", "-b", branch);
  git("config", "user.name", IDENTITY.name);
  git("config", "user.email", IDENTITY.email);
  git("config", "commit.gpgsign", "false");
  for (const [key, value] of Object.entries(options.config ?? {})) git("config", key, value);

  if (options.copyFrom !== undefined) cpSync(options.copyFrom, dir, { recursive: true });
  writeFiles(dir, options.files ?? {});
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", options.message ?? "base");

  const commit: Repository["commit"] = (files, message, commitOptions = {}) => {
    writeFiles(dir, files);
    execFileSync("git", ["-C", dir, "add", "-A"], {
      encoding: "utf8",
      env: gitEnvironment(),
    });
    const dates =
      commitOptions.at === undefined
        ? {}
        : { GIT_AUTHOR_DATE: commitOptions.at, GIT_COMMITTER_DATE: commitOptions.at };
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "commit",
        "-q",
        ...(Object.keys(files).length === 0 ? ["--allow-empty"] : []),
        "-m",
        message,
      ],
      { encoding: "utf8", env: gitEnvironment(dates) },
    );
    return git("rev-parse", "HEAD").trim();
  };

  return { dir, head: git("rev-parse", "HEAD").trim(), git, commit };
}

/**
 * A bare repository at `dir`, for a fixture that needs somewhere to push.
 *
 * It has no commits and no working tree, so there is nothing to hand back but
 * where it is.
 */
export function initBareRepository(dir: string, options: { branch?: string } = {}): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "--bare", "-b", options.branch ?? "main"], {
    encoding: "utf8",
    env: gitEnvironment(),
  });
  return dir;
}
