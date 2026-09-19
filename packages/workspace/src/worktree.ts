import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve, sep, toNamespacedPath } from "node:path";
import { z } from "zod";
import { assertWithinLimits, type LimitsTable } from "@perbo/contracts";
import { run, runOrThrow } from "./exec.js";
import { branchName, recordedBranch, type RecordedBranches } from "./naming.js";

/**
 * The local Git worktree provider (SCP-016, ADR-0004, ADR-0007).
 *
 * One isolated worktree and branch per attempt chain, provisioned from an exact
 * base commit. "Per attempt chain" rather than "per attempt" is not a weakening:
 * Git refuses to check the same branch out in two worktrees, so a remediation
 * round that continues an attempt on the same branch must share its worktree.
 * It takes over the lease and is recorded as a continuation.
 */

export const WORKSPACE_FAILURE_REASONS = [
  "not_a_git_repository",
  "base_commit_missing",
  "path_scope_escape",
  /**
   * The install the manifest declares runs at a workspace root the worktree
   * does not contain — a package whose monorepo sits above its own repository,
   * so the filtered install that is correct in the person's checkout has no
   * workspace to narrow in a checkout of the package alone.
   */
  "install_root_outside_worktree",
  /**
   * The scripts the verification was read from are not in the worktree — a
   * package directory the base commit predates, or one Git is ignoring. The
   * command names a script, and a script only means something in the directory
   * whose `package.json` declares it.
   */
  "verify_root_outside_worktree",
  "worktree_collision",
  "lease_held",
  "cleanup_failed",
  "host_suspended",
  /**
   * The port allocation could not be made exclusively — another attempt has
   * held the lock past any plausible allocation time, or the lease the range
   * would be recorded against is gone. Both are refusals: an allocation that is
   * not recorded is one every later attempt collides with.
   */
  "port_allocation_unavailable",
] as const;
export type WorkspaceFailureReason = (typeof WORKSPACE_FAILURE_REASONS)[number];

export class WorkspaceError extends Error {
  readonly reason: WorkspaceFailureReason;

  constructor(reason: WorkspaceFailureReason, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.reason = reason;
  }
}

export const LeaseSchema = z.strictObject({
  attempt_id: z.string().min(1),
  /** The attempt that first provisioned this worktree, if this is a continuation. */
  root_attempt_id: z.string().min(1),
  repository_id: z.string().min(1),
  branch: z.string().min(1),
  path: z.string().min(1),
  base_commit: z.string().min(1),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  pid: z.number().int().min(0),
  host: z.string().min(1),
  /**
   * The port range this attempt holds, once materialization has allocated one.
   *
   * The lease is where a *concurrent* attempt can see it. Probing for a free
   * port and then releasing it allocates the same range to everyone who probes
   * at the same moment, which is what two concurrent attempts measured on
   * 2026-08-27 did — both were handed 41000-41009. Neither used a port, so
   * nothing broke, and ADR-0025 §4's claim was false anyway.
   */
  port_range_start: z.number().int().min(0).nullable().default(null),
  port_range_end: z.number().int().min(0).nullable().default(null),
});
export type Lease = z.infer<typeof LeaseSchema>;

export interface Workspace {
  attempt_id: string;
  root_attempt_id: string;
  repository_id: string;
  repository_root: string;
  branch: string;
  path: string;
  base_commit: string;
  lease: Lease;
  /** True when this attempt took over an existing worktree rather than creating one. */
  continued: boolean;
}

export interface ProvisionRequest {
  repository_root: string;
  repository_id: string;
  /** The ticket's key, or a local run's label: it decides a new branch's prefix. */
  ticket_key: string;
  ticket_id: string;
  /** The plan's approved outcome sentence — the only source of the branch slug. */
  outcome: string;
  /**
   * The branch the ticket's records already name, which the worktree keeps
   * rather than a newly derived one where it is under `ticket_id` (D-098). The
   * lease on a chain this request continues is read here.
   */
  recorded?: Pick<RecordedBranches, "delivery" | "attempt"> | undefined;
  base_commit: string;
  attempt_id: string;
  /** Where worktrees live. Every provisioned path must resolve inside it. */
  root: string;
  limits: LimitsTable;
  continues?: { root_attempt_id: string } | undefined;
  lease_ms?: number;
  now?: Date;
  timeoutMs?: number;
}

const DEFAULT_LEASE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * The environment **the runner's** Git runs in, which is not the agent's.
 *
 * That distinction is the whole security posture: the agent's environment is
 * scrubbed of every credential and the agent never sees a token, while the
 * runner holds them and performs the commit, the push and the pull request
 * itself. So this forwards what Git legitimately needs from the user's setup —
 * the agent socket a signing key is unlocked through, and the config files that
 * say whether to sign at all — and nothing beyond it.
 *
 * Dropping `SSH_AUTH_SOCK` here looks safer and is not: on a machine with SSH
 * commit signing enabled it makes every seal fail with a passphrase prompt,
 * which is an outage rather than a control.
 *
 * `GIT_TERMINAL_PROMPT=0` turns a credential prompt into a failure rather than
 * a hang.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The last three are where Windows keeps a user's own state: `gh` reads its
  // host credential from `%AppData%\GitHub CLI\hosts.yml` and keeps its state
  // under `%LocalAppData%\GitHub CLI`, and `USERPROFILE` is the home Go's
  // `os.UserHomeDir` reads there. Without them the runner's `gh` is logged into
  // no host on a machine whose own `gh auth status` answers, and the attempt
  // fails at `gh pr create` with the work already sealed and reviewed.
  //
  // They name directories rather than carry secrets, and this is the runner's
  // own environment — the one that legitimately performs the commit, the push
  // and the pull request. The agent's environment is built separately and is
  // not widened by this. On POSIX the loop below skips a name the host does not
  // set.
  const forward = [
    "SSH_AUTH_SOCK",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "XDG_CONFIG_HOME",
    "GNUPGHOME",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
  ];
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH ?? "/usr/bin:/bin",
    HOME: base.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    LANG: base.LANG ?? "C",
  };
  for (const name of forward) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * `root` must already be a real path: on macOS `/var` is a symlink to
 * `/private/var`, so comparing a resolved path against an unresolved root
 * reports every temporary directory as an escape.
 */
function assertInsideRoot(root: string, path: string): void {
  const resolved = resolve(path);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new WorkspaceError(
      "path_scope_escape",
      `worktree path ${path} resolves outside the workspace root ${root}`,
    );
  }
}

function leasePath(root: string, rootAttemptId: string): string {
  return join(root, `${rootAttemptId}.lease.json`);
}

export function readLease(path: string): Lease | null {
  if (!existsSync(path)) return null;
  try {
    return LeaseSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** A lease is stale when it has expired, or when the process that held it is gone. */
export function leaseIsStale(lease: Lease, now: Date): boolean {
  if (new Date(lease.expires_at).getTime() <= now.getTime()) return true;
  if (lease.host !== hostname()) return false;
  try {
    process.kill(lease.pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** Ranges held by leases that are still live. Passed to the next allocation. */
export function heldPortRanges(root: string, now = new Date()): Array<{ start: number; end: number }> {
  return listLeases(root)
    .filter((lease) => !leaseIsStale(lease, now))
    .filter((lease) => lease.port_range_start !== null && lease.port_range_end !== null)
    .map((lease) => ({ start: lease.port_range_start!, end: lease.port_range_end! }));
}

/**
 * Take the port allocation lock, run `allocate`, and record what it chose
 * before releasing it.
 *
 * The lock is the point. Reading the held ranges and then probing takes long
 * enough — up to `attempts × size` sequential binds — that two attempts started
 * inside that window both read a held-set excluding the other, both find the
 * same range free (nothing is bound until the repository's own services start),
 * and both are handed it. `avoid` narrowed that window; it did not close it.
 *
 * `wx` is the whole mechanism: an exclusive create is atomic, so exactly one
 * process holds it. A lock left by a killed process is reclaimed once it is
 * older than any allocation could take.
 */
const PORT_LOCK_STALE_MS = 5 * 60 * 1000;

/** Record what materialization allocated, so a concurrent attempt avoids it. */
export async function withPortAllocation<T extends { start: number; end: number }>(
  root: string,
  rootAttemptId: string,
  allocate: (avoid: Array<{ start: number; end: number }>) => Promise<T>,
): Promise<T> {
  const resolved = realpathSync(root);
  const lock = join(resolved, ".port-allocation.lock");
  const waitedFrom = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age > PORT_LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() - waitedFrom > PORT_LOCK_STALE_MS) {
        throw new WorkspaceError(
          "port_allocation_unavailable",
          `another attempt has held the port allocation lock at ${lock} for over ` +
            `${Math.round(PORT_LOCK_STALE_MS / 1000)}s`,
        );
      }
      await new Promise((resume) => setTimeout(resume, 50));
    }
  }
  try {
    const range = await allocate(heldPortRanges(resolved));
    recordPortRange(resolved, rootAttemptId, range);
    return range;
  } finally {
    rmSync(lock, { force: true });
  }
}

export function recordPortRange(
  root: string,
  rootAttemptId: string,
  range: { start: number; end: number },
): void {
  const path = leasePath(realpathSync(root), rootAttemptId);
  const lease = readLease(path);
  if (!lease) {
    // Silently returning left the allocation unrecorded, so every later attempt
    // reused the range — the same collision, arrived at differently.
    throw new WorkspaceError(
      "port_allocation_unavailable",
      `no lease at ${path} to record the port range against; an unrecorded allocation is one ` +
        "every later attempt will collide with",
    );
  }
  writeFileSync(
    path,
    `${JSON.stringify({ ...lease, port_range_start: range.start, port_range_end: range.end }, null, 2)}\n`,
  );
}

export function listLeases(root: string): Lease[] {
  if (!existsSync(root)) return [];
  const out: Lease[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".lease.json")) continue;
    const lease = readLease(join(root, name));
    if (lease) out.push(lease);
  }
  return out;
}

async function gitLines(args: string[], cwd: string, timeoutMs: number): Promise<string[]> {
  const result = await runOrThrow(["git", ...args], {
    cwd,
    env: gitEnv(),
    timeoutMs,
  });
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/** Branches currently checked out in some worktree of this repository. */
export async function checkedOutBranches(
  repositoryRoot: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<Map<string, string>> {
  const lines = await gitLines(["worktree", "list", "--porcelain"], repositoryRoot, timeoutMs);
  const out = new Map<string, string>();
  let path: string | null = null;
  for (const line of lines) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line.startsWith("branch ") && path) {
      out.set(line.slice("branch ".length).replace(/^refs\/heads\//, ""), path);
    }
  }
  return out;
}

export async function reclaimStaleWorktrees(args: {
  repository_root: string;
  root: string;
  now?: Date;
  timeoutMs?: number;
}): Promise<Lease[]> {
  const now = args.now ?? new Date();
  const timeoutMs = args.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const reclaimed: Lease[] = [];
  for (const lease of listLeases(args.root)) {
    if (!leaseIsStale(lease, now)) continue;
    await run(["git", "worktree", "remove", "--force", lease.path], {
      cwd: args.repository_root,
      env: gitEnv(),
      timeoutMs,
    });
    rmSync(leasePath(args.root, lease.root_attempt_id), { force: true });
    reclaimed.push(lease);
  }
  // `git worktree prune` clears administrative files for directories that are
  // already gone; without it a reclaimed path cannot be reused.
  await run(["git", "worktree", "prune"], {
    cwd: args.repository_root,
    env: gitEnv(),
    timeoutMs,
  });
  return reclaimed;
}

export async function provision(request: ProvisionRequest): Promise<Workspace> {
  const now = request.now ?? new Date();
  const timeoutMs = request.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const repositoryRoot = resolve(request.repository_root);

  if (!existsSync(join(repositoryRoot, ".git"))) {
    throw new WorkspaceError(
      "not_a_git_repository",
      `${repositoryRoot} is not a Git repository (no .git entry)`,
    );
  }
  mkdirSync(request.root, { recursive: true });
  const root = realpathSync(request.root);

  await reclaimStaleWorktrees({ repository_root: repositoryRoot, root, now, timeoutMs });

  // The laptop ceiling, checked before anything is created rather than after.
  const live = listLeases(root).filter((lease) => !leaseIsStale(lease, now));
  const rootAttemptId = request.continues?.root_attempt_id ?? request.attempt_id;
  const continuing = live.find((lease) => lease.root_attempt_id === rootAttemptId);
  if (!continuing) {
    assertWithinLimits(request.limits, "concurrent_local_attempts", live.length + 1);
  }

  // A branch the ticket's records name under its own id is kept, the lease of
  // the chain this continues included; a name is derived only where none is
  // (D-098).
  const branch =
    recordedBranch(
      {
        delivery: request.recorded?.delivery,
        attempt: request.recorded?.attempt,
        lease: continuing?.branch,
      },
      request.ticket_id,
    ) ??
    branchName({ ticket_key: request.ticket_key, ticket_id: request.ticket_id, outcome: request.outcome });
  const path = join(root, rootAttemptId);
  assertInsideRoot(root, path);

  if (continuing) {
    if (continuing.branch !== branch) {
      throw new WorkspaceError(
        "worktree_collision",
        `attempt chain ${rootAttemptId} holds branch ${continuing.branch}, not ${branch}`,
      );
    }
    const lease: Lease = {
      ...continuing,
      attempt_id: request.attempt_id,
      expires_at: new Date(now.getTime() + (request.lease_ms ?? DEFAULT_LEASE_MS)).toISOString(),
      pid: process.pid,
    };
    writeFileSync(leasePath(root, rootAttemptId), `${JSON.stringify(lease, null, 2)}\n`);
    return {
      attempt_id: request.attempt_id,
      root_attempt_id: rootAttemptId,
      repository_id: request.repository_id,
      repository_root: repositoryRoot,
      branch,
      path: continuing.path,
      base_commit: continuing.base_commit,
      lease,
      continued: true,
    };
  }

  const checkedOut = await checkedOutBranches(repositoryRoot, timeoutMs);
  const holder = checkedOut.get(branch);
  if (holder !== undefined) {
    throw new WorkspaceError(
      "worktree_collision",
      `branch ${branch} is already checked out at ${holder}; Git permits one worktree per branch`,
    );
  }
  if (existsSync(path)) {
    throw new WorkspaceError("worktree_collision", `${path} already exists`);
  }

  // Verify the base commit resolves before creating anything, so a typo is a
  // typed refusal rather than a half-made worktree.
  const rev = await run(["git", "rev-parse", "--verify", `${request.base_commit}^{commit}`], {
    cwd: repositoryRoot,
    env: gitEnv(),
    timeoutMs,
  });
  if (rev.code !== 0) {
    throw new WorkspaceError(
      "base_commit_missing",
      `base commit ${request.base_commit} does not resolve in ${repositoryRoot}`,
    );
  }
  const resolvedBase = rev.stdout.trim();

  const branchExists = await run(["git", "rev-parse", "--verify", `refs/heads/${branch}`], {
    cwd: repositoryRoot,
    env: gitEnv(),
    timeoutMs,
  });
  const argv =
    branchExists.code === 0
      ? ["git", "worktree", "add", path, branch]
      : ["git", "worktree", "add", "-b", branch, path, resolvedBase];
  const added = await run(argv, { cwd: repositoryRoot, env: gitEnv(), timeoutMs });
  if (added.code !== 0) {
    throw new WorkspaceError(
      "worktree_collision",
      `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`,
    );
  }

  const lease: Lease = {
    attempt_id: request.attempt_id,
    root_attempt_id: rootAttemptId,
    repository_id: request.repository_id,
    branch,
    path,
    base_commit: resolvedBase,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (request.lease_ms ?? DEFAULT_LEASE_MS)).toISOString(),
    pid: process.pid,
    host: hostname(),
    // Materialization fills these in once it has allocated.
    port_range_start: null,
    port_range_end: null,
  };
  writeFileSync(leasePath(root, rootAttemptId), `${JSON.stringify(lease, null, 2)}\n`);

  return {
    attempt_id: request.attempt_id,
    root_attempt_id: rootAttemptId,
    repository_id: request.repository_id,
    repository_root: repositoryRoot,
    branch,
    path,
    base_commit: resolvedBase,
    lease,
    continued: false,
  };
}

export const CLEANUP_OUTCOMES = ["success", "failure", "cancelled"] as const;
export type CleanupOutcome = (typeof CLEANUP_OUTCOMES)[number];

/**
 * Cleanup removes the worktree and the lease and **leaves the branch alone**.
 * The branch is where the attempt's commits live; deleting it to tidy up would
 * discard the work the attempt exists to produce, and branch deletion is a
 * prohibited action for a reason.
 */
export async function cleanup(args: {
  workspace: Workspace;
  root: string;
  outcome: CleanupOutcome;
  timeoutMs?: number;
}): Promise<{ removed: boolean; detail: string }> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const registration = worktreeGitDir(args.workspace.path);
  const removed = await run(
    ["git", "worktree", "remove", "--force", args.workspace.path],
    { cwd: args.workspace.repository_root, env: gitEnv(), timeoutMs },
  );
  rmSync(leasePath(args.root, args.workspace.root_attempt_id), { force: true });
  // Git refuses a removal — a locked worktree, a main working tree, a path
  // that is not one of its worktrees — before it touches anything. Once it has
  // accepted one, it drops the registration whether or not deleting the tree
  // succeeded. So the tree is deleted here only where the registration its
  // `.git` file names is gone after the failure: a removal Git accepted and
  // could not finish, now or in an earlier cleanup, which leaves a tree that is
  // no longer a worktree of anything. A registered worktree Git refused stays
  // refused.
  //
  // On Windows that failure is the common case: Git reads each link's target
  // into a MAX_PATH buffer that `core.longpaths` does not enlarge, a pnpm
  // `node_modules` holds junctions whose targets run past it, and the first
  // one stops the removal with "Result too large". Node's fs has no such limit
  // on a namespaced path.
  let removedDirectly = false;
  let direct: string | null = null;
  if (
    removed.code !== 0 &&
    existsSync(args.workspace.path) &&
    registration !== null &&
    !existsSync(registration)
  ) {
    try {
      rmSync(toNamespacedPath(args.workspace.path), {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
      removedDirectly = true;
    } catch (error) {
      direct = error instanceof Error ? error.message : String(error);
    }
  }
  await run(["git", "worktree", "prune"], {
    cwd: args.workspace.repository_root,
    env: gitEnv(),
    timeoutMs,
  });
  if (removed.code !== 0 && existsSync(args.workspace.path)) {
    throw new WorkspaceError(
      "cleanup_failed",
      `could not remove ${args.workspace.path} after ${args.outcome}: ${removed.stderr.trim()}` +
        (direct === null ? "" : `; removing it directly failed as well: ${direct}`),
    );
  }
  return {
    removed: true,
    detail:
      `removed after ${args.outcome}; branch ${args.workspace.branch} retained` +
      (removedDirectly ? " (Git did not delete the tree; it was removed directly)" : ""),
  };
}

/**
 * The administrative directory Git keeps for a linked worktree, named by the
 * `.git` file at the worktree's root; null where there is no such file, which
 * includes a main working tree, whose `.git` is a directory.
 */
function worktreeGitDir(path: string): string | null {
  try {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(join(path, ".git"), "utf8"))?.[1];
    return pointer === undefined ? null : resolve(path, pointer.trim());
  } catch {
    return null;
  }
}
