import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  MaterializationMeasurementSchema,
  SecretIndex,
  assertWithinLimits,
  manifestHash,
  type InstallStrategy,
  type LimitsTable,
  type MaterializationEntry,
  type MaterializationManifest,
  type MaterializationMeasurement,
} from "@perbo/contracts";
import { narrowsToMember, unpinnedInstallEnv, workspaceMembership } from "./diagnostic.js";
import { DiskWatcher, directoryBytes } from "./disk.js";
import { run, type RunResult } from "./exec.js";
import { allocatePortRange, databaseSchemaFor, type PortRange } from "./ports.js";
import { SuspendDetector, type SuspendEvent } from "./suspend.js";
import { WorkspaceError, withPortAllocation, type Workspace } from "./worktree.js";

/**
 * Materialization: provisioning made runnable (ADR-0025, SCP-079).
 *
 * Four things happen and all four are declared rather than inferred — the
 * untracked files are copied, the dependencies are installed under a stated
 * strategy with lifecycle scripts off, the attempt gets its own ports and
 * database schema, and a command runs that proves the result works. The last
 * one is the definition: "time to first successful execution" ends when the
 * repository's own suite is green in the worktree, not when the install exits 0.
 */

export interface MaterializeRequest {
  workspace: Workspace;
  manifest: MaterializationManifest;
  limits: LimitsTable;
  /** Recorded, not enforced: whether the store was expected to be populated. */
  warm: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  /** Where leases live. Given, the port range avoids every live attempt's. */
  leaseRoot?: string;
  onProgress?: (message: string) => void;
  installTimeoutMs?: number;
}

export interface MaterializedWorkspace {
  workspace: Workspace;
  manifest_hash: string;
  /**
   * What the worktree occupies as a directory walk sees it. On pnpm this is an
   * upper bound rather than a cost: most of `node_modules` is hardlinks into a
   * shared store, so the free-space delta beside it is the bytes an attempt
   * actually consumed.
   */
  apparent_bytes: number;
  /** Tail of the verification output, redacted against the secret index. */
  verify_summary: string;
  /** Content hashes of everything copied in as a secret. Never plaintext. */
  secrets: SecretIndex;
  ports: PortRange;
  database_schema: string | null;
  measurement: MaterializationMeasurement;
  install: RunResult | null;
  verify: RunResult | null;
  suspended: SuspendEvent | null;
  materialized_paths: string[];
}

const DEFAULT_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The environment install and verification run under. It is built, not
 * inherited: an install that quietly picks up the developer's `NPM_TOKEN` or
 * `AWS_PROFILE` is a supply-chain surface, and one that picks up their
 * `DATABASE_URL` writes to the wrong database.
 */
export function materializationEnv(args: {
  base: NodeJS.ProcessEnv;
  worktree: string;
  ports: PortRange;
  database_schema: string | null;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: args.base.PATH ?? "/usr/bin:/bin",
    HOME: args.base.HOME ?? "",
    SHELL: args.base.SHELL ?? "/bin/sh",
    LANG: args.base.LANG ?? "C",
    TMPDIR: args.base.TMPDIR ?? "/tmp",
    CI: "1",
    PERBO_WORKTREE: args.worktree,
    PERBO_PORT_START: String(args.ports.start),
    PERBO_PORT_END: String(args.ports.end),
  };
  if (args.database_schema) env.PERBO_DB_SCHEMA = args.database_schema;
  return env;
}

function destinationInside(worktree: string, entry: MaterializationEntry): string {
  const target = resolve(worktree, entry.path);
  const root = resolve(worktree);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new WorkspaceError(
      "path_scope_escape",
      `materialization destination ${entry.path} resolves outside ${worktree}`,
    );
  }
  return target;
}

/**
 * Whether a path is there, as seen from this process — false where looking is
 * itself refused, which is what Node's permission model does to a directory
 * this process was not granted.
 */
function visible(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * The repository a worktree is a checkout **of**: the nearest directory at or
 * above the root the run was given that holds a `.git` entry.
 *
 * `git worktree add` checks out a repository, never a directory inside one, so
 * the worktree root is the counterpart of *this* directory rather than of the
 * root the run named. They are the same directory for a checkout that is its
 * own repository, and they differ for a run pointed at one package of a
 * monorepo: the package sits below the repository root, and it sits at that
 * same relative path inside the worktree.
 *
 * The checkout itself where nothing above it is a repository — there is no
 * better answer, and it is the mapping every caller had before this was
 * written.
 */
function checkoutRepositoryRoot(checkout: string): string {
  const given = resolve(checkout);
  let current = given;
  for (;;) {
    if (visible(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return given;
    current = parent;
  }
}

/**
 * Where a directory of the person's checkout would sit inside the worktree.
 *
 * This is the whole of how a derived command reaches the directory it was
 * derived for. The derivation reads two directories off the checkout — the
 * package whose scripts are the verification, the workspace root whose lockfile
 * the install reproduces — and each keeps its position relative to the
 * repository when that repository is checked out again somewhere else.
 *
 * The answer may be outside the worktree, which is not a failure of the
 * mapping: a directory above the repository is above the worktree too, and each
 * caller below says what it does about that.
 */
function worktreeCounterpart(args: {
  worktree: string;
  checkout: string;
  directory: string;
}): string {
  return resolve(
    resolve(args.worktree),
    relative(checkoutRepositoryRoot(args.checkout), resolve(args.directory)),
  );
}

/** Whether `path` is the directory `root` or one below it. */
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * Where the install runs — the second half of what an install is, and until
 * now assumed to be the worktree root.
 *
 * An install is derived against the checkout the run was given, and for one
 * package of a monorepo that derivation names two directories rather than one
 * (`proposedInstallStep`): the command is the workspace's, narrowed to the
 * member, and it runs at the workspace root, because that is where the lockfile
 * is and where the manager resolves the member graph from. The worktree is a
 * fresh checkout of the repository that root belongs to, so the directory is
 * carried across by where it sits **relative to that repository**: a workspace
 * root inside the repository is the same path inside the worktree, and a
 * monorepo checked out whole has its root at the worktree root whichever
 * package the run was pointed at.
 *
 * A workspace root *above* the repository is above the worktree, which is
 * outside it, and that is what this exists to catch. A package whose monorepo
 * sits above its own repository has no workspace in the worktree at all, so
 * `pnpm install --filter @scope/api` run there is not the install the manifest
 * describes: it fails, or it resolves the name against nothing. A run that
 * executes it has done neither what it said nor nothing, which is the failure
 * ADR-0025 exists to move earlier — so it is refused here, before a port is
 * taken or a file is copied, naming both directories.
 *
 * An install that does not narrow to a member asks nothing of the directory
 * beyond its being the checkout, and runs at the worktree root exactly as it
 * always has. That includes one a person wrote into `.perbo/config.json` for
 * such a package: it is their declaration rather than this derivation's, and
 * refusing it would refuse a command that works.
 */
export function installDirectory(args: {
  /** The attempt's worktree: a fresh checkout of `checkout`'s repository. */
  worktree: string;
  /** The repository root the run was given, which the derivation was read from. */
  checkout: string;
  install: InstallStrategy;
}): string {
  const root = resolve(args.worktree);
  const membership = workspaceMembership(args.checkout);
  const derived = worktreeCounterpart({
    worktree: root,
    checkout: args.checkout,
    directory: membership.workspace_root,
  });
  if (within(root, derived)) return derived;
  const { command, package_manager } = args.install;
  if (!narrowsToMember(command, package_manager, membership.package_name)) return root;
  throw new WorkspaceError(
    "install_root_outside_worktree",
    `\`${command.join(" ")}\` installs ${membership.package_name} as one member of the ` +
      `workspace at ${membership.workspace_root}, so it runs there — but that workspace is ` +
      `above ${checkoutRepositoryRoot(args.checkout)} rather than inside it, and the worktree ` +
      `at ${root} is a checkout of that repository alone. There is no workspace root here to ` +
      "run it in, and running it here anyway would install something other than what the " +
      "manifest describes. Point the run at a checkout that contains its own workspace root, " +
      "or declare an install this repository can run on its own.",
  );
}

/**
 * Where the verification runs, which is the same question asked of the other
 * command a manifest carries.
 *
 * The verification is the given root's own — the diagnostic reads it from that
 * root's `package.json`, and the checks a run pins come from the same
 * scripts — so it runs where those scripts live: the counterpart of that root
 * inside the worktree. For a checkout that is its own repository that is the
 * worktree root, as it always was. For one package of a monorepo checked out
 * whole it is the package's directory inside the worktree, and running there is
 * the difference between `pnpm run test` meaning the member's suite and meaning
 * the workspace root's script of the same name — which is a different suite,
 * silently substituted for the one the derivation named.
 *
 * Where the worktree does not hold that directory at all — a package the base
 * commit predates, or one Git is ignoring — there is nowhere to run it, and the
 * refusal is the answer for the same reason the install's is: a command run in
 * some other directory has done neither what it said nor nothing.
 */
export function verifyDirectory(args: {
  /** The attempt's worktree: a fresh checkout of `checkout`'s repository. */
  worktree: string;
  /** The repository root the run was given, whose scripts the command was read from. */
  checkout: string;
}): string {
  const root = resolve(args.worktree);
  const derived = worktreeCounterpart({
    worktree: root,
    checkout: args.checkout,
    directory: resolve(args.checkout),
  });
  if (within(root, derived) && visible(derived)) return derived;
  throw new WorkspaceError(
    "verify_root_outside_worktree",
    `the verification is read from the scripts ${resolve(args.checkout)} declares, so it runs ` +
      `where they live: ${derived}, which the worktree at ${root} does not hold. Running it at ` +
      "the worktree root instead would run whatever script of that name is there, which is not " +
      "the one the manifest describes.",
  );
}

/** Copy or link one entry, and index it when it is a secret. */
export function materializeEntry(args: {
  worktree: string;
  source_checkout: string;
  entry: MaterializationEntry;
  secrets: SecretIndex;
}): { path: string; materialized: boolean; detail: string } {
  const { entry } = args;
  const source = entry.source_path.startsWith("/")
    ? entry.source_path
    : join(args.source_checkout, entry.source_path);
  const target = destinationInside(args.worktree, entry);

  if (!existsSync(source)) {
    if (entry.required) {
      throw new WorkspaceError(
        "path_scope_escape",
        `required materialization source ${source} does not exist`,
      );
    }
    return { path: entry.path, materialized: false, detail: "optional source absent" };
  }

  mkdirSync(dirname(target), { recursive: true });
  if (entry.strategy === "symlink") {
    if (!existsSync(target)) symlinkSync(source, target);
  } else {
    cpSync(source, target, { recursive: entry.kind === "directory", force: true });
  }

  if (entry.secret) {
    if (entry.kind === "file") {
      args.secrets.add(entry.path, readFileSync(source));
    } else {
      // A secret directory is indexed file by file, because a directory has no
      // bytes of its own to hash and the values inside it are what leak.
      const walk = (dir: string, prefix: string) => {
        for (const child of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, child.name);
          if (child.isDirectory()) walk(full, `${prefix}/${child.name}`);
          else if (child.isFile()) args.secrets.add(`${prefix}/${child.name}`, readFileSync(full));
        }
      };
      walk(source, entry.path);
    }
  }
  return { path: entry.path, materialized: true, detail: entry.strategy };
}

/**
 * The laptop ceiling (D-049), checked against what the attempt actually
 * consumed rather than against what a directory walk would bill it.
 *
 * `peak_bytes` is a free-space delta, so on a machine with a warm package store
 * it is legitimately near zero: most of a pnpm `node_modules` is hardlinks into
 * bytes that were already there. That is the number a ceiling about filling a
 * disk should read.
 */
export function assertAttemptFootprint(
  limits: LimitsTable,
  measurement: MaterializationMeasurement,
): void {
  assertWithinLimits(limits, "local_workspace_bytes", measurement.peak_bytes);
}

export async function materialize(request: MaterializeRequest): Promise<MaterializedWorkspace> {
  const { workspace, manifest } = request;
  const progress = request.onProgress ?? (() => undefined);
  const started = Date.now();

  // Where the two commands will run, resolved before anything is created: a
  // command this worktree cannot offer a directory for is a refusal, and a
  // refusal that has already taken a port range and copied a secret in is a
  // refusal that had to be cleaned up.
  const installCwd = installDirectory({
    worktree: workspace.path,
    checkout: workspace.repository_root,
    install: manifest.install,
  });
  const verifyCwd = verifyDirectory({
    worktree: workspace.path,
    checkout: workspace.repository_root,
  });

  const secrets = new SecretIndex();
  const suspendDetector = new SuspendDetector(() => undefined);
  suspendDetector.start();
  const disk = new DiskWatcher(workspace.path);
  disk.watch();

  // Read-probe-write under one exclusive lock. Splitting them let two attempts
  // both read a held-set excluding the other and both be handed the same range.
  const ports =
    manifest.isolation.port_range_size === 0
      ? { start: manifest.isolation.port_range_start, end: manifest.isolation.port_range_end, size: 0 }
      : request.leaseRoot
        ? await withPortAllocation(request.leaseRoot, workspace.root_attempt_id, (avoid) =>
            allocatePortRange({
              size: manifest.isolation.port_range_size,
              base: manifest.isolation.port_range_start,
              avoid,
            }),
          )
        : await allocatePortRange({
            size: manifest.isolation.port_range_size,
            base: manifest.isolation.port_range_start,
            avoid: [],
          });
  const database_schema = manifest.isolation.database_schema_prefix
    ? databaseSchemaFor(manifest.isolation.database_schema_prefix, workspace.attempt_id)
    : null;

  const materializeStart = Date.now();
  const materialized_paths: string[] = [];
  for (const entry of manifest.entries) {
    const result = materializeEntry({
      worktree: workspace.path,
      source_checkout: manifest.source_checkout,
      entry,
      secrets,
    });
    if (result.materialized) materialized_paths.push(result.path);
    progress(`materialize ${entry.path} (${result.detail})`);
  }
  const materialize_ms = Date.now() - materializeStart;

  const env = materializationEnv({
    base: request.baseEnv ?? process.env,
    worktree: workspace.path,
    ports,
    database_schema,
  });

  let install: RunResult | null = null;
  let install_ms = 0;
  if (manifest.install.kind !== "none") {
    progress(
      `install: ${manifest.install.command.join(" ")}` +
        (installCwd === resolve(workspace.path) ? "" : ` (in ${installCwd})`),
    );
    install = await run(manifest.install.command, {
      cwd: installCwd,
      // The unpinned install's own settings, which keep it from leaving a
      // lockfile in the worktree: the install is the runner's, and a file it
      // leaves behind is sealed into the attempt as though the executor had
      // written it. Nothing for a pinned install, and nothing for a manager
      // that says it on the command line. The verification below runs without
      // them — what it installs, if it installs anything, is the repository's
      // own business.
      env: { ...env, ...unpinnedInstallEnv(manifest.install) },
      timeoutMs: request.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
    });
    install_ms = install.duration_ms;
    disk.sample();
  }

  let verify: RunResult | null = null;
  let verify_ms = 0;
  if (install === null || install.code === 0) {
    // At the counterpart of the root the run was given, which is the worktree
    // root for a checkout that is its own repository and the package's own
    // directory for one package of a monorepo checked out whole. The verify
    // command is read from that root's own scripts (`declaredVerifyCommand`), so
    // running it there is what makes the `test` script this executes the one
    // the derivation named rather than a script of the same name belonging to
    // some directory above it.
    progress(
      `verify: ${manifest.verify.command.join(" ")}` +
        (verifyCwd === resolve(workspace.path) ? "" : ` (in ${verifyCwd})`),
    );
    verify = await run(manifest.verify.command, {
      cwd: verifyCwd,
      env,
      timeoutMs: manifest.verify.timeout_ms,
    });
    verify_ms = verify.duration_ms;
  }

  const footprint = disk.stop();
  const suspended = suspendDetector.stop();
  const apparent_bytes = directoryBytes(workspace.path);
  // stdout and stderr are tailed separately: a suite writes its summary to
  // stdout and its warnings to stderr, and concatenating them loses the summary
  // behind whichever stream was noisier.
  const verify_summary = secrets.redact(
    [
      (verify?.stdout ?? "").trim().slice(-1600),
      (verify?.stderr ?? "").trim().slice(-600),
    ]
      .filter((part) => part.length > 0)
      .join("\n--- stderr ---\n"),
  ).text;

  const measurement = MaterializationMeasurementSchema.parse({
    provision_ms: 0,
    materialize_ms,
    install_ms,
    verify_ms,
    total_ms: Date.now() - started,
    steady_state_bytes: footprint.steady_state_bytes,
    peak_bytes: footprint.peak_bytes,
    warm: request.warm,
    install_strategy: manifest.install.kind,
    package_manager: manifest.install.package_manager,
  } satisfies MaterializationMeasurement);

  assertAttemptFootprint(request.limits, measurement);

  return {
    workspace,
    manifest_hash: manifestHash(manifest),
    apparent_bytes,
    verify_summary,
    secrets,
    ports,
    database_schema,
    measurement,
    install,
    verify,
    suspended,
    materialized_paths,
  };
}
