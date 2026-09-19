import { describe, expect, it } from "vitest";
import type { CheckResult, Finding } from "@perbo/contracts";
import { changeSetFromDiff, findingKey } from "@perbo/contracts";
import {
  CLOSURE_VERIFY_PROMPT_VERSION,
  closureVerifySchema,
  verifyClosures,
  type ClosureVerification,
} from "../src/closure-verify.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  key: findingKey({ rule_id: over.rule_id ?? "test.assertion_missing", criterion_id: null, file: over.file ?? "src/a.ts", symbol: null }),
  rule_id: "test.assertion_missing",
  source: "semantic",
  row: "semantic_ordinary",
  closure: "executor",
  criterion_id: null,
  severity: "advisory",
  blocking: false,
  blocking_reason: "routed",
  confidence: 0.8,
  file: "src/a.ts",
  line: 3,
  symbol: null,
  statement: "No test exercises total().",
  routing: "remediable",
  status: "open",
  outcome: "unknown",
  waiver: null,
  ...over,
});

const check = (status: CheckResult["status"]): CheckResult => ({
  check_id: "check_ut",
  name: "unit",
  kind: "unit",
  status,
  summary: `unit ${status}`,
  command: "pnpm test",
  detail: null,
  duration_ms: 5,
  source: "file",
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

const scope = {
  repository_id: "repo_fixture",
  paths_allowed: ["src/**"],
  paths_prohibited: [".github/**"],
  generated_paths: [],
  expansion_budget_files: 2,
};

const modelSaying = (
  closures: Array<{ finding_key: string; status: string; pointer: string }>,
  options: {
    reportedCostMicros?: number;
    unreportedCostBasis?: "provider_list_estimate" | "unavailable";
  } = {},
) => ({
  provider: "test",
  model_id: "test-model",
  ...(options.unreportedCostBasis
    ? { unreported_cost_basis: options.unreportedCostBasis }
    : {}),
  turn: async () => ({
    toolCalls: [{ id: "t1", name: "submit_review", input: { closures } }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    stop_reason: "tool_use",
    ...(options.reportedCostMicros === undefined
      ? {}
      : { reported_cost_micros: options.reportedCostMicros }),
  }),
});

const run = (args: {
  findings: Finding[];
  checks: CheckResult[];
  model: unknown;
}): Promise<ClosureVerification> =>
  verifyClosures({
    findings: args.findings,
    diff: DIFF,
    checks: args.checks,
    scope,
    changeset: changeSetFromDiff({ diff: DIFF, base_commit: "a1b2c3d" }),
    model: args.model as never,
  });

/** A pinned check the review routed once (d069): the checks close it, not the diff. */
const routedCheck = (): Finding =>
  finding({
    rule_id: "check.unit",
    source: "deterministic",
    row: "deterministic",
    closure: null,
    severity: "blocker",
    file: null,
    line: null,
    symbol: "unit",
    statement: "The unit check failed (exited 1). Its last lines:\nFAIL test/a.test.ts",
    caused_by_change: true,
  });

const modelNeverAsked = () => ({
  provider: "test",
  model_id: "test-model",
  turn: async () => {
    throw new Error("the verifier asked the model about a finding the checks already answered");
  },
});

describe("a routed check finding is closed by the checks, not the diff (d069)", () => {
  it("closes it without a model call when the round's pinned checks pass", async () => {
    const f = routedCheck();
    const result = await run({ findings: [f], checks: [check("passed")], model: modelNeverAsked() });
    expect(result.deterministic_failure).toBeNull();
    expect(result.all_closed).toBe(true);
    expect(result.open_keys).toEqual([]);
    expect(result.per_finding).toEqual([
      expect.objectContaining({ finding_key: f.key, status: "closed", pointer: "check_ut passed on the round's tree" }),
    ]);
    expect(result.cost_basis).toBe("not_incurred");
  });

  it("asks the model only about the rest, and the check row is closed beside its answer", async () => {
    const c = routedCheck();
    const s = finding();
    const asked: string[] = [];
    const model = {
      ...modelSaying([{ finding_key: s.key, status: "not_closed", pointer: "" }]),
    };
    const listening = {
      ...model,
      turn: async (input: { messages: Array<{ content: string }> }) => {
        asked.push(input.messages[0]!.content);
        return model.turn();
      },
    };
    const result = await run({ findings: [c, s], checks: [check("passed")], model: listening });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(s.key);
    expect(asked[0]).not.toContain(c.key);
    expect(result.per_finding.find((row) => row.finding_key === c.key)?.status).toBe("closed");
    expect(result.per_finding.find((row) => row.finding_key === s.key)?.status).toBe("not_closed");
    expect(result.open_keys).toEqual([s.key]);
    expect(result.all_closed).toBe(false);
  });

  it("stops on the checks when the round left them failing, and says which gate", async () => {
    const f = routedCheck();
    const result = await run({ findings: [f], checks: [check("failed")], model: modelNeverAsked() });
    expect(result.deterministic_failure).toContain("does not pass the pinned checks");
    expect(result.deterministic_failure_kind).toBe("check");
    expect(result.open_keys).toEqual([f.key]);
  });
});

describe("closure verification is not a second opinion (D-061, SCP-101)", () => {
  it("all findings verified closed opens the way", async () => {
    const f = finding();
    const result = await run({
      findings: [f],
      checks: [check("passed")],
      model: modelSaying([{ finding_key: f.key, status: "closed", pointer: "test added at test/a.test.ts" }]),
    });
    expect(result.all_closed).toBe(true);
    expect(result.deterministic_failure).toBeNull();
    expect(result.per_finding[0]?.status).toBe("closed");
    expect(result.prompt_version).toBe(CLOSURE_VERIFY_PROMPT_VERSION);
  });

  it("a failed pinned check fails verification before any model is asked", async () => {
    let asked = false;
    const model = { provider: "t", model_id: "t", turn: async () => ((asked = true), { toolCalls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, stop_reason: null }) };
    const result = await run({ findings: [finding()], checks: [check("failed")], model });
    expect(result.all_closed).toBe(false);
    expect(result.deterministic_failure).toContain("check_ut");
    expect(asked).toBe(false);
  });

  it("a scope escape introduced by the fix fails verification deterministically", async () => {
    const hostileDiff = DIFF + `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 1111111..2222222 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,1 +1,1 @@
-a
+b
`;
    const result = await verifyClosures({
      findings: [finding()],
      diff: hostileDiff,
      checks: [check("passed")],
      scope,
      changeset: changeSetFromDiff({ diff: hostileDiff, base_commit: "a1b2c3d" }),
      model: modelSaying([]) as never,
    });
    expect(result.all_closed).toBe(false);
    expect(result.deterministic_failure).toContain("scope");
  });

  it("a round that leaves illegible bytes in the change fails verification deterministically", async () => {
    // The review routed the NUL once (d068); the round is the executor's one
    // chance, and a diff that still carries it stops here with no model asked.
    const f = finding();
    const result = await verifyClosures({
      findings: [f],
      diff: DIFF.replace("+const a = 2;", "+const a = \"\u0000\";"),
      checks: [check("passed")],
      scope,
      changeset: changeSetFromDiff({ diff: DIFF, base_commit: "a1b2c3d" }),
      model: { turn: () => { throw new Error("the model must not be asked"); } } as never,
    });
    expect(result.deterministic_failure).toContain("legibility");
    expect(result.deterministic_failure).toContain("NUL");
    expect(result.all_closed).toBe(false);
    expect(result.cost_basis).toBe("not_incurred");
  });

  it("cannot_tell counts as not closed — uncertainty resolves toward a person", async () => {
    const f = finding();
    const result = await run({
      findings: [f],
      checks: [check("passed")],
      model: modelSaying([{ finding_key: f.key, status: "cannot_tell", pointer: "" }]),
    });
    expect(result.all_closed).toBe(false);
    expect(result.open_keys).toEqual([f.key]);
  });

  it("a finding the model omits is recorded cannot_tell, never silently closed", async () => {
    const a = finding();
    const b = finding({ rule_id: "code.unused_import", file: "src/b.ts" });
    const result = await run({
      findings: [a, b],
      checks: [check("passed")],
      model: modelSaying([{ finding_key: a.key, status: "closed", pointer: "done" }]),
    });
    expect(result.all_closed).toBe(false);
    expect(result.per_finding.find((row) => row.finding_key === b.key)?.status).toBe("cannot_tell");
  });

  it("the submit schema enumerates exactly the finding keys under verification", () => {
    const a = finding();
    const schema = closureVerifySchema([a.key]) as { properties?: { closures?: { items?: { properties?: { finding_key?: { enum?: string[] } } } } } };
    expect(schema.properties?.closures?.items?.properties?.finding_key?.enum).toEqual([a.key]);
  });
});

describe("closure-verification dollar accounting (D-070)", () => {
  it("uses the configured complete list-price basis when the transport reports no dollars", async () => {
    const f = finding();
    const result = await run({
      findings: [f],
      checks: [check("passed")],
      model: modelSaying([{ finding_key: f.key, status: "closed", pointer: "src/a.ts" }]),
    });
    expect(result.cost_micros).toBe(30);
    expect(result.cost_basis).toBe("provider_list_estimate");
  });

  it("keeps an unpriceable verifier at zero with an unavailable basis", async () => {
    const f = finding();
    const result = await run({
      findings: [f],
      checks: [check("passed")],
      model: modelSaying(
        [{ finding_key: f.key, status: "closed", pointer: "src/a.ts" }],
        { unreportedCostBasis: "unavailable" },
      ),
    });
    expect(result.usage.input_tokens).toBe(1);
    expect(result.cost_micros).toBe(0);
    expect(result.cost_basis).toBe("unavailable");
  });

  it("preserves a transport-reported verifier charge", async () => {
    const f = finding();
    const result = await run({
      findings: [f],
      checks: [check("passed")],
      model: modelSaying(
        [{ finding_key: f.key, status: "closed", pointer: "src/a.ts" }],
        { reportedCostMicros: 123_456, unreportedCostBasis: "unavailable" },
      ),
    });
    expect(result.cost_micros).toBe(123_456);
    expect(result.cost_basis).toBe("transport_reported");
  });

  it("distinguishes a deterministic no-call zero from an unavailable model charge", async () => {
    const result = await run({
      findings: [finding()],
      checks: [check("failed")],
      model: modelSaying([], { unreportedCostBasis: "unavailable" }),
    });
    expect(result.cost_micros).toBe(0);
    expect(result.cost_basis).toBe("not_incurred");
  });
});

describe("the idiomaticity question (D-065): asked, recorded, never gating", () => {
  it("asks whether the fix is the established pattern, in the schema", () => {
    const schema = closureVerifySchema(["k1"]) as {
      properties: { closures: { items: { required: string[]; properties: Record<string, unknown> } } };
    };
    expect(schema.properties.closures.items.required).toContain("idiomatic");
    expect(schema.properties.closures.items.required).toContain("practice");
  });

  it("records the answer and the named practice on the row", async () => {
    const f = finding();
    const result = await run({
      findings: [f],
      checks: [check("passed")],
      model: modelSaying([
        {
          finding_key: f.key,
          status: "closed",
          pointer: "src/a.ts",
          idiomatic: "working_but_not_idiomatic",
          practice: "use crypto.timingSafeEqual instead of a hand-rolled comparison",
        } as never,
      ]),
    });
    expect(result.per_finding[0]?.idiomatic).toBe("working_but_not_idiomatic");
    expect(result.per_finding[0]?.practice).toContain("timingSafeEqual");
    // Never gating: the finding is closed and stays closed. The note travels
    // to the notification; it does not reopen the loop.
    expect(result.all_closed).toBe(true);
    expect(result.open_keys).toEqual([]);
  });

  it("defaults to cannot_tell when the model does not answer it", async () => {
    const f = finding();
    const result = await run({
      findings: [f],
      checks: [check("passed")],
      model: modelSaying([{ finding_key: f.key, status: "closed", pointer: "src/a.ts" }]),
    });
    expect(result.per_finding[0]?.idiomatic).toBe("cannot_tell");
    expect(result.per_finding[0]?.practice).toBe("");
  });

  it("moved the prompt version with the question", () => {
    expect(CLOSURE_VERIFY_PROMPT_VERSION).toBe("closure_verify_v2");
  });
});

describe("an all-declined round still meets the deterministic gate (D-065 review fix)", () => {
  it("fails on a failed pinned check with no findings to verify", async () => {
    const result = await run({ findings: [], checks: [check("failed")], model: { turn: async () => { throw new Error("must not be called"); } } });
    expect(result.all_closed).toBe(false);
    expect(result.deterministic_failure).toContain("check_ut");
  });

  it("passes without a model call when the gates pass and nothing needs verifying", async () => {
    let asked = false;
    const result = await run({
      findings: [],
      checks: [check("passed")],
      model: { turn: async () => ((asked = true), { toolCalls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, stop_reason: null }) },
    });
    expect(asked).toBe(false);
    expect(result.all_closed).toBe(true);
    expect(result.open_keys).toEqual([]);
  });
});
