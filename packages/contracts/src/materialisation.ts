import { createHash } from "node:crypto";
import { z } from "zod";
import { MaterializationEntrySchema } from "./materialisation-entry.js";
import { RepositoryIdSchema } from "./ids.js";

/**
 * The worktree environment contract (ADR-0025, D-036, SCP-079).
 *
 * A worktree is not an environment. A fresh one has no `node_modules`, no
 * `.env` family, no local certificates, no seeded database and no allocated
 * ports, and none of that is recoverable from Git because none of it is in Git.
 * So it is declared, and the declaration is a contract the runner executes
 * rather than a heuristic it guesses.
 */

export * from "./materialisation-entry.js";

export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun", "uv", "none"] as const;
export const PackageManagerSchema = z.enum(PACKAGE_MANAGERS);
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const INSTALL_STRATEGIES = ["shared_store", "copy_on_write", "none"] as const;
export const InstallStrategyKindSchema = z.enum(INSTALL_STRATEGIES);
export type InstallStrategyKind = (typeof INSTALL_STRATEGIES)[number];

/**
 * ADR-0025 §3 and threat 20: dependency installation runs under the A2b profile
 * with package lifecycle scripts **disabled by default**. Enabling them is an
 * explicit, recorded exception with a name against it, not a configuration flag
 * someone flips to make an install work.
 */
export const LifecycleScriptPolicySchema = z
  .strictObject({
    policy: z.enum(["disabled", "enabled"]),
    exception: z
      .strictObject({
        approved_by: z.string().min(1),
        reason: z.string().min(1),
        recorded_at: z.iso.datetime(),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.policy === "enabled" && value.exception === null) {
      ctx.addIssue({
        code: "custom",
        path: ["exception"],
        message:
          "enabling package lifecycle scripts is an explicit recorded exception: " +
          "it requires an approver, a reason and a date",
      });
    }
  });
export type LifecycleScriptPolicy = z.infer<typeof LifecycleScriptPolicySchema>;

/**
 * Argv, never a shell string. Nothing a model produces reaches this array, and
 * the array form means that if something ever did, it would be one argument
 * rather than a command line.
 */
const ArgvSchema = z.array(z.string().min(1)).min(1);

export const InstallStrategySchema = z.strictObject({
  kind: InstallStrategyKindSchema,
  package_manager: PackageManagerSchema,
  /** Prefer the local store and avoid the network where the manager supports it. */
  offline_preferred: z.boolean(),
  lifecycle_scripts: LifecycleScriptPolicySchema,
  /** Declared, not inferred from the lockfile. An empty install is `[]`-free: use kind `none`. */
  command: ArgvSchema,
  /**
   * Whether a lockfile pins the versions this install resolves.
   *
   * False where the command resolves them itself, so two runs of it can differ
   * and what the attempt was judged against is not reproducible from the
   * repository alone. An install that installs nothing is pinned: it resolves
   * nothing.
   */
  pinned: z.boolean(),
});
export type InstallStrategy = z.infer<typeof InstallStrategySchema>;

/**
 * Parallel attempts are isolated or serialized (ADR-0025 §4). `serialized` is a
 * legitimate answer for a repository whose local services cannot be duplicated,
 * and is recorded rather than discovered when two attempts corrupt each other.
 */
export const IsolationSchema = z.strictObject({
  mode: z.enum(["parallel", "serialized"]),
  /** Contiguous ports handed to one attempt, referenced by the manifest's env template. */
  port_range_size: z.number().int().min(0),
  port_range_start: z.number().int().min(1024).max(65_535),
  port_range_end: z.number().int().min(1024).max(65_535),
  /** A per-attempt schema name, where the repository's database supports it. */
  database_schema_prefix: z.string().min(1).nullable(),
});
export type Isolation = z.infer<typeof IsolationSchema>;

export const MATERIALIZATION_MANIFEST_VERSION = 1;

export const MaterializationManifestSchema = z.strictObject({
  manifest_version: z.literal(MATERIALIZATION_MANIFEST_VERSION),
  repository_id: RepositoryIdSchema,
  /** The user's existing checkout, which the untracked files are copied from. */
  source_checkout: z.string().min(1),
  entries: z.array(MaterializationEntrySchema),
  install: InstallStrategySchema,
  /**
   * The command that proves the worktree can actually run the repository. Its
   * exit status is the definition of "time to first successful execution": a
   * materialization that installs cleanly and cannot run the suite has not
   * succeeded, it has failed later.
   *
   * Where the repository gives a worktree no suite to run (D-013), it is
   * `git status --porcelain`, which proves only that Git can read the worktree:
   * the loop reads a base it passed as unmeasured, and the materialization
   * measurement does not time it.
   */
  verify: z.strictObject({
    command: ArgvSchema,
    timeout_ms: z.number().int().min(1000),
  }),
  isolation: IsolationSchema,
});
export type MaterializationManifest = z.infer<typeof MaterializationManifestSchema>;

/**
 * The manifest hash pins the environment the same way `base.context_manifest_hash`
 * pins the context: two attempts claiming the same environment either agree on
 * this string or one of them is wrong.
 */
export function manifestHash(manifest: MaterializationManifest): string {
  const canonical = JSON.stringify({
    manifest_version: manifest.manifest_version,
    repository_id: manifest.repository_id,
    entries: [...manifest.entries]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    install: manifest.install,
    verify: manifest.verify,
    isolation: manifest.isolation,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * A diagnostic finding is a refusal or an advisory, and the difference decides
 * `materializable`. A repository is refused for what makes it unrunnable; it is
 * never refused for where the operator chose to keep worktrees, which is a
 * setting they can change by moving one path, nor for the kind of repository it
 * is (D-013).
 */
export const DIAGNOSTIC_SEVERITIES = ["refusal", "advisory"] as const;
export const DiagnosticSeveritySchema = z.enum(DIAGNOSTIC_SEVERITIES);
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export const UNMATERIALIZABLE_REASONS = [
  "source_checkout_missing",
  "required_entry_missing",
  "port_range_unavailable",
  "workspace_budget_exceeded",
  /**
   * The untracked files a worktree would need could not be listed at all — the
   * checkout is not a git repository, or `git ls-files` failed or timed out.
   *
   * A refusal rather than an empty manifest, because those are different
   * answers that used to look identical: "this repository needs nothing
   * materialized" and "I could not find out" both arrived as zero entries, and
   * the second was reported `materializable: true`.
   */
  "ignored_paths_unavailable",
  /**
   * The repository's git configuration signs commits, and the configured key
   * could not produce a signature without asking for a passphrase.
   *
   * The first thing in an attempt that asks the key to sign is the commit that
   * seals the change set, which is after the agent has run and been paid for —
   * so a key nothing on the machine can use costs a whole attempt and returns
   * nothing. Refused here instead.
   */
  "commit_signing_unavailable",
  /**
   * No branch can be named as the base a change would land on: the checkout is
   * detached, its remote declares no default branch, and no configuration says
   * one.
   *
   * The base is what the loop merges up from and what the pull request opens
   * against, and both come after the agent has run and been paid for — GitHub
   * refuses a pull request whose base is not a branch. Refused here instead.
   */
  "base_ref_unknown",
] as const;
export const UnmaterializableReasonSchema = z.enum(UNMATERIALIZABLE_REASONS);
export type UnmaterializableReason = (typeof UNMATERIALIZABLE_REASONS)[number];

/**
 * Reported and not disqualifying.
 *
 * `nested_package_manager_workspace`: a package manager resolves its workspace
 * root by walking **up** and does not stop at a Git boundary, so a worktree
 * placed under a directory that declares a workspace is read as a member of it
 * — every install and every `pnpm exec` inside it fails, naming neither the
 * worktree nor the workspace that captured it. Found by dogfooding, where it
 * cost two runs to diagnose.
 *
 * `undeclared_service_dependency`: the repository declares services
 * materialization cannot start, and the verification command does not name
 * them. If some test needs one anyway it will error or skip, and the attempt
 * reports green with that test unrun — so this is reported rather than refused,
 * because most repositories that ship a compose file do not need it to run
 * their unit suite.
 *
 * `lockfile_missing`: the manifest names the manager but no lockfile pins the
 * versions, so the install resolves them itself. Reported rather than refused,
 * because a repository somebody is trying for the first time often has no
 * lockfile yet and refusing it is a wall in the first hour. The finding says
 * what writes one.
 *
 * The five below describe a kind of repository rather than something wrong
 * with one, and an attempt can be made against any repository (D-013). Each
 * leaves the checkout without a command whose success says a worktree runs it,
 * so unless the diagnostic is given one, the verification is
 * `git status --porcelain`, which any checkout Git can read passes, and an
 * attempt there is judged by the review and whichever checks are pinned.
 *
 * `package_manager_undetected`: nothing in the checkout names a package manager
 * this build reads — no lockfile and no manifest — which is true of an empty
 * repository and of one in another ecosystem, such as Rust or Go. Nothing is
 * installed and no scripts are read.
 *
 * `unsupported_package_manager`: the checkout names a package manager this
 * build detects but does not install with, such as uv. The same as undetected:
 * nothing is installed and no scripts are read.
 *
 * `package_manifest_missing`: a lockfile names a manager this build installs
 * with, and nothing its install reads is beside it: no `package.json`, and for
 * pnpm no `pnpm-workspace.yaml` either, from which pnpm installs a workspace
 * that has no root manifest. The same again: an install with nothing to
 * install is not run.
 *
 * `no_verification_command`: the package declares no test script.
 *
 * `verification_requires_service`: a test script, or the `pre` script the
 * package manager runs before it, starts a service. Materialization copies
 * files and cannot start one, so the suite would run with the tests that need
 * the service erroring or skipping and report green. A script the diagnostic
 * read is not run; a command it was given runs as given, and the finding says
 * what it starts.
 */
export const DIAGNOSTIC_ADVISORY_REASONS = [
  "nested_package_manager_workspace",
  "undeclared_service_dependency",
  "lockfile_missing",
  "package_manager_undetected",
  "unsupported_package_manager",
  "package_manifest_missing",
  "no_verification_command",
  "verification_requires_service",
] as const;
export const DiagnosticAdvisoryReasonSchema = z.enum(DIAGNOSTIC_ADVISORY_REASONS);
export type DiagnosticAdvisoryReason = (typeof DIAGNOSTIC_ADVISORY_REASONS)[number];

export const DiagnosticReasonSchema = z.enum([
  ...UNMATERIALIZABLE_REASONS,
  ...DIAGNOSTIC_ADVISORY_REASONS,
]);
export type DiagnosticReason = z.infer<typeof DiagnosticReasonSchema>;

/**
 * SCP-079 acceptance criterion 6. A repository that cannot be materialized
 * fails the diagnostic with a specific reason, before an attempt starts —
 * rather than failing in the middle of one, where the failure looks like the
 * agent's fault.
 */
export const DiagnosticFindingSchema = z.strictObject({
  reason: DiagnosticReasonSchema,
  severity: DiagnosticSeveritySchema,
  detail: z.string().min(1),
  path: z.string().min(1).nullable(),
});
export type DiagnosticFinding = z.infer<typeof DiagnosticFindingSchema>;

export const DiagnosticResultSchema = z
  .strictObject({
    materializable: z.boolean(),
    findings: z.array(DiagnosticFindingSchema),
    /** Proposed from the user's checkout; the user confirms and edits it. */
    proposed: MaterializationManifestSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    // `materializable` is derived from the findings, so a result cannot claim
    // one thing and carry the other.
    const refused = value.findings.some((finding) => finding.severity === "refusal");
    if (value.materializable && refused) {
      ctx.addIssue({
        code: "custom",
        path: ["materializable"],
        message: "a result carrying a refusal finding cannot be materializable",
      });
    }
  });

export const isRefusal = (finding: DiagnosticFinding): boolean => finding.severity === "refusal";
export type DiagnosticResult = z.infer<typeof DiagnosticResultSchema>;

/**
 * What a materialization actually cost, measured rather than assumed
 * (ADR-0025 §3, SCP-079 criteria 3, 5 and 7).
 */
export const MaterializationMeasurementSchema = z.strictObject({
  provision_ms: z.number().int().min(0),
  materialize_ms: z.number().int().min(0),
  install_ms: z.number().int().min(0),
  verify_ms: z.number().int().min(0),
  total_ms: z.number().int().min(0),
  /** Bytes the worktree occupies once it is ready to run. */
  steady_state_bytes: z.number().int().min(0),
  /** The high-water mark during install, which is what actually fills a laptop. */
  peak_bytes: z.number().int().min(0),
  warm: z.boolean(),
  install_strategy: InstallStrategyKindSchema,
  package_manager: PackageManagerSchema,
});
export type MaterializationMeasurement = z.infer<typeof MaterializationMeasurementSchema>;

/** ADR-0025's reversal trigger, in the units the ADR states them in. */
export const COLD_START_TARGET_MS = 3 * 60 * 1000;
export const WARM_START_TARGET_MS = 45 * 1000;
export const COLD_START_REVERSAL_MS = 10 * 60 * 1000;
/** D-049's counterpart, stated in bytes because a laptop runs out of those first. */
export const ATTEMPT_DISK_REVERSAL_BYTES = 10 * 1024 * 1024 * 1024;
