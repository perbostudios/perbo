import {
  EXECUTION_ATTEMPT_SCHEMA_VERSION,
  ExecutionAttemptSchema,
  ReviewArtifactSchema,
  type ExecutionAttempt,
  type Finding,
  type ReviewArtifact,
} from "@perbo/contracts";

/**
 * Typed builders for the loop's own tests.
 *
 * A phase test states one fact, so each builder carries a whole valid value
 * and takes an override for the field under test. They are parsed through the
 * schemas rather than asserted into shape, so a builder that has drifted from
 * a contract fails here rather than in the phase.
 */

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

export function review(overrides: {
  review_id?: string;
  decision?: ReviewArtifact["decision"];
  findings?: Finding[];
  head_commit?: string;
  coverage?: Array<{
    criterion_id: string;
    status: "met" | "not_met" | "cannot_determine";
    verification_strength?: "directly_verified" | "proxy" | "asserted_only";
  }>;
} = {}): ReviewArtifact {
  return ReviewArtifactSchema.parse({
    schema_version: 1,
    review_id: overrides.review_id ?? "rev_0000000000000001",
    created_at: "2026-08-27T00:00:00.000Z",
    target: {
      type: "changeset",
      id: "cs_0000000000000001",
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
    error: null,
  });
}

export function attempt(input: {
  attempt_id: string;
  ticket_id?: string;
  root_attempt_id?: string;
  remediation_round?: number;
  created_at?: string;
  head_commit?: string | null;
  credential_class?: "subscription" | "user_api_key" | "unknown";
  cost_micros?: number;
  cost_basis?: ExecutionAttempt["usage"]["cost_basis"];
} = { attempt_id: "att_0000000000000001" }): ExecutionAttempt {
  return ExecutionAttemptSchema.parse({
    schema_version: EXECUTION_ATTEMPT_SCHEMA_VERSION,
    attempt_id: input.attempt_id,
    root_attempt_id: input.root_attempt_id ?? input.attempt_id,
    continues_attempt_id: null,
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
    branch: "ayo/fixture/the-feature-module",
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
      credential_class: input.credential_class ?? "user_api_key",
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
    termination: { reason: "completed", detail: "" },
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
