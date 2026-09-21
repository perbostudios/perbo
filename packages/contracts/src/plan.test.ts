import { describe, expect, it } from "vitest";
import {
  AcceptanceCriterionSchema,
  ExpectedVerificationSchema,
  PlanContractP1Schema,
  PlanContractP2Schema,
  PlanContractP3Schema,
  PlanContractSchema,
  hasAcceptanceCriteria,
} from "./plan.js";

const validP1 = {
  plan_id: "plan_01J8QK",
  version: 3,
  ticket_id: "ticket_01J8QJ",
  level: "P1" as const,
  outcome: "New users receive an activation email within 60s of signup.",
  acceptance_criteria: [
    {
      id: "ac_1",
      text: "A signup POST results in exactly one queued activation email.",
      expected_verification: {
        kind: "test" as const,
        assertion: "exactly one activation email is queued for a single signup",
      },
    },
  ],
  scope: {
    repository_id: "repo_01J8QH",
    paths_allowed: ["packages/auth/**"],
    paths_prohibited: [".github/**"],
    generated_paths: ["pnpm-lock.yaml"],
    expansion_budget_files: 3,
  },
  base: {
    base_commit: "a1b2c3d",
    context_manifest_hash: `sha256:${"0".repeat(64)}`,
    captured_at: "2026-08-26T12:00:00Z",
  },
};

describe("the P1 contract is exactly four fields", () => {
  it("accepts the canonical contract from docs/04", () => {
    expect(PlanContractP1Schema.parse(validP1).level).toBe("P1");
  });

  // SCP-009: bureaucracy is unrepresentable, not discouraged.
  it.each(["steps", "alternatives", "assumptions", "problem_statement", "test_plan", "valid_until"])(
    "cannot express %s",
    (field) => {
      const result = PlanContractP1Schema.safeParse({ ...validP1, [field]: "anything" });
      expect(result.success).toBe(false);
    },
  );

  it("rejects a criterion that names where the proof will live", () => {
    const withSelector = AcceptanceCriterionSchema.safeParse({
      ...validP1.acceptance_criteria[0],
      test_file: "test/signup.spec.ts",
    });
    expect(withSelector.success).toBe(false);
  });

  it("rejects duplicate criterion ids", () => {
    const criterion = validP1.acceptance_criteria[0]!;
    const result = PlanContractP1Schema.safeParse({
      ...validP1,
      acceptance_criteria: [criterion, { ...criterion, text: "different text" }],
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one criterion", () => {
    expect(PlanContractP1Schema.safeParse({ ...validP1, acceptance_criteria: [] }).success).toBe(
      false,
    );
  });
});

describe("expected_verification", () => {
  it("requires a named reviewer and a reason when the kind is manual", () => {
    expect(
      ExpectedVerificationSchema.safeParse({ kind: "manual", assertion: "a human looks at it" })
        .success,
    ).toBe(false);
    expect(
      ExpectedVerificationSchema.safeParse({
        kind: "manual",
        assertion: "a human looks at it",
        manual_reviewer: "lian",
        manual_reason: "the rendering can only be judged visually",
      }).success,
    ).toBe(true);
  });

  it("rejects manual fields on an automatable kind", () => {
    expect(
      ExpectedVerificationSchema.safeParse({
        kind: "test",
        assertion: "one email is queued",
        manual_reviewer: "lian",
      }).success,
    ).toBe(false);
  });
});

describe("higher levels add fields additively", () => {
  const p1Keys = Object.keys(PlanContractP1Schema.shape).filter((key) => key !== "level").sort();

  it("P2 keeps every P1 key", () => {
    const p2Keys = Object.keys(PlanContractP2Schema.shape);
    for (const key of p1Keys) expect(p2Keys).toContain(key);
  });

  it("P3 keeps every P2 key", () => {
    const p2Keys = Object.keys(PlanContractP2Schema.shape).filter((key) => key !== "level");
    const p3Keys = Object.keys(PlanContractP3Schema.shape);
    for (const key of p2Keys) expect(p3Keys).toContain(key);
  });

  it("a P1 body plus the P2 additions parses as P2", () => {
    const p2 = {
      ...validP1,
      level: "P2" as const,
      data_impact: "no schema change; one new column read",
      security_impact: "touches the signup path",
      rollout: "behind a flag",
      rollback: "disable the flag",
      estimated_recurring_cost_micros: 0,
    };
    expect(PlanContractSchema.parse(p2).level).toBe("P2");
  });

  it("a P1 body without the P2 additions is not a P2", () => {
    expect(PlanContractSchema.safeParse({ ...validP1, level: "P2" }).success).toBe(false);
  });
});

describe("P0", () => {
  it("has no acceptance criteria and is therefore not semantically reviewable", () => {
    const p0 = PlanContractSchema.parse({
      plan_id: validP1.plan_id,
      version: 1,
      ticket_id: validP1.ticket_id,
      level: "P0",
      outcome: "list the open pull requests",
      scope: validP1.scope,
      base: validP1.base,
      budget: { max_cost_micros: 50_000, max_wall_clock_ms: 20_000 },
    });
    expect(hasAcceptanceCriteria(p0)).toBe(false);
  });
});
