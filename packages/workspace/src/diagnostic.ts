import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import {
  MATERIALIZATION_MANIFEST_VERSION,
  MaterializationManifestSchema,
  isSecretPath,
  type DiagnosticFinding,
  type InstallStrategy,
  type MaterializationEntry,
  type MaterializationManifest,
  type PackageManager,
  type DiagnosticResult,
  isRefusal,
} from "@perbo/contracts";
import type { RunResult } from "./exec.js";
import { git } from "./repository/index.js";
import { DEFAULT_PORT_BASE, DEFAULT_PORT_SPAN } from "./ports.js";

/**
 * The first-run compatibility diagnostic (ADR-0025 §1, SCP-079 criteria 1 and 6).
 *
 * It proposes a manifest by looking at the checkout the user already has: which
 * package manager its lockfile — or, where it has none yet, its manifest —
 * names, which untracked files Git is ignoring that the repository nonetheless
 * needs, and what command proves the thing runs. The user confirms and edits
 * it. Proposing is the whole value — asking someone to write this file from
 * scratch at onboarding step four is asking them to stop.
 *
 * It also refuses. A repository that cannot be materialized fails **here**, with
 * a named reason, rather than in the middle of an attempt where the failure
 * wears the agent's face. A configuration that signs commits with a key nothing
 * can use is one of those: the seal is the first thing that asks the key to
 * sign, and by then the attempt has been paid for.
 *
 * And it warns. Where the worktree root is named, it says what the package
 * manager will make of that location — an advisory finding, because a badly
 * placed worktree root is the operator's setting rather than a property of the
 * repository, and the repository is not refused for it. A checkout with no
 * lockfile is the same shape: the install runs, unpinned, and the advisory says
 * what writes one.
 */

/** Untracked things a repository plausibly needs. Ordered widest first. */
const CANDIDATE_PATTERNS: Array<{ test: RegExp; reason: string; kindHint: "file" | "directory" }> = [
  { test: /(^|\/)\.env$/, reason: "the environment file the application reads at startup", kindHint: "file" },
  { test: /(^|\/)\.env\.[^/]+$/, reason: "an environment file the application reads at startup", kindHint: "file" },
  { test: /(^|\/)\.npmrc$/, reason: "registry configuration the install needs", kindHint: "file" },
  { test: /\.(pem|key|crt|p12|pfx)$/, reason: "a local certificate or key the application loads", kindHint: "file" },
  { test: /(^|\/)certs?\/$/, reason: "local certificates the application loads", kindHint: "directory" },
  { test: /(^|\/)seed(-data)?\/$/, reason: "seed data a local database is loaded from", kindHint: "directory" },
];

/** Never proposed: build output and dependency trees are produced, not materialized. */
const NEVER_PROPOSE = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.turbo(\/|$)/,
  /(^|\/)\.venv(\/|$)/,
  /(^|\/)target(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.pytest_cache(\/|$)/,
  /(^|\/)\.ruff_cache(\/|$)/,
  /(^|\/)\.mypy_cache(\/|$)/,
];

interface ManagerProfile {
  manager: PackageManager;
  /** The lockfile that names this manager and pins what its install resolves. */
  lockfile: string;
  /**
   * What its install reads beside that lockfile, any one of which gives it
   * something to install: `package.json`, and for pnpm also
   * `pnpm-workspace.yaml`, from which pnpm installs a workspace that has no
   * root manifest.
   */
  manifests: string[];
  /** With that lockfile: reproduces it, and fails rather than updating it. */
  install: string[];
  /**
   * Without it: resolves versions from the registry, so it cannot be frozen.
   * Whether it still prefers what is already on disk is the manager's own
   * answer — pnpm's store holds the package contents themselves, so preferring
   * it costs an unpinned install nothing and saves the second one; npm's cache
   * holds metadata about versions rather than the versions, so its unpinned
   * form asks for nothing.
   *
   * It also leaves no lockfile in the worktree. The install is the runner's,
   * and a file it leaves there is sealed into the attempt as though the
   * executor had written it: outside the contract's paths that is a defect in
   * the guard, and inside them it is the runner's output in a change set under
   * review.
   */
  unpinned: string[];
  /**
   * What the unpinned install needs in its **environment** to write no
   * lockfile, where the manager has no flag for it that belongs on a command
   * line a person reads.
   *
   * pnpm is the one: `--config.lockfile=false` on the argv says the same thing,
   * but it is the argv that `doctor --write-config` writes into
   * `.perbo/config.json` and that a person runs by hand to reproduce what the
   * runner did, and a setting of the runner's own is not part of that command.
   * npm, yarn and bun say it on the command line, because there it reads as
   * what it is.
   */
  unpinned_env?: Record<string, string>;
  /** What writes the lockfile, so the next install is the pinned one. */
  pin: string[];
  /**
   * What narrows an install at a workspace root to one member of it, given that
   * member's declared name. Appended to the install, which still runs at the
   * workspace root: that is where the lockfile is and where the manager
   * resolves the member graph from, and an install run in the member directory
   * either fails or installs against the wrong lockfile.
   *
   * `null` for a manager with no such form. Yarn is the one: classic has no
   * per-member install at all, and berry says it as a different command
   * (`yarn workspaces focus`) whose availability depends on the major version
   * a `yarn.lock` does not distinguish. The whole workspace is installed
   * instead — a superset of what the member needs, which is slower and correct,
   * rather than a command that is wrong on half the yarn checkouts there are.
   */
  filter: ((packageName: string) => string[]) | null;
  supported: boolean;
}

/**
 * `--ignore-scripts` is not an optimisation. A lifecycle script runs
 * repository-authored code as the runner during materialization (threat 20), so
 * it is off unless the manifest carries a recorded exception.
 */
const MANAGERS: ManagerProfile[] = [
  {
    manager: "pnpm",
    manifests: ["package.json", "pnpm-workspace.yaml"],
    lockfile: "pnpm-lock.yaml",
    install: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"],
    // The pinned install without the flag that needs a lockfile, so the two
    // forms of the same repository's install differ by exactly the thing the
    // lockfile decides. The lockfile it would otherwise write is suppressed
    // below rather than here.
    unpinned: ["pnpm", "install", "--prefer-offline", "--ignore-scripts"],
    unpinned_env: { npm_config_lockfile: "false" },
    pin: ["pnpm", "install", "--lockfile-only"],
    filter: (name) => ["--filter", name],
    supported: true,
  },
  {
    manager: "npm",
    manifests: ["package.json"],
    lockfile: "package-lock.json",
    install: ["npm", "ci", "--prefer-offline", "--ignore-scripts"],
    unpinned: ["npm", "install", "--ignore-scripts", "--no-package-lock"],
    pin: ["npm", "install", "--package-lock-only"],
    filter: (name) => ["--workspace", name],
    supported: true,
  },
  {
    manager: "yarn",
    manifests: ["package.json"],
    lockfile: "yarn.lock",
    install: ["yarn", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"],
    unpinned: ["yarn", "install", "--ignore-scripts", "--no-lockfile"],
    pin: ["yarn", "install"],
    filter: null,
    supported: true,
  },
  {
    manager: "bun",
    manifests: ["package.json"],
    lockfile: "bun.lockb",
    install: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    unpinned: ["bun", "install", "--ignore-scripts", "--no-save"],
    pin: ["bun", "install"],
    filter: (name) => ["--filter", name],
    supported: true,
  },
  {
    manager: "uv",
    manifests: ["pyproject.toml"],
    lockfile: "uv.lock",
    install: ["uv", "sync", "--frozen"],
    unpinned: ["uv", "sync"],
    pin: ["uv", "lock"],
    filter: (name) => ["--package", name],
    supported: false,
  },
];

/**
 * The manifests that name a manager where no lockfile does, widest first.
 *
 * `package.json` is read for `packageManager` — the field that pins a manager
 * for corepack — then for the workspace file beside it, and means npm where
 * neither says anything, which is what a Node checkout has without choosing
 * one. `pyproject.toml` means uv, the only Python manager above. Nothing else
 * is covered: a checkout whose manifest is `Cargo.toml`, `go.mod`, `Gemfile` or
 * `composer.json` names no manager here.
 */
const MANIFESTS: Array<{ file: string; manager: (path: string) => PackageManager }> = [
  {
    file: "package.json",
    manager: (path) => declaredPackageManager(path) ?? workspaceManager(dirname(path)) ?? "npm",
  },
  { file: "pyproject.toml", manager: () => "uv" },
];

/** The manager `packageManager` names, where it names one this file knows. */
function declaredPackageManager(manifest: string): PackageManager | null {
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { packageManager?: unknown };
    const named =
      typeof parsed.packageManager === "string" ? parsed.packageManager.split("@")[0] : null;
    return MANAGERS.some((profile) => profile.manager === named)
      ? (named as PackageManager)
      : null;
  } catch {
    return null;
  }
}

/**
 * The manager the workspace file in `dir` implies, where one implies a manager
 * on its own.
 *
 * `pnpm-workspace.yaml` is the only such file: no other manager reads it, so a
 * root holding one runs pnpm, and npm — what a `package.json` declaring no
 * manager otherwise means — is the wrong answer for it.
 *
 * This is read *after* `packageManager`, never before it. That field is the
 * explicit declaration a person wrote and corepack obeys; this is an inference
 * from a file's presence, and an inference does not overrule a declaration. A
 * `workspaces` array names no manager at all — npm, yarn and bun all read it —
 * so it is not consulted here and such a root keeps the answer it had.
 */
function workspaceManager(dir: string): PackageManager | null {
  return visible(join(dir, "pnpm-workspace.yaml")) ? "pnpm" : null;
}

/** The manager a checkout runs, and whether anything pins what its install resolves. */
export interface DetectedManager {
  manager: PackageManager;
  supported: boolean;
  /** True where a lockfile pins the versions the install resolves. */
  pinned: boolean;
  /** The install this checkout can actually run. */
  install: string[];
  /** The lockfile that pins this manager's install, present in the checkout or not. */
  lockfile: string;
  /** The install this checkout would run once that lockfile is there. */
  pinned_install: string[];
  /** What writes the lockfile, for a checkout that has none. */
  pin_with: string[];
  /** The file that named the manager: a lockfile, or the manifest standing in for one. */
  named_by: string;
  /** What the install reads, any one of which gives it something to install. */
  manifests: string[];
  /**
   * Whether one of those is where the install runs. A lockfile names its
   * manager on its own, and one with none of them beside it names an install
   * with nothing to install.
   */
  manifest_present: boolean;
}

/**
 * The globs a workspace declares its members by, or `null` where the directory
 * declares no workspace at all.
 *
 * An empty array is a workspace with no members — `packages: []` — and is not
 * the same answer as `null`: the first captures the directories under it and
 * belongs to no member, the second is an ordinary directory.
 *
 * `pnpm` reads `pnpm-workspace.yaml`; npm, yarn and bun read a `workspaces`
 * field in `package.json`, as an array or as `{ packages: [...] }`; uv reads
 * `[tool.uv.workspace]` in `pyproject.toml`.
 */
function workspaceMembers(dir: string): string[] | null {
  const pnpm = join(dir, "pnpm-workspace.yaml");
  if (visible(pnpm)) return readSequence(read(pnpm), "packages");
  const manifest = join(dir, "package.json");
  if (visible(manifest)) {
    try {
      const declared = (JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown })
        .workspaces;
      if (Array.isArray(declared)) return declared.filter((glob) => typeof glob === "string");
      if (declared !== null && typeof declared === "object") {
        const packages = (declared as { packages?: unknown }).packages;
        return Array.isArray(packages) ? packages.filter((glob) => typeof glob === "string") : [];
      }
      if (declared !== undefined) return [];
    } catch {
      // Unreadable: it declares nothing this can act on.
    }
  }
  const pyproject = join(dir, "pyproject.toml");
  if (visible(pyproject)) {
    // Only the table that declares the workspace, never a `members` under some
    // other one: `[tool.uv.workspace]` is what makes this directory a workspace
    // root, and its own key is the only one that says what belongs to it.
    const table = tomlTable(read(pyproject), "tool.uv.workspace");
    if (table !== null) return readSequence(table, "members");
  }
  return null;
}

/**
 * Whether a path is there, as seen from this process — false where looking is
 * itself refused.
 *
 * The walk above climbs out of the directory it was given, and a process
 * running under Node's permission model may read only what it was granted:
 * `existsSync` **throws** there rather than answering false. A directory this
 * process cannot look into declares no workspace it could act on — there is no
 * install it could run there either — so that is the answer, rather than an
 * exception out of a diagnostic that was asked what a repository looks like.
 */
function visible(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** A file's text, or empty where it cannot be read. */
function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * The lines one TOML table owns, or null where the text declares no such table.
 *
 * A TOML key sits at the start of its own line whichever table it belongs to,
 * so `members = [...]` under `[project]` and `members = [...]` under
 * `[tool.uv.workspace]` are indistinguishable to a reader that matches only the
 * key — and reading the first would let an unrelated list decide which
 * directories a workspace owns. The header is what separates them: everything
 * from it to the next header is that table's, and it is the only text the key
 * is looked for in.
 */
function tomlTable(text: string, name: string): string | null {
  const header = new RegExp(`^\\s*\\[\\s*${name.replace(/\./g, "\\.")}\\s*]\\s*(#.*)?$`);
  const lines = text.split("\n");
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  const body = lines.slice(start + 1);
  const next = body.findIndex((line) => /^\s*\[/.test(line));
  // Flush left, because indentation carries no meaning in TOML: a table whose
  // keys are indented under its header is the same table, and the reader below
  // takes a key at the start of a line.
  return (next === -1 ? body : body.slice(0, next))
    .map((line) => line.replace(/^[ \t]+/, ""))
    .join("\n");
}

/**
 * The strings a `<key>:` or `<key> =` sequence holds, in either the block form
 *
 *     packages:
 *       - "apps/*"
 *
 * or the flow form `packages: []` / `members = ["apps/*"]`.
 *
 * Read rather than parsed: no YAML or TOML parser is a dependency of this
 * repository, and adding one to read a list of globs out of two well-known
 * files would be a supply-chain decision taken for a five-line shape. What it
 * cannot read it reports as no members, which leaves the directory a workspace
 * that owns nothing — the same answer as an empty list, and never a claim that
 * some other directory belongs to it.
 *
 * The text it is given is the scope it reads in, and the caller narrows it: a
 * TOML key is looked for in its own table (see `tomlTable`), and a YAML key
 * only where it begins a line, which in a block-structured file is the
 * top-level mapping the workspace declares itself in and never a `packages:`
 * nested under some other key. Where a document repeats a top-level key —
 * which YAML does not permit — the first is the answer.
 */
function readSequence(text: string, key: string): string[] {
  const lines = text.split("\n");
  const opens = new RegExp(`^${key}\\s*[:=]\\s*(.*)$`);
  const items: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opened = opens.exec(lines[index] ?? "");
    if (!opened) continue;
    const inline = (opened[1] ?? "").trim();
    if (inline.startsWith("[")) {
      // The flow form, which may run over several lines until its bracket closes.
      let body = inline;
      while (!body.includes("]") && index + 1 < lines.length) {
        index += 1;
        body += lines[index] ?? "";
      }
      for (const item of body.slice(body.indexOf("[") + 1, body.lastIndexOf("]")).split(",")) {
        const value = unquote(item);
        if (value.length > 0) items.push(value);
      }
      return items;
    }
    // The block form: every `- item` under the key, to the first line that is
    // neither indented nor blank.
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? "";
      if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
      if (!/^\s/.test(line)) break;
      const entry = /^\s*-\s*(.*)$/.exec(line);
      if (!entry) break;
      const value = unquote(entry[1] ?? "");
      if (value.length > 0) items.push(value);
    }
    return items;
  }
  return [];
}

/** One list item, without its quotes or its trailing comment. */
function unquote(raw: string): string {
  const text = raw.trim();
  const quote = text.startsWith('"') ? '"' : text.startsWith("'") ? "'" : null;
  if (quote === null) return text.split("#")[0]?.trim() ?? "";
  const end = text.indexOf(quote, 1);
  return end === -1 ? text.slice(1) : text.slice(1, end);
}

/** Does this directory declare a package-manager workspace, members or none? */
function declaresWorkspace(dir: string): boolean {
  return workspaceMembers(dir) !== null;
}

/**
 * The nearest directory **above** `directory` that declares a package-manager
 * workspace, or null when there is none.
 *
 * A package manager resolves its workspace root by walking up, and it does not
 * stop at a Git boundary. So a worktree placed under such a directory is read
 * as a member of that workspace: `pnpm install` and every `pnpm exec` in it
 * fail with exit 254, and the message names neither the worktree nor the
 * workspace it was captured by. The directory itself is deliberately not an
 * ancestor — a checkout that is its own workspace root is the normal case, not
 * the hazard.
 */
export function enclosingWorkspaceRoot(directory: string): string | null {
  let current = dirname(resolve(directory));
  for (;;) {
    if (declaresWorkspace(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The `name` a package declares, which is what its manager filters by. */
function declaredPackageName(directory: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
}

/** Whether `packageRoot` is one of the members `patterns` names, negations honoured. */
function matchesMember(workspaceRoot: string, packageRoot: string, patterns: string[]): boolean {
  const path = relative(workspaceRoot, packageRoot).split(sep).join("/");
  if (path.length === 0 || path.startsWith("..")) return false;
  let member = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const glob = (negated ? pattern.slice(1) : pattern).replace(/^\.\//, "");
    if (matchesGlob(path, glob)) member = !negated;
  }
  return member;
}

/**
 * The root a run was given, and the workspace whose manager installs it.
 *
 * Pointing a run at one package of a monorepo is ordinary — the outcome is
 * about that package, and its scripts are the ones that judge it — but the
 * install is not the package's own business: the lockfile is at the workspace
 * root, and the manager resolves the member graph from there. So the two roots
 * are separated here once, and every derivation below reads the one it means.
 *
 * A directory under a workspace root that the workspace does not **list** is
 * not a member: the manager matches its `packages`/`workspaces` globs, and a
 * scratch directory that merely happens to sit below a monorepo is its own
 * checkout. Where nothing above declares a workspace at all, the two roots are
 * the same directory and everything reads exactly as it did before.
 */
export interface WorkspaceMembership {
  /** The root the run was given: the package itself. */
  package_root: string;
  /** Where its install runs — the workspace root, or the package root itself. */
  workspace_root: string;
  /** The member name its manager filters by, or null where it declares none. */
  package_name: string | null;
}

export function workspaceMembership(checkout: string): WorkspaceMembership {
  const packageRoot = resolve(checkout);
  const standalone: WorkspaceMembership = {
    package_root: packageRoot,
    workspace_root: packageRoot,
    package_name: null,
  };
  const workspaceRoot = enclosingWorkspaceRoot(packageRoot);
  if (workspaceRoot === null) return standalone;
  if (!matchesMember(workspaceRoot, packageRoot, workspaceMembers(workspaceRoot) ?? [])) {
    return standalone;
  }
  return {
    package_root: packageRoot,
    workspace_root: workspaceRoot,
    package_name: declaredPackageName(packageRoot),
  };
}

/**
 * Which package manager runs this checkout, and whether its install is pinned.
 *
 * A lockfile is the strongest answer and is read first: it names the manager
 * *and* pins what the install resolves. Where there is none, the manifest names
 * the manager on its own — a repository somebody is trying for the first time
 * often has no lockfile yet, and its scripts are read through that manager all
 * the same.
 *
 * Both are read at the **workspace** root where the checkout is a member of
 * one, because that is where the manager reads them: a package of a pnpm
 * monorepo has no lockfile of its own, and answering `npm` for it — which is
 * what reading only the package's own `package.json` did — proposed an install
 * that resolves a different dependency graph from the one the repository
 * actually runs. The install it returns is narrowed to that member, and the
 * directory it runs in is `proposedInstallStep`'s answer.
 */
export function detectPackageManager(
  checkout: string,
  membership: WorkspaceMembership = workspaceMembership(checkout),
): DetectedManager | null {
  const root = membership.workspace_root;
  // The path a finding names the file by, read from the root the run was given
  // — `pnpm-lock.yaml` for a checkout that is its own workspace, and
  // `../pnpm-lock.yaml` for a package of one, which is where a person will
  // find it.
  const namedBy = (file: string): string =>
    root === membership.package_root ? file : relative(membership.package_root, join(root, file));
  const filtered = (profile: ManagerProfile, argv: string[]): string[] =>
    membership.package_name === null || profile.filter === null
      ? argv
      : [...argv, ...profile.filter(membership.package_name)];

  for (const profile of MANAGERS) {
    if (!visible(join(root, profile.lockfile))) continue;
    return {
      manager: profile.manager,
      supported: profile.supported,
      pinned: true,
      install: filtered(profile, profile.install),
      lockfile: profile.lockfile,
      pinned_install: filtered(profile, profile.install),
      // The lockfile is the workspace's, and so is what writes it: a member
      // does not pin its own.
      pin_with: profile.pin,
      named_by: namedBy(profile.lockfile),
      manifests: profile.manifests,
      manifest_present: profile.manifests.some((file) => visible(join(root, file))),
    };
  }
  for (const manifest of MANIFESTS) {
    const path = join(root, manifest.file);
    if (!visible(path)) continue;
    const named = manifest.manager(path);
    const profile = MANAGERS.find((candidate) => candidate.manager === named);
    if (!profile) continue;
    return {
      manager: profile.manager,
      supported: profile.supported,
      pinned: false,
      install: filtered(profile, profile.unpinned),
      lockfile: profile.lockfile,
      pinned_install: filtered(profile, profile.install),
      pin_with: profile.pin,
      named_by: namedBy(manifest.file),
      manifests: profile.manifests,
      manifest_present: true,
    };
  }
  return null;
}

/**
 * The verification proposed where the checkout declares none a worktree can
 * run: nothing names a package manager this build installs with, there is no
 * manifest for its install to read, the package declares no test script, or
 * each one it declares starts a service. What it proves is that the worktree is
 * a checkout Git can read; it exits non-zero on one it cannot, and takes no
 * value from a model or from repository content. Exported so that the
 * read-back of a configuration can recognise the manifest `doctor
 * --write-config` pins for such a checkout.
 */
export const GREENFIELD_VERIFY: readonly string[] = ["git", "status", "--porcelain"];

/**
 * Whether a verification is `GREENFIELD_VERIFY`. It passes on any checkout Git
 * can read, so a base it passed is a base nothing measured, and it is no suite.
 */
export function isGreenfieldVerify(command: readonly string[]): boolean {
  return (
    command.length === GREENFIELD_VERIFY.length &&
    command.every((part, index) => part === GREENFIELD_VERIFY[index])
  );
}

/**
 * What a finding says where the verification is `GREENFIELD_VERIFY`: what that
 * command proves, and so what an attempt there is judged by instead. Checks a
 * person pins in `.perbo/config.json` judge it whatever the manifest says.
 */
const UNVERIFIED =
  `Verification is \`${GREENFIELD_VERIFY.join(" ")}\`, which any checkout Git can read passes, ` +
  "so an attempt here is judged by the review and whichever checks are pinned.";

/**
 * The verification a checkout gets, and the only place it is derived.
 *
 * A command the diagnostic is given is the caller's, and runs as given; the
 * finding says what it starts. Otherwise it is the first test script the
 * package declares — `test`, then `test:unit` — that starts no service, where
 * this build installs with the package manager and its manifest is there to
 * install. A script that starts a service is passed over, as the proposed
 * checks pass it over. Null where there is none a worktree can run, and the
 * verification is then `GREENFIELD_VERIFY`.
 *
 * The finding is what the package's scripts made of it: that it declares no
 * test script, that each one it declares starts a service, or that it depends
 * on services the script it runs may need. Where no manager this build
 * installs with is named, or its manifest is missing, no script was read, and
 * the manager's own finding says so.
 */
function verification(
  checkout: string,
  detected: DetectedManager | null,
  given: string[] | undefined,
): { command: string[] | null; finding: DiagnosticFinding | null } {
  if (given !== undefined) {
    return { command: given, finding: verificationServiceNeed(checkout, given, { given: true }) };
  }
  if (!detected?.supported || !detected.manifest_present) return { command: null, finding: null };
  let passedOver: DiagnosticFinding | null = null;
  for (const candidate of declaredTestScripts(checkout, detected.manager)) {
    const service = verificationServiceNeed(checkout, candidate);
    if (service?.reason !== "verification_requires_service") {
      return { command: candidate, finding: service };
    }
    passedOver ??= service;
  }
  return {
    command: null,
    finding: passedOver ?? {
      reason: "no_verification_command",
      severity: "advisory",
      detail:
        "the repository declares no test script, so there is no command whose success defines " +
        `'the worktree can run this repository'. ${UNVERIFIED} Declare a \`test\` script to have ` +
        "it run; `doctor --write-config` pins this manifest, and a later `doctor` says so once " +
        "the repository declares one.",
      path: existsSync(join(checkout, "package.json")) ? "package.json" : null,
    },
  };
}

/**
 * The verification this checkout declares that a worktree can run, as the
 * diagnostic derives it where it is given none; null where it would verify with
 * `GREENFIELD_VERIFY`. The read-back of a pinned manifest compares against it.
 */
export function declaredVerifyCommand(
  checkout: string,
  detected: DetectedManager | null = detectPackageManager(checkout),
): string[] | null {
  return verification(checkout, detected, undefined).command;
}

/**
 * The install a checkout's own lockfile or manifest implies, and the only place
 * it is derived. The run's report and the manifest the diagnostic proposes read
 * it from here, so what a person is told and what materialization runs cannot
 * disagree.
 */
export function proposedInstall(
  checkout: string,
  detected: DetectedManager | null = detectPackageManager(checkout),
): InstallStrategy {
  // A manager this build detects but does not install with installs nothing,
  // as one it does not detect does, and so does one with no manifest beside
  // its lockfile for the install to read.
  const installs = detected?.supported && detected.manifest_present ? detected : null;
  const pinned = installs?.pinned ?? true;
  return {
    kind: installs ? "shared_store" : "none",
    package_manager: installs?.manager ?? "none",
    // Read off the command rather than from the pinning: this field describes
    // what the install below does, and a strategy that claimed the offline
    // store for a command that never asks for it would be describing a
    // different install.
    offline_preferred: (installs?.install ?? []).includes("--prefer-offline"),
    lifecycle_scripts: { policy: "disabled", exception: null },
    command: installs?.install ?? ["true"],
    // An install that installs nothing resolves nothing, so nothing about it
    // can drift.
    pinned,
  };
}

/**
 * The install as a step somebody could run: the command, and the directory it
 * runs in.
 *
 * The directory is the second half of the answer and was previously implicit.
 * For a checkout that is its own workspace it is the checkout, which is what
 * every caller assumed; for one package of a monorepo it is the workspace root,
 * because that is where the lockfile is. `pnpm install --filter web` run inside
 * `packages/web` installs the whole workspace anyway on a good day and fails
 * on a bad one — the flag narrows the graph, the directory decides which
 * lockfile is being reproduced, and only both together say what runs.
 */
export interface InstallStep {
  /** Where the command runs: the workspace root, or the checkout that is its own. */
  cwd: string;
  command: string[];
  /** Whether a lockfile pins what it resolves, as on the strategy. */
  pinned: boolean;
}

export function proposedInstallStep(
  checkout: string,
  membership: WorkspaceMembership = workspaceMembership(checkout),
  detected: DetectedManager | null = detectPackageManager(checkout, membership),
): InstallStep {
  const strategy = proposedInstall(checkout, detected);
  return {
    cwd: membership.workspace_root,
    command: strategy.command,
    pinned: strategy.pinned,
  };
}

/**
 * Whether an install command narrows this manager's install to one named
 * member of a workspace.
 *
 * Asked of the command rather than of the checkout, because it is the command
 * that carries the requirement: `--filter @scope/api` says "install this member
 * of the workspace I am being run in", and a directory that is not a workspace
 * root cannot answer it — the manager fails, or resolves the name against
 * nothing. So whatever runs such a command has to be able to see that it is one,
 * whether the derivation above proposed it or a person wrote it down.
 *
 * False for a manager with no per-member form, false for a checkout that
 * declares no member name, and false for the whole-workspace install of a
 * member — none of those need a workspace root to mean what they say.
 */
export function narrowsToMember(
  command: readonly string[],
  manager: PackageManager,
  packageName: string | null,
): boolean {
  const profile = MANAGERS.find((candidate) => candidate.manager === manager);
  if (packageName === null || profile === undefined || profile.filter === null) return false;
  const tokens = profile.filter(packageName);
  return command.some((_, index) =>
    tokens.every((token, offset) => command[index + offset] === token),
  );
}

/** What writes the lockfile a manager's install would otherwise resolve without. */
export function pinInstallCommand(manager: PackageManager): string[] | null {
  return MANAGERS.find((profile) => profile.manager === manager)?.pin ?? null;
}

/**
 * What an install needs in its environment beyond the command it declares.
 *
 * Empty for a pinned install, which reproduces a lockfile rather than writing
 * one, and empty for every manager whose unpinned form says it on the command
 * line. It is pnpm's answer, and it is here rather than in the argv because the
 * argv is what a configuration carries and what a person runs by hand; the
 * rule it enforces — the runner's install leaves no lockfile in the worktree
 * for the seal to commit as the executor's work — is the runner's.
 */
export function unpinnedInstallEnv(install: InstallStrategy): Record<string, string> {
  if (install.pinned) return {};
  return MANAGERS.find((profile) => profile.manager === install.package_manager)?.unpinned_env ?? {};
}

/** The test scripts a package declares, `test` then `test:unit`, read from `package.json`, never invented. */
function declaredTestScripts(checkout: string, manager: PackageManager): string[][] {
  const packageJson = join(checkout, "package.json");
  if (!existsSync(packageJson)) return [];
  let scripts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    return [];
  }
  return ["test", "test:unit"]
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => [manager, "run", name]);
}

/**
 * Files Git is ignoring that are nonetheless present. This is exactly the set
 * ADR-0025 is about: present in the user's checkout, absent from a fresh
 * worktree, and invisible to anything that only reads the repository.
 */
export class IgnoredPathsUnavailableError extends Error {
  constructor(checkout: string, detail: string) {
    super(
      `could not list the ignored files in ${checkout}: ${detail}. Without them there is nothing ` +
        "to materialize, and a manifest with no entries is not the same answer as a repository " +
        "that needs none",
    );
    this.name = "IgnoredPathsUnavailableError";
  }
}

export async function ignoredPaths(checkout: string, timeoutMs = 60_000): Promise<string[]> {
  const result = await git.run(
    checkout,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    { timeoutMs },
  );
  // A listing git did not finish saying is refused, never read as the whole
  // of it: an empty or a cut list is indistinguishable from "this repository
  // needs nothing more materialized", and the `.env` it left out resurfaces
  // mid-attempt as a test failure the agent is blamed for. That is the outcome
  // this file exists to prevent.
  if (result.code !== 0 || result.timed_out || result.truncated) {
    throw new IgnoredPathsUnavailableError(
      checkout,
      result.timed_out
        ? `it did not finish within ${timeoutMs}ms`
        : result.truncated
          ? "the listing is longer than git's answer may be, and part of it was cut off"
          : (result.stderr.trim() || `git exited ${result.code}`),
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !NEVER_PROPOSE.some((pattern) => pattern.test(line)));
}

export function proposeEntries(paths: string[], checkout: string): MaterializationEntry[] {
  const entries: MaterializationEntry[] = [];
  for (const path of paths) {
    const candidate = CANDIDATE_PATTERNS.find((pattern) => pattern.test.test(path));
    if (!candidate) continue;
    const clean = path.replace(/\/$/, "");
    const absolute = join(checkout, clean);
    if (!existsSync(absolute)) continue;
    const kind = statSync(absolute).isDirectory() ? ("directory" as const) : ("file" as const);
    entries.push({
      path: clean,
      kind,
      source_path: clean,
      strategy: "copy",
      secret: isSecretPath(clean),
      required: true,
      reason: candidate.reason,
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export interface DiagnoseRequest {
  checkout: string;
  repository_id: string;
  /**
   * Where worktrees would be created. Given, the diagnostic checks what the
   * package manager will make of that location; omitted, it says nothing about
   * it — a location it was not told about is not one it can vouch for.
   */
  worktree_root?: string | undefined;
  /**
   * The verification to propose in place of the one the diagnostic would
   * derive. It runs as given, including where it starts a service, which the
   * findings then report.
   */
  verify_command?: string[] | undefined;
  verify_timeout_ms?: number | undefined;
  port_base?: number | undefined;
  port_span?: number | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Whether the verification command needs something materialization cannot give it.
 *
 * Materialization copies files. It cannot start a database, and the failure that
 * produces is the dangerous kind: the suite runs, the tests that need the
 * service error or skip, and the attempt reports **green with its verification
 * unrun**. So it is said here, before an attempt rather than inside one
 * (ADR-0025).
 *
 * Two findings, because the two signals are not equally strong. A verify
 * command that itself runs `docker compose up` cannot work, so it is not run
 * and the verification is `GREENFIELD_VERIFY`. A repository that merely
 * *declares* services — a compose file, a testcontainers dependency — usually
 * runs its unit suite without them, so its command still runs and the finding
 * says what that may leave unrun. Neither refuses the repository (D-013).
 */
const SERVICE_STARTERS = [
  /\bdocker[- ]compose\b/,
  /\bdocker\s+(?:compose|run|start)\b/,
  /\bpodman[- ]compose\b/,
  /\bpg_ctl\b/,
  /\bsupabase\s+start\b/,
  /\bminikube\s+start\b/,
  /\bservice\s+\w+\s+start\b/,
];

/** Declared, but not necessarily needed by the verification command. */
const SERVICE_DECLARATIONS = ["testcontainers", "@testcontainers/postgresql", "dockerode"];

export function verificationServiceNeed(
  checkout: string,
  verify: readonly string[] | null,
  options: {
    /**
     * The command is one the diagnostic was given, which runs as given, rather
     * than one it read from the scripts and would pass over.
     */
    given?: boolean;
  } = {},
): DiagnosticFinding | null {
  let pkg: { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const scripts = pkg.scripts ?? {};

  // The script the verify command names, and the `pre` hook the package manager
  // runs before it — which is where a service is usually started, precisely so
  // the test script stays clean.
  const scriptName = verify && verify.length >= 3 && verify[1] === "run" ? (verify[2] ?? null) : null;
  for (const name of scriptName === null ? [] : [`pre${scriptName}`, scriptName]) {
    const body = scripts[name];
    if (typeof body !== "string" || !SERVICE_STARTERS.some((pattern) => pattern.test(body))) {
      continue;
    }
    return {
      reason: "verification_requires_service",
      severity: "advisory",
      detail:
        `\`${name}\` runs \`${body}\`, which starts a service. Materialization copies files ` +
        "into a worktree and cannot start one, so this suite would report green with the tests " +
        "that need the service not run" +
        (options.given
          ? ". It is the verification this diagnostic was given, so it runs as given."
          : `, and it is not run. ${UNVERIFIED} To have the suite run, give it a test script ` +
            "that does not start a service, against one that is already running."),
      path: "package.json",
    };
  }

  const declared = [...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.dependencies ?? {})]
    .filter((name) => SERVICE_DECLARATIONS.includes(name));
  if (declared.length > 0) {
    return {
      reason: "undeclared_service_dependency",
      severity: "advisory",
      detail:
        `the repository depends on ${declared.join(", ")}, which starts containers. The ` +
        "verification command does not name one, so it may not need any — but a test that does " +
        "will error or skip, and the attempt will report green with that test unrun.",
      path: "package.json",
    };
  }
  return null;
}

/** Long enough for a signer that is going to answer; short enough to fail a run's diagnostic. */
const SIGNING_PROBE_TIMEOUT_MS = 20_000;
/** A probe reads the repository's own configuration, which is on this disk. */
const PROBE_READ_TIMEOUT_MS = 10_000;
/** Lines of the signer's stderr the finding quotes. */
const SIGNER_LINES = 8;

/**
 * One command of the probe. A process that could not be started at all is no
 * answer rather than an error: git missing from PATH is a machine the whole
 * diagnostic has other things to say about.
 */
async function probeRun(
  args: string[],
  checkout: string,
  timeoutMs: number,
  overlay?: Readonly<Record<string, string>>,
): Promise<RunResult | null> {
  try {
    return await git.run(checkout, args, overlay === undefined ? { timeoutMs } : { timeoutMs, overlay });
  } catch {
    return null;
  }
}

/** A configured value, or null where git resolves none. */
async function gitConfig(checkout: string, key: string, type?: "bool"): Promise<string | null> {
  try {
    return await git.config(checkout, key, type, { timeoutMs: PROBE_READ_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/**
 * Every object store the checkout reads from: its own, and any it borrows.
 *
 * The probe writes into a directory of its own, which makes that directory the
 * primary store and leaves the checkout's as an alternate — so a repository
 * cloned `--shared` has to keep the alternates it already had, or the probe
 * cannot read the tree it is about to sign.
 */
function objectSources(objectsDir: string): string[] {
  const sources = [objectsDir];
  const alternates = join(objectsDir, "info", "alternates");
  if (!existsSync(alternates)) return sources;
  try {
    for (const line of readFileSync(alternates, "utf8").split("\n")) {
      const path = line.trim();
      if (path.length > 0 && !path.startsWith("#")) sources.push(resolve(objectsDir, path));
    }
  } catch {
    // Unreadable: the checkout's own store is what the probe gets.
  }
  return sources;
}

/** The tree the probe signs over: the checkout's own, or the empty one. */
async function treeToSign(checkout: string): Promise<string | null> {
  for (const argv of [
    ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"],
    ["hash-object", "-t", "tree", "/dev/null"],
  ]) {
    const result = await probeRun(argv, checkout, PROBE_READ_TIMEOUT_MS);
    const oid = result?.stdout.trim() ?? "";
    if (result?.code === 0 && oid.length > 0) return oid;
  }
  return null;
}

/** The signer's own last words, indented, or a sentence where it said nothing. */
function quoteSigner(stderr: string, timedOut: boolean, timeoutMs: number): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return timedOut
      ? `  (it did not answer within ${Math.round(timeoutMs / 1000)}s, which is what a key ` +
          "waiting on a passphrase prompt looks like from here)"
      : "  (it said nothing)";
  }
  return lines
    .slice(-SIGNER_LINES)
    .map((line) => `  ${line}`)
    .join("\n");
}

/**
 * Whether the key this checkout signs commits with can actually sign one.
 *
 * Where the resolved configuration does not sign, this says nothing. Where it
 * does, it signs the way git will — `git commit-tree -S` over the checkout's
 * own tree, so `gpg.format` and `user.signingkey` are read and the signing
 * program is invoked exactly as a commit would invoke it — and reports what the
 * signer said when it could not.
 *
 * **Nothing is asked of a person while it runs.** The child has no controlling
 * terminal and no stdin, and `SSH_ASKPASS` points at a program that fails, so
 * `ssh-keygen` cannot open a prompt to wait on; a signer that finds some other
 * way to wait is cut off by the timeout and reported as not having answered.
 *
 * **Nothing of it survives.** The one object a successful signature produces is
 * written into a temporary directory that is the probe's own object store — the
 * checkout's store is an alternate, read but not written — and that directory
 * is removed. The checkout's objects, refs, index and working tree are as they
 * were.
 *
 * Where the probe cannot be run at all — not a git checkout, no tree to sign —
 * it reports nothing rather than guessing: a repository refused for a signature
 * that was never attempted would be a lie about the repository.
 */
export async function signableCommit(
  checkout: string,
  timeoutMs = SIGNING_PROBE_TIMEOUT_MS,
): Promise<DiagnosticFinding | null> {
  if ((await gitConfig(checkout, "commit.gpgsign", "bool")) !== "true") return null;
  const format = (await gitConfig(checkout, "gpg.format")) ?? "openpgp";
  const key = await gitConfig(checkout, "user.signingkey");

  const objects = await probeRun(["rev-parse", "--git-path", "objects"], checkout, PROBE_READ_TIMEOUT_MS);
  if (objects === null || objects.code !== 0) return null;
  const tree = await treeToSign(checkout);
  if (tree === null) return null;

  const scratch = mkdtempSync(join(tmpdir(), "perbo-signing-probe-"));
  try {
    const askpass = join(scratch, "askpass");
    writeFileSync(askpass, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const written = join(scratch, "objects");
    mkdirSync(written, { recursive: true });
    const overlay: Record<string, string> = {
      GIT_OBJECT_DIRECTORY: written,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectSources(
        resolve(checkout, objects.stdout.trim()),
      ).join(":"),
      // The identity is the probe's own, so a checkout that has not set one
      // fails here for that rather than being reported as unable to sign.
      GIT_AUTHOR_NAME: "perbo",
      GIT_AUTHOR_EMAIL: "perbo@localhost",
      GIT_COMMITTER_NAME: "perbo",
      GIT_COMMITTER_EMAIL: "perbo@localhost",
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
    };

    const attempt = await probeRun(
      ["commit-tree", "-S", "-m", "signing probe", tree],
      checkout,
      timeoutMs,
      overlay,
    );
    if (attempt === null || attempt.code === 0) return null;

    // The same commit without a signature. Where that fails too, what failed
    // was the probe rather than the key — an object store shaped in a way this
    // could not redirect — and a repository is not refused for that.
    const unsigned = await probeRun(
      ["commit-tree", "-m", "signing probe", tree],
      checkout,
      timeoutMs,
      overlay,
    );
    if (unsigned === null || unsigned.code !== 0) return null;

    const load =
      format === "ssh"
        ? `load the key into an agent (\`ssh-add ${
            key === null || key.startsWith("ssh-") ? "<the private key>" : key.replace(/\.pub$/, "")
          }\`)`
        : "unlock the signing key so its agent holds it";
    return {
      reason: "commit_signing_unavailable",
      severity: "refusal",
      detail:
        `this repository signs its commits (commit.gpgsign is true, gpg.format is ${format}` +
        `${key === null ? ", with no user.signingkey" : `, user.signingkey is ${key}`}), and the ` +
        "key could not sign without asking for a passphrase. The commit that seals a change set " +
        "would fail the same way, after the agent had run and been paid for. The signer said:\n" +
        `${quoteSigner(attempt.stderr, attempt.timed_out, timeoutMs)}\n` +
        `Either ${load}, or stop this checkout signing with ` +
        `\`git -C ${checkout} config commit.gpgsign false\`.`,
      path: null,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function diagnose(request: DiagnoseRequest): Promise<DiagnosticResult> {
  const checkout = resolve(request.checkout);
  const findings: DiagnosticFinding[] = [];

  if (request.worktree_root !== undefined) {
    const root = resolve(request.worktree_root);
    const enclosing = enclosingWorkspaceRoot(root);
    if (enclosing !== null) {
      findings.push({
        reason: "nested_package_manager_workspace",
        severity: "advisory",
        detail:
          `the worktree root ${root} sits inside the package manager workspace declared at ` +
          `${enclosing}: pnpm resolves its workspace root by walking up, so every install and ` +
          "every `pnpm exec` in a worktree under this root fails, naming neither directory. " +
          "Put the worktree root somewhere with no package manager workspace above it.",
        path: enclosing,
      });
    }
  }

  if (!existsSync(checkout)) {
    findings.push({
      reason: "source_checkout_missing",
      severity: "refusal",
      detail: `${checkout} does not exist, so there is nothing to propose a manifest from`,
      path: checkout,
    });
    return { materializable: false, findings, proposed: null };
  }

  // Read once and passed down, so the manager, the install and the directory it
  // runs in are all answered about the same pair of roots.
  const membership = workspaceMembership(checkout);
  const inWorkspace = membership.workspace_root !== membership.package_root;
  const detected = detectPackageManager(checkout, membership);
  if (!detected) {
    findings.push({
      reason: "package_manager_undetected",
      // Advisory, by decision (D-013): a repository whose package manager this
      // build cannot read is accepted with nothing installed.
      severity: "advisory",
      detail:
        `nothing ${inWorkspace ? `in the workspace at ${membership.workspace_root}` : "here"} ` +
        "names a package manager this build reads (looked for " +
        `${MANAGERS.map((m) => m.lockfile).join(", ")}, and for ` +
        `${MANIFESTS.map((m) => m.file).join(" and ")}), so nothing is installed and no ` +
        "scripts are read" +
        (request.verify_command === undefined
          ? `. ${UNVERIFIED} ` +
            "`doctor --write-config` pins that manifest, and a later `doctor` says so once the " +
            "repository names a package manager this build reads."
          : "."),
      path: null,
    });
  } else if (!detected.supported) {
    findings.push({
      reason: "unsupported_package_manager",
      // Advisory, by the same decision: a manager this build detects but does
      // not install with is answered as one it does not detect.
      severity: "advisory",
      detail:
        // A lockfile names its manager. A manifest standing in for one names
        // nothing: a `pyproject.toml` is read as uv whatever built it.
        (detected.pinned
          ? `${detected.named_by} names ${detected.manager}, which this build does not install with`
          : `this build reads ${detected.named_by} as ${detected.manager}, which it does not install with`) +
        ", so nothing is installed and no scripts are read" +
        (request.verify_command === undefined
          ? `. ${UNVERIFIED} \`doctor --write-config\` pins that manifest.`
          : "."),
      path: detected.named_by,
    });
  } else if (!detected.manifest_present) {
    findings.push({
      reason: "package_manifest_missing",
      // Advisory, by the same decision: an install with nothing to install is
      // not run, and the repository is answered as one that names no manager.
      severity: "advisory",
      detail:
        `${detected.named_by} names ${detected.manager}, but there is no ` +
        `${detected.manifests.join(" or ")} beside it to install, so nothing is installed and ` +
        "no scripts are read" +
        (request.verify_command === undefined ? `. ${UNVERIFIED}` : "."),
      path: detected.named_by,
    });
  } else if (!detected.pinned) {
    findings.push({
      reason: "lockfile_missing",
      severity: "advisory",
      detail:
        `${detected.named_by} names ${detected.manager} but there is no ${detected.lockfile} to ` +
        `pin what it installs, so \`${detected.install.join(" ")}\` resolves its own versions and ` +
        `two runs of it can differ (looked for ${MANAGERS.map((m) => m.lockfile).join(", ")}). ` +
        `Pin it with \`${detected.pin_with.join(" ")}\` and commit ${detected.lockfile}; the ` +
        `install then becomes \`${detected.pinned_install.join(" ")}\`.`,
      path: detected.named_by,
    });
  }

  const verified = verification(checkout, detected, request.verify_command);
  if (verified.finding) findings.push(verified.finding);
  const verify = verified.command ?? [...GREENFIELD_VERIFY];

  const signing = await signableCommit(checkout);
  if (signing) findings.push(signing);

  let entries: MaterializationEntry[] = [];
  try {
    entries = proposeEntries(await ignoredPaths(checkout, request.timeoutMs ?? 60_000), checkout);
  } catch (error) {
    if (!(error instanceof IgnoredPathsUnavailableError)) throw error;
    findings.push({
      reason: "ignored_paths_unavailable",
      severity: "refusal",
      detail: error.message,
      path: null,
    });
  }

  const install: InstallStrategy = proposedInstall(checkout, detected);

  const span = request.port_span ?? DEFAULT_PORT_SPAN;
  const base = request.port_base ?? DEFAULT_PORT_BASE;
  const proposed: MaterializationManifest = MaterializationManifestSchema.parse({
    manifest_version: MATERIALIZATION_MANIFEST_VERSION,
    repository_id: request.repository_id,
    source_checkout: checkout,
    entries,
    install,
    verify: { command: verify, timeout_ms: request.verify_timeout_ms ?? 900_000 },
    isolation: {
      mode: "parallel",
      port_range_size: span,
      port_range_start: base,
      port_range_end: base + span - 1,
      database_schema_prefix: null,
    },
  } satisfies MaterializationManifest);

  return {
    // Advisories do not disqualify: a badly placed worktree root is the
    // operator's setting, fixable by moving one path, and refusing the
    // repository for it would be a lie about the repository.
    materializable: !findings.some(isRefusal),
    findings,
    proposed,
  };
}

/**
 * Validate a manifest against the checkout it names, before an attempt starts.
 * A required entry that is not there is the failure ADR-0025 exists to move
 * earlier: without this it surfaces as a test failure the agent gets blamed for.
 */
export function validateManifest(manifest: MaterializationManifest): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  if (!existsSync(manifest.source_checkout)) {
    findings.push({
      reason: "source_checkout_missing",
      severity: "refusal",
      detail: `${manifest.source_checkout} does not exist`,
      path: manifest.source_checkout,
    });
    return findings;
  }
  for (const entry of manifest.entries) {
    if (!entry.required) continue;
    const source = entry.source_path.startsWith("/")
      ? entry.source_path
      : join(manifest.source_checkout, entry.source_path);
    if (!existsSync(source)) {
      findings.push({
        reason: "required_entry_missing",
      severity: "refusal",
        detail: `${entry.path} is required (${entry.reason}) but ${source} does not exist`,
        path: entry.path,
      });
    }
  }
  return findings;
}
