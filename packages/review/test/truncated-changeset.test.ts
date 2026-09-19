import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ChangeSetSchema, type PlanContract } from "@perbo/contracts";
import { runReview } from "../src/review.js";
import { coverageEntry, scriptedModel, submits } from "./double.js";

/**
 * A change set whose diff was withheld for size. The reviewer must refuse it
 * deterministically — never judge the prefix that survived, never spend a
 * model call on nothing — while scope is still decided over the complete
 * file list the seal recorded from `git diff --name-status`.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-truncated-test-"));
mkdirSync(join(scratch, "a/src"), { recursive: true });
writeFileSync(join(scratch, "a/src/a.ts"), "export const a = 1;\n");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const contract: PlanContract = {
  plan_id: "plan_test",
  version: 1,
  ticket_id: "ticket_test",
  level: "P1",
  outcome: "a does the thing",
  acceptance_criteria: [
    { id: "ac_1", text: "a returns 1", expected_verification: { kind: "test", assertion: "a === 1" } },
  ],
  scope: {
    repository_id: "repo_fixture",
    paths_allowed: ["a/**"],
    paths_prohibited: [".github/**"],
    generated_paths: [],
    expansion_budget_files: 0,
  },
  base: {
    base_commit: "a1b2c3d",
    context_manifest_hash: `sha256:${"0".repeat(64)}`,
    captured_at: "2026-08-27T09:00:00Z",
  },
};

const file = (path: string) => ({
  path,
  previous_path: null,
  change_kind: "modified" as const,
  additions: 0,
  deletions: 0,
  patch: "",
});

const truncated = ChangeSetSchema.parse({
  changeset_id: "cs_0000000000000009",
  base_commit: "a1b2c3d",
  head_commit: "7f4e91c",
  head_commit_source: "recorded",
  files: [file("a/src/a.ts"), file("b/src/elsewhere.ts")],
  truncated: true,
  diff_bytes: 9_000_000,
});

describe("a change set too large to review", () => {
  it("is refused with a blocking finding that names the size, and the model is never asked", async () => {
    const model = scriptedModel([submits({ coverage: [coverageEntry({})], findings: [], check_assertions: [], overall_confidence: 0.9 })]);
    const { artifact } = await runReview({
      contract,
      diff: "",
      changeset: truncated,
      checks: [],
      repoDir: scratch,
      model,
    });

    const finding = artifact.findings.find((entry) => entry.rule_id === "changeset.too_large_to_review");
    expect(finding).toBeDefined();
    expect(finding?.blocking).toBe(true);
    expect(finding?.source).toBe("deterministic");
    expect(finding?.statement).toContain("9000000 bytes");
    expect(model.requests).toHaveLength(0);
    expect(artifact.model.input_tokens).toBe(0);
    // Nothing was judged: the coverage says so rather than inventing an answer.
    expect(artifact.coverage.every((entry) => entry.status === "cannot_determine")).toBe(true);
    expect(artifact.decision).not.toBe("approve");
    expect(artifact.error).toBeNull();
  });

  it("still decides scope over the complete file list, not the parsed diff", async () => {
    const { artifact } = await runReview({
      contract,
      diff: "",
      changeset: truncated,
      checks: [],
      repoDir: scratch,
      model: scriptedModel([]),
    });
    expect(artifact.findings.map((entry) => entry.rule_id)).toContain("scope.escape");
    expect(artifact.scope_deviation.files_outside_scope).toEqual(["b/src/elsewhere.ts"]);
  });

  it("reviews a supplied change set that is not truncated exactly as before", async () => {
    const whole = ChangeSetSchema.parse({ ...truncated, truncated: false, diff_bytes: 12, files: [file("a/src/a.ts")] });
    const model = scriptedModel([submits({ coverage: [coverageEntry({})], findings: [], check_assertions: [], overall_confidence: 0.9 })]);
    const { artifact } = await runReview({
      contract,
      diff: "",
      changeset: whole,
      checks: [],
      repoDir: scratch,
      model,
    });
    expect(model.requests).toHaveLength(1);
    expect(artifact.findings.map((entry) => entry.rule_id)).not.toContain("changeset.too_large_to_review");
    expect(artifact.target.id).toBe("cs_0000000000000009");
  });
});
