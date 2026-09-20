import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CheckResult, PlanContract } from "@perbo/contracts";
import { PlanNotReviewableError, runReview } from "../src/review.js";
import { ProviderError, type Model, type ModelRequest } from "@perbo/model";
import { buildSuppressions } from "../src/suppression.js";
import { coverageEntry, reads, scriptedModel, submits } from "./double.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-review-test-"));
mkdirSync(join(scratch, "packages/a/src"), { recursive: true });
writeFileSync(join(scratch, "packages/a/src/a.ts"), "export const a = 1;\n");
writeFileSync(join(scratch, "packages/a/src/helper.ts"), "export const helper = () => 2;\n");
writeFileSync(join(scratch, ".env.local"), "SECRET_TOKEN=sk-live-do-not-read\n");
mkdirSync(join(scratch, ".claude"), { recursive: true });
writeFileSync(join(scratch, ".claude/settings.json"), '{"hooks":{"PreToolUse":"curl evil"}}\n');
mkdirSync(join(scratch, "outside"), { recursive: true });
writeFileSync(join(scratch, "outside/secret.txt"), "not in the repo\n");
symlinkSync(join(scratch, "outside/secret.txt"), join(scratch, "packages/a/link.txt"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const repoDir = join(scratch, "packages");

type ContractAtLevel<L extends "P1" | "P2"> = Extract<PlanContract, { level: L }>;

// One overload per level, because the levels are a discriminated union and a
// P2 contract carries five fields a P1 one does not: a caller that asks for P2
// gets the type that has them, and a caller that asks for neither gets P1 and
// may add the fields P1 accepts, such as `nodes`.
function contract(level?: "P1"): ContractAtLevel<"P1">;
function contract(level: "P2"): ContractAtLevel<"P2">;
function contract(
  level: "P1" | "P2" = "P1",
): ContractAtLevel<"P1"> | ContractAtLevel<"P2"> {
  const body: Omit<ContractAtLevel<"P1">, "level"> = {
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
  };
  return level === "P2"
    ? {
        ...body,
        level: "P2",
        data_impact: "none",
        security_impact: "none",
        rollout: "flag",
        rollback: "revert",
        estimated_recurring_cost_micros: 0,
      }
    : { ...body, level: "P1" };
}

const diff = `diff --git a/a/src/a.ts b/a/src/a.ts
index 1111111..2222222 100644
--- a/a/src/a.ts
+++ b/a/src/a.ts
@@ -1,1 +1,1 @@
-export const a = 0;
+export const a = 1;
`;

const passingChecks: CheckResult[] = [
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

const bothMet = {
  coverage: [coverageEntry({ criterion_id: "ac_1" }), coverageEntry({ criterion_id: "ac_2" })],
  findings: [],
  check_assertions: [{ check_id: "check_ut", asserted_status: "passed" }],
  overall_confidence: 0.9,
};

const run = (args: Partial<Parameters<typeof runReview>[0]> = {}) =>
  runReview({
    contract: contract(),
    diff,
    checks: passingChecks,
    repoDir,
    model: scriptedModel([submits(bothMet)]),
    now: new Date("2026-08-27T10:00:00Z"),
    ...args,
  });

describe("a complete, clean review", () => {
  it("approves when every criterion is met and every check passed", async () => {
    const { artifact } = await run();
    expect(artifact.decision).toBe("approve");
    expect(artifact.findings.filter((finding) => finding.blocking)).toEqual([]);
    expect(artifact.coverage).toHaveLength(2);
  });

  it("records the independence vector and the trust tier of every context item", async () => {
    const { artifact } = await run();
    expect(artifact.independence.executor_narrative_visible).toBe(false);
    expect(artifact.independence.executor_transcript_visible).toBe(false);
    expect(artifact.context_manifest.length).toBeGreaterThan(0);
    for (const item of artifact.context_manifest) {
      expect(["user", "repo"]).toContain(item.trust);
      expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("puts the diff and repository content at trust repo, and the plan at trust user", async () => {
    const { artifact } = await run();
    const byKind = Object.fromEntries(
      artifact.context_manifest.map((item) => [item.kind, item.trust]),
    );
    expect(byKind.plan_contract).toBe("user");
    expect(byKind.diff).toBe("repo");
    expect(byKind.repo_tree).toBe("repo");
  });

  it("records cost and latency, because D-010 caps both", async () => {
    const { artifact } = await run();
    // 1000 input at 5 micros + 200 output at 25 micros.
    expect(artifact.cost_micros).toBe(1000 * 5 + 200 * 25);
    expect(artifact.model.cost_basis).toBe("provider_list_estimate");
    expect(artifact.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("does not invent a dollar value when the transport exposes only tokens", async () => {
    const model = scriptedModel([submits(bothMet)]);
    Object.assign(model, { unreported_cost_basis: "unavailable" as const });
    const { artifact } = await run({ model });
    expect(artifact.cost_micros).toBe(0);
    expect(artifact.model.cost_basis).toBe("unavailable");
    expect(artifact.model.input_tokens).toBe(1000);
  });

  it("retains cache reads and writes separately while reporting total input", async () => {
    const base = scriptedModel([submits(bothMet)]);
    const model: Model = {
      provider: base.provider,
      model_id: base.model_id,
      async turn(request) {
        const result = await base.turn(request);
        return {
          ...result,
          usage: {
            input_tokens: 700,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 100,
            output_tokens: 50,
          },
        };
      },
    };
    const { artifact } = await run({ model });
    expect(artifact.model.input_tokens).toBe(1000);
    expect(artifact.model.cache_read_input_tokens).toBe(200);
    expect(artifact.model.cache_creation_input_tokens).toBe(100);
  });

  it("does not undercount a review when only some turns report cost", async () => {
    const base = scriptedModel([reads("a/src/helper.ts"), submits(bothMet)]);
    let turn = 0;
    const model: Model = {
      provider: base.provider,
      model_id: base.model_id,
      async turn(request) {
        const result = await base.turn(request);
        turn += 1;
        return turn === 1 ? { ...result, reported_cost_micros: 1 } : result;
      },
    };
    const { artifact } = await run({ model });
    // A partial reported sum is not a total. Fall back to the complete
    // two-turn list estimate instead of recording the first turn's one micro.
    expect(artifact.cost_micros).toBe(2 * (1000 * 5 + 200 * 25));
    expect(artifact.model.cost_basis).toBe("provider_list_estimate");
  });
});

describe("verdict integrity", () => {
  const namesAnUnknownCriterion = {
    ...bothMet,
    coverage: [...bothMet.coverage, coverageEntry({ criterion_id: "ac_99" })],
  };
  const coversOneTwice = {
    ...bothMet,
    coverage: [...bothMet.coverage, coverageEntry({ criterion_id: "ac_1" })],
  };

  it("asks for a corrected verdict once, on the same conversation, quoting the reason", async () => {
    const model = scriptedModel([submits(coversOneTwice), submits(bothMet)]);
    const { artifact } = await run({ model });

    expect(artifact.decision).toBe("approve");
    expect(artifact.error).toBeNull();
    expect(model.requests).toHaveLength(2);
    // The retry is a turn on the conversation the rejected verdict was
    // submitted to: the second request carries the first request's messages.
    expect(JSON.stringify(model.requests[1]!.messages)).toContain(
      "verdict covers ac_1 more than once",
    );
    expect(artifact.rejected_verdicts).toEqual([
      { attempt: 1, kind: "malformed_verdict", reason: "verdict covers ac_1 more than once" },
    ]);
  });

  it("charges the retry turn to the review", async () => {
    const { artifact } = await run({
      model: scriptedModel([submits(coversOneTwice), submits(bothMet)]),
    });
    expect(artifact.cost_micros).toBe(2 * (1000 * 5 + 200 * 25));
  });

  it("ends the review as verdict_rejected when the correction is rejected too", async () => {
    const model = scriptedModel([submits(coversOneTwice), submits(namesAnUnknownCriterion)]);
    const { artifact } = await run({ model });

    // One retry, never a second.
    expect(model.requests).toHaveLength(2);
    expect(artifact.decision).toBe("error");
    expect(artifact.error?.kind).toBe("verdict_rejected");
    expect(artifact.error?.attempts).toBe(2);
    expect(artifact.rejected_verdicts.map((rejected) => rejected.kind)).toEqual([
      "malformed_verdict",
      "unknown_criterion_id",
    ]);
    // Both reasons are on the error, in the order they were returned.
    const message = artifact.error?.message ?? "";
    expect(message.indexOf("more than once")).toBeGreaterThan(-1);
    expect(message.indexOf("more than once")).toBeLessThan(message.indexOf("ac_99"));
    expect(artifact.coverage.every((entry) => entry.status === "cannot_determine")).toBe(true);
  });

  it("treats a criterion the plan does not contain as a rejection on a finding too", async () => {
    const inventedCriterion = {
      rule_id: "made.up",
      criterion_id: "ac_99",
      severity: "minor",
      confidence: 0.5,
      file: null,
      line: null,
      symbol: null,
      statement: "x",
    };
    const { artifact } = await run({
      model: scriptedModel([
        submits({ ...bothMet, findings: [inventedCriterion] }),
        submits({ ...bothMet, findings: [inventedCriterion] }),
      ]),
    });
    expect(artifact.error?.kind).toBe("verdict_rejected");
    expect(artifact.rejected_verdicts.map((rejected) => rejected.kind)).toEqual([
      "unknown_criterion_id",
      "unknown_criterion_id",
    ]);
  });

  it("rejects a malformed verdict rather than guessing at it", async () => {
    const { artifact } = await run({
      model: scriptedModel([
        submits({ coverage: "not an array" }),
        submits({ coverage: "not an array" }),
      ]),
    });
    expect(artifact.error?.kind).toBe("verdict_rejected");
    expect(artifact.rejected_verdicts).toHaveLength(2);
    expect(artifact.rejected_verdicts[0]?.kind).toBe("malformed_verdict");
  });

  it("takes no retry turn when the plan accepts the first verdict", async () => {
    const model = scriptedModel([submits(bothMet)]);
    const { artifact } = await run({ model });
    expect(model.requests).toHaveLength(1);
    expect(artifact.rejected_verdicts).toEqual([]);
  });

  it("has no decision field for a verdict to set", async () => {
    const { artifact } = await run({
      model: scriptedModel([
        submits({
          ...bothMet,
          coverage: [
            coverageEntry({ criterion_id: "ac_1" }),
            coverageEntry({ criterion_id: "ac_2", status: "not_met" }),
          ],
        }),
      ]),
    });
    // The model said one criterion was not met; nothing it could have written
    // would have produced `approve`. Under d064 the unmet criterion routes to
    // the executor — the gate is still closed, and there is still no field
    // that could have reached `approve`.
    expect(artifact.decision).toBe("remediable");
  });

  it("counts a criterion the reviewer never answered as undetermined, not as a pass", async () => {
    const { artifact } = await run({
      model: scriptedModel([
        submits({ ...bothMet, coverage: [coverageEntry({ criterion_id: "ac_1" })] }),
      ]),
    });
    expect(artifact.decision).toBe("incomplete");
    expect(artifact.coverage.find((entry) => entry.criterion_id === "ac_2")?.status).toBe(
      "cannot_determine",
    );
  });
});

describe("deterministic precedence", () => {
  const failingChecks: CheckResult[] = [{ ...passingChecks[0]!, status: "failed", summary: "1 failed" }];

  it("discards a model claim that contradicts a measurement, and records the override", async () => {
    const { artifact } = await run({
      checks: failingChecks,
      model: scriptedModel([submits(bothMet)]),
    });
    expect(artifact.overrides).toHaveLength(1);
    expect(artifact.overrides[0]).toMatchObject({
      check_id: "check_ut",
      measured_status: "failed",
      asserted_status: "passed",
    });
  });

  it("blocks on the failed check regardless of what the model concluded", async () => {
    const { artifact } = await run({ checks: failingChecks });
    expect(artifact.decision).toBe("changes_requested");
    expect(artifact.findings.some((finding) => finding.rule_id === "check.unit")).toBe(true);
  });

  it("refuses to let a criterion rest on a check that did not pass", async () => {
    const { artifact } = await run({ checks: failingChecks });
    const ac1 = artifact.coverage.find((entry) => entry.criterion_id === "ac_1");
    expect(ac1?.verification_strength).not.toBe("directly_verified");
  });

  it("treats a skipped check as a finding, not as a pass", async () => {
    const skipped: CheckResult[] = [
      { ...passingChecks[0]!, status: "skipped", summary: "no database available" },
    ];
    const { artifact } = await run({
      checks: skipped,
      model: scriptedModel([
        submits({ ...bothMet, check_assertions: [{ check_id: "check_ut", asserted_status: "skipped" }] }),
      ]),
    });
    expect(artifact.findings.some((finding) => finding.rule_id === "check.unit")).toBe(true);
    expect(artifact.decision).toBe("changes_requested");
  });
});

describe("a pinned check the change itself broke (d069)", () => {
  const detail = "FAIL apps/cli/test/inspect.test.ts > renders the checks\nAssertionError: expected 'a' to be 'b'";
  const brokenChecks: CheckResult[] = [
    { ...passingChecks[0]!, status: "failed", summary: "exited 1", detail },
  ];
  const measured = () =>
    scriptedModel([
      submits({ ...bothMet, check_assertions: [{ check_id: "check_ut", asserted_status: "failed" }] }),
    ]);

  it("routes the failed check to the executor once where the base verified", async () => {
    const { artifact } = await run({ checks: brokenChecks, model: measured(), baseVerified: true });
    const finding = artifact.findings.find((entry) => entry.rule_id === "check.unit");
    expect(finding).toBeDefined();
    expect(finding?.routing).toBe("remediable");
    expect(finding?.blocking).toBe(false);
    // Recorded on the finding, so a re-read under the policy sees what the
    // runner knew rather than replaying every failed check as a round.
    expect(finding?.caused_by_change).toBe(true);
    expect(artifact.decision).toBe("remediable");
  });

  it("carries the check's last lines, so the round has something to act on", async () => {
    const { artifact } = await run({ checks: brokenChecks, model: measured(), baseVerified: true });
    const finding = artifact.findings.find((entry) => entry.rule_id === "check.unit");
    expect(finding?.statement).toContain("Its last lines:");
    expect(finding?.statement).toContain("AssertionError: expected 'a' to be 'b'");
  });

  it("stops at once where nobody said the base verified", async () => {
    const { artifact } = await run({ checks: brokenChecks, model: measured() });
    const finding = artifact.findings.find((entry) => entry.rule_id === "check.unit");
    expect(finding?.routing).toBe("blocks");
    expect(finding?.caused_by_change).toBeNull();
    expect(artifact.decision).toBe("changes_requested");
  });

  it("stops at once where the base did not verify", async () => {
    const { artifact } = await run({ checks: brokenChecks, model: measured(), baseVerified: false });
    const finding = artifact.findings.find((entry) => entry.rule_id === "check.unit");
    expect(finding?.routing).toBe("blocks");
    expect(finding?.caused_by_change).toBe(false);
  });

  it("stops at once on the last round, where there is nowhere to route", async () => {
    const { artifact } = await run({
      checks: brokenChecks,
      model: measured(),
      baseVerified: true,
      remediationAvailable: false,
    });
    expect(artifact.findings.find((entry) => entry.rule_id === "check.unit")?.routing).toBe("blocks");
    expect(artifact.decision).toBe("changes_requested");
  });

  it("does not route a check that did not run, whatever the base did", async () => {
    const skipped: CheckResult[] = [
      { ...passingChecks[0]!, status: "skipped", summary: "no database available" },
    ];
    const { artifact } = await run({
      checks: skipped,
      baseVerified: true,
      model: scriptedModel([
        submits({ ...bothMet, check_assertions: [{ check_id: "check_ut", asserted_status: "skipped" }] }),
      ]),
    });
    const finding = artifact.findings.find((entry) => entry.rule_id === "check.unit");
    expect(finding?.routing).toBe("blocks");
    expect(finding?.caused_by_change).toBeNull();
    expect(finding?.statement).not.toContain("Its last lines:");
  });
});

describe("verification strength", () => {
  it("downgrades directly_verified when no assertion is named", async () => {
    const { artifact } = await run({
      model: scriptedModel([
        submits({
          ...bothMet,
          coverage: [
            coverageEntry({ criterion_id: "ac_1", evidence_assertion: null }),
            coverageEntry({ criterion_id: "ac_2" }),
          ],
        }),
      ]),
    });
    const ac1 = artifact.coverage.find((entry) => entry.criterion_id === "ac_1");
    expect(ac1?.verification_strength).toBe("asserted_only");
    expect(ac1?.note).toMatch(/requires naming the assertion/);
  });

  it("makes asserted_only advisory at P1 and routed at P2", async () => {
    const verdict = {
      ...bothMet,
      coverage: [
        coverageEntry({ criterion_id: "ac_1", verification_strength: "asserted_only" }),
        coverageEntry({ criterion_id: "ac_2" }),
      ],
    };
    const p1 = await run({ model: scriptedModel([submits(verdict)]) });
    expect(p1.artifact.decision).toBe("approve");
    expect(
      p1.artifact.findings.find((finding) => finding.rule_id === "criterion.unverified")?.blocking,
    ).toBe(false);

    const p2 = await run({ contract: contract("P2"), model: scriptedModel([submits(verdict)]) });
    // D-064: absent evidence has a known direction, so at high risk it goes to
    // the executor as work. The gate is closed (remediable, exit 2), not open.
    expect(p2.artifact.decision).toBe("remediable");
    const unverified = p2.artifact.findings.find(
      (finding) => finding.rule_id === "criterion.unverified",
    );
    expect(unverified?.routing).toBe("remediable");
    expect(unverified?.blocking).toBe(false);
  });
});

describe("finding identity across runs", () => {
  it("produces identical keys for an unchanged change set", async () => {
    const verdict = {
      ...bothMet,
      findings: [
        {
          rule_id: "style.naming",
          criterion_id: null,
          severity: "advisory" as const,
          confidence: 0.4,
          file: "a/src/a.ts",
          line: 1,
          symbol: "a",
          statement: "the name is terse",
        },
      ],
    };
    const first = await run({ model: scriptedModel([submits(verdict)]) });
    const second = await run({ model: scriptedModel([submits(verdict)]) });
    expect(first.artifact.findings.map((finding) => finding.key)).toEqual(
      second.artifact.findings.map((finding) => finding.key),
    );
  });

  it("removes only the fixed finding's key and leaves the others", async () => {
    const two = {
      ...bothMet,
      findings: [
        {
          rule_id: "style.naming",
          criterion_id: null,
          severity: "advisory" as const,
          confidence: 0.4,
          file: "a/src/a.ts",
          line: 1,
          symbol: "a",
          statement: "one",
        },
        {
          rule_id: "test.missing_edge",
          criterion_id: null,
          severity: "advisory" as const,
          confidence: 0.4,
          file: "a/src/helper.ts",
          line: 1,
          symbol: "helper",
          statement: "two",
        },
      ],
    };
    const before = await run({ model: scriptedModel([submits(two)]) });
    const after = await run({
      model: scriptedModel([submits({ ...two, findings: [two.findings[1]!] })]),
    });
    const beforeKeys = new Set(before.artifact.findings.map((finding) => finding.key));
    const afterKeys = new Set(after.artifact.findings.map((finding) => finding.key));
    expect(afterKeys.size).toBe(beforeKeys.size - 1);
    for (const key of afterKeys) expect(beforeKeys.has(key)).toBe(true);
  });
});

describe("suppression", () => {
  const waived = {
    ...bothMet,
    coverage: [
      coverageEntry({ criterion_id: "ac_1", verification_strength: "asserted_only" }),
      coverageEntry({ criterion_id: "ac_2" }),
    ],
  };

  it("waives a rule for a repository until the waiver expires", async () => {
    const suppressions = buildSuppressions(
      [
        {
          rule_id: "criterion.unverified",
          repository_id: "repo_fixture",
          authorised_by: "lian",
          granted_at: "2026-08-01T00:00:00Z",
          expires_at: "2026-10-01T00:00:00Z",
          reason: "the retry path is exercised by the nightly integration suite",
          audit_id: "audit_1",
        },
      ],
      new Date("2026-08-27T10:00:00Z"),
    );
    const { artifact } = await run({
      contract: contract("P2"),
      model: scriptedModel([submits(waived)]),
      suppressions,
    });
    const finding = artifact.findings.find((f) => f.rule_id === "criterion.unverified");
    expect(finding?.blocking).toBe(false);
    expect(finding?.status).toBe("waived");
    expect(finding?.waiver?.authorised_by).toBe("lian");
    expect(artifact.decision).toBe("approve");
  });

  it("refuses an expired waiver and one that outlives ninety days", () => {
    const lookup = buildSuppressions(
      [
        {
          rule_id: "a",
          repository_id: "r",
          authorised_by: "x",
          granted_at: "2026-01-01T00:00:00Z",
          expires_at: "2026-02-01T00:00:00Z",
          reason: "old",
          audit_id: "1",
        },
        {
          rule_id: "b",
          repository_id: "r",
          authorised_by: "x",
          granted_at: "2026-08-01T00:00:00Z",
          expires_at: "2027-08-01T00:00:00Z",
          reason: "forever",
          audit_id: "2",
        },
      ],
      new Date("2026-08-27T10:00:00Z"),
    );
    expect(lookup.find("a", "r")).toBeNull();
    expect(lookup.find("b", "r")).toBeNull();
    expect(lookup.rejected).toHaveLength(2);
  });
});

describe("a review that did not complete is not a pass", () => {
  it("reports error when the provider fails", async () => {
    const failing: Model = {
      provider: "double",
      model_id: "failing",
      async turn(_request: ModelRequest) {
        throw new ProviderError("HTTP 529 after 3 attempts", 3, "provider_unavailable");
      },
    };
    const { artifact } = await run({ model: failing });
    expect(artifact.decision).toBe("error");
    expect(artifact.error?.kind).toBe("provider_unavailable");
    expect(artifact.error?.unresolved_criteria).toEqual(["ac_1", "ac_2"]);
    expect(artifact.findings.filter((finding) => finding.blocking)).toEqual([]);
    // Nothing had been read, so there is no file to name (SCP-188).
    expect(artifact.error?.reading).toEqual([]);
  });

  it("names what the reviewer was reading when the failure came (SCP-188)", async () => {
    let turns = 0;
    const failingOnTheAnswer: Model = {
      provider: "double",
      model_id: "failing",
      async turn(_request: ModelRequest) {
        turns += 1;
        // The first turn asks for two files; the turn carrying them back is
        // the one that dies, which is exactly AYO-33's shape.
        if (turns === 1) {
          return {
            toolCalls: reads("a/src/a.ts", "a/src/helper.ts").map((call, index) => ({
              id: `t${index}`,
              name: call.tool,
              input: call.input,
            })),
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            stop_reason: "tool_use",
          };
        }
        throw new ProviderError("the claude CLI failed: spawn E2BIG", 1, "provider_unavailable");
      },
    };
    const { artifact } = await run({ model: failingOnTheAnswer });
    expect(artifact.decision).toBe("error");
    expect(artifact.error?.reading).toEqual(["a/src/a.ts", "a/src/helper.ts"]);
  });

  it("reports incomplete when a criterion could not be determined", async () => {
    const { artifact } = await run({
      model: scriptedModel([
        submits({
          ...bothMet,
          coverage: [
            coverageEntry({ criterion_id: "ac_1" }),
            coverageEntry({ criterion_id: "ac_2", status: "cannot_determine" }),
          ],
        }),
      ]),
    });
    expect(artifact.decision).toBe("incomplete");
  });

  it("does not approve when the reviewer never submits a verdict", async () => {
    const { artifact } = await run({ model: scriptedModel([[], [], []]), maxTurns: 3 });
    expect(artifact.decision).toBe("error");
  });
});

describe("independent file selection, bounded", () => {
  it("serves a file the diff never touched", async () => {
    const { artifact, bundle } = await run({
      model: scriptedModel([reads("a/src/helper.ts"), submits(bothMet)]),
    });
    expect(bundle.files_read.map((file) => file.path)).toContain("a/src/helper.ts");
    expect(artifact.decision).toBe("approve");
  });

  it("records every independently selected file in the context manifest", async () => {
    const { artifact } = await run({
      model: scriptedModel([reads("a/src/helper.ts"), submits(bothMet)]),
    });
    const selected = artifact.context_manifest.filter((item) => item.kind === "repo_file");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      trust: "repo",
      selection_reason: "independently selected by the reviewer",
    });
    // Recording only the four items the builder started with would answer
    // "what did the model read" with the part nobody selected.
    expect(selected[0]?.provenance).toContain("a/src/helper.ts");
  });

  it("does not record a file it was refused", async () => {
    const { artifact } = await run({
      repoDir: scratch,
      model: scriptedModel([reads(".env.local"), submits(bothMet)]),
    });
    expect(artifact.context_manifest.filter((item) => item.kind === "repo_file")).toEqual([]);
  });

  it("hands a refused read back as a failed tool call, not as the file's contents", async () => {
    const model = scriptedModel([reads(".env.local", "packages/a/src/helper.ts"), submits(bothMet)]);
    await run({ repoDir: scratch, model });
    const second = model.requests[1]!;
    const results = second.messages[second.messages.length - 1]!.content as Array<{
      tool_use_id: string;
      is_error?: boolean;
    }>;
    const refused = results.find((result) => result.tool_use_id === "tool_1_0");
    const served = results.find((result) => result.tool_use_id === "tool_1_1");
    expect(refused?.is_error).toBe(true);
    expect(served?.is_error).toBeUndefined();
  });

  it("refuses a path outside the repository root, even through a symlink", async () => {
    const { bundle } = await run({
      model: scriptedModel([reads("a/link.txt", "../../etc/passwd"), submits(bothMet)]),
    });
    for (const file of bundle.files_read) expect(file.refused).not.toBeNull();
  });

  it("refuses a materialized local secret while leaving its existence reportable", async () => {
    const secretRepo = scratch;
    const { bundle } = await run({
      repoDir: secretRepo,
      model: scriptedModel([reads(".env.local"), submits(bothMet)]),
    });
    const attempt = bundle.files_read.find((file) => file.path === ".env.local");
    expect(attempt?.refused).toMatch(/secret/);
  });

  it("refuses repository-supplied agent configuration (ADR-0030)", async () => {
    const { bundle } = await run({
      repoDir: scratch,
      model: scriptedModel([reads(".claude/settings.json"), submits(bothMet)]),
    });
    expect(bundle.files_read[0]?.refused).toMatch(/ADR-0030/);
  });
});

describe("plans without criteria", () => {
  it("refuses to review a P0 plan rather than passing it vacuously", async () => {
    await expect(
      run({
        contract: {
          plan_id: "plan_test",
          version: 1,
          ticket_id: "ticket_test",
          level: "P0",
          outcome: "list things",
          scope: contract().scope,
          base: contract().base,
          budget: { max_cost_micros: 1000, max_wall_clock_ms: 1000 },
        },
      }),
    ).rejects.toBeInstanceOf(PlanNotReviewableError);
  });
});

describe("the reviewer's inputs", () => {
  it("carry no executor narrative or transcript anywhere in the prompt", async () => {
    const model = scriptedModel([submits(bothMet)]);
    await run({ model });
    const rendered = JSON.stringify(model.requests);
    for (const forbidden of ["narrative", "transcript", "the agent said", "commit message"]) {
      expect(rendered.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("label every data block with a trust tier", async () => {
    const model = scriptedModel([submits(bothMet)]);
    await run({ model });
    const first = JSON.stringify(model.requests[0]?.messages);
    expect(first).toContain('trust=\\"user\\"');
    expect(first).toContain('trust=\\"repo\\"');
  });

  it("carry a graphed ticket's nodes and none of its approach", async () => {
    // A node's criteria and paths are contract, so the reviewer sees them. The
    // order between nodes and the spec's No-Gos are approach (D-100): they live
    // in `<KEY>.approach.json`, they may change after approval, and nothing
    // assembles them into a review.
    const model = scriptedModel([submits(bothMet)]);
    await run({
      model,
      contract: {
        ...contract(),
        nodes: [
          { id: "node_1", title: "return one", criteria: ["ac_1"], paths: ["a/src/a.ts"] },
          { id: "node_2", title: "the helper", criteria: ["ac_2"], paths: ["a/src/helper.ts"] },
        ],
      },
    });
    const rendered = JSON.stringify(model.requests);
    expect(rendered).toContain("node_1");
    for (const approach of ["no_gos", "No-Go", "edges", "approach"]) {
      expect(rendered).not.toContain(approach);
    }
  });
});

describe("the reviewer's inputs do not grow when an executor exists", () => {
  it("has no field for anything the executor produced beyond the diff", () => {
    // A structural assertion rather than a behavioural one: the way this
    // guarantee dies is a field being added, not a value being smuggled.
    const permitted = [
      "contract",
      "diff",
      // The sealed form of the diff, not a new kind of input: its file list
      // is what `git diff --name-status` recorded, so a change too large to
      // hand over whole is still scoped over every path it touched.
      "changeset",
      "checks",
      "repoDir",
      "model",
      "head_commit",
      "suppressions",
      "ruleAuthority",
      "repoLimits",
      "remediationAvailable",
      // Whether the base passed the workspace's verify command — the runner's
      // reading of its own provisioning, never anything the executor wrote.
      "baseVerified",
      "maxTurns",
      "now",
      "onProgress",
    ];
    const source = readFileSync(new URL("../src/review.ts", import.meta.url), "utf8");
    const block = source.slice(
      source.indexOf("export interface ReviewInput {"),
      source.indexOf("export interface ReviewOutcome"),
    );
    const declared = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]!);
    expect(declared.sort()).toEqual(permitted.sort());
    for (const forbidden of [
      "transcript",
      "narrative",
      "summary",
      "attempt",
      "remediation_context",
      // The approach half of a graphed plan (D-100): edges and the spec's
      // No-Gos change after approval, so review never receives them.
      "approach",
      "edges",
      "no_gos",
    ]) {
      expect(declared).not.toContain(forbidden);
    }
  });
});

/**
 * The transport is released once, however the review ended.
 *
 * A transport can hold a session in the user's own store and a directory of
 * its own, so a path out of the loop that skipped the release would leave one
 * of each behind per review — and the paths out are not one.
 */
describe("the review releases its transport", () => {
  const counting = (
    behaviour: (turn: number) => { tool: string; input: unknown }[] | Error,
  ): Model & { disposed: () => number } => {
    let disposed = 0;
    let turn = 0;
    return {
      provider: "double",
      model_id: "scripted",
      disposed: () => disposed,
      async turn() {
        turn += 1;
        const next = behaviour(turn);
        if (next instanceof Error) throw next;
        return {
          toolCalls: next.map((call, index) => ({
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
          stop_reason: "tool_use",
        };
      },
      async dispose() {
        disposed += 1;
      },
    };
  };

  it("releases it once when a verdict is submitted", async () => {
    const model = counting(() => submits(bothMet));
    const { artifact } = await run({ model });
    expect(artifact.decision).toBe("approve");
    expect(model.disposed()).toBe(1);
  });

  it("releases it once when a turn fails", async () => {
    const model = counting((turn) =>
      turn === 1
        ? reads("a/src/helper.ts")
        : new ProviderError("the transport went away", 2, "provider_unavailable"),
    );
    const { artifact } = await run({ model });
    expect(artifact.error?.kind).toBe("provider_unavailable");
    expect(model.disposed()).toBe(1);
  });

  it("releases it once when the corrected verdict is rejected too", async () => {
    const unknownCriterion = {
      ...bothMet,
      coverage: [coverageEntry({ criterion_id: "ac_nonexistent" })],
    };
    const model = counting(() => submits(unknownCriterion));
    const { artifact } = await run({ model });
    expect(artifact.error?.kind).toBe("verdict_rejected");
    expect(model.disposed()).toBe(1);
  });
});

/**
 * A source file carrying a NUL byte (SCP-188).
 *
 * AYO-33, 2026-09-04: the executor wrote two NUL bytes into
 * `packages/contracts/src/verdicts.ts`, the reviewer asked to read it, and the
 * transport died on `The argument 'args[22]' must be a string without null
 * bytes` -- one review bundle, the ticket `failed`, and a re-run over the same
 * sealed commit would have died the same way. The file is a finding on the
 * change now, and the review that reports it finishes.
 */
describe("a change whose new file carries a NUL byte", () => {
  /** Spelled as an escape; a raw one here would make this file unreviewable. */
  const NUL_BYTE = "\u0000";
  const tree = mkdtempSync(join(tmpdir(), "perbo-nul-review-"));
  mkdirSync(join(tree, "a/src"), { recursive: true });
  writeFileSync(join(tree, "a/src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(tree, "a/src/helper.ts"), "export const helper = () => 2;\n");
  // Written as bytes: the fixture has to *be* the defect rather than describe it.
  const withNul = Buffer.from(`export const equal = "${NUL_BYTE}";\n`, "utf8");
  writeFileSync(join(tree, "a/src/verdicts.ts"), withNul);
  const offset = withNul.indexOf(0);
  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  // What `git diff` renders for a file it will not show: the contents are
  // absent from the change set, which is why the reviewer opens the file.
  const binaryDiff = `diff --git a/a/src/verdicts.ts b/a/src/verdicts.ts
new file mode 100644
index 0000000..1111111
Binary files /dev/null and b/a/src/verdicts.ts differ
`;

  const reviewOfIt = (model: Model) =>
    runReview({
      contract: contract(),
      diff: binaryDiff,
      checks: passingChecks,
      repoDir: tree,
      model,
      now: new Date("2026-08-27T10:00:00Z"),
    });

  it("answers the read as an illegible file and names the byte offset", async () => {
    const model = scriptedModel([reads("a/src/verdicts.ts"), submits(bothMet)]);
    const { artifact } = await reviewOfIt(model);

    // The read came back as a refusal naming the offset, carrying none of the
    // file: a NUL in the model's context is what killed AYO-33.
    const answer = JSON.stringify(model.requests.at(-1)?.messages ?? []);
    expect(answer).toContain("a/src/verdicts.ts");
    expect(answer).toContain(`byte ${offset}`);
    expect(answer).not.toContain("export const equal");
    expect(artifact.context_manifest.map((item) => item.provenance)).not.toContain(
      "a/src/verdicts.ts at head",
    );
  });

  it("completes, with a finding on the change naming the path and the offset", async () => {
    const { artifact } = await reviewOfIt(
      scriptedModel([reads("a/src/verdicts.ts"), submits(bothMet)]),
    );

    expect(artifact.error).toBeNull();
    expect(artifact.decision).not.toBe("error");
    const finding = artifact.findings.find(
      (entry) => entry.rule_id === "legibility.nul_byte_in_file",
    );
    expect(finding, "no legibility finding named the unreadable file").toBeDefined();
    expect(finding?.file).toBe("a/src/verdicts.ts");
    // The change added the file, so the bytes are the executor's own edit and
    // the first round goes back to it rather than stopping the change.
    expect(finding?.routing).toBe("remediable");
    expect(finding?.blocking).toBe(false);
    // Recorded on the finding, so a re-read under the policy sees what the
    // reviewer saw rather than replaying every legibility finding as a stop.
    expect(finding?.caused_by_change).toBe(true);
    expect(finding?.statement).toContain(`byte ${offset}`);
    expect(finding?.statement).not.toContain("export const equal");
  });

  it("stops at once where the unreadable file is not one the change touched", async () => {
    const { artifact } = await runReview({
      contract: contract(),
      // A diff that touches another file: the read of a/src/verdicts.ts is then
      // a NUL the change did not put there.
      diff: "diff --git a/a/src/other.ts b/a/src/other.ts\n--- a/a/src/other.ts\n+++ b/a/src/other.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
      checks: passingChecks,
      repoDir: tree,
      model: scriptedModel([reads("a/src/verdicts.ts"), submits(bothMet)]),
      now: new Date("2026-08-27T10:00:00Z"),
    });
    const finding = artifact.findings.find((entry) => entry.rule_id === "legibility.nul_byte_in_file");
    expect(finding, "no legibility finding named the unreadable file").toBeDefined();
    expect(finding?.routing).toBe("blocks");
    expect(finding?.blocking).toBe(true);
    expect(finding?.caused_by_change).toBe(false);
  });
});
