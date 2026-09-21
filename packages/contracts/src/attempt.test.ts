import { describe, expect, it } from "vitest";
import {
  EXECUTION_ATTEMPT_SCHEMA_VERSION,
  ExecutionAttemptSchema,
  TERMINATION_REASONS,
} from "./attempt.js";

/**
 * The two verification fields an attempt carries, and what a record written
 * before they existed parses to.
 *
 * `base_verification` is the ticket's answer about the contract's base commit —
 * the thing a check failure's attribution rests on — and `provisioning_verify`
 * is the verify this attempt's own worktree ran, which for an attempt that
 * continued a ticket is the ticket's own sealed head. An older record has
 * neither, and the absence has to read as "nobody measured it" rather than as
 * "the base failed": the review is told nothing on `undefined` and told the
 * change is not to blame on `false`.
 */

/** An attempt as the loop writes one, minus whatever a case is about. */
const attempt = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: EXECUTION_ATTEMPT_SCHEMA_VERSION,
  attempt_id: "att_0000000000000001",
  root_attempt_id: "att_0000000000000001",
  continues_attempt_id: null,
  remediation_round: 0,
  created_at: "2026-09-10T00:00:00.000Z",
  ticket_id: "ticket_base00001",
  plan_id: "plan_base00001",
  plan_version: 1,
  planned_risk: "P1",
  repository_id: "repo_fixture",
  base_ref: "main",
  base_commit: "a1b2c3d",
  provider: "local_worktree",
  branch: "ayo/fixture/the-feature",
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
    credential_class: "subscription",
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
    materialized_paths: [],
    secret_content_sha256: [],
    port_range_start: 41_000,
    port_range_end: 41_000,
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
    output_tokens: 0,
    cost_micros: 0,
    cost_basis: "transport_reported",
    wall_clock_ms: 0,
    commands: 0,
    iterations: 0,
  },
  termination: { reason: "completed", detail: "" },
  changeset_id: null,
  head_commit: null,
  ...overrides,
});

describe("an attempt's base verification", () => {
  it("defaults both fields to null on a record written before they existed", () => {
    const parsed = ExecutionAttemptSchema.parse(attempt());
    expect(parsed.base_verification).toBeNull();
    expect(parsed.provisioning_verify).toBeNull();
  });

  it("keeps the commit each was measured on beside its result", () => {
    const parsed = ExecutionAttemptSchema.parse(
      attempt({
        base_verification: { commit: "a1b2c3d", verified: true },
        provisioning_verify: { commit: "d4e5f6a", verified: false },
      }),
    );
    expect(parsed.base_verification).toEqual({ commit: "a1b2c3d", verified: true });
    expect(parsed.provisioning_verify).toEqual({ commit: "d4e5f6a", verified: false });
  });

  it("refuses a verification that names no commit", () => {
    expect(() =>
      ExecutionAttemptSchema.parse(attempt({ base_verification: { verified: true } })),
    ).toThrow();
  });
});

/**
 * SCP-323: `stalled` is the reason the stall detector terminates with, and it
 * has to be on the record's own enum before the runner can write one.
 */
describe("a stalled attempt's termination reason", () => {
  it("is accepted on the record, distinct from the wall clock's", () => {
    expect(TERMINATION_REASONS).toContain("stalled");
    const parsed = ExecutionAttemptSchema.parse(
      attempt({
        termination: {
          reason: "stalled",
          detail: "attempt_stall_ms would reach 1200001, above the limit of 1200000",
        },
      }),
    );
    expect(parsed.termination.reason).toBe("stalled");
  });
});
