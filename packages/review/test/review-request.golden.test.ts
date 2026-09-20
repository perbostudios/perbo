import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckResult, PlanContract } from "@perbo/contracts";
import { anthropicModel } from "@perbo/model";
import { runReview } from "../src/review.js";
import { verdictSchemas } from "../src/verdict.js";
import { expectGolden } from "./golden.js";

/**
 * The request a review composes: the system prompt, the context blocks and
 * their trust tiers, the verdict schema and the tool list, as one body.
 *
 * A capturing `fetch` answers 400, so the review ends in a transport error
 * after the first request has been built and nothing reaches a provider.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-review-request-golden-"));
mkdirSync(join(scratch, "packages/a/src"), { recursive: true });
writeFileSync(join(scratch, "packages/a/src/a.ts"), "export const a = 1;\n");
writeFileSync(join(scratch, "packages/a/src/helper.ts"), "export const helper = () => 2;\n");
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
    {
      id: "ac_2",
      text: "helper returns 2",
      expected_verification: { kind: "test", assertion: "helper() === 2" },
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

let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousKey;
});

describe("the request a review composes", () => {
  it("is the one recorded", async () => {
    const bodies: unknown[] = [];
    const schemas = verdictSchemas(
      contract.acceptance_criteria.map((criterion) => criterion.id),
      checks.map((check) => check.check_id),
    );
    const { artifact } = await runReview({
      contract,
      diff,
      checks,
      repoDir: join(scratch, "packages"),
      model: anthropicModel({
        submitSchema: schemas.toolInputSchema,
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body ?? "null")));
          return new Response(
            JSON.stringify({ type: "error", error: { type: "api_error", message: "status 400" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
      }),
      now: new Date("2026-08-27T10:00:00Z"),
    });
    expect(artifact.error).not.toBeNull();
    expect(bodies).toHaveLength(1);

    expectGolden(new URL("./review-request.golden.json", import.meta.url), bodies[0]);
  });
});
