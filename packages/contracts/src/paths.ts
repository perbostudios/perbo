/**
 * Path classification, in one place because two things depend on it: scope
 * enforcement (deterministic, and required to be perfect) and risk derivation.
 * Two copies of "what counts as a migration" would drift.
 */

/** Minimal glob: `*` within a segment, `**` across segments, `?` one character. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more leading segments; a bare `**` matches the rest.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/**
 * Whether a repository-relative path is inside a set of globs. An empty set
 * admits everything, which is what the runner's guard is handed when no
 * contract named any (SCP-195).
 */
export function insideAllowedPaths(path: string, globs: readonly string[]): boolean {
  return globs.length === 0 || matchesAny(path, globs);
}

/**
 * The package a path belongs to. `packages/x/**` and `apps/x/**` are two
 * segments deep; anything else is its top-level directory.
 */
export function packageOf(path: string): string {
  const segments = path.split("/");
  const first = segments[0] ?? "";
  if ((first === "packages" || first === "apps" || first === "tooling") && segments.length > 1) {
    return `${first}/${segments[1]}`;
  }
  return first;
}

/** A schema or data migration. Non-expand/contract changes are the hazard class. */
export const MIGRATION_PATTERNS = [
  "**/migrations/**",
  "**/migration/**",
  "infra/migrations/**",
  "**/*.sql",
  "**/schema.prisma",
  "**/schema.rb",
] as const;

/** Dependency manifests and lockfiles. */
export const DEPENDENCY_PATTERNS = [
  "**/package.json",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pyproject.toml",
  "**/requirements*.txt",
  "**/uv.lock",
  "**/Cargo.toml",
  "**/Cargo.lock",
  "**/go.mod",
  "**/go.sum",
  "**/Gemfile",
  "**/Gemfile.lock",
] as const;

/** Configuration that changes how the system runs rather than what it computes. */
export const CONFIG_PATTERNS = [
  ".github/**",
  "infra/**",
  "**/Dockerfile",
  "**/docker-compose*.yml",
  "**/*.tf",
  "**/tsconfig*.json",
  "**/*.config.js",
  "**/*.config.mjs",
  "**/*.config.ts",
] as const;

/** Paths where a mistake is a security incident rather than a bug. */
export const SECURITY_PATTERNS = [
  "**/auth/**",
  "**/authn/**",
  "**/authz/**",
  "**/billing/**",
  "**/payment*/**",
  "**/session*/**",
  "**/crypto/**",
  "**/security/**",
  "**/*.pem",
  "**/*.key",
  "**/.env*",
  "**/secrets/**",
] as const;

/**
 * Repository-supplied agent configuration (ADR-0030). It is not a scope
 * question — it is an execution and egress channel that runs before any of the
 * product's controls apply, so a change to it is always at least P2 and is
 * called out by name rather than folded into "config".
 */
export const AGENT_CONFIG_PATTERNS = [
  "**/.claude/**",
  "**/.mcp.json",
  "**/.cursor/**",
  "**/.aider*",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/.agent/**",
  "**/.codex/**",
] as const;

/**
 * Machine-local secrets, Git metadata and repository-supplied agent
 * configuration: the paths no surface reads. Materialized local secrets are
 * excluded from every change set, run bundle, log, telemetry payload and model
 * context (D-012); Git metadata is machine-local; agent configuration is
 * withheld rather than interpreted (ADR-0030). That such a path exists is
 * reportable; its contents are not readable.
 *
 * Here rather than in the reviewer because two surfaces apply it: the
 * reviewer's bounded reader, and the desktop's explorer, which neither lists
 * nor previews one.
 */
export const NEVER_READ_PATHS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/id_rsa*",
  "**/secrets/**",
  "**/.npmrc",
  "**/.netrc",
  "**/.git",
  "**/.git/**",
  ...AGENT_CONFIG_PATTERNS,
] as const;

export const isNeverReadPath = (path: string) => matchesAny(path, NEVER_READ_PATHS);

/**
 * Where a repository keeps its specs, unless `.perbo/config.json` names
 * another folder under `specs` (D-103).
 */
export const DEFAULT_SPEC_FOLDER = "specs";

/**
 * Where a repository keeps its ADRs, unless `.perbo/config.json` names
 * another folder under `adr` (D-103).
 *
 * Read beside the spec folder, because the two travel together: the interview
 * writes the spec, `CONTEXT.md` and the ADRs, and the loop commits whatever of
 * the three approval recorded as one commit on the ticket's branch.
 */
export const DEFAULT_ADR_FOLDER = "docs/adr";

/**
 * Whether a configured spec folder is a plain repository-relative one:
 * `specs`, `docs/specs`. Not absolute, not a drive path, no backslash, no `.`
 * or `..` segment, no trailing slash. The CLI, the runner and the desktop
 * read the same key, and this is what they agree on.
 */
export function isRepositoryRelativeFolder(folder: string): boolean {
  if (folder.trim() !== folder || folder.length === 0) return false;
  if (folder.startsWith("/") || /^[A-Za-z]:/.test(folder) || folder.includes("\\")) return false;
  const segments = folder.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * The repository-relative path of a spec that is one piece of work's, or null
 * where it is not one (D-103).
 *
 * A spec lives at `<specs>/<slug>/spec.md`, so the folder holding it is its
 * own: that folder is what the interview may write, what admission records
 * whole, and what the loop commits on the branch. A `spec.md` at the root of
 * the repository, or under a folder the repository keeps other things in,
 * would make all three of those the whole repository or somebody else's work.
 *
 * Judged on where the path lands rather than on what was typed, because a
 * prefix test says nothing about that: `specs/x/../../elsewhere` keeps the
 * prefix and leaves the folder. The CLI reads it for `--from-spec` and for the
 * interview's `--spec`, which is why it is here.
 */
export function onePieceOfWork(spec: string, specs: string): string | null {
  const landed = resolveRepositoryPath(spec);
  if (landed === null) return null;
  const at = landed.lastIndexOf("/");
  if (at <= 0) return null;
  const folder = landed.slice(0, at);
  // A folder directly under the spec folder, and not one under another spec's:
  // the folder is taken whole, so a spec nested inside one would be recorded
  // and committed by both.
  const slug = folder.startsWith(`${specs}/`) ? folder.slice(specs.length + 1) : null;
  return slug !== null && slug.length > 0 && !slug.includes("/") ? landed : null;
}

/**
 * One repository-relative path with its `.` and `..` segments resolved, or
 * null where it is not one: absolute, a drive path, or a climb past the root.
 *
 * Written on the string rather than through `node:path`, because the renderer
 * loads this module in the browser and the answer is the same either way for a
 * path the repository states with `/`.
 *
 * A backslash spelling is not one: Git states a tracked path with `/`, so a
 * path holding `\` is not a path this repository names, and rewriting the
 * separator here would resolve `..\..\elsewhere` as if it had been written
 * the repository's way.
 */
export function resolveRepositoryPath(path: string): string | null {
  if (
    path.length === 0 ||
    path.trim() !== path ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\")
  ) {
    return null;
  }
  const landed: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment !== "..") {
      landed.push(segment);
      continue;
    }
    if (landed.length === 0) return null;
    landed.pop();
  }
  return landed.length === 0 ? null : landed.join("/");
}

/**
 * The paths an executor may never write, whatever a contract says (D-103).
 *
 * A spec is the intent the contract was drafted from, and it is a person's and
 * the interview's to write; an attempt that edited it would be rewriting the
 * statement it is judged against. It is prohibited rather than merely
 * unadmitted so the refusal reads as "this is not yours to touch" rather than
 * "widen the scope to reach it", which is the distinction D-105 draws.
 *
 * `folder` is the repository's configured spec folder; the default is added
 * beside it, so a repository that moved its specs still refuses writes to the
 * place they used to be and to the place a stale worktree might still have.
 */
export function standingProhibitedPaths(folder?: string | null): string[] {
  const folders = [DEFAULT_SPEC_FOLDER, ...(folder ? [folder] : [])];
  return [...new Set(folders)].map((each) => `${each}/**`);
}

export const isMigrationPath = (path: string) => matchesAny(path, MIGRATION_PATTERNS);
export const isDependencyPath = (path: string) => matchesAny(path, DEPENDENCY_PATTERNS);
export const isConfigPath = (path: string) => matchesAny(path, CONFIG_PATTERNS);
export const isSecurityPath = (path: string) => matchesAny(path, SECURITY_PATTERNS);
export const isAgentConfigPath = (path: string) => matchesAny(path, AGENT_CONFIG_PATTERNS);

/**
 * The globs a contract admits a **write** under, which is what the runner's
 * write guard enforces before a tool runs (SCP-195).
 *
 * Wider than `paths_allowed`, because `paths_allowed` is not the whole of what
 * the contract permits and a guard narrower than the contract would refuse work
 * the contract asked for:
 *
 * - **the declared packages, while the expansion budget is positive.** A diff
 *   touching a path outside `paths_allowed` but inside the same package, within
 *   `expansion_budget_files`, is an advisory finding rather than a gate
 *   (docs/04, "In-flight scope expansion") and the executor's brief invites it
 *   by name. Refusing those writes would make the budget unreachable. Beyond the
 *   budget it is the review that blocks, on a count only the change set has.
 * - **the generated paths**, which are exempt from scope accounting entirely.
 *
 * `**` anywhere admits everything, so a ticketless run — whose scope is exactly
 * `**` — is judged by the worktree root alone, as it was before this existed.
 *
 * `paths_prohibited` is not subtracted here. It is a rule of its own in the
 * guard, judged before these globs are, so a path that is both is refused as
 * prohibited rather than as unadmitted (D-105): the same rule applied at write
 * time saves a remediation round for every slip, and subagents write as well as
 * the executor. The reviewer's `scope.prohibited_path` finding stays behind it.
 */
export function admittedWriteGlobs(scope: {
  paths_allowed: readonly string[];
  generated_paths?: readonly string[];
  expansion_budget_files?: number;
}): string[] {
  const globs: string[] = [...scope.paths_allowed];
  if ((scope.expansion_budget_files ?? 0) > 0) {
    for (const pattern of scope.paths_allowed) globs.push(`${packageOf(pattern)}/**`);
  }
  globs.push(...(scope.generated_paths ?? []));
  return [...new Set(globs)];
}
