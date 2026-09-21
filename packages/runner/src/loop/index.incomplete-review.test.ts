import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema, type ReviewArtifact } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import type { AgentResult } from "../adapter.js";
import { EgressLog } from "../egress.js";
import { TicketRunConfigSchema, runTicket } from "./index.js";
import { finding, makeContract, makeReview } from "../test-support/records.js";
import { runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * An `incomplete` verdict whose unjudgeable criteria hang on a finding the
 * executor may be handed.
 *
 * The review artifact carries no field joining a `cannot_determine` criterion
 * to the finding that made it one, so the join is the two things it does
 * carry: the finding's `criterion_id` and its routing. A criterion whose cause
 * is remediable is one a remediation round can answer, and the re-review that
 * follows the round reaches its own verdict; a criterion with no such cause is
 * a person's at once, as it has always been.
 */

/** The executor: one new file per round, so every round seals a change of its own. */
const agentDouble = () => {
  let round = 0;
  const calls: string[] = [];
  const run = async (request: {
    worktree: string;
    prompt: string;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
    calls.push(request.prompt);
    mkdirSync(join(request.worktree, "src"), { recursive: true });
    writeFileSync(join(request.worktree, "src", `round-${round}.ts`), `export const round = ${round};\n`);
    round += 1;
    return {
      invocation: {
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
      commands: [],
      egress: new EgressLog(request.profile.network_allow_list),
      prohibited: [],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: 5,
        cost_micros: 1234,
        cost_basis: "transport_reported",
        cost_partial: false,
        iterations: 1,
      },
      termination: { reason: "completed", detail: "" },
      final_message: null,
      transcript: ['{"type":"result","subtype":"success"}'],
    };
  };
  return { run, calls };
};

function makeConfig(repositoryRoot: string) {
  const root = scratch("perbo-incomplete-");
  return TicketRunConfigSchema.parse({
    ticket_key: "SCP232",
    repository_root: repositoryRoot,
    base_ref: "main",
    worktree_root: join(root, "worktrees"),
    bundle_root: join(root, "bundles"),
    quarantine_root: join(root, "quarantine"),
    state_root: join(root, "state"),
    checks: [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        command: ["node", "-e", "process.exit(0)"],
        timeout_ms: 30_000,
      },
    ],
    agent_binary: "true",
    model: "double",
    max_remediation_rounds: 2,
    limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
  });
}

/**
 * The reviewer, answering with the given verdicts in order and repeating the
 * last. Each echoes the head and change set it was handed, the way a real
 * reviewer states what it judged.
 */
const reviewing = (verdicts: readonly ReviewArtifact[]) => {
  const seen: Array<Record<string, unknown>> = [];
  const review = (async (input: Record<string, unknown>) => {
    const artifact = verdicts[Math.min(seen.length, verdicts.length - 1)]!;
    seen.push(input);
    return {
      artifact: {
        ...artifact,
        target: {
          ...artifact.target,
          id:
            (input.changeset as { changeset_id?: string } | undefined)?.changeset_id ??
            artifact.target.id,
          head_commit: (input.head_commit as string | undefined) ?? artifact.target.head_commit,
        },
      },
      bundle: {
        prompt_version: "reviewer_v2",
        system_prompt: "s",
        turns: [],
        files_read: [],
        rejected_verdicts: [],
      },
    };
  }) as never;
  return { review, seen };
};

const incomplete = (review_id: string, findings: ReturnType<typeof finding>[]) =>
  makeReview({
    review_id,
    decision: "incomplete",
    coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
    findings,
  });

const setUp = () => {
  const repo = runnerRepository(scratch);
  const contract = makeContract();
  contract.base.base_commit = repo.head;
  return { contract, config: makeConfig(repo.dir), agent: agentDouble() };
};

describe("an incomplete review whose unjudgeable criteria hang on a remediable finding", () => {
  it("spends a remediation round on the cause rather than asking a person", async () => {
    const { contract, config, agent } = setUp();
    const reviewer = reviewing([
      incomplete("rev_0000000000000232", [finding()]),
      makeReview({ review_id: "rev_0000000000000233", decision: "approve" }),
    ]);

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: reviewer.review },
    });

    // The round ran, and the executor was handed the finding that made the
    // criterion unjudgeable.
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1]).toContain("remediation round 1 of at most 2");
    expect(agent.calls[1]).toContain("No test exercises total()");
    expect(result.rounds.map((round) => round.kind)).toEqual(["execute", "remediate"]);
    expect(result.incomplete_review).toBe("incomplete_remediated");
  }, 90_000);

  it("re-reviews the round rather than verifying one finding closed", async () => {
    const { contract, config, agent } = setUp();
    const reviewer = reviewing([
      incomplete("rev_0000000000000232", [finding()]),
      makeReview({ review_id: "rev_0000000000000233", decision: "changes_requested" }),
    ]);

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: reviewer.review,
        verify: (async () => {
          throw new Error("a round answering an incomplete verdict is re-reviewed, not verified");
        }) as never,
      },
    });

    // The re-review reached its own verdict and the run recorded that verdict
    // rather than escalating over the first review's silence.
    expect(reviewer.seen).toHaveLength(2);
    expect(result.outcome).toBe("changes_requested");
    expect(result.final_review?.review_id).toBe("rev_0000000000000233");
    expect(result.rounds[1]?.review?.decision).toBe("changes_requested");
    expect(result.rounds[1]?.verification).toBeNull();
    expect(result.incomplete_review).toBe("incomplete_remediated");
  }, 90_000);

  it("escalates when the re-review is still incomplete, with the rounds counted", async () => {
    const { contract, config, agent } = setUp();
    const reviewer = reviewing([incomplete("rev_0000000000000232", [finding()])]);

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: reviewer.review },
    });

    expect(reviewer.seen).toHaveLength(2);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toContain("1 remediation round");
    expect(result.detail).toContain("ac_1");
    // The record says a round ran before the person was asked.
    expect(result.incomplete_review).toBe("incomplete_remediated");
  }, 90_000);
});

describe("an incomplete review whose unjudgeable criteria hang on something else", () => {
  it("escalates at once when the cause is not one the executor may be handed", async () => {
    const { contract, config, agent } = setUp();
    const reviewer = reviewing([
      incomplete("rev_0000000000000232", [
        finding({
          rule_id: "security.credential_in_source",
          routing: "blocks",
          blocking: true,
          blocking_reason: "deterministic: a credential is in the change",
        }),
      ]),
    ]);

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: reviewer.review },
    });

    expect(agent.calls).toHaveLength(1);
    expect(reviewer.seen).toHaveLength(1);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toContain("ac_1");
    expect(result.incomplete_review).toBe("incomplete_escalated");
  }, 90_000);
});
