import {
  EXECUTION_ATTEMPT_SCHEMA_VERSION,
  ExecutionAttemptSchema,
  PlanContractSchema,
  ReviewArtifactSchema,
  type ExecutionAttempt,
  type Finding,
  type MaterializationManifest,
  type PlanContract,
  type ReviewArtifact,
} from "@perbo/contracts";
import { BriefRecordsSchema, type BriefRecords } from "../brief.js";

/**
 * A manifest that installs nothing. The fixture repositories have no
 * dependencies, and letting the package manager rewrite a lockfile would put a
 * file in every change set that no attempt wrote — which is exactly what these
 * tests are counting.
 */
export const withoutInstall = (repositoryRoot: string): MaterializationManifest => ({
  manifest_version: 1,
  repository_id: "repo_fixture",
  source_checkout: repositoryRoot,
  entries: [],
  install: {
    kind: "none",
    package_manager: "none",
    offline_preferred: true,
    lifecycle_scripts: { policy: "disabled", exception: null },
    command: ["true"],
    pinned: true,
  },
  verify: { command: ["node", "-e", "process.exit(0)"], timeout_ms: 30_000 },
  isolation: {
    mode: "parallel",
    port_range_size: 0,
    port_range_start: 41_000,
    port_range_end: 41_009,
    database_schema_prefix: null,
  },
});

export function makeContract(repositoryId = "repo_fixture"): PlanContract {
  return PlanContractSchema.parse({
    plan_id: "plan_stage2",
    version: 1,
    ticket_id: "ticket_SCP094",
    level: "P1",
    outcome: "The feature module exports a computed total",
    acceptance_criteria: [
      {
        id: "ac_1",
        text: "total() returns the sum of its inputs",
        expected_verification: { kind: "test", assertion: "total([1,2]) is 3" },
      },
    ],
    scope: {
      repository_id: repositoryId,
      paths_allowed: ["src/**", "test/**"],
      paths_prohibited: [".github/**"],
      // The runner's own materialization rewrites the lockfile before the agent
      // starts, and scope enforcement — the review's, and now the guard's —
      // fires on it unless the contract declares it generated (docs/04).
      generated_paths: ["pnpm-lock.yaml"],
      expansion_budget_files: 2,
    },
    base: {
      base_commit: "0000000",
      context_manifest_hash: `sha256:${"0".repeat(64)}`,
      captured_at: "2026-08-27T00:00:00.000Z",
    },
  });
}

/**
 * An attempt record shaped exactly as the loop writes one, validated through
 * the same schema — so a record a test builds is indistinguishable from a real
 * one to the code that reads it back.
 */
export function makeAttempt(input: {
  attempt_id: string;
  ticket_id?: string;
  root_attempt_id?: string;
  continues_attempt_id?: string | null;
  remediation_round?: number;
  created_at?: string;
  termination?: ExecutionAttempt["termination"];
  head_commit?: string | null;
  /** The branch the attempt worked on. */
  branch?: string;
  /** What the executor's credential was; a subscription attempt is the one the ledger does not price. */
  credential_class?: "subscription" | "user_api_key" | "unknown";
  cost_micros?: number;
  cost_basis?: ExecutionAttempt["usage"]["cost_basis"];
}): ExecutionAttempt {
  return ExecutionAttemptSchema.parse({
    schema_version: EXECUTION_ATTEMPT_SCHEMA_VERSION,
    attempt_id: input.attempt_id,
    root_attempt_id: input.root_attempt_id ?? input.attempt_id,
    continues_attempt_id: input.continues_attempt_id ?? null,
    remediation_round: input.remediation_round ?? 0,
    created_at: input.created_at ?? "2026-08-27T00:00:00.000Z",
    ticket_id: input.ticket_id ?? "ticket_SCP094",
    plan_id: "plan_stage2",
    plan_version: 1,
    planned_risk: "P1",
    repository_id: "repo_fixture",
    base_ref: "main",
    base_commit: "a1b2c3d",
    provider: "local_worktree",
    branch: input.branch ?? "ayo/fixture/the-feature-module",
    worktree_path: "/nowhere/worktree",
    autonomy_class: "A2b",
    permission_profile: {
      autonomy_class: "A2b",
      command_allow_list: ["Bash"],
      command_deny_list: ["gh"],
      path_jail_root: "/nowhere/worktree",
      env_allow_list: ["PATH"],
      network_allow_list: ["api.anthropic.com"],
      provider_base_url: "https://api.anthropic.com",
      lifecycle_scripts: "disabled",
      prohibited_actions: ["self_merge"],
    },
    agent: {
      adapter: "double",
      binary_path: "/bin/true",
      binary_version: "0.0.0",
      binary_sha256: "0".repeat(64),
      model: "double",
      credential_class: input.credential_class ?? "subscription",
      argv: ["-p", "<prompt>"],
      shape_sha256: "1".repeat(64),
      neutralisation: {
        suppressed_at_invocation: ["double"],
        withheld_from_worktree: [],
        asserted_empty: ["mcp_servers"],
        reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
      },
    },
    environment: {
      manifest_hash: "sha256:fixture",
      install_pinned: true,
      materialized_paths: [],
      secret_content_sha256: [],
      port_range_start: 41000,
      port_range_end: 41000,
      database_schema: null,
      env_names_passed: ["PATH"],
      env_names_dropped: 0,
    },
    commands: [],
    egress: [],
    prohibited_action_hits: [],
    user_instructions: [],
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      cost_micros: input.cost_micros ?? 0,
      cost_basis: input.cost_basis ?? "transport_reported",
      wall_clock_ms: 0,
      commands: 0,
      iterations: 0,
    },
    termination: input.termination ?? { reason: "completed", detail: "" },
    changeset_id: null,
    head_commit: input.head_commit ?? null,
    prior_commits: [],
    change_set_origin: "attempt",
    executor_skills: [],
    executor_account: null,
    brief_reinjections: [],
    resumed_from: null,
    merged_base: null,
    spec_commit: null,
    swept_processes: [],
    base_verification: null,
    provisioning_verify: null,
    wait: null,
  } satisfies ExecutionAttempt);
}

export const finding = (overrides: Partial<Finding> = {}): Finding => ({
  key: "f".repeat(64),
  rule_id: "test.missing_for_criterion",
  source: "semantic",
  criterion_id: "ac_1",
  severity: "major",
  blocking: false,
  blocking_reason: "verification: routed to the executor",
  routing: "remediable",
  row: null,
  closure: null,
  direction: null,
  caused_by_change: null,
  confidence: 0.9,
  file: "src/feature.ts",
  line: 1,
  symbol: "total",
  statement: "No test exercises total(); nothing establishes ac_1.",
  status: "open",
  outcome: "unknown",
  waiver: null,
  ...overrides,
});

export function makeReview(overrides: {
  review_id?: string;
  decision?: ReviewArtifact["decision"];
  findings?: Finding[];
  /** One entry per criterion the reviewer read; each defaults to an asserted-only strength. */
  coverage?: ReadonlyArray<{
    criterion_id: string;
    status: "met" | "not_met" | "cannot_determine";
    verification_strength?: "directly_verified" | "proxy" | "asserted_only";
  }>;
  head_commit?: string;
  error?: {
    kind: NonNullable<ReviewArtifact["error"]>["kind"];
    message?: string;
    attempts?: number;
    unresolved_criteria?: string[];
    reading?: string[];
  };
  /**
   * The change set the reviewer was handed, echoed back the way a real one
   * does — it is told what to judge and states it in its verdict. A double that
   * names a change set nobody sealed is a double that cannot be joined to the
   * attempt it judged, which is a property of the double and not of the loop.
   */
  changeset_id?: string;
} = {}): ReviewArtifact {
  return ReviewArtifactSchema.parse({
    schema_version: 1,
    review_id: overrides.review_id ?? "rev_0000000000000001",
    created_at: "2026-08-27T00:00:00.000Z",
    target: {
      type: "changeset",
      id: overrides.changeset_id ?? "cs_0000000000000001",
      base_commit: "abc1234",
      head_commit: overrides.head_commit ?? "def5678",
    },
    plan_id: "plan_stage2",
    plan_version: 1,
    planned_risk: "P1",
    actual_risk: "P1",
    escalated: false,
    independence: {
      context_builder: "reviewer_v2",
      executor_narrative_visible: false,
      executor_transcript_visible: false,
      separate_process: true,
      model_family: "same",
      grounded_in: ["plan.acceptance_criteria", "diff", "check_results", "selected_files"],
    },
    context_manifest: [],
    checks: [],
    overrides: [],
    coverage: (overrides.coverage ?? [{ criterion_id: "ac_1", status: "met" as const }]).map(
      (entry) => ({
        criterion_id: entry.criterion_id,
        status: entry.status,
        verification_strength: entry.verification_strength ?? "asserted_only",
        evidence: null,
        note: null,
      }),
    ),
    findings: overrides.findings ?? [],
    scope_deviation: {
      files_outside_scope: [],
      files_in_prohibited_paths: [],
      files_exempt_as_generated: [],
      within_expansion_budget: true,
      expansion_budget_files: 2,
    },
    decision: overrides.decision ?? "approve",
    confidence: 0.9,
    cost_micros: 1000,
    latency_ms: 100,
    model: {
      provider: "stub",
      model_id: "stub",
      prompt_version: "reviewer_v2",
      input_tokens: 1,
      output_tokens: 1,
    },
    error:
      overrides.error === undefined
        ? null
        : {
            kind: overrides.error.kind,
            message: overrides.error.message ?? "the review did not complete",
            attempts: overrides.error.attempts ?? 1,
            unresolved_criteria: overrides.error.unresolved_criteria ?? [],
            reading: overrides.error.reading ?? [],
          },
  });
}

/**
 * A round's records as the re-injected brief's state block reads them (D-096).
 *
 * A graph with two nodes, one of which has a failed check, so the two things
 * the block must get right — criteria grouped by node, and a node's state read
 * from the per-node results — are both exercised by the default. Overrides
 * empty `nodes` for a flat plan and `checks` for a round nothing has measured.
 */
export const briefRecords = (overrides: Record<string, unknown> = {}): BriefRecords =>
  BriefRecordsSchema.parse({
    outcome: "The feature module exports a computed total",
    acceptance_criteria: [
      {
        id: "ac_1",
        text: "total() returns the sum of its inputs",
        expected_verification: { kind: "test", assertion: "total([1,2]) is 3" },
      },
      {
        id: "ac_2",
        text: "the report renders the total",
        expected_verification: { kind: "test", assertion: "the row shows 3" },
      },
    ],
    nodes: [
      { id: "node_total", title: "The total", criteria: ["ac_1"], paths: ["src/total/**"] },
      { id: "node_report", title: "The report", criteria: ["ac_2"], paths: ["src/report/**"] },
    ],
    paths_allowed: ["src/**", "test/**"],
    paths_prohibited: [".github/**", "specs/**"],
    no_gos: ["No new dependency reaches the lockfile"],
    principles: null,
    checks: [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        status: "failed",
        summary: "Tests  1 failed (12)",
        command: "pnpm exec vitest run test/total.test.ts",
        detail: null,
        duration_ms: 1200,
        source: "file",
        node: { node_id: "node_total", paths: ["test/total.test.ts"], scope: "files", note: null },
      },
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        status: "passed",
        summary: "Tests  12 passed (12)",
        command: "pnpm exec turbo run test",
        detail: null,
        duration_ms: 900,
        source: "file",
        node: {
          node_id: "node_report",
          paths: [],
          scope: "task",
          note: "no changed file inside the node's paths is a test file",
        },
      },
    ],
    open_findings: [finding()],
    ...overrides,
  });
