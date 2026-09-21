import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import type { AgentResult } from "../src/adapter.js";
import type { BriefRecords } from "../src/brief.js";
import { EgressLog } from "../src/egress.js";
import { TicketRunConfigSchema, runTicket } from "../src/loop.js";
import { finding, makeContract, makeReview } from "../src/test-support/records.js";
import { runnerRepository } from "../src/test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * D-096: what the round hands the re-injection mechanisms.
 *
 * The composer is pure and tested on its own; this is the wiring — that the
 * records a round gives the adapter are the round's own, so the state block a
 * compaction composes says what this round is for rather than what some
 * earlier one was.
 */

const INVOCATION: AgentResult["invocation"] = {
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
};

const USAGE = {
  input_tokens: 10,
  cache_read_input_tokens: 0,
  output_tokens: 5,
  cost_micros: 1234,
  cost_basis: "transport_reported",
  cost_partial: false,
  iterations: 1,
} as const;

/** An executor that keeps the records it was given and reports one re-injection. */
const recordingDouble = () => {
  const given: Array<BriefRecords | undefined> = [];
  let round = 0;
  const run = async (request: {
    worktree: string;
    brief_records?: BriefRecords;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
    const mine = round++;
    given.push(request.brief_records);
    const dir = mine === 0 ? "src" : "test";
    mkdirSync(join(request.worktree, dir), { recursive: true });
    writeFileSync(
      join(request.worktree, dir, mine === 0 ? "feature.ts" : "feature.test.ts"),
      mine === 0 ? "export const total = (n) => n.length;\n" : "// exercises total()\n",
    );
    return {
      invocation: { ...INVOCATION },
      commands: [],
      egress: new EgressLog(request.profile.network_allow_list),
      prohibited: [],
      usage: { ...USAGE },
      termination: { reason: "completed", detail: "" },
      transcript: [],
      final_message: null,
      reinjections: [
        {
          target: mine === 0 ? null : "a1068d4ecef4890c3",
          mechanism: "session_start_hook",
          at: `2026-09-13T10:0${mine}:00.000Z`,
        },
      ],
    };
  };
  return { run, given };
};

const remediableReview = (async () => ({
  artifact: makeReview({
    review_id: "rev_0000000000000324",
    decision: "remediable",
    findings: [finding()],
  }),
  bundle: {
    prompt_version: "reviewer_v2",
    system_prompt: "s",
    turns: [],
    files_read: [],
    rejected_verdicts: [],
  },
})) as never;

const closingVerifier = (async (input: Record<string, unknown>) => {
  const keys = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
  return {
    prompt_version: "closure_verify_v1",
    per_finding: keys.map((finding_key) => ({
      finding_key,
      status: "closed",
      pointer: "test/feature.test.ts",
    })),
    deterministic_failure: null,
    all_closed: true,
    open_keys: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    cost_micros: 30,
    cost_basis: "provider_list_estimate",
  };
}) as never;

describe("the records a round hands the re-injection (D-096)", () => {
  it("carries the contract, the scope, the No-Gos and the round's open findings", async () => {
    const repo = runnerRepository(scratch);
    const plan = makeContract();
    plan.base.base_commit = repo.head;
    const root = scratch("perbo-rebrief-round-");
    const config = TicketRunConfigSchema.parse({
      ticket_key: "SCP324",
      repository_root: repo.dir,
      base_ref: "main",
      worktree_root: join(root, "worktrees"),
      bundle_root: join(root, "bundles"),
      quarantine_root: join(root, "quarantine"),
      state_root: join(root, "state"),
      no_gos: ["No new dependency reaches the lockfile"],
      agent_binary: "true",
      model: "double",
      max_remediation_rounds: 2,
      limits: LimitsTableSchema.parse({
        organisation: "test",
        limits: { concurrent_local_attempts: 4 },
      }),
    });
    const agent = recordingDouble();

    const result = await runTicket({
      config,
      contract: plan,
      hooks: { agent: agent.run as never, review: remediableReview, verify: closingVerifier },
    });

    expect(result.outcome).toBe("approved");
    const execute = agent.given[0]!;
    expect(execute.outcome).toBe(plan.outcome);
    expect(execute.acceptance_criteria.map((criterion) => criterion.id)).toEqual(["ac_1"]);
    // The globs the guard enforces, and the prohibitions it judges first — the
    // same two lists the guard's own state file carries.
    expect(execute.paths_allowed).toContain("src/**");
    expect(execute.paths_prohibited).toContain(".github/**");
    expect(execute.paths_prohibited).toContain("specs/**");
    expect(execute.no_gos).toEqual(["No new dependency reaches the lockfile"]);
    // An execute round is open on nothing.
    expect(execute.open_findings).toEqual([]);

    // The remediation round is open on what the review routed to it.
    const remediate = agent.given[1]!;
    expect(remediate.open_findings.map((each) => each.rule_id)).toEqual([
      "test.missing_for_criterion",
    ]);

    // And each round's record says its brief went back once.
    expect(result.rounds[0]?.attempt.brief_reinjections).toHaveLength(1);
    expect(result.rounds[0]?.attempt.brief_reinjections[0]!.target).toBeNull();
    expect(result.rounds[1]?.attempt.brief_reinjections[0]!.target).toBe("a1068d4ecef4890c3");
  }, 60_000);
});
