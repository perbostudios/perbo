import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  COLD_START_TARGET_MS,
  DEFAULT_LIMITS_TABLE,
  LimitsTableSchema,
  MaterializationManifestSchema,
  WARM_START_TARGET_MS,
  manifestHash,
  type MaterializationManifest,
} from "@perbo/contracts";
import { diagnose, isGreenfieldVerify, validateManifest } from "./diagnostic.js";
import { run } from "./exec.js";
import { materialize } from "./materialize.js";
import { gitEnv } from "./repository/index.js";
import { cleanup, provision, type Workspace } from "./worktree.js";

/**
 * The ADR-0025 measurement (SCP-079 criterion 5, roadmap item 6).
 *
 * It runs **before** the runner protocol on purpose. If a worktree cannot be
 * made to run three representative repositories inside the budget, the
 * execution substrate is wrong and a protocol designed around it is wasted, so
 * the number comes first and it is a go/no-go.
 *
 * What it measures, per repository:
 *
 * | phase | what it is |
 * |---|---|
 * | `clone` | a clean clone, reported separately — the product starts from a checkout the user already has |
 * | `provision` | `git worktree add` from an exact base commit |
 * | `materialize` | copying the untracked files the repository needs |
 * | `install` | dependencies, under the declared strategy, lifecycle scripts off |
 * | `verify` | the repository's own suite, green |
 *
 * `time_to_first_execution_ms` is provision + materialize + install + verify.
 * The clone is excluded from it and reported beside it, because a user who
 * already has the repository does not pay it.
 */

export const RepositorySpecSchema = z.strictObject({
  name: z.string().min(1),
  repository_id: z.string().min(1),
  /** A path on this machine, or a URL. */
  source: z.string().min(1),
  clone: z.enum(["local", "network", "none"]),
  /** Recorded in the result instead of the name, where the repository is private. */
  label: z.string().min(1).optional(),
  verify_command: z.array(z.string().min(1)).min(1).optional(),
  verify_timeout_ms: z.number().int().min(1000).optional(),
  install_command: z.array(z.string().min(1)).min(1).optional(),
  /** Extra materialization entries the diagnostic cannot infer. */
  extra_entries: MaterializationManifestSchema.shape.entries.optional(),
  ref: z.string().min(1).optional(),
});
export type RepositorySpec = z.infer<typeof RepositorySpecSchema>;

export const ExperimentConfigSchema = z.strictObject({
  scratch: z.string().min(1),
  repositories: z.array(RepositorySpecSchema).min(1),
  limits: LimitsTableSchema.optional(),
});
export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;

export interface PhaseTiming {
  phase: string;
  ms: number;
  ok: boolean;
  detail: string;
}

export interface RunMeasurement {
  kind: "cold" | "warm";
  phases: PhaseTiming[];
  /** provision + materialize + install: the worktree is ready to run. */
  time_to_ready_ms: number;
  /** …plus the repository's own suite, green. */
  time_to_first_execution_ms: number;
  steady_state_bytes: number;
  peak_bytes: number;
  apparent_bytes: number;
  verified: boolean;
  verify_summary: string;
  failure: string | null;
}

export interface RepositoryResult {
  name: string;
  label: string;
  /** Where the manifest was proposed from, which is not the clone. */
  diagnosed_from: string;
  repository_id: string;
  package_manager: string;
  workspaces: number | null;
  head_commit: string;
  clone_ms: number | null;
  manifest_hash: string;
  materialized_entries: string[];
  diagnostic_findings: Array<{ reason: string; detail: string }>;
  manual_interventions: string[];
  cold: RunMeasurement | null;
  warm: RunMeasurement | null;
}

const TEN_MINUTES = 10 * 60 * 1000;

async function gitHead(dir: string): Promise<string> {
  const result = await run(["git", "rev-parse", "HEAD"], {
    cwd: dir,
    env: gitEnv(),
    timeoutMs: 60_000,
  });
  return result.stdout.trim();
}

async function countWorkspaces(dir: string): Promise<number | null> {
  const file = join(dir, "pnpm-workspace.yaml");
  if (!existsSync(file)) return null;
  const result = await run(["git", "ls-files", "--", "**/package.json", "package.json"], {
    cwd: dir,
    env: gitEnv(),
    timeoutMs: 60_000,
  });
  const manifests = result.stdout.split("\n").filter((line) => line.trim().length > 0);
  return manifests.length;
}

async function cloneInto(spec: RepositorySpec, into: string): Promise<number | null> {
  if (spec.clone === "none") return null;
  const started = Date.now();
  // `--no-hardlinks` on a local clone so the number is a copy rather than a
  // link table: a hardlinked local clone measures nothing a user would see.
  const argv =
    spec.clone === "local"
      ? ["git", "clone", "--no-hardlinks", resolve(spec.source), into]
      : ["git", "clone", spec.source, into];
  const result = await run(argv, { cwd: resolve(into, ".."), env: gitEnv(), timeoutMs: TEN_MINUTES });
  if (result.code !== 0) {
    throw new Error(`clone failed for ${spec.name}: ${result.stderr.trim().slice(0, 400)}`);
  }
  return Date.now() - started;
}

async function measureOne(args: {
  spec: RepositorySpec;
  repositoryRoot: string;
  manifest: MaterializationManifest;
  worktreeRoot: string;
  kind: "cold" | "warm";
  ticketId: string;
  attemptId: string;
  onProgress: (message: string) => void;
  limits: ExperimentConfig["limits"];
}): Promise<{ measurement: RunMeasurement; workspace: Workspace | null }> {
  const phases: PhaseTiming[] = [];
  const limits = args.limits ?? DEFAULT_LIMITS_TABLE;
  let workspace: Workspace;

  const provisionStart = Date.now();
  try {
    workspace = await provision({
      repository_root: args.repositoryRoot,
      repository_id: args.spec.repository_id,
      ticket_key: "SCP-079",
      ticket_id: args.ticketId,
      outcome: `measure materialization of ${args.spec.name}`,
      base_commit: await gitHead(args.repositoryRoot),
      attempt_id: args.attemptId,
      root: args.worktreeRoot,
      limits,
    });
  } catch (error) {
    const ms = Date.now() - provisionStart;
    phases.push({ phase: "provision", ms, ok: false, detail: String(error) });
    return {
      measurement: {
        kind: args.kind,
        phases,
        time_to_ready_ms: ms,
        time_to_first_execution_ms: ms,
        steady_state_bytes: 0,
        peak_bytes: 0,
        apparent_bytes: 0,
        verified: false,
        verify_summary: "",
        failure: `provision: ${String(error)}`,
      },
      workspace: null,
    };
  }
  const provision_ms = Date.now() - provisionStart;
  phases.push({ phase: "provision", ms: provision_ms, ok: true, detail: workspace.branch });

  const result = await materialize({
    workspace,
    manifest: args.manifest,
    limits,
    warm: args.kind === "warm",
    onProgress: args.onProgress,
  });

  phases.push({
    phase: "materialize",
    ms: result.measurement.materialize_ms,
    ok: true,
    detail: `${result.materialized_paths.length} entries, ${result.secrets.entries.length} indexed as secret`,
  });
  phases.push({
    phase: "install",
    ms: result.measurement.install_ms,
    ok: result.install === null || result.install.code === 0,
    detail:
      result.install === null
        ? "no install declared"
        : `${args.manifest.install.command.join(" ")} exited ${result.install.code}`,
  });
  phases.push({
    phase: "verify",
    ms: result.measurement.verify_ms,
    ok: result.verify?.code === 0,
    detail:
      result.verify === null
        ? "skipped: install failed"
        : `${args.manifest.verify.command.join(" ")} exited ${result.verify.code}${
            result.verify.timed_out ? " (timed out)" : ""
          }`,
  });

  const failure =
    result.install && result.install.code !== 0
      ? `install exited ${result.install.code}: ${result.install.stderr.trim().slice(-400)}`
      : result.verify && result.verify.code !== 0
        ? `verify exited ${result.verify.code}: ${(result.verify.stderr || result.verify.stdout).trim().slice(-400)}`
        : result.suspended
          ? `host suspended for ${result.suspended.gap_ms} ms during the attempt`
          : null;

  const time_to_ready_ms =
    provision_ms + result.measurement.materialize_ms + result.measurement.install_ms;
  return {
    measurement: {
      kind: args.kind,
      phases,
      time_to_ready_ms,
      time_to_first_execution_ms: time_to_ready_ms + result.measurement.verify_ms,
      steady_state_bytes: result.measurement.steady_state_bytes,
      peak_bytes: result.measurement.peak_bytes,
      apparent_bytes: result.apparent_bytes,
      verified: result.verify?.code === 0,
      verify_summary: result.verify_summary,
      failure,
    },
    workspace,
  };
}

export async function runExperiment(
  config: ExperimentConfig,
  onProgress: (message: string) => void = () => undefined,
): Promise<RepositoryResult[]> {
  const scratch = resolve(config.scratch);
  mkdirSync(scratch, { recursive: true });
  const results: RepositoryResult[] = [];

  for (const spec of config.repositories) {
    onProgress(`--- ${spec.name}`);
    const manual: string[] = [];
    const checkout = spec.clone === "none" ? resolve(spec.source) : join(scratch, spec.name);
    let clone_ms: number | null = null;
    if (spec.clone !== "none" && !existsSync(checkout)) {
      onProgress(`clone ${spec.name}`);
      clone_ms = await cloneInto(spec, checkout);
    }
    if (spec.ref) {
      const checked = await run(["git", "checkout", "--detach", spec.ref], {
        cwd: checkout,
        env: gitEnv(),
        timeoutMs: 120_000,
      });
      if (checked.code !== 0) manual.push(`could not check out ${spec.ref}`);
    }

    // ADR-0025 §1: the manifest is proposed from **the user's existing
    // checkout**, because that is the only place the untracked files exist. A
    // clean clone has none of them by definition, so diagnosing the clone would
    // measure an environment nobody has.
    const sourceCheckout = spec.source.startsWith("/") ? resolve(spec.source) : checkout;
    const diagnostic = await diagnose({
      checkout: sourceCheckout,
      repository_id: spec.repository_id,
      ...(spec.verify_command ? { verify_command: spec.verify_command } : {}),
      ...(spec.verify_timeout_ms ? { verify_timeout_ms: spec.verify_timeout_ms } : {}),
    });
    // What is measured is a start up to the repository's own suite, green. A
    // proposal that verifies with `git status --porcelain` has no suite, so
    // timing it would report a start nothing proved; it is not measured, and
    // the findings say why.
    if (!diagnostic.proposed || isGreenfieldVerify(diagnostic.proposed.verify.command)) {
      results.push({
        name: spec.name,
        label: spec.label ?? spec.name,
        diagnosed_from: sourceCheckout,
        repository_id: spec.repository_id,
        package_manager: diagnostic.proposed?.install.package_manager ?? "unknown",
        workspaces: null,
        head_commit: "",
        clone_ms,
        manifest_hash: "",
        materialized_entries: [],
        diagnostic_findings: diagnostic.findings.map((f) => ({ reason: f.reason, detail: f.detail })),
        manual_interventions: manual,
        cold: null,
        warm: null,
      });
      continue;
    }

    const manifest = MaterializationManifestSchema.parse({
      ...diagnostic.proposed,
      source_checkout: sourceCheckout,
      entries: [...diagnostic.proposed.entries, ...(spec.extra_entries ?? [])],
      // A spec's install runs: where the proposal installs nothing, its kind
      // would skip the command the spec names.
      ...(spec.install_command
        ? {
            install: {
              ...diagnostic.proposed.install,
              kind: diagnostic.proposed.install.kind === "none" ? "shared_store" : diagnostic.proposed.install.kind,
              command: spec.install_command,
            },
          }
        : {}),
      isolation: {
        ...diagnostic.proposed.isolation,
        port_range_start: 41_000 + results.length * 100,
        port_range_end: 41_000 + results.length * 100 + diagnostic.proposed.isolation.port_range_size - 1,
      },
    });
    for (const finding of validateManifest(manifest)) {
      manual.push(`${finding.reason}: ${finding.detail}`);
    }

    const worktreeRoot = join(scratch, `${spec.name}-worktrees`);
    const cold = await measureOne({
      spec,
      repositoryRoot: checkout,
      manifest,
      worktreeRoot,
      kind: "cold",
      ticketId: "ticket_scp079cold",
      attemptId: `att_${spec.name.replace(/[^a-z0-9]/gi, "")}_cold`,
      onProgress,
      limits: config.limits,
    });
    if (cold.workspace) {
      await cleanup({ workspace: cold.workspace, root: worktreeRoot, outcome: "success" });
    }

    const warm = await measureOne({
      spec,
      repositoryRoot: checkout,
      manifest,
      worktreeRoot,
      kind: "warm",
      ticketId: "ticket_scp079warm",
      attemptId: `att_${spec.name.replace(/[^a-z0-9]/gi, "")}_warm`,
      onProgress,
      limits: config.limits,
    });
    if (warm.workspace) {
      await cleanup({ workspace: warm.workspace, root: worktreeRoot, outcome: "success" });
    }

    results.push({
      name: spec.name,
      label: spec.label ?? spec.name,
      diagnosed_from: sourceCheckout,
      repository_id: spec.repository_id,
      package_manager: manifest.install.package_manager,
      workspaces: await countWorkspaces(checkout),
      head_commit: await gitHead(checkout),
      clone_ms,
      manifest_hash: manifestHash(manifest),
      materialized_entries: manifest.entries.map((entry) => entry.path),
      diagnostic_findings: diagnostic.findings.map((f) => ({ reason: f.reason, detail: f.detail })),
      manual_interventions: manual,
      cold: cold.measurement,
      warm: warm.measurement,
    });
  }
  return results;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const bytes = (value: number) => {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MiB`;
  return `${(value / 1024).toFixed(0)} KiB`;
};

export function renderExperiment(results: RepositoryResult[]): string {
  const lines: string[] = [];
  const verdict = (measurement: RunMeasurement | null, target: number) => {
    if (!measurement) return "not measured";
    if (!measurement.verified) return "**failed**";
    return measurement.time_to_first_execution_ms <= target ? "within" : "**over**";
  };
  lines.push(
    "| repository | manager | clone | cold ready | cold + suite | warm ready | warm + suite | cold verdict | warm verdict |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const result of results) {
    const cold = result.cold;
    const warm = result.warm;
    lines.push(
      `| ${result.label} | ${result.package_manager} | ` +
        `${result.clone_ms === null ? "—" : seconds(result.clone_ms)} | ` +
        `${cold ? seconds(cold.time_to_ready_ms) : "—"} | ` +
        `${cold ? seconds(cold.time_to_first_execution_ms) : "—"} | ` +
        `${warm ? seconds(warm.time_to_ready_ms) : "—"} | ` +
        `${warm ? seconds(warm.time_to_first_execution_ms) : "—"} | ` +
        `${verdict(cold, COLD_START_TARGET_MS)} | ${verdict(warm, WARM_START_TARGET_MS)} |`,
    );
  }
  lines.push("");
  lines.push("| repository | phase | cold | warm |");
  lines.push("|---|---|---|---|");
  for (const result of results) {
    for (const phase of result.cold?.phases ?? []) {
      const warmPhase = result.warm?.phases.find((entry) => entry.phase === phase.phase);
      lines.push(
        `| ${result.label} | ${phase.phase} | ${seconds(phase.ms)} | ` +
          `${warmPhase ? seconds(warmPhase.ms) : "—"} |`,
      );
    }
  }
  lines.push("");
  lines.push(
    "| repository | disk consumed (cold) | peak (cold) | apparent worktree size | over ADR-0025 reversal (10 min)? |",
  );
  lines.push("|---|---|---|---|---|");
  for (const result of results) {
    if (!result.cold) continue;
    lines.push(
      `| ${result.label} | ${bytes(result.cold.steady_state_bytes)} | ${bytes(result.cold.peak_bytes)} | ` +
        `${bytes(result.cold.apparent_bytes)} | ` +
        `${result.cold.time_to_first_execution_ms > 10 * 60 * 1000 ? "**yes**" : "no"} |`,
    );
  }
  return lines.join("\n");
}
