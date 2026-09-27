import {
  DEFAULT_ENV_ALLOW_LIST,
  OPENCODE_API_KEY_ENV,
  PROHIBITED_ACTIONS,
  PermissionProfileSchema,
  scrubEnvironment,
  type PermissionProfile,
} from "@perbo/contracts";
import { z } from "zod";
import { SUBAGENT_TOOL_NAMES } from "./agents.js";
import { scratchEnvironment, scratchPath } from "./scratch.js";

/**
 * The A2b permission profile the runner hands to an agent (SCP-078, docs/08).
 *
 * Every entry is a flag or an environment decision the runner makes. None of it
 * is a sentence in a prompt asking the agent to behave, because the agent reads
 * attacker-controlled text all day and a request is not a control.
 */

/**
 * The built-in tools an executor needs, and no others. `WebFetch` and
 * `WebSearch` are absent: on the local provider egress cannot be intercepted,
 * so the honest control is not to hand the agent a fetch tool at all.
 *
 * The tool that starts a subagent is here because the executor may delegate
 * ([D-106](../../../docs/11-open-decisions.md)). Both names it answers to —
 * `Agent`, and `Task` under its former name — are listed, because the guard's
 * own matcher has to carry both and the two lists must not disagree about
 * what the agent's own permission layer admits ahead of it. Which role it
 * starts is not its choice: the invocation offers the roles Perbo defines
 * and the write guard refuses a `subagent_type` outside them, so the tool
 * being available does not put the person's own agent definitions within
 * reach (ADR-0038).
 */
export const DEFAULT_AGENT_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  ...SUBAGENT_TOOL_NAMES,
] as const;

/**
 * Read-only orientation the executor reaches for bare and inside `$(…)`, such
 * as `git diff --end-of-options $(git merge-base HEAD main)`; without
 * `--end-of-options`, what the substitution prints stands where `git diff`
 * reads an option, and the guard refuses it (`shell/internal/command.ts`,
 * `builtOption`). None of the four writes a file, a
 * ref or the index under any flag, or reaches the network (short of a
 * `core.fsmonitor` in a configuration the executor cannot write), which `git diff`,
 * `git log` and `git show` (`--output`) and `git status` (its index refresh)
 * cannot say. That is why the write guard takes a line's use of one of these,
 * where the allow list carries it, as grounds to admit the line, as it takes
 * `echo` (`pretool.ts`). `date` sets the clock only for root, and `sudo` is
 * denied; the deny list names `-s` and `--set` all the same, and the guard
 * reads every other spelling that sets it as `--set` (`shell/internal/clock.ts`):
 * `-s` in a cluster, a prefix of `--set`, and an operand that is not a
 * `+FORMAT` unless `-j`, `-d`, `--date`, `--file` or `--reference` is given —
 * so BSD's `date -f %s 0` and `date -r 0 0101` are refused.
 */
export const READ_ONLY_ORIENTATION = [
  "Bash(git rev-parse:*)",
  "Bash(git merge-base:*)",
  "Bash(git ls-files:*)",
  "Bash(date:*)",
] as const;

/**
 * Command patterns the agent may run. Read-only Git is permitted so it can
 * orient; every mutating Git verb is absent, because the runner performs the
 * commit, the push and the pull request itself and the agent never sees a token.
 */
export const DEFAULT_COMMAND_ALLOW_LIST = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  ...READ_ONLY_ORIENTATION,
  "Bash(node:*)",
  "Bash(pnpm test:*)",
  "Bash(pnpm run:*)",
  "Bash(pnpm exec:*)",
  // Dogfooding this repository found the gap these five close: an agent asked
  // to make a change in a monorepo reaches for `pnpm typecheck`, `pnpm -r
  // typecheck` and `./node_modules/.bin/tsc`, none of which the verb-shaped
  // entries above match. Thirteen of its fifty-three commands were denied and
  // it produced no change at all, because it could never check its own work.
  "Bash(pnpm typecheck:*)",
  "Bash(pnpm lint:*)",
  "Bash(pnpm build:*)",
  "Bash(pnpm -r:*)",
  "Bash(pnpm --filter:*)",
  "Bash(npm test:*)",
  "Bash(npm run:*)",
  "Bash(npx:*)",
  "Bash(vitest:*)",
  "Bash(tsc:*)",
  "Bash(eslint:*)",
  "Bash(./node_modules/.bin/:*)",
  "Bash(python3:*)",
  "Bash(pytest:*)",
  "Bash(make:*)",
  // The executor starts subagents from Perbo's roles (D-106). The guard's
  // hook decides which role, before the call; these entries are what stop the
  // agent's own permission layer refusing the tool, under either name it
  // answers to, ahead of it.
  ...SUBAGENT_TOOL_NAMES,
] as const;

/**
 * Explicit denials on top of the allow-list. An allow-list already excludes
 * these, so the deny list is belt: it makes the prohibition legible in the
 * recorded invocation, and it survives an operator widening the allow-list.
 */
/**
 * The deny list carries the weight the allow-list cannot.
 *
 * Claude Code matches a command by prefix, so a global flag before the verb
 * defeats a verb-shaped rule: `Bash(git push:*)` does not match
 * `git -C /path push`. That is a real limitation of prefix matching and the
 * reason the runner's own `inspectCommand` tolerates intervening flags — the
 * allow-list is the first line and the transcript inspection is the one that
 * catches what prefixes miss.
 */
export const DEFAULT_COMMAND_DENY_LIST = [
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git reset:*)",
  "Bash(git rebase:*)",
  "Bash(git branch:*)",
  "Bash(git remote:*)",
  "Bash(git tag:*)",
  // SCP-200: the machine's `gh` credential, named ahead of the blanket entry
  // below so that a refusal says which prohibition it hit. `Bash(gh:*)`
  // already refuses these; what these add is the deny list's own purpose —
  // the recorded invocation reads as a fact about the credential rather than
  // about the word `gh`. One `gh` login is shared by every process on the
  // machine; two `gh` processes writing it at once signed the machine out of
  // GitHub (2026-09-04), and an attempt must not be a third.
  "Bash(gh auth:*)",
  "Bash(gh config set:*)",
  "Bash(gh:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(nc:*)",
  "Bash(npm publish:*)",
  "Bash(pnpm publish:*)",
  "Bash(cargo publish:*)",
  "Bash(pip install:*)",
  "Bash(sudo:*)",
  // `date`'s setting flags, beside its read forms on the allow list. The guard
  // reads every spelling that sets the clock (`-us`, `--se=…`, `MMDDhhmm`) as
  // `date --set`, so these two make each one's refusal the runner's own.
  "Bash(date -s:*)",
  "Bash(date --set:*)",
  "WebFetch",
  "WebSearch",
] as const;

/**
 * Hosts an attempt may reach. The model provider is pinned by the runner, the
 * repository host is where the code came from, and the registries are what an
 * install needs. Anything else terminates the attempt.
 */
export const DEFAULT_NETWORK_ALLOW_LIST = [
  "api.anthropic.com",
  "statsig.anthropic.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "proxy.golang.org",
] as const;

/** What a Codex executor reaches in place of Anthropic's hosts. */
const CODEX_NETWORK_ALLOW_LIST = [
  "chatgpt.com",
  "api.openai.com",
  ...DEFAULT_NETWORK_ALLOW_LIST.filter((host) => !host.endsWith("anthropic.com")),
] as const;

/**
 * What an OpenCode executor reaches in place of Anthropic's hosts: OpenCode
 * Zen, which serves every model an OpenCode role is let call, and the model
 * catalogue OpenCode reads as it starts (D-134).
 */
const OPENCODE_NETWORK_ALLOW_LIST = [
  "opencode.ai",
  "models.dev",
  ...DEFAULT_NETWORK_ALLOW_LIST.filter((host) => !host.endsWith("anthropic.com")),
] as const;

/**
 * One host name as a repository writes it: dot-separated labels of letters,
 * digits and inner hyphens, 253 characters at most. Exact, so a wildcard, a
 * scheme, a path, a port or a space is not one.
 */
const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * The hosts a repository adds to the executor's egress allow-list, as
 * `network_allow_list` in `.perbo/config.json`: a plain list of exact host
 * names, each one refused by name when it is anything else.
 */
export const NetworkAllowListSchema = z.array(
  z.string().superRefine((value, context) => {
    if (!HOST_NAME.test(value))
      context.addIssue({
        code: "custom",
        message:
          `${JSON.stringify(value)} is not a host name: name each host exactly, as in ` +
          '"googlechromelabs.github.io", with no wildcard, scheme, path or port',
      });
  }),
);

/** Pinned by the runner and never read from repository configuration (ADR-0030). */
export const PINNED_PROVIDER_BASE_URL = "https://api.anthropic.com";

/** The model host each executor is pinned to; a repository's configuration cannot set it. */
const PROVIDER_BASE_URLS = {
  "claude-cli": PINNED_PROVIDER_BASE_URL,
  "codex-cli": "https://chatgpt.com/backend-api",
  "opencode-cli": "https://opencode.ai/zen/v1",
} as const;

export function buildPermissionProfile(args: {
  worktree: string;
  provider?: "claude-cli" | "codex-cli" | "opencode-cli";
  allow?: readonly string[];
  deny?: readonly string[];
  /** Hosts the repository adds to its provider's defaults (`network_allow_list`). */
  network?: readonly string[];
  lifecycle_scripts?: "disabled" | "enabled";
}): PermissionProfile {
  return PermissionProfileSchema.parse({
    autonomy_class: "A2b",
    command_allow_list: [...(args.allow ?? DEFAULT_COMMAND_ALLOW_LIST)],
    command_deny_list: [...(args.deny ?? DEFAULT_COMMAND_DENY_LIST)],
    path_jail_root: args.worktree,
    // OpenCode Zen's key, by name, is the one credential an OpenCode executor
    // is passed; every other executor authenticates from its own login.
    env_allow_list: [...DEFAULT_ENV_ALLOW_LIST, ...(args.provider === "opencode-cli" ? [OPENCODE_API_KEY_ENV] : [])],
    network_allow_list: [
      ...new Set([
        ...(args.provider === "codex-cli"
          ? CODEX_NETWORK_ALLOW_LIST
          : args.provider === "opencode-cli"
            ? OPENCODE_NETWORK_ALLOW_LIST
            : DEFAULT_NETWORK_ALLOW_LIST),
        ...(args.network ?? []),
      ]),
    ],
    provider_base_url: PROVIDER_BASE_URLS[args.provider ?? "claude-cli"],
    lifecycle_scripts: args.lifecycle_scripts ?? "disabled",
    prohibited_actions: [...PROHIBITED_ACTIONS],
  });
}

/**
 * The agent's environment.
 *
 * `HOME` is present, and that is the trade BYOK forces: the agent authenticates
 * with the user's own credential and the credential lives under `HOME`. Perbo
 * never reads it, never stores it and never forwards it — but it also cannot
 * hide the directory it sits in without breaking the login. The compensating
 * controls are the tool allow-list and the path jail, and ADR-0004's amendment
 * is explicit that on the local provider those are detection, not prevention.
 *
 * `TMPDIR`, `TMP` and `TEMP` are set rather than passed through: they name a
 * directory inside the worktree, so a temporary file lands where the write
 * guard allows it (SCP-166). They are `extra` rather than allow-listed values
 * for that reason — the host's `/tmp` must not survive.
 */
export function buildAgentEnvironment(args: {
  base: NodeJS.ProcessEnv;
  profile: PermissionProfile;
  worktree: string;
  ports: { start: number; end: number };
  database_schema: string | null;
}): { env: NodeJS.ProcessEnv; passed: string[]; dropped: string[] } {
  const extra: Record<string, string> = {
    // Pinned here so a repository cannot redirect model traffic (threat 19).
    ...(args.profile.provider_base_url === PINNED_PROVIDER_BASE_URL ? { ANTHROPIC_BASE_URL: PINNED_PROVIDER_BASE_URL } : {}),
    PERBO_WORKTREE: args.worktree,
    PERBO_PORT_START: String(args.ports.start),
    PERBO_PORT_END: String(args.ports.end),
    CI: "1",
    ...scratchEnvironment(scratchPath(args.worktree)),
  };
  if (args.database_schema) extra.PERBO_DB_SCHEMA = args.database_schema;
  return scrubEnvironment({ base: args.base, allow: args.profile.env_allow_list, extra });
}
