import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CheckResult, PlanContract } from "@perbo/contracts";
import type { ModelRequest, ModelTurn, ReviewModel } from "../src/provider.js";
import { runReview } from "../src/review.js";
import { READ_FILE_TOOL, SUBMIT_REVIEW_TOOL } from "../src/verdict.js";
import { coverageEntry } from "./double.js";
import { expectGolden } from "./golden.js";

/**
 * Every message the review loop builds, over the four moves it has: reads
 * answered (one served, one refused), a turn with no tool call, a rejected
 * verdict answered with the correction, and an accepted one.
 *
 * The double clones each request as it is made, because the loop appends to
 * the one `messages` array and a reference would only show its final state.
 * The system prompt is recorded once: it is the same object on every turn, and
 * `review-request.golden.json` already holds it.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-review-sequence-golden-"));
mkdirSync(join(scratch, "packages/a/src"), { recursive: true });
writeFileSync(join(scratch, "packages/a/src/a.ts"), "export const a = 1;\n");
writeFileSync(join(scratch, "packages/a/src/helper.ts"), "export const helper = () => 2;\n");
writeFileSync(join(scratch, "packages/a/.env"), "SECRET_TOKEN=sk-live-do-not-read\n");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const contract: PlanContract = {
  plan_id: "plan_test",
  version: 1,
  ticket_id: "ticket_test",
  outcome: "a does the thing",
  acceptance_criteria: [
    {
      id: "ac_1",
      text: "a returns 1",
      expected_verification: { kind: "test", assertion: "a === 1" },
    },
  ],
  scope: {
    repository_id: "repo_fixture",
    paths_allowed: ["a/**"],
    paths_prohibited: [".github/**"],
    generated_paths: [],
    expansion_budget_files: 3,
  },
  base: {
    base_commit: "a1b2c3d",
    context_manifest_hash: `sha256:${"0".repeat(64)}`,
    captured_at: "2026-08-27T09:00:00Z",
  },
  level: "P1",
};

const diff = `diff --git a/a/src/a.ts b/a/src/a.ts
index 1111111..2222222 100644
--- a/a/src/a.ts
+++ b/a/src/a.ts
@@ -1,1 +1,1 @@
-export const a = 0;
+export const a = 1;
`;

const checks: CheckResult[] = [
  {
    check_id: "check_ut",
    name: "unit",
    kind: "unit",
    status: "passed",
    summary: "2 passed",
    command: "vitest run",
    detail: null,
    duration_ms: null,
    source: "file",
  },
];

const met = {
  coverage: [coverageEntry({ criterion_id: "ac_1" })],
  findings: [],
  check_assertions: [{ check_id: "check_ut", asserted_status: "passed" }],
  overall_confidence: 0.9,
};

/** A model that records the conversation as it was on each turn. */
function recordingModel(
  script: Array<Array<{ tool: string; input: unknown }>>,
): ReviewModel & { requests: Array<{ forceSubmit: boolean; messages: unknown }> } {
  const requests: Array<{ forceSubmit: boolean; messages: unknown }> = [];
  let turn = 0;
  return {
    provider: "double",
    model_id: "scripted",
    requests,
    async turn(request: ModelRequest): Promise<ModelTurn> {
      requests.push({
        forceSubmit: request.forceSubmit,
        messages: structuredClone(request.messages),
      });
      const calls = script[turn] ?? [];
      turn += 1;
      return {
        toolCalls: calls.map((call, index) => ({
          id: `tool_${turn}_${index}`,
          name: call.tool,
          input: call.input,
        })),
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      };
    },
  };
}

describe("the conversation a review builds", () => {
  it("is the one recorded", async () => {
    const model = recordingModel([
      [
        { tool: READ_FILE_TOOL, input: { path: "a/src/helper.ts" } },
        { tool: READ_FILE_TOOL, input: { path: "a/.env" } },
      ],
      [],
      [
        {
          tool: SUBMIT_REVIEW_TOOL,
          input: { ...met, coverage: [coverageEntry({ criterion_id: "ac_nonexistent" })] },
        },
      ],
      [{ tool: SUBMIT_REVIEW_TOOL, input: met }],
    ]);
    const { artifact } = await runReview({
      contract,
      diff,
      checks,
      repoDir: join(scratch, "packages"),
      model,
      now: new Date("2026-08-27T10:00:00Z"),
    });
    expect(artifact.error).toBeNull();
    expect(model.requests).toHaveLength(4);

    // Each turn carries the whole conversation; what is recorded is what that
    // turn added to it, so one move's messages are read in one place.
    let carried = 0;
    const turns = model.requests.map((request) => {
      const messages = request.messages as unknown[];
      const added = messages.slice(carried);
      carried = messages.length;
      return { forceSubmit: request.forceSubmit, added };
    });

    expectGolden(new URL("./review-sequence.golden.json", import.meta.url), {
      // The opening message is the rendered context, pinned in full by
      // `review-request.golden.json`; here only its size is recorded, so a
      // change to the loop is not lost inside it.
      context_bytes: JSON.stringify(turns[0]?.added ?? []).length,
      turns: turns.map((turn, index) =>
        index === 0 ? { forceSubmit: turn.forceSubmit, added: ["<context>"] } : turn,
      ),
    });
  });
});
