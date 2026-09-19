import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { runAgent, type AgentResult } from "../src/adapter.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { buildPermissionProfile } from "../src/profile.js";
import { scratch } from "./support.js";

/**
 * What an attempt the runner stopped says it cost (SCP-159).
 *
 * Every one of these drives the real adapter against an executor whose stream
 * is written by hand, because the surface under test is the one that reads that
 * stream: what is recorded when the process is terminated and the transport's
 * final accounting line therefore never arrives.
 */

let sequence = 0;

/**
 * An executor that writes the given stream-json lines and then outlives the
 * attempt, so the runner's own termination is what ends it rather than the
 * process exiting. `--version` is answered without the wait: the adapter
 * fingerprints the binary before it runs it.
 */
function streamExecutor(worktree: string, lines: readonly string[], linger = true): string {
  sequence += 1;
  const binary = join(worktree, `executor-${sequence}`);
  writeFileSync(
    binary,
    `#!/bin/sh\ncase "$1" in --version) echo 'fake-executor 1.0.0'; exit 0 ;; esac\n` +
      `cat <<'JSON'\n${lines.join("\n")}\nJSON\n` +
      (linger ? "sleep 30\n" : ""),
    { mode: 0o755 },
  );
  return binary;
}

/** One assistant envelope: cumulative charge, per-request usage, and tool calls. */
const assistant = (input: {
  id?: string;
  request_id?: string;
  total_cost_usd?: number;
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  commands?: readonly string[];
}): string =>
  JSON.stringify({
    type: "assistant",
    ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
    ...(input.total_cost_usd === undefined ? {} : { total_cost_usd: input.total_cost_usd }),
    message: {
      ...(input.id === undefined ? {} : { id: input.id }),
      content: (input.commands ?? []).map((command) => ({
        type: "tool_use",
        name: "Bash",
        input: { command },
      })),
      usage: {
        input_tokens: input.input_tokens ?? 0,
        cache_creation_input_tokens: input.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: input.cache_read_input_tokens ?? 0,
        output_tokens: input.output_tokens ?? 0,
      },
    },
  });

const resultEvent = (input: {
  total_cost_usd?: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    ...(input.total_cost_usd === undefined ? {} : { total_cost_usd: input.total_cost_usd }),
    usage: {
      input_tokens: input.input_tokens,
      cache_creation_input_tokens: input.cache_creation_input_tokens,
      cache_read_input_tokens: input.cache_read_input_tokens,
      output_tokens: input.output_tokens,
    },
  });

async function run(
  worktree: string,
  lines: readonly string[],
  limits: Record<string, number> = {},
  linger = true,
  model = "claude-opus-5",
): Promise<{ result: AgentResult; ceilings: AttemptCeilings }> {
  const ceilings = new AttemptCeilings(
    LimitsTableSchema.parse({
      organisation: "test",
      limits: { attempt_wall_clock_ms: 600_000, ...limits },
    }),
  );
  const result = await runAgent({
    binary: streamExecutor(worktree, lines, linger),
    worktree,
    prompt: "irrelevant",
    model,
    profile: buildPermissionProfile({ worktree }),
    ceilings,
    env: { PATH: process.env.PATH ?? "" },
  });
  return { result, ceilings };
}

describe("an attempt the runner stops records what it cost", () => {
  it("estimates a stopped priced-model attempt from the assistant usage read before the stop", async () => {
    const worktree = scratch("perbo-scp292-estimated-");
    const { result: stopped } = await run(
      worktree,
      [
        assistant({
          id: "msg_one",
          request_id: "req_one",
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 40,
          output_tokens: 10,
        }),
      ],
      { attempt_iterations: 0 },
    );

    expect(stopped.termination.reason).toBe("iteration_ceiling_exceeded");
    // 100*5 + 20*6.25 + 40*0.5 + 10*25 micro-dollars.
    expect(stopped.usage.cost_micros).toBe(895);
    expect(stopped.usage.cost_basis).toBe("provider_list_estimate");
    expect(stopped.usage.cost_partial).toBe(true);
    expect(stopped.usage.input_tokens).toBe(160);
    expect(stopped.usage.cache_creation_input_tokens).toBe(20);
    expect(stopped.usage.cache_read_input_tokens).toBe(40);
    expect(stopped.usage.output_tokens).toBe(10);
  }, 60_000);

  it("uses the running list-price estimate to stop before a result event", async () => {
    const worktree = scratch("perbo-scp292-cost-ceiling-");
    const { result: stopped, ceilings } = await run(
      worktree,
      [
        assistant({ id: "msg_one", request_id: "req_one", input_tokens: 100, output_tokens: 20 }),
        assistant({ id: "msg_two", request_id: "req_two", input_tokens: 100, output_tokens: 20 }),
        // The fake can flush lines already buffered when the stop signal lands.
        // Neither later usage nor a final result is inside the stopped prefix.
        assistant({ id: "msg_three", request_id: "req_three", input_tokens: 1_000, output_tokens: 200 }),
        resultEvent({
          total_cost_usd: 9,
          input_tokens: 1_200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 240,
        }),
      ],
      { attempt_cost_micros: 1_500 },
    );

    expect(stopped.termination.reason).toBe("cost_ceiling_exceeded");
    expect(stopped.termination.detail).toContain(
      "attempt_cost_micros would reach 2000, above the limit of 1500",
    );
    expect(stopped.usage.cost_micros).toBe(2_000);
    expect(stopped.usage.cost_micros).toBe(ceilings.counts().cost_micros);
    expect(stopped.usage.cost_basis).toBe("provider_list_estimate");
    expect(stopped.usage.cost_partial).toBe(true);
    expect(stopped.usage.input_tokens).toBe(200);
    expect(stopped.usage.output_tokens).toBe(40);
  }, 60_000);

  it("counts repeated content envelopes for one assistant request only once", async () => {
    const worktree = scratch("perbo-scp292-repeated-assistant-");
    const repeated = assistant({
      id: "msg_one",
      request_id: "req_one",
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 40,
      output_tokens: 10,
    });
    const { result: stopped, ceilings } = await run(
      worktree,
      [repeated, repeated],
      { attempt_iterations: 1 },
    );

    expect(stopped.termination.reason).toBe("iteration_ceiling_exceeded");
    expect(stopped.usage.input_tokens).toBe(160);
    expect(stopped.usage.output_tokens).toBe(10);
    expect(stopped.usage.cost_micros).toBe(895);
    expect(stopped.usage.cost_basis).toBe("provider_list_estimate");
    // The token guard deliberately retains its pre-existing raw-envelope
    // count even though billed accounting deduplicates that transport shape.
    expect(ceilings.counts().tokens).toBe(260);
  }, 60_000);

  it("leaves an unpriced model unavailable when its stopped stream has only tokens", async () => {
    const worktree = scratch("perbo-scp292-unpriced-model-");
    const { result: stopped } = await run(
      worktree,
      [assistant({ id: "msg_one", request_id: "req_one", input_tokens: 100, output_tokens: 20 })],
      { attempt_iterations: 0 },
      true,
      "some-unpriced-model",
    );

    expect(stopped.termination.reason).toBe("iteration_ceiling_exceeded");
    expect(stopped.usage.cost_micros).toBe(0);
    expect(stopped.usage.cost_basis).toBe("unavailable");
    expect(stopped.usage.cost_partial).toBe(true);
  }, 60_000);

  it("carries the charge reported before a prohibited action, marked partial", async () => {
    const worktree = scratch("perbo-scp159-prohibited-");
    const { result } = await run(worktree, [
      assistant({ total_cost_usd: 0.8, input_tokens: 1_000, output_tokens: 100 }),
      assistant({ total_cost_usd: 2.0, input_tokens: 1_500, output_tokens: 200 }),
      assistant({ commands: ["cp secrets.json ~/backup.json"] }),
    ]);

    expect(result.termination.reason).toBe("prohibited_action");
    expect(result.usage.cost_micros).toBe(2_000_000);
    expect(result.usage.cost_basis).toBe("transport_reported");
    expect(result.usage.cost_partial).toBe(true);
    expect(result.usage.input_tokens).toBe(2_500);
    expect(result.usage.output_tokens).toBe(300);
  }, 60_000);

  it("records the cost ceiling's own figure when the ceiling is what stopped it", async () => {
    const worktree = scratch("perbo-scp159-cost-");
    const { result, ceilings } = await run(
      worktree,
      [
        assistant({ total_cost_usd: 0.4, input_tokens: 500, output_tokens: 50 }),
        assistant({ total_cost_usd: 5.11, input_tokens: 500, output_tokens: 50 }),
        assistant({ total_cost_usd: 9.0, input_tokens: 500, output_tokens: 50 }),
      ],
      { attempt_cost_micros: 5_000_000 },
    );

    expect(result.termination.reason).toBe("cost_ceiling_exceeded");
    expect(result.usage.cost_micros).toBe(5_110_000);
    expect(result.usage.cost_micros).toBe(ceilings.counts().cost_micros);
    expect(result.usage.cost_basis).toBe("transport_reported");
    expect(result.usage.cost_partial).toBe(true);
  }, 60_000);

  it("says the cost is unavailable, never zero, when nothing was reported before the stop", async () => {
    const worktree = scratch("perbo-scp159-unavailable-");
    const { result } = await run(worktree, [], { attempt_wall_clock_ms: 1 });

    expect(result.termination.reason).toBe("wall_clock_exceeded");
    expect(result.usage.cost_basis).toBe("unavailable");
    expect(result.usage.cost_partial).toBe(true);
  }, 60_000);

  it("stops on the iteration ceiling with the charge reported by then", async () => {
    const worktree = scratch("perbo-scp159-iterations-");
    const { result } = await run(
      worktree,
      [
        assistant({ total_cost_usd: 0.25, input_tokens: 100, output_tokens: 10 }),
        assistant({ total_cost_usd: 0.5, input_tokens: 100, output_tokens: 10 }),
        assistant({ total_cost_usd: 0.75, input_tokens: 100, output_tokens: 10 }),
      ],
      { attempt_iterations: 2 },
    );

    // The third message is what trips the ceiling, and the transport had
    // already charged for it: what is recorded includes it.
    expect(result.termination.reason).toBe("iteration_ceiling_exceeded");
    expect(result.usage.cost_micros).toBe(750_000);
    expect(result.usage.cost_partial).toBe(true);
  }, 60_000);

  it("stops on the token ceiling with the charge reported by then", async () => {
    const worktree = scratch("perbo-scp159-tokens-");
    const { result } = await run(
      worktree,
      [
        assistant({ total_cost_usd: 0.3, input_tokens: 400, output_tokens: 100 }),
        assistant({ total_cost_usd: 0.6, input_tokens: 400, output_tokens: 100 }),
      ],
      { attempt_tokens: 600 },
    );

    expect(result.termination.reason).toBe("token_ceiling_exceeded");
    expect(result.usage.cost_micros).toBe(600_000);
    expect(result.usage.cost_partial).toBe(true);
  }, 60_000);

  it("takes final usage totals and transport cost instead of repeated assistant accounting", async () => {
    const worktree = scratch("perbo-scp159-completed-");
    const { result } = await run(
      worktree,
      [
        assistant({
          id: "msg_one",
          request_id: "req_one",
          input_tokens: 2,
          cache_creation_input_tokens: 24_470,
          cache_read_input_tokens: 27_744,
          output_tokens: 2,
        }),
        // The pinned transport emits another content block for this same
        // request, repeating rather than adding its usage.
        assistant({
          id: "msg_one",
          request_id: "req_one",
          input_tokens: 2,
          cache_creation_input_tokens: 24_470,
          cache_read_input_tokens: 27_744,
          output_tokens: 2,
        }),
        assistant({
          id: "msg_two",
          request_id: "req_two",
          input_tokens: 2,
          cache_creation_input_tokens: 2_729,
          cache_read_input_tokens: 52_214,
          output_tokens: 1,
        }),
        resultEvent({
          total_cost_usd: 0.316814,
          input_tokens: 4,
          cache_creation_input_tokens: 27_199,
          cache_read_input_tokens: 79_958,
          output_tokens: 193,
        }),
      ],
      {},
      false,
    );

    expect(result.termination.reason).toBe("completed");
    expect(result.usage.input_tokens).toBe(107_161);
    expect(result.usage.cache_creation_input_tokens).toBe(27_199);
    expect(result.usage.cache_read_input_tokens).toBe(79_958);
    expect(result.usage.output_tokens).toBe(193);
    expect(result.usage.cost_micros).toBe(316_814);
    expect(result.usage.cost_basis).toBe("transport_reported");
    expect(result.usage.cost_partial).toBe(false);
  }, 60_000);

  it("keeps distinct assistant-request sums when the result carries no usage", async () => {
    const worktree = scratch("perbo-scp292-result-without-usage-");
    const { result } = await run(
      worktree,
      [
        assistant({
          id: "msg_one",
          request_id: "req_one",
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 40,
          output_tokens: 10,
        }),
        JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.5 }),
      ],
      {},
      false,
    );

    expect(result.termination.reason).toBe("completed");
    expect(result.usage.input_tokens).toBe(160);
    expect(result.usage.cache_creation_input_tokens).toBe(20);
    expect(result.usage.cache_read_input_tokens).toBe(40);
    expect(result.usage.output_tokens).toBe(10);
    expect(result.usage.cost_micros).toBe(500_000);
    expect(result.usage.cost_basis).toBe("transport_reported");
    expect(result.usage.cost_partial).toBe(false);
  }, 60_000);
});
