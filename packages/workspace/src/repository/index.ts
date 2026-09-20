import { CommandFailedError, type RunResult } from "../exec.js";
import { ghEnv, gitEnv } from "./internal/environment.js";
import { operand } from "./internal/operand.js";
import { answered, nodeProcess, type GitProcess, type ProcessOptions } from "./internal/process.js";
import { parseWorktrees, type WorktreeEntry } from "./internal/worktrees.js";

/**
 * Every git and `gh` process Perbo starts.
 *
 * One module, because the facts about running them are one set of facts: which
 * environment the runner's git gets, that a prompt is a failure rather than a
 * hang, how long a local read may take and how long one that crosses the
 * network may, and what a timeout or an output too large to hold means for the
 * answer. A second copy of any of them is a place they can disagree.
 *
 * The questions callers ask are here by name — the head, the merge base, the
 * tracked files, the worktrees, a pull request — so a caller states what it
 * wants to know rather than how git spells it, and the module answers with a
 * value or a refusal. `run`, `runOrThrow` and `runSync` are for the commands
 * with one caller, where the exit status is the answer.
 *
 * ADR-0023 §4 holds structurally here: argv only, never a shell string, and an
 * operand that would be read as an option is refused before anything is
 * spawned.
 */

export type { GitProcess, ProcessOptions } from "./internal/process.js";
export type { WorktreeEntry } from "./internal/worktrees.js";
export { gitEnv } from "./internal/environment.js";

/** A local read or write of the repository on this disk. */
const LOCAL_TIMEOUT_MS = 120_000;
/** Anything that has to reach a server, `gh` included. */
const NETWORK_TIMEOUT_MS = 180_000;
/** What a command whose output nobody parses is allowed to say. */
const GENERIC_MAX_OUTPUT_BYTES = 512 * 1024;
/** What a question whose answer is read is allowed to say. A diff is big. */
const QUERY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const NETWORK_COMMANDS = new Set(["clone", "fetch", "ls-remote", "pull", "push"]);

export interface CallOptions {
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  /**
   * Added over the environment the module builds, for a caller that needs a
   * name it does not carry: the signing probe redirects git's object store so
   * that the object a signature would produce is written into a directory of
   * its own, and the runner's own delivery hands the two commands that reach
   * GitHub the credential their helper presents.
   */
  overlay?: Readonly<Record<string, string>> | undefined;
}

export interface RepositoryOptions {
  /** Default: this process starts its own children. */
  process?: GitProcess | undefined;
  /**
   * Where the environment is taken from, read at every call rather than at
   * import: a test that puts a fake `git` first on `PATH` does it after this
   * module is loaded.
   */
  environment?: (() => NodeJS.ProcessEnv) | undefined;
  binary?: string | undefined;
}

export type AddWorktree =
  | { path: string; branch: string }
  | { path: string; newBranch: string; startPoint: string }
  | { path: string; detach: string; force?: boolean | undefined };

export interface Git {
  /** The exit status is data; a non-zero exit is a result, not an error. */
  run(cwd: string, args: readonly string[], options?: CallOptions): Promise<RunResult>;
  runOrThrow(cwd: string, args: readonly string[], options?: CallOptions): Promise<RunResult>;
  runSync(cwd: string, args: readonly string[], options?: CallOptions): RunResult;

  head(cwd: string, options?: CallOptions): Promise<string | null>;
  headSync(cwd: string, options?: CallOptions): string | null;
  resolveCommit(cwd: string, ref: string, options?: CallOptions): Promise<string | null>;
  resolveCommitSync(cwd: string, ref: string, options?: CallOptions): string | null;
  isAncestor(cwd: string, ancestor: string, descendant: string, options?: CallOptions): Promise<boolean>;
  mergeBase(cwd: string, a: string, b: string, options?: CallOptions): Promise<string | null>;
  mergeBaseSync(cwd: string, a: string, b: string, options?: CallOptions): string | null;
  changedPaths(cwd: string, from: string, to: string, options?: CallOptions): Promise<string[] | null>;
  trackedFiles(cwd: string, options?: CallOptions): Promise<string[]>;
  trackedFilesSync(cwd: string, options?: CallOptions): string[];
  hasTrackedChangesSync(cwd: string, options?: CallOptions): boolean;
  topLevel(cwd: string, options?: CallOptions): Promise<string>;
  topLevelSync(cwd: string, options?: CallOptions): string;
  config(cwd: string, key: string, type?: "bool", options?: CallOptions): Promise<string | null>;
  configSync(cwd: string, key: string, type?: "bool", options?: CallOptions): string | null;
  worktrees(cwd: string, options?: CallOptions): Promise<WorktreeEntry[]>;
  addWorktree(cwd: string, spec: AddWorktree, options?: CallOptions): Promise<RunResult>;
  removeWorktree(cwd: string, path: string, options?: CallOptions): Promise<RunResult>;
  pruneWorktrees(cwd: string, options?: CallOptions): Promise<void>;
  stage(
    cwd: string,
    pathspec: readonly string[],
    options?: { force?: boolean | undefined } & CallOptions,
  ): Promise<void>;
  stagedPaths(cwd: string, pathspec: readonly string[], options?: CallOptions): Promise<string[]>;
  /** The new commit's sha. Signing is whatever the person's configuration says. */
  commit(cwd: string, message: string, options?: CallOptions): Promise<string>;
  clone(
    parent: string,
    source: string,
    into: string,
    options?: { noTags?: boolean | undefined; noHardlinks?: boolean | undefined } & CallOptions,
  ): Promise<RunResult>;
}

/** A `gh` call's environment, where the caller holds one of its own. */
export interface GhCallOptions extends CallOptions {
  base?: NodeJS.ProcessEnv | undefined;
}

export interface Gh {
  run(cwd: string, args: readonly string[], options?: GhCallOptions): Promise<RunResult>;
  runSync(cwd: string, args: readonly string[], options?: GhCallOptions): RunResult;
  viewPullRequest(
    cwd: string,
    selector: string,
    fields: readonly string[],
    options?: GhCallOptions & { repo?: string | undefined },
  ): Promise<RunResult>;
  viewPullRequestSync(
    cwd: string,
    selector: string,
    fields: readonly string[],
    options?: GhCallOptions & { repo?: string | undefined },
  ): RunResult;
  api(
    cwd: string,
    path: string,
    options?: GhCallOptions & { accept?: string | undefined; silent?: boolean | undefined },
  ): Promise<RunResult>;
}

/** The trimmed first answer, or null where git said it has none. */
function value(result: RunResult): string | null {
  if (result.code !== 0) return null;
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function lines(result: RunResult): string[] {
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

function succeeded(result: RunResult): RunResult {
  if (result.code !== 0) throw new CommandFailedError(result);
  return result;
}

export function createGit(options: RepositoryOptions = {}): Git {
  const child = options.process ?? nodeProcess;
  const environment = options.environment ?? (() => process.env);
  const binary = options.binary ?? "git";

  const spawnOptions = (
    cwd: string,
    args: readonly string[],
    call: CallOptions | undefined,
    fallbackMaxOutputBytes: number,
  ): ProcessOptions => ({
    cwd,
    env: { ...gitEnv(environment()), ...(call?.overlay ?? {}) },
    timeoutMs: call?.timeoutMs ?? (isNetwork(args) ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS),
    maxOutputBytes: call?.maxOutputBytes ?? fallbackMaxOutputBytes,
  });

  const argv = (args: readonly string[]): string[] => [binary, ...args];

  const run = (cwd: string, args: readonly string[], call?: CallOptions): Promise<RunResult> =>
    child.run(argv(args), spawnOptions(cwd, args, call, GENERIC_MAX_OUTPUT_BYTES));
  const runSync = (cwd: string, args: readonly string[], call?: CallOptions): RunResult =>
    child.runSync(argv(args), spawnOptions(cwd, args, call, GENERIC_MAX_OUTPUT_BYTES));

  /** A question, whose answer is read: a fragment of one is refused. */
  const ask = async (cwd: string, args: readonly string[], call?: CallOptions): Promise<RunResult> =>
    answered(await child.run(argv(args), spawnOptions(cwd, args, call, QUERY_MAX_OUTPUT_BYTES)));
  const askSync = (cwd: string, args: readonly string[], call?: CallOptions): RunResult =>
    answered(child.runSync(argv(args), spawnOptions(cwd, args, call, QUERY_MAX_OUTPUT_BYTES)));

  const commitish = (ref: string): string => `${operand(ref, "ref")}^{commit}`;
  const configArgs = (key: string, type?: "bool"): string[] => [
    "config",
    "--get",
    ...(type === "bool" ? ["--type=bool"] : []),
    operand(key, "configuration key"),
  ];
  // `--no-optional-locks` keeps a read from rewriting the index's stat cache,
  // so a listing asked for while an attempt is committing does not wait on
  // `index.lock` or take it. It changes nothing git reports.
  const trackedArgs = ["--no-optional-locks", "ls-files", "-z"];
  const statusArgs = ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"];
  const nulSeparated = (result: RunResult): string[] =>
    result.stdout.split("\0").filter((path) => path.length > 0);

  return {
    run,
    runOrThrow: async (cwd, args, call) => succeeded(await run(cwd, args, call)),
    runSync,

    head: async (cwd, call) => value(await ask(cwd, ["rev-parse", "HEAD"], call)),
    headSync: (cwd, call) => value(askSync(cwd, ["rev-parse", "HEAD"], call)),
    resolveCommit: async (cwd, ref, call) =>
      value(await ask(cwd, ["rev-parse", "--verify", "--quiet", commitish(ref)], call)),
    resolveCommitSync: (cwd, ref, call) =>
      value(askSync(cwd, ["rev-parse", "--verify", "--quiet", commitish(ref)], call)),
    isAncestor: async (cwd, ancestor, descendant, call) => {
      const args = ["merge-base", "--is-ancestor", operand(ancestor, "ref"), operand(descendant, "ref")];
      return (await ask(cwd, args, call)).code === 0;
    },
    mergeBase: async (cwd, a, b, call) =>
      value(await ask(cwd, ["merge-base", operand(a, "ref"), operand(b, "ref")], call)),
    mergeBaseSync: (cwd, a, b, call) =>
      value(askSync(cwd, ["merge-base", operand(a, "ref"), operand(b, "ref")], call)),
    changedPaths: async (cwd, from, to, call) => {
      const args = ["diff", "--name-only", operand(from, "ref"), operand(to, "ref")];
      const result = await ask(cwd, args, call);
      return result.code === 0 ? lines(result) : null;
    },
    trackedFiles: async (cwd, call) => nulSeparated(succeeded(await ask(cwd, trackedArgs, call))),
    trackedFilesSync: (cwd, call) => nulSeparated(succeeded(askSync(cwd, trackedArgs, call))),
    hasTrackedChangesSync: (cwd, call) => succeeded(askSync(cwd, statusArgs, call)).stdout.trim().length > 0,
    topLevel: async (cwd, call) => succeeded(await ask(cwd, ["rev-parse", "--show-toplevel"], call)).stdout.trim(),
    topLevelSync: (cwd, call) => succeeded(askSync(cwd, ["rev-parse", "--show-toplevel"], call)).stdout.trim(),
    config: async (cwd, key, type, call) => value(await ask(cwd, configArgs(key, type), call)),
    configSync: (cwd, key, type, call) => value(askSync(cwd, configArgs(key, type), call)),

    worktrees: async (cwd, call) =>
      parseWorktrees(succeeded(await ask(cwd, ["worktree", "list", "--porcelain", "-z"], call)).stdout),
    addWorktree: (cwd, spec, call) => run(cwd, addWorktreeArgs(spec), call),
    removeWorktree: (cwd, path, call) =>
      run(cwd, ["worktree", "remove", "--force", operand(path, "worktree path")], call),
    pruneWorktrees: async (cwd, call) => {
      await run(cwd, ["worktree", "prune"], call);
    },

    stage: async (cwd, pathspec, call) => {
      succeeded(await run(cwd, ["add", call?.force === true ? "--force" : "-A", "--", ...pathspec], call));
    },
    stagedPaths: async (cwd, pathspec, call) =>
      lines(succeeded(await ask(cwd, ["diff", "--cached", "--name-only", "--", ...pathspec], call))),
    commit: async (cwd, message, call) => {
      succeeded(await run(cwd, ["commit", "-q", "-m", message], call));
      const head = value(await ask(cwd, ["rev-parse", "HEAD"], call));
      if (head === null) throw new Error(`${cwd} has no HEAD after a commit git accepted`);
      return head;
    },
    clone: (parent, source, into, call) =>
      run(
        parent,
        [
          "clone",
          ...(call?.noTags === true ? ["--no-tags"] : []),
          ...(call?.noHardlinks === true ? ["--no-hardlinks"] : []),
          operand(source, "clone source"),
          operand(into, "clone destination"),
        ],
        call,
      ),
  };
}

function isNetwork(args: readonly string[]): boolean {
  const first = args.find((argument) => !argument.startsWith("-"));
  return first !== undefined && NETWORK_COMMANDS.has(first);
}

function addWorktreeArgs(spec: AddWorktree): string[] {
  const path = operand(spec.path, "worktree path");
  if ("newBranch" in spec) {
    return ["worktree", "add", "-b", operand(spec.newBranch, "branch"), path, operand(spec.startPoint, "ref")];
  }
  if ("detach" in spec) {
    return [
      "worktree",
      "add",
      "--detach",
      ...(spec.force === true ? ["--force"] : []),
      path,
      operand(spec.detach, "ref"),
    ];
  }
  return ["worktree", "add", path, operand(spec.branch, "branch")];
}

export function createGh(options: RepositoryOptions = {}): Gh {
  const child = options.process ?? nodeProcess;
  const environment = options.environment ?? (() => process.env);
  const binary = options.binary ?? "gh";

  const spawnOptions = (
    cwd: string,
    call: GhCallOptions | undefined,
    fallbackMaxOutputBytes: number,
  ): ProcessOptions => ({
    cwd,
    env: { ...ghEnv(call?.base ?? environment()), ...(call?.overlay ?? {}) },
    // Every `gh` call crosses the network.
    timeoutMs: call?.timeoutMs ?? NETWORK_TIMEOUT_MS,
    maxOutputBytes: call?.maxOutputBytes ?? fallbackMaxOutputBytes,
  });

  const argv = (args: readonly string[]): string[] => [binary, ...args];

  const viewArgs = (selector: string, fields: readonly string[], repo: string | undefined): string[] => [
    "pr",
    "view",
    operand(selector, "pull request"),
    ...(repo === undefined ? [] : ["--repo", operand(repo, "repository")]),
    "--json",
    fields.join(","),
  ];

  return {
    run: (cwd, args, call) => child.run(argv(args), spawnOptions(cwd, call, GENERIC_MAX_OUTPUT_BYTES)),
    runSync: (cwd, args, call) => child.runSync(argv(args), spawnOptions(cwd, call, GENERIC_MAX_OUTPUT_BYTES)),
    viewPullRequest: (cwd, selector, fields, call) =>
      child.run(argv(viewArgs(selector, fields, call?.repo)), spawnOptions(cwd, call, QUERY_MAX_OUTPUT_BYTES)),
    viewPullRequestSync: (cwd, selector, fields, call) =>
      child.runSync(argv(viewArgs(selector, fields, call?.repo)), spawnOptions(cwd, call, QUERY_MAX_OUTPUT_BYTES)),
    api: (cwd, path, call) =>
      child.run(
        argv([
          "api",
          ...(call?.accept === undefined ? [] : ["-H", `Accept: ${call.accept}`]),
          operand(path, "api path"),
          ...(call?.silent === true ? ["--silent"] : []),
        ]),
        spawnOptions(cwd, call, QUERY_MAX_OUTPUT_BYTES),
      ),
  };
}

/** The repository as this process reaches it. */
export const git: Git = createGit();
export const gh: Gh = createGh();
