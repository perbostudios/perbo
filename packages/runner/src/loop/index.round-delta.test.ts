import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { verifyClosures, type ClosureVerification } from "@perbo/review";
import { scratchDirectories } from "@perbo/test-support";
import type { AgentResult } from "../adapter.js";
import { EgressLog } from "../egress.js";
import { TicketRunConfigSchema, runTicket } from "./index.js";
import { finding, makeContract, makeReview } from "../test-support/records.js";
import { runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/** An executor double: each round writes what `write` says, and the rest of the loop is real. */
const agentDouble = (write: (worktree: string, round: number) => void) => {
  let round = 0;
  return async (request: { worktree: string; profile: { network_allow_list: readonly string[] } }): Promise<AgentResult> => {
    write(request.worktree, round);
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
};

/** The pinned unit check: it fails where `src/c.ts` says `broken`, and passes otherwise. */
const UNIT = [
  "node",
  "-e",
  "const f=require('fs');process.exit(f.existsSync('src/c.ts')&&f.readFileSync('src/c.ts','utf8').includes('broken')?1:0)",
];

describe("a failed check's verification names what the round itself changed", () => {
  it("hands the verifier each round's own paths against the commit last judged, not the whole change set", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const root = scratch("perbo-loop-");
    const config = TicketRunConfigSchema.parse({
      ticket_key: "SCP094",
      repository_root: repo.dir,
      base_ref: "main",
      worktree_root: join(root, "worktrees"),
      bundle_root: join(root, "bundles"),
      quarantine_root: join(root, "quarantine"),
      state_root: join(root, "state"),
      checks: [{ check_id: "check_unit", name: "unit", kind: "unit", command: UNIT, timeout_ms: 30_000 }],
      agent_binary: "true",
      model: "double",
      max_remediation_rounds: 3,
      limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
    });

    // Round 0 writes a three-file change; round 1 changes one of them, and
    // round 2 another, which breaks the pinned check.
    const agent = agentDouble((worktree, round) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      if (round === 0) {
        for (const name of ["a", "b", "c"]) writeFileSync(join(worktree, "src", `${name}.ts`), `export const ${name} = 0;\n`);
      } else if (round === 1) {
        writeFileSync(join(worktree, "src", "b.ts"), "export const b = 1;\n");
      } else {
        writeFileSync(join(worktree, "src", "c.ts"), "export const c = 'broken';\n");
      }
    });

    const closedFirst = finding({ key: "a".repeat(64) });
    const stillOpen = finding({ key: "b".repeat(64) });
    const given: Array<{ round_changed: readonly string[] | null; changed: string[] }> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent as never,
        // The review states the change set it was handed, as the real one does.
        review: (async (input: { head_commit?: string; changeset: { changeset_id: string; base_commit: string } }) => {
          const artifact = makeReview({
            review_id: "rev_0000000000000001",
            decision: "remediable",
            findings: [closedFirst, stillOpen],
            head_commit: input.head_commit!,
            changeset_id: input.changeset.changeset_id,
          });
          return {
            artifact: { ...artifact, target: { ...artifact.target, base_commit: input.changeset.base_commit } },
            bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
          };
        }) as never,
        // Round 1's verification closes one finding, so round 2 is earned; round
        // 2's is the real verifier, whose failed check ends the run before any
        // model is asked.
        verify: (async (input: Parameters<typeof verifyClosures>[0]) => {
          given.push({
            round_changed: input.roundChangedPaths,
            changed: input.changeset.files.map((file) => file.path).sort(),
          });
          if (given.length === 2) return verifyClosures(input);
          const keys = input.findings.map((entry) => entry.key);
          const verification: ClosureVerification = {
            prompt_version: "closure_verify_v2",
            per_finding: keys.map((finding_key) => ({
              finding_key,
              status: finding_key === closedFirst.key ? "closed" : "not_closed",
              pointer: "",
              idiomatic: "cannot_tell",
              practice: "",
            })),
            deterministic_failure: null,
            deterministic_failure_kind: null,
            all_closed: false,
            open_keys: [stillOpen.key],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            cost_micros: 30,
            cost_basis: "provider_list_estimate",
          };
          return verification;
        }) as never,
      },
    });

    expect(given).toHaveLength(2);
    // The change set the verifier judges is the whole change back to the base;
    // what the round itself changed is one path of it.
    const whole = ["pnpm-lock.yaml", "src/a.ts", "src/b.ts", "src/c.ts"];
    expect(given[0]).toEqual({ round_changed: ["src/b.ts"], changed: whole });
    // Round 2 is measured against round 1's verified commit, not the review's.
    expect(given[1]).toEqual({ round_changed: ["src/c.ts"], changed: whole });
    expect(result.outcome).toBe("changes_requested");
    expect(result.detail).toBe(
      `the fix regressed: the unit check (\`${UNIT.join(" ")}\`) failed on the round's tree; ` +
        "the round changed src/c.ts.",
    );
  }, 60_000);
});
