import { describe, expect, it } from "vitest";
import {
  EXECUTION_ATTEMPT_SCHEMA_VERSION,
  ExecutionAttemptSchema,
  TICKET_SCHEMA_VERSION,
  TicketSchema,
  admittedSpecFiles,
  type Ticket,
} from "../src/index.js";

const HASH = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;

const ticket = (spec: unknown): Ticket =>
  TicketSchema.parse({
    schema_version: TICKET_SCHEMA_VERSION,
    ticket_id: "ticket_01abcdef",
    key: "PRB-1",
    title: "New users receive an activation email within 60 seconds of signing up.",
    state: "plan_review",
    priority: "normal",
    labels: [],
    depends_on: [],
    source: { kind: "none", reference: null, url: null, title_at_admission: null },
    repository_root: "/repo",
    plan_id: "plan_01abcdef",
    plan_version: 1,
    approved_at: null,
    admitted_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    admission: { elapsed_ms: 10, criteria_source: "spec", criteria_count: 1, spec },
    history: [{ at: "2026-08-28T00:00:00.000Z", from: null, to: "plan_review", note: "admitted" }],
  });

describe("the files admission records the spec covering", () => {
  it("reads a record written before the field existed back as covering spec.md alone", () => {
    const recorded = ticket({
      path: "specs/activation-email/spec.md",
      content_sha256: HASH,
    }).admission.spec;
    expect(recorded?.files).toEqual([]);
    expect(admittedSpecFiles(recorded!)).toEqual([
      { path: "specs/activation-email/spec.md", content_sha256: HASH },
    ]);
  });

  it("keeps the listed files where admission recorded them, spec.md included", () => {
    const recorded = ticket({
      path: "specs/activation-email/spec.md",
      content_sha256: HASH,
      files: [
        { path: "specs/activation-email/spec.md", content_sha256: HASH },
        { path: "specs/activation-email/nodes/node_1.md", content_sha256: OTHER },
        { path: "CONTEXT.md", content_sha256: OTHER },
      ],
    }).admission.spec;
    expect(admittedSpecFiles(recorded!).map((file) => file.path)).toEqual([
      "specs/activation-email/spec.md",
      "specs/activation-email/nodes/node_1.md",
      "CONTEXT.md",
    ]);
  });

  it("refuses a key the record does not declare, and a file with no hash", () => {
    expect(() =>
      ticket({ path: "specs/a/spec.md", content_sha256: HASH, file_list: [] }),
    ).toThrow();
    expect(() =>
      ticket({
        path: "specs/a/spec.md",
        content_sha256: HASH,
        files: [{ path: "specs/a/spec.md" }],
      }),
    ).toThrow();
    expect(() =>
      ticket({
        path: "specs/a/spec.md",
        content_sha256: HASH,
        files: [{ path: "specs/a/spec.md", content_sha256: "not-a-hash" }],
      }),
    ).toThrow();
  });
});

describe("what the baseline of names was taken with", () => {
  it("reads a record written before the flag existed back as one whose symbols were judged", () => {
    // Every ticket already in every store was written by a version that took
    // the baseline exactly as this one does: what it recorded was judged.
    // Defaulting the other way would turn the symbol half of the stale-spec
    // reading off for all of them at once, silently.
    expect(
      ticket({
        path: "specs/activation-email/spec.md",
        content_sha256: HASH,
        names_that_resolved: ["@sendActivation"],
      }).admission.spec?.symbols_judged_at_approval,
    ).toBe(true);
  });

  it("keeps a recorded false, which is the approval that could not believe the index", () => {
    expect(
      ticket({
        path: "specs/activation-email/spec.md",
        content_sha256: HASH,
        names_that_resolved: [],
        symbols_judged_at_approval: false,
      }).admission.spec?.symbols_judged_at_approval,
    ).toBe(false);
  });
});

describe("the commit an attempt's spec sits in", () => {
  const attempt = (overrides: Record<string, unknown> = {}) =>
    ExecutionAttemptSchema.parse({
      schema_version: EXECUTION_ATTEMPT_SCHEMA_VERSION,
      attempt_id: "att_0000000000000001",
      root_attempt_id: "att_0000000000000001",
      continues_attempt_id: null,
      remediation_round: 0,
      created_at: "2026-08-28T00:00:00.000Z",
      ticket_id: "ticket_01abcdef",
      plan_id: "plan_01abcdef",
      plan_version: 1,
      planned_risk: "P1",
      repository_id: "repo_fixture",
      base_ref: "main",
      base_commit: "0".repeat(40),
      provider: "local_worktree",
      branch: "prb/ticket_01abcdef/slug",
      worktree_path: "/worktree",
      autonomy_class: "A2b",
      permission_profile: {
        autonomy_class: "A2b",
        command_allow_list: ["Bash"],
        command_deny_list: ["gh"],
        path_jail_root: "/worktree",
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
        argv: ["-p"],
        shape_sha256: "1".repeat(64),
        neutralisation: {
          suppressed_at_invocation: [],
          withheld_from_worktree: [],
          asserted_empty: [],
          reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
        },
      },
      environment: {
        manifest_hash: `sha256:${"0".repeat(64)}`,
        materialized_paths: [],
        secret_content_sha256: [],
        port_range_start: 4000,
        port_range_end: 4009,
        database_schema: null,
        env_names_passed: [],
        env_names_dropped: 0,
      },
      commands: [],
      egress: [],
      prohibited_action_hits: [],
      user_instructions: [],
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
        cost_micros: 0,
        cost_basis: "not_incurred",
        wall_clock_ms: 1,
        commands: 0,
        iterations: 1,
      },
      termination: { reason: "completed", detail: "" },
      changeset_id: null,
      head_commit: null,
      ...overrides,
    });

  it("defaults to none, so a record written before the field existed parses", () => {
    expect(attempt().spec_commit).toBeNull();
  });

  it("carries the commit the loop put the spec in", () => {
    expect(attempt({ spec_commit: "1".repeat(40) }).spec_commit).toBe("1".repeat(40));
  });
});
