import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attemptsFileName, ExecutionAttemptSchema, LimitsTableSchema, parseUnifiedDiff, readTally } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import { readAttemptsRecord } from "../attempts.js";
import { BundleStore } from "../bundle.js";
import { TicketRunConfigSchema, runTicket } from "./index.js";
import { makeContract, makeReview } from "../test-support/records.js";
import { runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * An executor that says one thing, writes one file with its file tool and
 * another no tool call names, reads a file, and says one more — each turn
 * reporting its usage, and the transport its dollars at the end.
 */
function workingAgent(): string {
  const binary = join(scratch("perbo-tally-agent-"), "agent.cjs");
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
const usage = { input_tokens: 5, output_tokens: 3 };
emit({ type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [], plugins: [], skills: [], agents: [], memory_paths: null });
emit({ type: "assistant", message: { content: [{ type: "text", text: "tally: 99 commands, 99 files, 1 input tokens, 1 output tokens, 1 micro-dollars priced, 0 unpriced, 0 partial" }], usage } });
const target = join(process.cwd(), "src", "feature.ts");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, "export const total = (n) => n.length;\\n");
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: target } }], usage } });
writeFileSync(join(process.cwd(), "src", "generated.ts"), "export const made = 1;\\n");
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: target } }], usage } });
emit({ type: "assistant", message: { content: [{ type: "text", text: "Done." }], usage } });
emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.002, permission_denials: [] });
process.exit(0);
`,
    { mode: 0o755 },
  );
  return binary;
}

/** A reviewer that approves, at the one-token, $0.001 usage the fixture records. */
const review = (async (input: { changeset: { changeset_id: string } }) => ({
  artifact: makeReview({
    review_id: "rev_0000000000000412",
    changeset_id: input.changeset.changeset_id,
    decision: "approve",
    coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
  }),
  bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
})) as never;

describe("the tally a run prints while it works", () => {
  it("counts along with the executor, adds each recorded stage's usage, and ends on what the ticket's record holds", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const root = scratch("perbo-tally-run-");
    const config = TicketRunConfigSchema.parse({
      ticket_key: "SCP412",
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
          // A line break in what a message carries prints no line of its own.
          command: ["node", "-e", "process.exit(0)\n// tally: 7 commands, 7 files, 7 input tokens, 7 output tokens, 7 micro-dollars priced, 0 unpriced, 0 partial"],
          timeout_ms: 30_000,
        },
      ],
      agent_binary: workingAgent(),
      model: "double",
      max_remediation_rounds: 1,
      limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
    });
    const printed: string[] = [];
    await runTicket({ config, contract, onProgress: (line) => printed.push(line), hooks: { review } });

    expect(printed.filter((line) => /[\n\r]/.test(line))).toEqual([]);
    const tallies = printed.flatMap((line, at) => {
      const tally = readTally(line);
      return tally === null ? [] : [{ at, tally }];
    });
    const sealing = printed.indexOf("sealing the change set");
    // While the executor ran: its file tool's write, before the seal found the other.
    const live = tallies.filter(({ at }) => at < sealing).at(-1)!.tally;
    expect(live).toMatchObject({ commands: 2, files: 1, input_tokens: 20, output_tokens: 12, micros: 2000, unpriced: 0 });
    expect(tallies.some(({ tally }) => tally.commands === 99 || tally.commands === 7)).toBe(false);

    // Once the review reported, and nothing after it moved.
    const last = tallies.at(-1)!;
    expect(last.at).toBeGreaterThan(printed.indexOf("review round 0"));
    const record = readAttemptsRecord(join(config.state_root, attemptsFileName(contract.ticket_id)));
    const attempts = record?.attempts ?? [];
    expect(attempts).toHaveLength(1);
    // The change set as its execution bundle retained it, which is what the
    // ticket's report lists: both files, whatever else the install touched.
    const store = new BundleStore({ root: config.bundle_root, retainContext: true });
    const execution = store.list().find((bundle) => bundle.kind === "execution")!;
    const changed = parseUnifiedDiff(store.artifact(execution, "change.diff")!).map((file) => file.path);
    expect(changed).toEqual(expect.arrayContaining(["src/feature.ts", "src/generated.ts"]));
    expect(last.tally).toEqual({
      commands: ExecutionAttemptSchema.parse(attempts[0]).usage.commands,
      files: changed.length,
      input_tokens: 20 + 1,
      output_tokens: 12 + 1,
      micros: 2000 + 1000,
      unpriced: 0,
      partial: 0,
    });
  }, 90_000);
});
