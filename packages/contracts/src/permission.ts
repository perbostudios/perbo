import { z } from "zod";

/**
 * The A2b permission profile and the prohibited-action list
 * (docs/08, ADR-0023, ADR-0030, SCP-078, D-022, D-041).
 *
 * Every field here is something the **runner** does to the agent process, not
 * something the prompt asks the agent to do. That distinction is the whole
 * point: a prompt is a request to a system that reads attacker-controlled text
 * all day, and a flag is not.
 */

export const AUTONOMY_CLASSES = ["A0", "A1", "A2a", "A2b", "A3", "A4", "A5"] as const;
export const AutonomyClassSchema = z.enum(AUTONOMY_CLASSES);
export type AutonomyClass = (typeof AUTONOMY_CLASSES)[number];

/**
 * A2a and A2b are distinct because `npm test` is not a reversible worktree
 * edit: it executes whatever the repository specifies, in an environment the
 * agent just modified, on the user's machine, with the user's network. Treating
 * them as one class propagated a wrong answer into every downstream policy.
 */
export const AUTONOMY_DESCRIPTIONS: Record<AutonomyClass, string> = {
  A0: "observe only",
  A1: "draft only",
  A2a: "reversible worktree action, no process spawn",
  A2b: "arbitrary command execution, under the permission profile",
  A3: "bounded external action, policy-gated",
  A4: "material action, named approver",
  A5: "prohibited in the current product",
};

/** docs/08, "Prohibited actions". Enforced in the runner, regardless of request. */
export const PROHIBITED_ACTIONS = [
  "self_merge",
  "write_policy_path",
  "write_outside_worktree",
  "write_outside_scope",
  "write_prohibited_path",
  "destructive_git",
  "registry_publication",
  "non_local_migration",
  "modify_judging_artifact",
  "unlisted_egress_host",
  "external_communication",
  "new_registry_dependency",
  "enable_own_tooling",
] as const;
export const ProhibitedActionSchema = z.enum(PROHIBITED_ACTIONS);
export type ProhibitedAction = (typeof PROHIBITED_ACTIONS)[number];

export const PROHIBITED_ACTION_STATEMENTS: Record<ProhibitedAction, string> = {
  self_merge: "merging its own pull request; a human merges (D-041)",
  write_policy_path:
    "writing to .github/**, CODEOWNERS, branch protection, repository settings, secret stores " +
    "or agent configuration",
  write_outside_worktree: "writing anywhere outside the worktree root",
  write_outside_scope:
    "writing inside the worktree but outside the globs the approved contract admits a write " +
    "under (SCP-195)",
  write_prohibited_path:
    "writing to a path the approved contract prohibits, inside the allowed paths as much as " +
    "outside them (D-105)",
  destructive_git:
    "force-push, history rewrite, branch deletion, or a push whose remote is not a path inside " +
    "the attempt's worktree or temporary directory — the runner performs the push",
  registry_publication: "publishing to a package registry, or creating a release-pattern tag",
  non_local_migration: "running a migration against a non-local connection string",
  modify_judging_artifact:
    "modifying an artifact that judges this attempt: the review policy, the corpus, a protected " +
    "or contract test, workflow or branch-protection configuration, or the pinned check set (D-045)",
  unlisted_egress_host: "reaching a host outside the resolved allow-list",
  external_communication:
    "email, chat, webhooks, or issue comments on a repository other than the one under change",
  new_registry_dependency: "adding a dependency not already in the lockfile without approval",
  enable_own_tooling:
    "connecting a tool server, registering a hook, starting a subagent from a role Perbo does " +
    "not define, a subagent starting one of its own whatever role it names (D-106), or " +
    "widening its own permissions in any other way",
};

/**
 * Paths that judge the attempt, or that govern the system judging it (D-045).
 * The distinguishing question is never "is it a test" — it is whether the
 * artifact is judging this attempt or is part of what this attempt produces.
 */
export const POLICY_PATTERNS = [
  ".github/**",
  "CODEOWNERS",
  "**/CODEOWNERS",
  ".perbo/**",
  "**/.perbo/**",
] as const;

export const AGENT_CONFIGURATION_NEUTRALISATION_MODES = [
  "suppressed_at_invocation",
  "withheld_from_worktree",
  "asserted_empty",
] as const;
export const NeutralisationModeSchema = z.enum(AGENT_CONFIGURATION_NEUTRALISATION_MODES);
export type NeutralisationMode = (typeof AGENT_CONFIGURATION_NEUTRALISATION_MODES)[number];

/**
 * ADR-0030 requires the adapter to declare **how** it neutralised repository
 * configuration, not merely that it did. All three mechanisms are recorded,
 * because they cover different gaps and an adapter that can only manage one of
 * them is a different security posture that should be visible in the record.
 */
export const NeutralisationRecordSchema = z.strictObject({
  suppressed_at_invocation: z.array(z.string().min(1)),
  withheld_from_worktree: z.array(z.string().min(1)),
  asserted_empty: z.array(z.string().min(1)),
  /** What the agent reported loading, kept so the assertion is auditable. */
  reported: z.strictObject({
    mcp_servers: z.array(z.string()),
    plugins: z.array(z.string()),
    skills: z.array(z.string()),
    subagents: z.array(z.string()),
    memory_paths: z.array(z.string()),
  }),
});
export type NeutralisationRecord = z.infer<typeof NeutralisationRecordSchema>;

export const PermissionProfileSchema = z.strictObject({
  autonomy_class: z.enum(["A2a", "A2b"]),
  /** Tool and command patterns the agent may use. Anything else is denied. */
  command_allow_list: z.array(z.string().min(1)),
  command_deny_list: z.array(z.string().min(1)),
  /** Absolute; the agent's working directory and the root of its path jail. */
  path_jail_root: z.string().min(1),
  /** Variable **names** passed through. Values are never recorded anywhere. */
  env_allow_list: z.array(z.string().min(1)),
  network_allow_list: z.array(z.string().min(1)),
  /** Pinned by the runner and not readable from repository configuration. */
  provider_base_url: z.string().min(1),
  lifecycle_scripts: z.enum(["disabled", "enabled"]),
  prohibited_actions: z.array(ProhibitedActionSchema),
});
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

/**
 * The environment an agent process receives, by name.
 *
 * An allow-list rather than a deny-list, because a deny-list is a list of the
 * credentials someone remembered. `HOME` is present and load-bearing: BYOK
 * means the agent authenticates with the user's own credential, which lives
 * there. That is a deliberate trade and it is the reason the path jail matters.
 *
 * `TMPDIR`, `TMP` and `TEMP` are on the list so the runner can carry them, but
 * the runner replaces all three with a directory inside the worktree (SCP-166);
 * the host's value never reaches the agent.
 */
export const DEFAULT_ENV_ALLOW_LIST = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "USER",
  "TZ",
] as const;

/** Names that must never be forwarded even if an allow-list is widened. */
export const CREDENTIAL_ENV_DENY_PATTERNS = [
  /^GH_/,
  /^GITHUB_/,
  /^GIT_ASKPASS$/,
  /^GIT_SSH/,
  /^SSH_AUTH_SOCK$/,
  /^AWS_/,
  /^AZURE_/,
  /^GOOGLE_/,
  /^GCP_/,
  /^NPM_TOKEN$/,
  /^NODE_AUTH_TOKEN$/,
  /^PERBO_TOKEN$/,
  /^PERBO_API/,
  /TOKEN$/,
  /SECRET$/,
  /PASSWORD$/,
  /^ANTHROPIC_BASE_URL$/,
  /^ANTHROPIC_AUTH_TOKEN$/,
] as const;

export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV_DENY_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Build the agent's environment from an allow-list, dropping anything that
 * looks like a credential even if it was allow-listed by mistake.
 */
export function scrubEnvironment(args: {
  base: NodeJS.ProcessEnv;
  allow: readonly string[];
  extra?: Record<string, string>;
}): { env: NodeJS.ProcessEnv; passed: string[]; dropped: string[] } {
  const env: NodeJS.ProcessEnv = {};
  const passed: string[] = [];
  const dropped: string[] = [];
  for (const name of args.allow) {
    const value = args.base[name];
    if (value === undefined) continue;
    if (isCredentialEnvName(name)) {
      dropped.push(name);
      continue;
    }
    env[name] = value;
    passed.push(name);
  }
  for (const [name, value] of Object.entries(args.extra ?? {})) {
    env[name] = value;
    passed.push(name);
  }
  for (const name of Object.keys(args.base)) {
    if (!passed.includes(name)) dropped.push(name);
  }
  // A name that is both allow-listed and overridden by the runner is listed
  // once: the record says which names the agent received, not how often.
  return { env, passed: [...new Set(passed)], dropped: [...new Set(dropped)] };
}
