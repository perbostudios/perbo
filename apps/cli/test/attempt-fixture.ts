import {
  ExecutionAttemptSchema,
  ReviewArtifactSchema,
  TicketSchema,
  type ExecutionAttempt,
  type Finding,
  type ReviewArtifact,
  type Ticket,
} from "@perbo/contracts";

/**
 * Records shaped exactly as the loop writes them, validated through the same
 * schemas, so a test store is indistinguishable from a real one to the code
 * that reads it back.
 */

export const FINDING_KEY = "a".repeat(64);

export function makeTicket(input: {
  key: string;
  ticket_id: string;
  repository_root: string;
  pull_request_url?: string | null;
  state?: Ticket["state"];
  /** How many runs the history should say started; the record may or may not exist. */
  runs_started?: number;
  /** Overrides the generated history entirely, for a specific transition sequence a test needs. */
  history?: Ticket["history"];
}): Ticket {
  const runs = Array.from({ length: input.runs_started ?? 0 }, (_, index) => [
    {
      at: `2026-08-28T11:4${index}:00.000Z`,
      from: "ready" as const,
      to: "provisioning" as const,
      note: "run started against plan_fixture0001",
    },
    {
      at: `2026-08-28T11:4${index}:30.000Z`,
      from: "provisioning" as const,
      to: "failed" as const,
      note: "the attempt did not complete: terminated",
    },
    { at: `2026-08-28T11:4${index}:40.000Z`, from: "failed" as const, to: "ready" as const, note: "new attempt" },
  ]).flat();
  return TicketSchema.parse({
    schema_version: 1,
    ticket_id: input.ticket_id,
    key: input.key,
    title: "Search results are paginated.",
    state: input.state ?? "changes_requested",
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: input.repository_root,
    plan_id: "plan_fixture0001",
    plan_version: 1,
    approved_at: "2026-08-28T11:33:19.894Z",
    admitted_at: "2026-08-28T11:33:17.079Z",
    updated_at: "2026-08-28T12:00:42.968Z",
    admission: { elapsed_ms: 25, criteria_source: "typed", criteria_count: 1 },
    delivery: {
      branch: "ayo/fixture/search-results-are-paginated",
      pull_request_url: input.pull_request_url ?? null,
      pull_request_number: input.pull_request_url ? 9 : null,
      state: input.pull_request_url ? "open" : "none",
      observed_at: "2026-08-28T12:00:42.968Z",
    },
    history: input.history ?? [
      { at: "2026-08-28T11:33:17.079Z", from: null, to: "plan_review", note: "admitted" },
      { at: "2026-08-28T11:33:19.894Z", from: "plan_review", to: "ready", note: "contract approved" },
      ...runs,
    ],
  });
}

export function makeAttempt(input: {
  attempt_id: string;
  ticket_id: string;
  created_at: string;
  termination: ExecutionAttempt["termination"];
  usage: Partial<ExecutionAttempt["usage"]>;
  changeset_id: string | null;
  head_commit: string | null;
  root_attempt_id?: string;
  continues_attempt_id?: string | null;
  remediation_round?: number;
  change_set_origin?: ExecutionAttempt["change_set_origin"];
  prior_commits?: ExecutionAttempt["prior_commits"];
  commands?: ExecutionAttempt["commands"];
  base_verification?: ExecutionAttempt["base_verification"];
  provisioning_verify?: ExecutionAttempt["provisioning_verify"];
  /** The branch the attempt worked on. */
  branch?: string;
}): ExecutionAttempt {
  return ExecutionAttemptSchema.parse({
    schema_version: 1,
    ...(input.base_verification === undefined ? {} : { base_verification: input.base_verification }),
    ...(input.provisioning_verify === undefined
      ? {}
      : { provisioning_verify: input.provisioning_verify }),
    attempt_id: input.attempt_id,
    root_attempt_id: input.root_attempt_id ?? input.attempt_id,
    continues_attempt_id: input.continues_attempt_id ?? null,
    remediation_round: input.remediation_round ?? 0,
    change_set_origin: input.change_set_origin ?? "attempt",
    prior_commits: input.prior_commits ?? [],
    created_at: input.created_at,
    ticket_id: input.ticket_id,
    plan_id: "plan_fixture0001",
    plan_version: 1,
    planned_risk: "P1",
    repository_id: "repo_fixture",
    base_ref: "HEAD",
    base_commit: "a1b2c3d",
    provider: "local_worktree",
    branch: input.branch ?? "ayo/fixture/search-results-are-paginated",
    worktree_path: "/tmp/perbo-fixture-worktree",
    autonomy_class: "A2b",
    permission_profile: {
      autonomy_class: "A2b",
      command_allow_list: ["Bash", "Edit"],
      command_deny_list: ["gh"],
      path_jail_root: "/tmp/perbo-fixture-worktree",
      env_allow_list: ["HOME", "PATH"],
      network_allow_list: ["api.anthropic.com"],
      provider_base_url: "https://api.anthropic.com",
      lifecycle_scripts: "disabled",
      prohibited_actions: ["self_merge", "write_policy_path"],
    },
    agent: {
      adapter: "claude-code",
      binary_path: "/usr/local/bin/claude",
      binary_version: "1.0.98",
      binary_sha256: "0".repeat(64),
      model: "claude-opus-5",
      credential_class: "subscription",
      argv: ["claude", "-p", "(prompt)"],
      shape_sha256: "1".repeat(64),
      neutralisation: {
        suppressed_at_invocation: ["--strict-mcp-config"],
        withheld_from_worktree: [],
        asserted_empty: ["mcp_servers"],
        reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
      },
    },
    environment: {
      manifest_hash: "sha256:fixture",
      materialized_paths: [],
      secret_content_sha256: [],
      port_range_start: 41000,
      port_range_end: 41000,
      database_schema: null,
      env_names_passed: ["HOME", "PATH"],
      env_names_dropped: 3,
    },
    commands: input.commands ?? [],
    egress: [],
    prohibited_action_hits: [],
    user_instructions: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cost_micros: 0,
      cost_basis: "transport_reported",
      wall_clock_ms: 0,
      commands: 0,
      iterations: 0,
      ...input.usage,
    },
    termination: input.termination,
    changeset_id: input.changeset_id,
    head_commit: input.head_commit,
  });
}

export function makeReview(input: {
  review_id: string;
  changeset_id: string;
  decision: ReviewArtifact["decision"];
  cost_basis: ReviewArtifact["model"]["cost_basis"];
  cost_micros?: number;
  checks?: ReviewArtifact["checks"];
}): ReviewArtifact {
  return ReviewArtifactSchema.parse({
    schema_version: 1,
    review_id: input.review_id,
    created_at: "2026-08-28T11:52:00.000Z",
    target: { type: "changeset", id: input.changeset_id, base_commit: "a1b2c3d", head_commit: "b2c3d4e" },
    plan_id: "plan_fixture0001",
    plan_version: 1,
    planned_risk: "P1",
    actual_risk: "P1",
    escalated: false,
    independence: {
      context_builder: "perbo",
      executor_narrative_visible: false,
      executor_transcript_visible: false,
      separate_process: true,
      model_family: "same",
      grounded_in: ["diff", "checks"],
    },
    context_manifest: [],
    checks: input.checks ?? [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        status: "passed",
        summary: "12 passed",
        command: "pnpm exec turbo run test",
        detail: null,
        duration_ms: 1200,
        source: "file",
      },
    ],
    overrides: [],
    coverage: [],
    findings: [
      {
        key: FINDING_KEY,
        rule_id: "test.mocks_module_under_test",
        source: "semantic",
        criterion_id: "ac_1",
        severity: "major",
        blocking: false,
        blocking_reason: "verification_strength: proxy evidence, routed to the executor",
        routing: "remediable",
        row: "verification_strength",
        closure: "executor",
        direction: "negative",
        confidence: 0.8,
        file: "packages/search/test/query.test.ts",
        line: 12,
        symbol: null,
        statement: "The suite mocks the module under test, so the criterion is proxy-verified.",
        status: "open",
        outcome: "unknown",
        waiver: null,
      },
    ],
    scope_deviation: {
      files_outside_scope: [],
      files_in_prohibited_paths: [],
      files_exempt_as_generated: [],
      within_expansion_budget: true,
      expansion_budget_files: 3,
    },
    decision: input.decision,
    routing_policy: "d065",
    remediation: null,
    confidence: 0.8,
    cost_micros: input.cost_micros ?? 0,
    latency_ms: 4000,
    model: {
      provider: "claude-cli",
      model_id: "claude-opus-5",
      prompt_version: "review_v7",
      input_tokens: 100,
      output_tokens: 50,
      cost_basis: input.cost_basis,
    },
    error: null,
  });
}

/** The four rule ids `makeRoutedReview` carries, in the order it lists them. */
export const ROUTED_RULES = ["test.assertion_missing", "code.unused_import"] as const;
export const BLOCKING_RULE = "auth.token_never_expires";
export const ESCALATED_RULE = "concurrency.unlocked_write";

/**
 * A review carrying the routings a reader has to tell apart: two findings the
 * executor closed, one that blocks and one that escalates, over two criteria —
 * one of which has nothing but routed findings under it.
 */
export function makeRoutedReview(input: {
  review_id: string;
  changeset_id: string;
}): ReviewArtifact {
  const one = (over: Partial<Finding>): Finding =>
    ({
      key: "0".repeat(64),
      rule_id: ROUTED_RULES[0],
      source: "semantic",
      criterion_id: "ac_2",
      severity: "major",
      blocking: false,
      blocking_reason: "verification_strength: proxy evidence, routed to the executor",
      routing: "remediable",
      row: "verification_strength",
      closure: "executor",
      direction: "negative",
      confidence: 0.8,
      file: "packages/search/src/query.ts",
      line: 4,
      symbol: null,
      statement: "No test exercises total().",
      status: "open",
      outcome: "unknown",
      waiver: null,
      ...over,
    }) as Finding;
  return ReviewArtifactSchema.parse({
    ...makeReview({
      review_id: input.review_id,
      changeset_id: input.changeset_id,
      decision: "changes_requested",
      cost_basis: "provider_list_estimate",
    }),
    coverage: [
      {
        criterion_id: "ac_1",
        status: "met",
        verification_strength: "directly_verified",
        evidence: null,
        note: null,
      },
      {
        criterion_id: "ac_2",
        status: "not_met",
        verification_strength: "asserted_only",
        evidence: null,
        note: "No test reads the total back.",
      },
    ],
    findings: [
      one({ key: "1".repeat(64) }),
      one({
        key: "2".repeat(64),
        rule_id: ROUTED_RULES[1],
        statement: "`readFileSync` is imported and never used.",
      }),
      one({
        key: "3".repeat(64),
        rule_id: BLOCKING_RULE,
        criterion_id: "ac_1",
        blocking: true,
        routing: "blocks",
        row: "semantic_high_risk",
        closure: "human",
        blocking_reason: "security: always blocks — no confidence term",
        statement: "The token carries no exp claim.",
      }),
      one({
        key: "4".repeat(64),
        rule_id: ESCALATED_RULE,
        criterion_id: null,
        routing: "escalates",
        row: "semantic_high_risk",
        closure: "human",
        confidence: 0.5,
        blocking_reason: "below the stated confidence floor: escalated to a human",
        statement: "Two writers reach the counter without a lock.",
      }),
    ],
  });
}
