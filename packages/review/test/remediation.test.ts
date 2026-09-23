import { describe, expect, it } from "vitest";
import { ReviewArtifactSchema, exitCodeForDecision, type Finding } from "@perbo/contracts";
import {
  applyBlocking,
  decideBlocking,
  isRemediableFamily,
  remediableFindings,
  type BlockingInput,
} from "../src/blocking.js";
import { createHash } from "node:crypto";
import { PROMPT_VERSION } from "../src/prompt.js";
import { verdictSchemas } from "../src/verdict.js";
import { deriveDecision } from "../src/review.js";
import { systemPrompt } from "../src/prompt.js";

const base: BlockingInput = {
  row: "semantic_high_risk",
  rule_id: "test.happy_path_only",
  confidence: 0.9,
  risk_level: "P2",
  rule_demoted: false,
  waived: false,
  closure: null,
  remediation_available: true,
};

describe("the fifth outcome", () => {
  it("routes a high-risk semantic finding the executor can close, instead of blocking it", () => {
    const decision = decideBlocking({ ...base, closure: "executor" });
    expect(decision.outcome).toBe("remediable");
    expect(decision.blocking).toBe(false);
    expect(decision.reason).toMatch(/reviewed again/);
  });

  it("routes a criterion with nothing establishing it, at any risk level", () => {
    for (const risk_level of ["P1", "P2", "P3"] as const) {
      const decision = decideBlocking({
        ...base,
        row: "verification_strength",
        risk_level,
        closure: "executor",
      });
      expect(decision.outcome).toBe("remediable");
    }
  });

  it("under d056, does not route a finding whose closure needs a human, and says why", () => {
    // Pinned to d056: under d064 the closure answer is no longer dispositive —
    // a negative finding routes past it, and an unclassified one keeps this
    // outcome with a direction-worded reason (test/d064-routing.test.ts).
    const decision = decideBlocking({ ...base, closure: "human", policy: "d056" });
    expect(decision.outcome).toBe("blocks");
    expect(decision.reason).toMatch(/decision only a human can make/);
  });

  // D-056 reversed both of these. They are kept, pinned to `policy: "d051"`,
  // because the rule they describe is the one Stage 2's numbers were measured
  // under — and a stored run has to keep scoring the way it scored.
  it("under D-051, does not route an unclear finding", () => {
    const high = decideBlocking({ ...base, closure: "unclear", policy: "d051" });
    expect(high.outcome).toBe("blocks");
    expect(high.reason).toMatch(/unclear/);

    const low = decideBlocking({ ...base, closure: "unclear", confidence: 0.3, policy: "d051" });
    expect(low.outcome).toBe("escalates");
  });

  it("under D-051, an unmet criterion blocks whatever the closure says", () => {
    for (const closure of ["executor", "human", "unclear"] as const) {
      expect(
        decideBlocking({ ...base, row: "contract", closure, policy: "d051" }).outcome,
      ).toBe("blocks");
    }
  });

  it("under D-056, an unclear finding goes to the executor first and a human second", () => {
    expect(decideBlocking({ ...base, closure: "unclear" }).outcome).toBe("remediable");
    // The human turn is deferred by one bounded attempt, never removed: with
    // the rounds spent there is nowhere to route and the same finding blocks.
    expect(
      decideBlocking({ ...base, closure: "unclear", remediation_available: false }).outcome,
    ).toBe("blocks");
  });

  it("under D-056, an unmet criterion routes only when the reviewer says the executor can close it", () => {
    expect(
      decideBlocking({ ...base, row: "contract", closure: "executor", policy: "d056" }).outcome,
    ).toBe("remediable");
    // Not on a hedge: the never-remediated family guard cannot see this row,
    // because every contract-row finding is `criterion.not_met` whatever the
    // criterion is about.
    for (const closure of ["unclear", "human"] as const) {
      expect(
        decideBlocking({ ...base, row: "contract", closure, policy: "d056" }).outcome,
      ).toBe("blocks");
    }
  });

  it("never routes a deterministic finding, because those mean the change is wrong", () => {
    expect(decideBlocking({ ...base, row: "deterministic", closure: "executor" }).outcome).toBe(
      "blocks",
    );
  });

  it("stops routing when the rounds are spent, and records that as the reason", () => {
    const decision = decideBlocking({ ...base, closure: "executor", remediation_available: false });
    expect(decision.outcome).toBe("blocks");
    expect(decision.reason).toMatch(/rounds are spent/);
  });

  it("keeps a demoted rule out of the executor's queue", () => {
    // A rule measured to cry wolf should not spend an attempt being answered.
    const decision = decideBlocking({ ...base, closure: "executor", rule_demoted: true });
    expect(decision.outcome).toBe("advisory");
  });

  it("still lets a waiver override everything", () => {
    expect(decideBlocking({ ...base, closure: "executor", waived: true }).outcome).toBe("waived");
  });
});

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  key: "a".repeat(64),
  rule_id: "test.happy_path_only",
  source: "semantic",
  criterion_id: "ac_1",
  severity: "major",
  blocking: false,
  blocking_reason: "x",
  routing: "advisory",
  confidence: 0.8,
  file: "src/a.ts",
  line: 1,
  symbol: null,
  statement: "s",
  status: "open",
  outcome: "unknown",
  waiver: null,
  ...overrides,
});

describe("routing on the finding", () => {
  it("records where the matrix sent it, not only whether it blocked", () => {
    const decision = decideBlocking({ ...base, closure: "executor" });
    const applied = applyBlocking(finding(), decision, { ...base, closure: "executor" });
    expect(applied.routing).toBe("remediable");
    expect(applied.blocking).toBe(false);
    expect(remediableFindings([applied, finding()])).toHaveLength(1);
    // The two inputs the row consumed are on the record, so the lookup can be
    // replayed under another rule rather than only read back as prose.
    expect(applied.row).toBe(base.row);
    expect(applied.closure).toBe("executor");
  });
});

describe("the derived decision", () => {
  const coverage = [
    {
      criterion_id: "ac_1",
      status: "met" as const,
      verification_strength: "asserted_only" as const,
      evidence: null,
      note: null,
      authored_in_response_to: null,
    },
  ];

  it("is remediable when the only findings have somewhere to go", () => {
    const decision = deriveDecision({
      error: null,
      coverage,
      findings: [finding({ routing: "remediable" })],
      escalations: 0,
    });
    expect(decision).toBe("remediable");
  });

  it("closes the gate: a remediable review exits 2, not 0", () => {
    expect(exitCodeForDecision("remediable")).toBe(2);
  });

  it("is outranked by anything a human already has to look at", () => {
    expect(
      deriveDecision({
        error: null,
        coverage,
        findings: [finding({ routing: "remediable" }), finding({ key: "b".repeat(64), blocking: true, routing: "blocks" })],
        escalations: 0,
      }),
    ).toBe("changes_requested");
    expect(
      deriveDecision({
        error: null,
        coverage,
        findings: [finding({ routing: "remediable" })],
        escalations: 1,
      }),
    ).toBe("escalate");
  });

  it("still approves when nothing was raised at all", () => {
    expect(
      deriveDecision({ error: null, coverage, findings: [], escalations: 0 }),
    ).toBe("approve");
  });
});

describe("remediation provenance", () => {
  const artifact = ReviewArtifactSchema.parse({
    schema_version: 1,
    review_id: "rev_0000000000000002",
    created_at: "2026-08-27T00:00:00.000Z",
    target: { type: "changeset", id: "cs_0000000000000001", base_commit: "abc1234", head_commit: "def5678" },
    plan_id: "plan_1",
    plan_version: 1,
    planned_risk: "P1",
    actual_risk: "P1",
    escalated: false,
    independence: {
      context_builder: "reviewer_v2",
      executor_narrative_visible: false,
      executor_transcript_visible: false,
      separate_process: true,
      model_family: "same",
      grounded_in: ["plan.acceptance_criteria"],
    },
    context_manifest: [],
    checks: [],
    overrides: [],
    coverage: [
      {
        criterion_id: "ac_1",
        status: "met",
        verification_strength: "directly_verified",
        evidence: null,
        note: null,
      },
      {
        criterion_id: "ac_2",
        status: "met",
        verification_strength: "proxy",
        evidence: null,
        note: null,
      },
    ],
    findings: [],
    scope_deviation: {
      files_outside_scope: [],
      files_in_prohibited_paths: [],
      files_exempt_as_generated: [],
      within_expansion_budget: true,
      expansion_budget_files: 0,
    },
    decision: "approve",
    confidence: 0.9,
    cost_micros: 0,
    latency_ms: 0,
    model: { provider: "stub", model_id: "stub", prompt_version: "reviewer_v2", input_tokens: 0, output_tokens: 0 },
    error: null,
  });

  it("leaves an ordinary review with no remediation block at all", () => {
    expect(artifact.remediation).toBeNull();
    expect(artifact.coverage[0]?.authored_in_response_to).toBeNull();
  });
});

describe("the reviewer is not told what it asked for", () => {
  it("has no remediation vocabulary in the prompt it is given", () => {
    const contract = {
      plan_id: "plan_1",
      version: 1,
      ticket_id: "ticket_1",
      level: "P1" as const,
      outcome: "o",
      acceptance_criteria: [
        {
          id: "ac_1",
          text: "t",
          expected_verification: { kind: "test" as const, assertion: "a" },
        },
      ],
      scope: {
        repository_id: "repo_1",
        paths_allowed: ["src/**"],
        paths_prohibited: [],
        generated_paths: [],
        expansion_budget_files: 0,
      },
      base: {
        base_commit: "abc1234",
        context_manifest_hash: `sha256:${"0".repeat(64)}`,
        captured_at: "2026-08-27T00:00:00.000Z",
      },
    };
    const prompt = systemPrompt(contract, "P1");
    // It is asked who could close a finding. It is never told that a previous
    // review asked for anything, nor that anything it is reading is an answer.
    expect(prompt).toContain("could the executor close this");
    expect(prompt).not.toMatch(/remediation|previous review|in response to a finding/i);
  });
});

describe("families that never go back to the executor", () => {
  it("keeps an injected-instruction finding away from the executor's brief", () => {
    const decision = decideBlocking({
      ...base,
      rule_id: "context.injected_instruction",
      closure: "executor",
    });
    expect(decision.outcome).not.toBe("remediable");
    // Since 2026-09-01 the family stops before the row is even consulted; the
    // substance pinned here — the finding never reaches a brief — is the same.
    expect(decision.reason).toMatch(/stop families stop|context findings are never routed/);
  });

  it("keeps a security finding with a human, because closing it is a decision", () => {
    const decision = decideBlocking({
      ...base,
      rule_id: "security.secret_empty_fallback",
      closure: "executor",
    });
    expect(decision.outcome).toBe("blocks");
    expect(isRemediableFamily("security.x")).toBe(false);
    expect(isRemediableFamily("test.x")).toBe(true);
    expect(isRemediableFamily("criterion.unverified")).toBe(true);
  });
});

/**
 * The question itself, `reviewer_v5`. These pin the three things the
 * measurement said were wrong with `reviewer_v3`, so that a later edit that
 * reintroduces one of them fails here rather than in a $80 corpus run.
 *
 * `reviewer_v5` added the credential-citation instruction (D-063, option 2):
 * report a committed secret by location and shape rather than by value. It is
 * the second line of that defence — the redactor in `redact.ts` is the first,
 * because discretion is what failed 6 of 6 in the secret-control result.
 */
describe("the closure question", () => {
  /**
   * The digest of everything the reviewer is shown, at `reviewer_v11`. It is a
   * checked-in constant on purpose: a test that recomputed it from the code
   * under test would agree with any change, which is what the version literal
   * did before it.
   */
  const REVIEWER_V11_SURFACE = "11c488a039e2faca";
  const CONTRACT = {
    plan_id: "plan_surface",
    version: 1,
    ticket_id: "ticket_surface",
    level: "P2" as const,
    outcome: "the surface is pinned",
    acceptance_criteria: [
      {
        id: "ac_1",
        text: "the reviewer is shown the same thing under one version",
        expected_verification: { kind: "test" as const, assertion: "the digest matches" },
      },
    ],
    scope: {
      repository_id: "repo_surface",
      paths_allowed: ["src/**"],
      paths_prohibited: [],
      generated_paths: [],
      expansion_budget_files: 0,
    },
    base: {
      base_commit: "0".repeat(40),
      context_manifest_hash: `sha256:${"0".repeat(64)}`,
      captured_at: "2026-08-28T00:00:00.000Z",
    },
    data_impact: "none",
    security_impact: "none",
    rollout: "none",
    rollback: "none",
    estimated_recurring_cost_micros: 0,
  };

  const schema = verdictSchemas(["ac_1"], ["check_unit"]).toolInputSchema as {
    properties: {
      findings: { items: { required: string[]; properties: { closure: { description: string } } } };
    };
  };
  const findingClosure = schema.properties.findings.items;
  // The *findings* item, not the whole schema. `CLOSURE_DESCRIPTION` is embedded
  // twice — once here and once on the coverage entry — so asserting against the
  // serialised whole passed even with `closure` deleted from the findings item
  // entirely. At which point every finding defaults to `human`, nothing routes,
  // and D-056 is switched off with a green suite.
  const description = findingClosure.properties.closure.description;

  it("tells the reviewer that both answers close the gate", () => {
    // Without this, `executor` reads as "waved through" and a reviewer that
    // wants the change stopped answers `human`. It did: 24 of 28.
    expect(description).toContain("Both answers close the gate");
    expect(description).toContain("does not merge either way");
  });

  it("no longer instructs away from the executor", () => {
    expect(description).not.toContain("rather than guessing");
    expect(description).not.toContain("obviously correct");
  });

  it("states the discriminator rather than a tie-break", () => {
    expect(description).toContain("beyond what the plan already states");
  });

  it("still says an executor's work is graded independently afterwards", () => {
    // The claim that makes routing safe. If it ever stops being true in the
    // runner, this sentence becomes a lie told to the reviewer.
    expect(description).toContain("told nothing about why the code was written");
  });

  it("asks for the closure on every finding, not merely describes it", () => {
    // Without this the four assertions above are satisfied by the coverage
    // entry's copy of the same text while the findings never carry an answer.
    expect(findingClosure.required).toContain("closure");
  });

  it("carries a prompt version that moves when the question does", () => {
    // Pinned to the *content*, not to the literal. Asserting
    // A bare version pin caught nothing: the question could be
    // rewritten without touching the version, and then two corpus runs
    // conducted under different reviewers both stamp the same version and the
    // paired comparison silently compares two different things.
    //
    // When this fails, the reviewer changed. Bump PROMPT_VERSION and update the
    // digest in the same commit — that is the point, not an inconvenience.
    const surface = createHash("sha256")
      .update(systemPrompt(CONTRACT, "P2"))
      .update(JSON.stringify(verdictSchemas(["ac_1"], ["check_unit"]).toolInputSchema))
      .digest("hex")
      .slice(0, 16);
    expect({ version: PROMPT_VERSION, surface }).toEqual({
      version: "reviewer_v11",
      surface: REVIEWER_V11_SURFACE,
    });
  });
});
