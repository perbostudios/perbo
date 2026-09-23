import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CheckResult, PlanContract } from "@perbo/contracts";
import { PROMPT_VERSION, systemPrompt } from "../src/prompt.js";
import { runReview } from "../src/review.js";
import { coverageEntry, scriptedModel, submits } from "./double.js";

/** sha256 of `systemPrompt(contract, "P1")` at `reviewer_v11`, the one prompt version. */
const REVIEWER_V11_P1_DIGEST = "11336132723b5a18e02802a4a16e6ea007e80245662e80e3fdd06911e0af3135";

const contract: PlanContract = {
  plan_id: "plan_pv",
  version: 1,
  ticket_id: "ticket_pv",
  level: "P1",
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
};

const scratch = mkdtempSync(join(tmpdir(), "perbo-prompt-version-test-"));
mkdirSync(join(scratch, "a/src"), { recursive: true });
writeFileSync(join(scratch, "a/src/a.ts"), "export const a = 1;\n");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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

const verdict = {
  coverage: [coverageEntry({ criterion_id: "ac_1" }), coverageEntry({ criterion_id: "ac_2" })],
  findings: [],
  check_assertions: [{ check_id: "check_ut", asserted_status: "passed" }],
  overall_confidence: 0.9,
};

describe("the reviewer prompt version", () => {
  it("is reviewer_v11, byte-identical to the pinned digest", () => {
    expect(PROMPT_VERSION).toBe("reviewer_v11");
    const prompt = systemPrompt(contract, "P1");
    expect(createHash("sha256").update(prompt).digest("hex")).toBe(REVIEWER_V11_P1_DIGEST);
  });

  it("delimits everything it shows the reviewer under one namespace, perbo:", () => {
    const prompt = systemPrompt(contract, "P1");
    expect(prompt).toContain("<perbo:...>");
    expect(prompt).toContain("<perbo:check_result>");
    // Every namespaced tag the prompt names, not merely the two above: a block
    // left behind under another namespace is a reviewer shown two conventions.
    const namespaces = [...prompt.matchAll(/<\/?([a-z_]+):/g)].map((match) => match[1]);
    expect([...new Set(namespaces)]).toEqual(["perbo"]);
  });
});

describe("runReview stamps the prompt version that produced the artifact", () => {
  it("stamps reviewer_v11 and shows the model the prompt", async () => {
    const model = scriptedModel([submits(verdict)]);
    const outcome = await runReview({
      contract,
      diff,
      checks,
      repoDir: scratch,
      model,
      now: new Date("2026-09-02T10:00:00Z"),
    });
    expect(outcome.artifact.model.prompt_version).toBe("reviewer_v11");
    expect(outcome.artifact.independence.context_builder).toBe("reviewer_v11");
    expect(outcome.bundle.prompt_version).toBe("reviewer_v11");
  });
});
