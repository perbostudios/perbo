import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { GH_NOT_LOGGED_IN } from "@perbo/contracts";
import type { ModelProvider } from "@perbo/model";
import { createGh, createGit } from "@perbo/workspace";
import {
  readGithubCredential,
  type GithubCredentialReading,
} from "./github-credential.js";

/**
 * What must be on this machine before `perbo run` can do anything, checked
 * before a worktree is provisioned rather than discovered as an ENOENT stack
 * trace with the ticket left in `provisioning`.
 *
 * Every check is a fixed argv against a fixed binary. Nothing here takes a
 * value from a model or from repository content. `git` and `gh` are asked
 * through `@perbo/workspace`'s repository module, which starts every one of
 * their processes; the other binaries are asked here.
 */

export interface PreflightFinding {
  severity: "blocking" | "warning";
  reason:
    | "node_too_old"
    | "git_missing"
    | "install_binary_missing"
    | "agent_binary_missing"
    | "gh_missing"
    | "gh_not_authenticated"
    | "reviewer_credential_missing"
    | "reviewer_binary_missing"
    | "codex_too_old";
  detail: string;
  /** The one command or action that clears it. */
  fix: string;
}

export interface PreflightTool {
  present: boolean;
  version: string | null;
}

export interface PreflightResult {
  ok: boolean;
  findings: PreflightFinding[];
  tools: Record<string, PreflightTool>;
  /**
   * SCP-200: which credential path GitHub is read through here, and whether it
   * answers. Null where nothing asked — `gh` is not installed, or this run
   * neither publishes nor wanted the round trip.
   */
  github: GithubCredentialReading | null;
}

export interface PreflightRequest {
  /**
   * The coding agent binary the adapter will spawn — a free path a
   * repository configures, not necessarily named `claude` or `codex`.
   * `null` when no agent runs — `perbo review` on its own — so only the
   * reviewer's transport is checked.
   */
  agentBinary: string | null;
  /**
   * Which agent transport `agentBinary` is, when the caller already knows —
   * from the same repository configuration's `agent_provider`, never
   * guessed from `agentBinary`'s own spelling. `null` where the caller has
   * an `agentBinary` but does not know which transport it is, or has none.
   */
  agentProvider: "claude-cli" | "codex-cli" | null;
  /** Which reviewer transport the run will use. */
  reviewerProvider: ModelProvider;
  /** Whether the run will push and open a pull request through `gh`. */
  needsGh: boolean;
  /**
   * The binary the materialisation manifest installs a worktree with — `pnpm`
   * where a repository pins one. Null where the caller has none to name; a run
   * that provisions no worktree installs nothing.
   */
  installBinary?: string | null;
  /** Whether a worktree will be provisioned. Defaults to true; `review` alone needs no git. */
  needsGit?: boolean;
  /**
   * Ask `gh auth status` even where this run will not publish. `doctor` sets
   * it, because saying whether GitHub answers is what a diagnostic is for; a
   * run that only needs the binary present does not pay for the round trip.
   */
  probeGithub?: boolean;
  env?: NodeJS.ProcessEnv;
  minNodeMajor?: number;
}

function version(
  binary: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[] = ["--version"],
): PreflightTool {
  try {
    const out = execFileSync(binary, [...args], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();
    return { present: true, version: out.split("\n")[0] ?? "" };
  } catch {
    return { present: false, version: null };
  }
}

/** The repository module's answer, as a tool this check reports. */
const asTool = (line: string | null): PreflightTool =>
  line === null ? { present: false, version: null } : { present: true, version: line };

/** How long a `--version` may take before the binary counts as missing. */
const VERSION_TIMEOUT_MS = 30_000;

/** D-106: the earliest Codex build the runner's subagent role files and per-thread guard are held to. */
const CODEX_MIN_VERSION = "0.145.0";

/**
 * `major.minor.patch` with an optional `-prerelease`, as semver spells it;
 * null where the text is not one, which is refused rather than guessed at.
 */
function parseSemver(value: string): { parts: [number, number, number]; prerelease: boolean } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/**
 * Whether `found` is at or above the floor, as semver orders versions: a
 * prerelease of the floor itself (`0.145.0-rc.1`) is below it, a prerelease
 * of a later version is above it.
 */
function atLeast(found: ReturnType<typeof parseSemver>, floor: [number, number, number]): boolean {
  if (found === null) return false;
  const pairs: Array<[number, number]> = [
    [found.parts[0], floor[0]],
    [found.parts[1], floor[1]],
    [found.parts[2], floor[2]],
  ];
  for (const [have, need] of pairs) {
    if (have !== need) return have > need;
  }
  return !found.prerelease;
}

/**
 * `identity` resolved to a real filesystem path, so the same Codex binary
 * named two ways — an absolute path one caller configures and a bare name
 * PATH resolves for another — dedupes to the same key. A bare name (no
 * `/`) is looked up across `env.PATH` the way `execFileSync` itself would
 * find it, since `realpathSync` alone only resolves a path already written
 * as one; `identity` itself, unresolved, where nothing here can resolve it,
 * so an unresolvable name still dedupes a second, identical mention.
 */
function resolvedBinaryIdentity(identity: string, env: NodeJS.ProcessEnv): string {
  const candidates = identity.includes("/")
    ? [identity]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter((dir) => dir.length > 0)
        .map((dir) => join(dir, identity));
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return identity;
}

/**
 * D-106: a Codex binary below {@link CODEX_MIN_VERSION} cannot hold the
 * subagent role files and per-thread guard state this runner asks it to.
 * Called only where the caller already knows `tool` is meant to be Codex —
 * the agent binary once its `agentProvider` is `codex-cli`, and the reviewer
 * transport once it is `codex-cli` — so a version line that does not start
 * with `codex-cli `, including no output at all, is refused the same way a
 * parsed lower version is, naming what it printed, rather than passed as
 * fine for not looking like Codex's own. `agentBinary` is a free path a
 * repository configures, never a spelling to guess the transport from —
 * `preflight()` falls back to reading the line's own prefix only where the
 * transport is not given at all.
 *
 * `identity` is the binary string the caller checked it under —
 * `agentBinary`, or the reviewer's `PERBO_CODEX_BINARY`/`codex` — resolved
 * through {@link resolvedBinaryIdentity} before `checked` sees it, so the
 * same binary configured two ways still dedupes to one entry. `checked` is
 * shared across both call sites in one `preflight()` run: the agent and the
 * reviewer are often the same binary, and a person reading `doctor`'s
 * output should see that binary's version problem once, not twice for the
 * same run.
 */
function checkCodexVersion(
  identity: string,
  tool: PreflightTool,
  findings: PreflightFinding[],
  checked: Set<string>,
  env: NodeJS.ProcessEnv,
): void {
  const resolved = resolvedBinaryIdentity(identity, env);
  if (checked.has(resolved)) return;
  checked.add(resolved);
  if (!tool.present) return;
  if (tool.version === null || !tool.version.startsWith("codex-cli ")) {
    findings.push({
      severity: "blocking",
      reason: "codex_too_old",
      detail: `codex's version could not be read from ${JSON.stringify(tool.version ?? "")}; ${CODEX_MIN_VERSION} or later is needed`,
      fix: `install Codex ${CODEX_MIN_VERSION} or later`,
    });
    return;
  }
  const found = tool.version.slice("codex-cli ".length).trim();
  const floor = parseSemver(CODEX_MIN_VERSION)!.parts;
  const parsed = parseSemver(found);
  if (!atLeast(parsed, floor)) {
    findings.push({
      severity: "blocking",
      reason: "codex_too_old",
      // A line with no version to order against the floor was never below
      // it; that verb belongs to a version this actually parsed and placed.
      detail:
        parsed === null
          ? `codex ${found} could not be read as a version; ${CODEX_MIN_VERSION} or later is needed`
          : `codex ${found} is below the ${CODEX_MIN_VERSION} subagents need`,
      fix: `install Codex ${CODEX_MIN_VERSION} or later`,
    });
  }
}

export function preflight(request: PreflightRequest): PreflightResult {
  const env = request.env ?? process.env;
  const findings: PreflightFinding[] = [];
  const tools: Record<string, PreflightTool> = {};
  /** Every binary identity {@link checkCodexVersion} has already reported on, once. */
  const codexVersionChecked = new Set<string>();

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const minNode = request.minNodeMajor ?? 22;
  tools.node = { present: true, version: process.versions.node };
  if (nodeMajor < minNode) {
    findings.push({
      severity: "blocking",
      reason: "node_too_old",
      detail: `node ${process.versions.node} is below the ${minNode} this runner needs`,
      fix: `install Node ${minNode} or later and re-run`,
    });
  }

  if (request.needsGit ?? true) {
    tools.git = asTool(createGit({ environment: () => env }).versionSync({ timeoutMs: VERSION_TIMEOUT_MS }));
    if (!tools.git.present) {
      findings.push({
        severity: "blocking",
        reason: "git_missing",
        detail: "`git` is not on PATH",
        fix: "install git (https://git-scm.com) and re-run",
      });
    }
  }

  // The install is the first command a run gives a worktree, and it is spawned
  // argv-only with no shell like every other command a run starts. Probing it
  // the same way is the whole point: on Windows a package manager installed as
  // a `.cmd` shim answers when a person types it and cannot be spawned without
  // a shell, so it is present to them and absent to the runner. Found here it
  // costs a sentence; found at materialisation it costs a provisioned worktree
  // and a ticket left in `provisioning`.
  const installBinary = request.installBinary ?? null;
  if (installBinary !== null && (request.needsGit ?? true)) {
    const tool = tools[installBinary] ?? version(installBinary, env);
    tools[installBinary] = tool;
    if (!tool.present) {
      findings.push({
        severity: "blocking",
        reason: "install_binary_missing",
        detail:
          `the materialisation manifest installs with \`${installBinary}\`, ` +
          "which cannot be run",
        fix:
          installBinary === "pnpm" && process.platform === "win32"
            ? "install pnpm as an executable (npm install -g @pnpm/exe); a `.cmd` shim answers in a shell but cannot be spawned without one"
            : `install \`${installBinary}\` and make sure it is on PATH`,
      });
    }
  }

  if (request.agentBinary !== null) {
    tools[request.agentBinary] = version(request.agentBinary, env);
    if (!tools[request.agentBinary]!.present) {
      findings.push({
        severity: "blocking",
        reason: "agent_binary_missing",
        detail: `the coding agent \`${request.agentBinary}\` is not on PATH`,
        fix:
          request.agentBinary === "claude"
            ? "install Claude Code (npm install -g @anthropic-ai/claude-code) and sign in with `claude`"
            : `install \`${request.agentBinary}\` and make sure it is on PATH`,
      });
    }
    // Keyed on the provider, not the binary's spelling: `agentBinary` is a
    // free path, so a Claude Code configured somewhere other than literally
    // `claude` is still Claude. Where the provider is not given at all, the
    // line's own prefix is the only signal there is, and a line that does
    // not even start with `codex-cli ` is not this runner's business to
    // refuse — it is not known to be Codex's.
    const looksLikeCodex = tools[request.agentBinary]!.version?.startsWith("codex-cli ") === true;
    if (request.agentProvider === "codex-cli" || (request.agentProvider === null && looksLikeCodex))
      checkCodexVersion(request.agentBinary, tools[request.agentBinary]!, findings, codexVersionChecked, env);
  }

  if (request.reviewerProvider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      findings.push({
        severity: "blocking",
        reason: "reviewer_credential_missing",
        detail: "the reviewer provider is `anthropic` and ANTHROPIC_API_KEY is not set",
        fix: "export ANTHROPIC_API_KEY=… or use --provider claude-cli to review on your Claude Code login",
      });
    }
  } else if (request.reviewerProvider === "claude-cli") {
    // Keyed on the binary, not the provider: the reviewer's `claude-cli`
    // transport spawns the bare `claude` command on its own, independently
    // of `agentBinary`, which a repository is free to configure as any
    // path. Only where the agent check above already looked up that exact
    // bare command — `agentBinary === "claude"` — does this reach the same
    // answer without asking again; a Claude agent configured anywhere else
    // still needs its own lookup of the command the reviewer actually runs.
    if (request.agentBinary !== "claude") {
      tools.claude = version("claude", env);
      if (!tools.claude.present) {
        findings.push({
          severity: "blocking",
          reason: "reviewer_binary_missing",
          detail: "the reviewer provider is `claude-cli` and `claude` is not on PATH",
          fix: "install Claude Code (npm install -g @anthropic-ai/claude-code) and sign in with `claude`",
        });
      }
    }
  } else if (request.reviewerProvider === "codex-cli") {
    const codex = env.PERBO_CODEX_BINARY ?? "codex";
    tools.codex = version(codex, env);
    if (!tools.codex.present) {
      findings.push({
        severity: "blocking",
        reason: "reviewer_binary_missing",
        detail: `the reviewer provider is \`codex-cli\` and \`${codex}\` cannot be run`,
        fix: "set PERBO_CODEX_BINARY to the Codex executable, or use --provider claude-cli",
      });
    }
    checkCodexVersion(codex, tools.codex, findings, codexVersionChecked, env);
  }

  // `gh` is checked whether or not this run publishes: `sync`, `stops` and
  // the next `--publish` all need it, and a partner's first hour should hear
  // about it once, as a warning, rather than at the first pull request.
  tools.gh = asTool(createGh({ environment: () => env }).versionSync({ timeoutMs: VERSION_TIMEOUT_MS }));
  const ghSeverity = request.needsGh ? "blocking" : "warning";
  let github: GithubCredentialReading | null = null;
  if (!tools.gh.present) {
    findings.push({
      severity: ghSeverity,
      reason: "gh_missing",
      detail: request.needsGh
        ? "`gh` is not on PATH and --publish opens the pull request through it"
        : "`gh` is not on PATH; publishing, `sync` and `stops` need it",
      fix: "install the GitHub CLI (https://cli.github.com) and run `gh auth login`",
    });
  } else if (request.needsGh || request.probeGithub) {
    // SCP-200: which credential path GitHub is read through, decided here and
    // once. `gh auth status` is a network round-trip, so only a run that will
    // publish — or a caller that asked, which is `doctor` — pays for it; a run
    // that does neither is told about a missing binary only.
    //
    // A `GH_TOKEN` in the environment is the path whether or not GitHub
    // accepts it: this is where a missing credential is refused, not where a
    // rejected one is. Only the machine's shared `gh` login can be missing in
    // the sense that stops a run before it starts.
    github = readGithubCredential({ env });
    if (github.credential === "gh_login" && !github.answers) {
      findings.push({
        severity: ghSeverity,
        reason: "gh_not_authenticated",
        detail:
          `${GH_NOT_LOGGED_IN} and no GH_TOKEN is set` +
          (request.needsGh
            ? ", and --publish opens the pull request through one of them"
            : "; publishing, `sync` and `stops` need one of them"),
        fix: "run `gh auth login`, or export GH_TOKEN with a token scoped to this repository",
      });
    }
  }

  return {
    ok: findings.every((finding) => finding.severity !== "blocking"),
    findings,
    tools,
    github,
  };
}

export function renderPreflight(result: PreflightResult): string {
  const lines: string[] = [];
  for (const [name, tool] of Object.entries(result.tools)) {
    lines.push(`  ${tool.present ? "✓" : "✗"} ${name.padEnd(8)} ${tool.version ?? "not found"}`);
  }
  if (result.github) {
    // SCP-200: the path, and whether it answered. Never the token, not even a
    // prefix — this block is what a person pastes into an issue.
    const path = result.github.credential === "GH_TOKEN" ? "GH_TOKEN" : "gh login";
    const answer = result.github.answers
      ? "`gh auth status` answers"
      : result.github.credential === "GH_TOKEN"
        ? "`gh auth status` does not answer: GitHub refused the token"
        : GH_NOT_LOGGED_IN;
    lines.push(`  ${result.github.answers ? "✓" : "✗"} ${"github".padEnd(8)} ${path}, and ${answer}`);
  }
  for (const finding of result.findings) {
    lines.push("", `  ${finding.severity}  ${finding.reason}: ${finding.detail}`, `           fix: ${finding.fix}`);
  }
  return lines.join("\n");
}
