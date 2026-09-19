import { describe, expect, it } from "vitest";
import { BRIEF_TARGET_MAX_CHARS, BriefReinjectionSchema, EXECUTION_ATTEMPT_SCHEMA_VERSION, ExecutionAttemptSchema } from "../src/attempt.js";

/**
 * D-096: every time an attempt's brief went back after a compaction is on the
 * attempt's own record, so `perbo inspect` can say an executor was re-briefed
 * twice in a round rather than leaving the answer in a transcript.
 */

/** An attempt as the loop writes one, minus whatever a case is about. */
const attempt = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: EXECUTION_ATTEMPT_SCHEMA_VERSION,
  attempt_id: "att_0000000000000001",
  root_attempt_id: "att_0000000000000001",
  continues_attempt_id: null,
  remediation_round: 0,
  created_at: "2026-09-13T00:00:00.000Z",
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

describe("the re-injections an attempt records (D-096)", () => {
  it("reads back both of two, with the agent each went to", () => {
    const parsed = ExecutionAttemptSchema.parse(
      attempt({
        brief_reinjections: [
          { target: null, mechanism: "session_start_hook", at: "2026-09-13T10:00:00.000Z" },
          {
            target: "a1068d4ecef4890c3",
            mechanism: "session_start_hook",
            at: "2026-09-13T10:20:00.000Z",
          },
        ],
      }),
    );
    expect(parsed.brief_reinjections).toHaveLength(2);
    expect(parsed.brief_reinjections[0]!.target).toBeNull();
    expect(parsed.brief_reinjections[1]!.target).toBe("a1068d4ecef4890c3");
    expect(parsed.brief_reinjections[1]!.at).toBe("2026-09-13T10:20:00.000Z");
  });

  it("reads a Codex thread's re-injection under its own mechanism", () => {
    const parsed = ExecutionAttemptSchema.parse(
      attempt({
        brief_reinjections: [
          {
            target: "01a0955f-3dc1-0000-0000-000000000000",
            mechanism: "thread_inject_items",
            at: "2026-09-13T10:00:00.000Z",
          },
        ],
      }),
    );
    expect(parsed.brief_reinjections[0]!.mechanism).toBe("thread_inject_items");
  });

  it("reads a record written before the field existed as none", () => {
    expect(ExecutionAttemptSchema.parse(attempt()).brief_reinjections).toEqual([]);
  });

  it("holds a target to the length an agent or thread id has", () => {
    expect(() =>
      BriefReinjectionSchema.parse({ target: "x".repeat(BRIEF_TARGET_MAX_CHARS + 1), mechanism: "session_start_hook", at: "2026-09-13T10:00:00.000Z" }),
    ).toThrow();
  });

  it("refuses a mechanism nobody declared", () => {
    expect(() =>
      ExecutionAttemptSchema.parse(
        attempt({
          brief_reinjections: [
            { target: null, mechanism: "smuggled", at: "2026-09-13T10:00:00.000Z" },
          ],
        }),
      ),
    ).toThrow();
  });
});
