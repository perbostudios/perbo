import type { Workspace } from "@perbo/workspace";
import type { AttemptWait } from "@perbo/contracts";
import type { HeldRunLock } from "../../lock.js";
import type { AgentResult } from "../../adapter.js";
import { EgressLog } from "../../egress.js";
import { makeAttempt } from "../../test-support/records.js";
import { initialRoundState, type RoundState } from "../state.js";
import {
  planContractFromSource,
  type ExecutionAttempt,
  type PlanContractWithCriteria,
} from "@perbo/contracts";

/**
 * Typed builders for the loop's own tests.
 *
 * A phase test states one fact, so each builder carries a whole valid value
 * and takes an override for the field under test. The contract records come
 * from the package's own `test-support/records.ts`; what is here is the loop's
 * own state, its ports and the defaults its phases read.
 */

/**
 * An attempt as the loop's own phases read one.
 *
 * The credential is an API key, because a subscription attempt is the one the
 * ledger declines to price and every cost case here is about one it does.
 */
export const attempt = (
  input: {
    attempt_id: string;
    ticket_id?: string;
    root_attempt_id?: string;
    remediation_round?: number;
    created_at?: string;
    head_commit?: string | null;
    credential_class?: "subscription" | "user_api_key" | "unknown";
    cost_micros?: number;
    cost_basis?: ExecutionAttempt["usage"]["cost_basis"];
  } = { attempt_id: "att_0000000000000001" },
): ExecutionAttempt =>
  makeAttempt({ ...input, credential_class: input.credential_class ?? "user_api_key" });

const WORKSPACE: Workspace = {
  attempt_id: "att_0000000000000001",
  root_attempt_id: "att_0000000000000001",
  repository_id: "repo_fixture",
  repository_root: "/nowhere/repo",
  branch: "ayo/fixture/the-feature-module",
  path: "/nowhere/worktree",
  base_commit: "a1b2c3d",
  lease: {
    attempt_id: "att_0000000000000001",
    root_attempt_id: "att_0000000000000001",
    repository_id: "repo_fixture",
    branch: "ayo/fixture/the-feature-module",
    path: "/nowhere/worktree",
    base_commit: "a1b2c3d",
    created_at: "2026-08-27T00:00:00.000Z",
    expires_at: "2026-08-27T01:00:00.000Z",
    pid: 1,
    host: "fixture",
    port_range_start: null,
    port_range_end: null,
  },
  continued: false,
};

export const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  ...WORKSPACE,
  ...overrides,
});

/** A round state as the loop enters a round, with the field under test set. */
export const roundState = (overrides: Partial<RoundState> = {}): RoundState => ({
  ...initialRoundState(WORKSPACE, null),
  ...overrides,
});

/** A plan contract with one criterion, minted the way a source's is. */
export const contract = (
  overrides: { outcome?: string; paths_allowed?: readonly string[] } = {},
): PlanContractWithCriteria =>
  planContractFromSource({
    contract: {
      source: "arguments",
      reference: null,
      url: null,
      title: null,
      outcome: overrides.outcome ?? "the feature works",
      outcome_from: "stated",
      criteria: [{ id: "ac_1", text: "total() is exercised", assertion: "a test calls total()", kind: "test" }],
    },
    base_commit: "a1b2c3d",
    repository_id: "repo_fixture",
    paths_allowed: overrides.paths_allowed ?? ["src/**"],
    captured_at: new Date("2026-08-27T00:00:00.000Z"),
  });

/** What an executor that finished and wrote nothing surprising returns. */
export const agentResult = (
  overrides: { termination?: AgentResult["termination"]; commands?: AgentResult["commands"] } = {},
): AgentResult => ({
  invocation: {
    adapter: "double",
    binary_path: "/bin/true",
    binary_version: "0.0.0",
    binary_sha256: "0".repeat(64),
    model: "double",
    credential_class: "user_api_key",
    argv: ["-p", "<prompt>"],
    shape_sha256: "1".repeat(64),
    neutralisation: {
      suppressed_at_invocation: ["double"],
      withheld_from_worktree: [],
      asserted_empty: ["mcp_servers"],
      reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
    },
  },
  commands: overrides.commands ?? [],
  egress: new EgressLog([]),
  prohibited: [],
  usage: {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_micros: 0,
    cost_basis: "transport_reported",
    cost_partial: false,
    iterations: 0,
  },
  termination: overrides.termination ?? { reason: "completed", detail: "" },
  final_message: null,
  transcript: [],
});

/** A run lock that records the parks written to it rather than a file. */
export function fakeLock(): HeldRunLock & { parks: (AttemptWait | null)[] } {
  const parks: (AttemptWait | null)[] = [];
  return {
    path: "/nowhere/run.lock",
    parks,
    parked: (wait) => {
      parks.push(wait);
    },
    release: () => undefined,
  };
}
