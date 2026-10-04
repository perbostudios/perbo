import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import type { AgentResult } from "../adapter.js";
import { EgressLog } from "../egress.js";
import { TicketRunConfigSchema, runTicket } from "./index.js";
import { makeContract, makeReview } from "../test-support/records.js";
import { runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * A review whose provider refused the request Perbo built (`request_refused`).
 *
 * It is a review that did not happen, so it is `review_failed` and never a
 * verdict, and unlike a provider that could not serve it is never taken again:
 * the same request is refused the same way, and waiting for it spends the
 * person's time on nothing.
 */

const agent = async (request: {
  worktree: string;
  profile: { network_allow_list: readonly string[] };
}): Promise<AgentResult> => {
  mkdirSync(join(request.worktree, "src"), { recursive: true });
  writeFileSync(join(request.worktree, "src", "thing.ts"), "export const thing = 1;\n");
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

function setUp() {
  const repo = runnerRepository(scratch);
  const contract = makeContract();
  contract.base.base_commit = repo.head;
  const root = scratch("perbo-refused-");
  const config = TicketRunConfigSchema.parse({
    ticket_key: "SCP300",
    repository_root: repo.dir,
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
  return { contract, config };
}

describe("a review whose provider refused the request", () => {
  it("is review_failed, says trying again will not help, and is reviewed once", async () => {
    const { contract, config } = setUp();
    let reviews = 0;
    const slept: number[] = [];
    const result = await runTicket({
      config,
      contract,
      sleep: async (ms: number) => void slept.push(ms),
      hooks: {
        agent: agent as never,
        review: (async () => {
          reviews += 1;
          return {
            artifact: makeReview({
              review_id: "rev_0000000000000300",
              decision: "error",
              coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
              error: {
                kind: "request_refused",
                message: "BadRequestError 400: invalid_request_error",
                attempts: 1,
                unresolved_criteria: ["ac_1"],
                reading: [],
              },
            }),
            bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
          };
        }) as never,
      },
    });

    expect(result.outcome).toBe("review_failed");
    expect(result.detail).toContain("request_refused");
    expect(result.detail).toContain("reviewing again will not help");
    expect(reviews).toBe(1);
    expect(slept).toEqual([]);
    expect(result.rounds[0]?.review?.decision).toBe("error");
  }, 60_000);
});
