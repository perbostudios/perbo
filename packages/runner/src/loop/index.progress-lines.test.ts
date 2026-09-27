import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema, readSpoken } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { TicketRunConfigSchema, runTicket } from "./index.js";
import { finding, makeContract, makeReview } from "../test-support/records.js";
import { runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * What a run prints while it works, which the desktop relays as it arrives
 * (docs/15): each stage as the run reaches it, and the executor's and the
 * reviewer's own words where they say them, in the order they happened.
 */

/** An executor that says one thing, writes one file, and says one more. */
function talkingAgent(): string {
  const binary = join(scratch("perbo-talking-agent-"), "agent.cjs");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
"use strict";
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
if (process.argv.includes("--version")) {
  process.stdout.write("fake-agent 1.0.0\\n");
  process.exit(0);
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [], plugins: [], skills: [], agents: [], memory_paths: null });
emit({ type: "assistant", message: { content: [{ type: "text", text: "Adding total() to the feature." }], usage: { input_tokens: 5, output_tokens: 3 } } });
const target = join(process.cwd(), "src", "feature.ts");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, "export const total = (n) => n.length;\\n");
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: target } }], usage: { input_tokens: 5, output_tokens: 3 } } });
emit({ type: "assistant", message: { content: [{ type: "text", text: "Done: total() is in." }], usage: { input_tokens: 5, output_tokens: 3 } } });
emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.002, permission_denials: [] });
process.exit(0);
`,
    { mode: 0o755 },
  );
  return binary;
}

/** A reviewer that approves and leaves one advisory finding open, in its own words. */
const review = (async () => ({
  artifact: makeReview({
    review_id: "rev_0000000000000411",
    decision: "approve",
    coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
    findings: [
      finding({
        routing: "advisory",
        blocking: false,
        severity: "minor",
        statement: "total() has no test of an empty list.",
      }),
    ],
  }),
  bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
})) as never;

describe("what a run prints while it works", () => {
  it("prints each stage as it reaches it and each agent's words where they said them, in order", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const root = scratch("perbo-progress-lines-");
    const config = TicketRunConfigSchema.parse({
      ticket_key: "SCP411",
      repository_root: repo.dir,
      base_ref: "main",
      worktree_root: join(root, "worktrees"),
      bundle_root: join(root, "bundles"),
      quarantine_root: join(root, "quarantine"),
      state_root: join(root, "state"),
      checks: [
        { check_id: "check_unit", name: "unit", kind: "unit", command: ["node", "-e", "process.exit(0)"], timeout_ms: 30_000 },
      ],
      agent_binary: talkingAgent(),
      model: "double",
      max_remediation_rounds: 1,
      limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
    });
    const printed: string[] = [];
    await runTicket({ config, contract, onProgress: (line) => printed.push(line), hooks: { review } });

    const at = (test: (line: string) => boolean): number => {
      const index = printed.findIndex(test);
      expect(index, printed.join("\n")).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at((line) => line.startsWith("worktree ")),
      at((line) => line === "executing"),
      at((line) => line === "executor says: Adding total() to the feature."),
      at((line) => line === "executor says: Done: total() is in."),
      at((line) => line === "sealing the change set"),
      at((line) => line.startsWith("check unit: ")),
      at((line) => line === "review round 0"),
      at((line) => line === "reviewer says: total() has no test of an empty list."),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Only the two agents' words are marked as words; nothing of the tool call is.
    expect(printed.map(readSpoken).filter((line) => line !== null)).toHaveLength(3);
  }, 90_000);
});
