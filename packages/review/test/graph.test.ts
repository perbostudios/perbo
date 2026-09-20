import { describe, expect, it, vi } from "vitest";
import {
  ChangeSetSchema,
  PlanContractSchema,
  ReviewArtifactSchema,
  hasAcceptanceCriteria,
  type ChangeSet,
  type CheckResult,
  type CriterionEvidenceBinding,
  type PlanContract,
  type ReviewArtifact,
} from "@perbo/contracts";
import { combineReviews, reviewGraph } from "../src/graph.js";
import { escalationCount } from "../src/review.js";
import type { ReviewInput, ReviewOutcome } from "../src/review.js";

const flatContract = (): PlanContract =>
  PlanContractSchema.parse({
    plan_id: "plan_flat",
    version: 1,
    ticket_id: "ticket_flat",
    level: "P1",
    outcome: "One piece of work lands.",
    acceptance_criteria: [
      {
        id: "ac_1",
        text: "The flat criterion holds.",
        expected_verification: { kind: "test", assertion: "it holds" },
      },
    ],
    scope: {
      repository_id: "repo_fixture",
      paths_allowed: ["packages/a/**"],
      paths_prohibited: [],
      generated_paths: [],
      expansion_budget_files: 0,
    },
    base: {
      base_commit: "0000000",
      context_manifest_hash: `sha256:${"0".repeat(64)}`,
      captured_at: "2026-08-27T00:00:00.000Z",
    },
  });

/**
 * Two nodes, and a third glob in `scope.paths_allowed` no node names — the
 * fixture AC4 needs: a file inside it reaches only the overall call.
 */
const graphContract = (): PlanContract =>
  PlanContractSchema.parse({
    plan_id: "plan_graph",
    version: 1,
    ticket_id: "ticket_graph",
    level: "P1",
    outcome: "Two independent pieces land together.",
    acceptance_criteria: [
      {
        id: "ac_1",
        text: "Node A's criterion holds.",
        expected_verification: { kind: "test", assertion: "a holds" },
      },
      {
        id: "ac_2",
        text: "Node B's criterion holds.",
        expected_verification: { kind: "test", assertion: "b holds" },
      },
    ],
    nodes: [
      { id: "node_a", title: "Node A", criteria: ["ac_1"], paths: ["packages/a/**"] },
      { id: "node_b", title: "Node B", criteria: ["ac_2"], paths: ["packages/b/**"] },
    ],
    scope: {
      repository_id: "repo_fixture",
      paths_allowed: ["packages/a/**", "packages/b/**", "packages/shared/**"],
      paths_prohibited: [],
      generated_paths: [],
      expansion_budget_files: 0,
    },
    base: {
      base_commit: "0000000",
      context_manifest_hash: `sha256:${"0".repeat(64)}`,
      captured_at: "2026-08-27T00:00:00.000Z",
    },
  });

const filePatch = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 0000000..1111111 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

const changeset = (files: string[]): ChangeSet =>
  ChangeSetSchema.parse({
    changeset_id: "cs_0000000000000001",
    base_commit: "0000000",
    head_commit: "1111111",
    head_commit_source: "recorded",
    files: files.map((path) => ({
      path,
      previous_path: null,
      change_kind: "modified" as const,
      additions: 1,
      deletions: 1,
      patch: filePatch(path),
    })),
    truncated: false,
    diff_bytes: 100,
  });

const check = (overrides: Partial<CheckResult> & { check_id: string; status: CheckResult["status"] }): CheckResult => ({
  name: "unit",
  kind: "unit",
  summary: "",
  command: null,
  detail: null,
  duration_ms: null,
  source: "file",
  ...overrides,
});

const coverageEntry = (overrides: Partial<CriterionEvidenceBinding> = {}): CriterionEvidenceBinding => ({
  criterion_id: "ac_1",
  status: "met",
  verification_strength: "directly_verified",
  evidence: null,
  note: null,
  authored_in_response_to: null,
  ...overrides,
});

let artifactSequence = 0;
const artifact = (overrides: Partial<ReviewArtifact> = {}): ReviewArtifact => {
  artifactSequence += 1;
  return ReviewArtifactSchema.parse({
    schema_version: 1,
    review_id: `rev_${artifactSequence.toString().padStart(16, "0")}`,
    created_at: "2026-08-27T00:00:00.000Z",
    target: { type: "changeset", id: "cs_0000000000000001", base_commit: "0000000", head_commit: "1111111" },
    plan_id: "plan_graph",
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
      grounded_in: ["plan.acceptance_criteria", "diff", "check_results", "selected_files"],
    },
    context_manifest: [],
    checks: [],
    overrides: [],
    coverage: [coverageEntry()],
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
    cost_micros: 1000,
    latency_ms: 100,
    model: { provider: "double", model_id: "double", prompt_version: "reviewer_v2", input_tokens: 1, output_tokens: 1 },
    error: null,
    ...overrides,
  });
};

const outcome = (artifactOverrides: Partial<ReviewArtifact> = {}): ReviewOutcome => ({
  artifact: artifact(artifactOverrides),
  bundle: { prompt_version: "reviewer_v2", system_prompt: "", turns: [], files_read: [], rejected_verdicts: [] },
});

const baseInput = (contract: PlanContract, changesetFiles: string[], checks: CheckResult[]): ReviewInput => ({
  contract,
  diff: changesetFiles.map(filePatch).join("\n"),
  changeset: changeset(changesetFiles),
  checks,
  repoDir: "/nowhere",
  model: { provider: "double", model_id: "double", turn: async () => ({ toolCalls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, stop_reason: "end_turn" }) },
});

/** A distinct model value, so a test can assert which call received which by identity. */
const fakeModel = (model_id: string) => ({
  provider: "double",
  model_id,
  turn: async () => ({
    toolCalls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    stop_reason: "end_turn" as const,
  }),
});

/** A counting double: records every call's input, in order, and answers from a fixed script. */
function scriptedRun(outcomes: ReviewOutcome[]): {
  run: (input: ReviewInput) => Promise<ReviewOutcome>;
  calls: ReviewInput[];
} {
  const calls: ReviewInput[] = [];
  let index = 0;
  return {
    calls,
    run: async (input: ReviewInput) => {
      calls.push(input);
      const next = outcomes[index];
      index += 1;
      if (!next) throw new Error(`scriptedRun called more times (${index}) than scripted (${outcomes.length})`);
      return next;
    },
  };
}

describe("reviewGraph — a flat contract", () => {
  it("calls run exactly once, with the input untouched, and combined is the overall artifact itself", async () => {
    const input = baseInput(flatContract(), ["packages/a/x.ts"], []);
    const scripted = outcome();
    const { run, calls } = scriptedRun([scripted]);

    const result = await reviewGraph(input, run);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(input);
    expect(result.nodes).toEqual([]);
    expect(result.overall).toBe(scripted);
    expect(result.combined).toBe(scripted.artifact);
  });

  it("drops a check tagged to a node this flat plan does not have, from the one call it makes", async () => {
    const taggedToNoNode = check({
      check_id: "check_unit",
      status: "failed",
      node: { node_id: "node_a", scope: "task", paths: [], note: "narrowed" },
    });
    const wholeChangeCheck = check({ check_id: "check_unit", status: "passed" });
    const input = baseInput(flatContract(), ["packages/a/x.ts"], [wholeChangeCheck, taggedToNoNode]);
    const { run, calls } = scriptedRun([outcome()]);

    await reviewGraph(input, run);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.checks).toEqual([wholeChangeCheck]);
    // The input itself is rebuilt only because checks changed; nothing else did.
    expect(calls[0]).not.toBe(input);
    expect(calls[0]!.contract).toBe(input.contract);
  });

  it("never calls modelFor, and the call's model is the caller's own", async () => {
    const input = baseInput(flatContract(), ["packages/a/x.ts"], []);
    const { run, calls } = scriptedRun([outcome()]);
    const modelFor = vi.fn();

    await reviewGraph(input, run, { modelFor });

    expect(modelFor).not.toHaveBeenCalled();
    expect(calls[0]).toBe(input);
    expect(calls[0]!.model).toBe(input.model);
  });
});

describe("reviewGraph — a two-node contract", () => {
  it("reviews each node in plan order, then the overall, with correctly narrowed inputs", async () => {
    const contract = graphContract();
    const failedNodeACheck = check({
      check_id: "check_unit",
      status: "failed",
      node: { node_id: "node_a", scope: "task", paths: [], note: "narrowed" },
    });
    const passedNodeBCheck = check({
      check_id: "check_unit",
      status: "passed",
      node: { node_id: "node_b", scope: "task", paths: [], note: "narrowed" },
    });
    const wholeChangeCheck = check({ check_id: "check_unit", status: "passed" });
    const checks = [wholeChangeCheck, failedNodeACheck, passedNodeBCheck];

    // packages/shared/** is in scope.paths_allowed but named by no node (AC4).
    const files = ["packages/a/a.ts", "packages/b/b.ts", "packages/shared/s.ts"];
    const input = baseInput(contract, files, checks);

    const nodeAOutcome = outcome({ review_id: "rev_0000000000000a01" });
    const nodeBOutcome = outcome({ review_id: "rev_0000000000000b01" });
    const overallOutcome = outcome({ review_id: "rev_0000000000000f01" });
    const { run, calls } = scriptedRun([nodeAOutcome, nodeBOutcome, overallOutcome]);

    const result = await reviewGraph(input, run);

    expect(calls).toHaveLength(3);
    expect(result.nodes.map((entry) => entry.node_id)).toEqual(["node_a", "node_b"]);
    expect(result.nodes[0]?.outcome).toBe(nodeAOutcome);
    expect(result.nodes[1]?.outcome).toBe(nodeBOutcome);
    expect(result.overall).toBe(overallOutcome);

    const [nodeACall, nodeBCall, overallCall] = calls;

    // Each node's contract carries only its own criteria and no graph.
    expect(nodeACall!.contract).toMatchObject({ acceptance_criteria: [{ id: "ac_1" }] });
    expect((nodeACall!.contract as { nodes?: unknown }).nodes).toBeUndefined();
    expect(nodeBCall!.contract).toMatchObject({ acceptance_criteria: [{ id: "ac_2" }] });
    // Scope is the ticket's whole scope on every call, node or overall.
    expect(nodeACall!.contract.scope).toEqual(contract.scope);
    expect(nodeBCall!.contract.scope).toEqual(contract.scope);
    expect(overallCall!.contract.scope).toEqual(contract.scope);
    // The overall call's contract keeps the full criteria and the graph.
    expect(overallCall!.contract).toBe(contract);

    // Each node's diff/change set holds only the files inside its paths.
    expect(nodeACall!.changeset?.files.map((file) => file.path)).toEqual(["packages/a/a.ts"]);
    expect(nodeBCall!.changeset?.files.map((file) => file.path)).toEqual(["packages/b/b.ts"]);
    // The path in scope.paths_allowed that no node names is in the overall
    // call's change set, and in neither node's (AC4).
    expect(overallCall!.changeset?.files.map((file) => file.path)).toEqual(files);

    // Each node's checks are only its own; the overall's are whole-change only.
    expect(nodeACall!.checks).toEqual([failedNodeACheck]);
    expect(nodeBCall!.checks).toEqual([passedNodeBCheck]);
    expect(overallCall!.checks).toEqual([wholeChangeCheck]);
  });

  it("does not review a node with no file inside its paths: no call, outcome null", async () => {
    const contract = graphContract();
    // Only node A's path changed.
    const input = baseInput(contract, ["packages/a/a.ts"], []);
    const overallOutcome = outcome();
    const { run, calls } = scriptedRun([outcome(), overallOutcome]);

    const result = await reviewGraph(input, run);

    expect(calls).toHaveLength(2);
    expect(result.nodes[0]?.node_id).toBe("node_a");
    expect(result.nodes[1]?.node_id).toBe("node_b");
    expect(result.nodes[1]?.outcome).toBeNull();
  });

  it("builds a model per call, from that call's own contract and checks, in plan order", async () => {
    const contract = graphContract();
    const nodeACheck = check({
      check_id: "check_unit",
      status: "passed",
      node: { node_id: "node_a", scope: "task", paths: [], note: "narrowed" },
    });
    const nodeBCheck = check({
      check_id: "check_unit",
      status: "passed",
      node: { node_id: "node_b", scope: "task", paths: [], note: "narrowed" },
    });
    const wholeChangeCheck = check({ check_id: "check_unit", status: "passed" });
    const checks = [wholeChangeCheck, nodeACheck, nodeBCheck];
    const files = ["packages/a/a.ts", "packages/b/b.ts"];
    const input = baseInput(contract, files, checks);

    const modelA = fakeModel("model_a");
    const modelB = fakeModel("model_b");
    const modelOverall = fakeModel("model_overall");
    const modelFor = vi.fn((c: PlanContract, _checks: readonly CheckResult[]) => {
      const ids = hasAcceptanceCriteria(c) ? c.acceptance_criteria.map((entry) => entry.id) : [];
      if (ids.length === 1 && ids[0] === "ac_1") return modelA;
      if (ids.length === 1 && ids[0] === "ac_2") return modelB;
      return modelOverall;
    });
    const { run, calls } = scriptedRun([outcome(), outcome(), outcome()]);

    await reviewGraph(input, run, { modelFor });

    expect(modelFor).toHaveBeenCalledTimes(3);
    // Node A, node B, then the overall — in that order — each with that
    // call's own narrowed criteria and checks, the overall's the full
    // contract and the whole-change checks alone.
    expect(modelFor.mock.calls[0]![0]).toMatchObject({ acceptance_criteria: [{ id: "ac_1" }] });
    expect(modelFor.mock.calls[0]![1]).toEqual([nodeACheck]);
    expect(modelFor.mock.calls[1]![0]).toMatchObject({ acceptance_criteria: [{ id: "ac_2" }] });
    expect(modelFor.mock.calls[1]![1]).toEqual([nodeBCheck]);
    expect(modelFor.mock.calls[2]![0]).toBe(contract);
    expect(modelFor.mock.calls[2]![1]).toEqual([wholeChangeCheck]);

    // Each call's own input carries the model built for it.
    expect(calls[0]!.model).toBe(modelA);
    expect(calls[1]!.model).toBe(modelB);
    expect(calls[2]!.model).toBe(modelOverall);
  });
});

describe("combineReviews — coverage precedence", () => {
  const cases: Array<{
    name: string;
    overall: Partial<CriterionEvidenceBinding>;
    node: Partial<CriterionEvidenceBinding>;
    winner: "overall" | "node";
  }> = [
    { name: "cannot_determine over not_met", overall: { status: "not_met" }, node: { status: "cannot_determine" }, winner: "node" },
    { name: "not_met over met", overall: { status: "met" }, node: { status: "not_met" }, winner: "node" },
    { name: "cannot_determine over met", overall: { status: "met" }, node: { status: "cannot_determine" }, winner: "node" },
    { name: "the overall's cannot_determine over the node's met", overall: { status: "cannot_determine" }, node: { status: "met" }, winner: "overall" },
    { name: "equal status: asserted_only over proxy", overall: { verification_strength: "proxy" }, node: { verification_strength: "asserted_only" }, winner: "node" },
    { name: "equal status: proxy over directly_verified", overall: { verification_strength: "directly_verified" }, node: { verification_strength: "proxy" }, winner: "node" },
    { name: "equal status and strength: the overall wins the tie", overall: { verification_strength: "proxy" }, node: { verification_strength: "proxy" }, winner: "overall" },
  ];

  it.each(cases)("$name", ({ overall, node, winner }) => {
    const overallOutcome = outcome({
      coverage: [coverageEntry({ criterion_id: "ac_1", note: "from-overall", ...overall })],
    });
    const nodeOutcome = outcome({
      coverage: [coverageEntry({ criterion_id: "ac_1", note: "from-node", ...node })],
    });

    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);

    expect(combined.coverage).toHaveLength(1);
    expect(combined.coverage[0]?.note).toBe(winner === "overall" ? "from-overall" : "from-node");
  });

  it("keeps the overall's entry whole (with its evidence) when it wins", () => {
    const overallOutcome = outcome({
      coverage: [
        coverageEntry({
          criterion_id: "ac_1",
          status: "cannot_determine",
          evidence: { type: "manual", ref: null, assertion: "seen by hand", location: null },
        }),
      ],
    });
    const nodeOutcome = outcome({ coverage: [coverageEntry({ criterion_id: "ac_1", status: "met" })] });

    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);

    expect(combined.coverage[0]?.evidence?.assertion).toBe("seen by hand");
  });

  it("leaves a criterion no node reviewed as the overall's entry alone", () => {
    const overallOutcome = outcome({
      coverage: [coverageEntry({ criterion_id: "ac_1" }), coverageEntry({ criterion_id: "ac_2", status: "not_met" })],
    });
    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: null }]);
    expect(combined.coverage).toHaveLength(2);
    expect(combined.coverage.find((entry) => entry.criterion_id === "ac_2")?.status).toBe("not_met");
  });
});

describe("combineReviews — findings, error and decision", () => {
  const blockingFinding = (overrides: Record<string, unknown> = {}) => ({
    key: "f".repeat(64),
    rule_id: "test.missing_for_criterion",
    source: "semantic" as const,
    criterion_id: "ac_1",
    severity: "major" as const,
    blocking: true,
    blocking_reason: "blocks",
    routing: "blocks" as const,
    row: null,
    closure: null,
    direction: null,
    caused_by_change: null,
    confidence: 0.9,
    file: "packages/a/a.ts",
    line: 1,
    symbol: null,
    statement: "A node-local defect.",
    status: "open" as const,
    outcome: "unknown" as const,
    waiver: null,
    ...overrides,
  });

  it("drops a finding whose key the overall already used", () => {
    const shared = blockingFinding();
    const overallOutcome = outcome({ findings: [shared], decision: "changes_requested" });
    const nodeOutcome = outcome({ findings: [shared], decision: "changes_requested" });
    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);
    expect(combined.findings).toHaveLength(1);
  });

  it("keeps the blocking finding, not the overall's, when the same key reads non-blocking there and blocking in a node", () => {
    const sharedKey = "b".repeat(64);
    const overallOutcome = outcome({
      decision: "approve",
      findings: [
        blockingFinding({
          key: sharedKey,
          blocking: false,
          blocking_reason: "advisory",
          routing: "advisory",
          statement: "The overall read this as advisory.",
        }),
      ],
    });
    const nodeOutcome = outcome({
      decision: "changes_requested",
      findings: [blockingFinding({ key: sharedKey, statement: "The node read the same defect as blocking." })],
    });

    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);

    expect(combined.findings).toHaveLength(1);
    expect(combined.findings[0]?.blocking).toBe(true);
    expect(combined.findings[0]?.statement).toBe("The node read the same defect as blocking.");
    expect(combined.decision).toBe("changes_requested");
  });

  it("keeps the escalating finding, not the overall's advisory one, when the same key reads differently", () => {
    const sharedKey = "c".repeat(64);
    const overallOutcome = outcome({
      decision: "approve",
      findings: [
        blockingFinding({
          key: sharedKey,
          blocking: false,
          blocking_reason: "advisory",
          routing: "advisory",
          statement: "The overall read this as advisory.",
        }),
      ],
    });
    const nodeOutcome = outcome({
      decision: "escalate",
      findings: [
        blockingFinding({
          key: sharedKey,
          blocking: false,
          blocking_reason: "escalates",
          routing: "escalates",
          statement: "The node escalated the same defect.",
        }),
      ],
    });

    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);

    expect(combined.findings).toHaveLength(1);
    expect(combined.findings[0]?.routing).toBe("escalates");
    expect(combined.findings[0]?.statement).toBe("The node escalated the same defect.");
    expect(combined.decision).toBe("escalate");
  });

  it("closes the gate on a node-only blocking finding even when the overall approved", () => {
    const overallOutcome = outcome({ decision: "approve", findings: [] });
    const nodeOutcome = outcome({
      decision: "changes_requested",
      findings: [blockingFinding({ key: "a".repeat(64) })],
    });
    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);
    expect(combined.decision).toBe("changes_requested");
  });

  it("takes the overall's error, else the first node's", () => {
    const overallError = { kind: "internal" as const, message: "overall broke", attempts: 1, unresolved_criteria: [], reading: [] };
    const nodeError = { kind: "timeout" as const, message: "node broke", attempts: 1, unresolved_criteria: [], reading: [] };

    const withOverallError = combineReviews(outcome({ error: overallError }), [
      { node_id: "node_a", outcome: outcome({ error: nodeError }) },
    ]);
    expect(withOverallError.error).toEqual(overallError);
    expect(withOverallError.decision).toBe("error");

    const withNodeErrorOnly = combineReviews(outcome({ error: null }), [
      { node_id: "node_a", outcome: outcome({ error: nodeError }) },
      { node_id: "node_b", outcome: null },
    ]);
    expect(withNodeErrorOnly.error).toEqual(nodeError);
    expect(withNodeErrorOnly.decision).toBe("error");
  });

  it("reads incomplete off the combined coverage, from a node's cannot_determine", () => {
    const overallOutcome = outcome({ coverage: [coverageEntry({ criterion_id: "ac_1", status: "met" })] });
    const nodeOutcome = outcome({ coverage: [coverageEntry({ criterion_id: "ac_1", status: "cannot_determine" })] });
    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);
    expect(combined.decision).toBe("incomplete");
  });
});

describe("combineReviews — sums, unions and schema", () => {
  it("sums cost and latency over every call made", () => {
    const overallOutcome = outcome({ cost_micros: 1000, latency_ms: 500 });
    const nodeAOutcome = outcome({ cost_micros: 200, latency_ms: 50 });
    const nodeBOutcome = outcome({ cost_micros: 300, latency_ms: 75 });
    const combined = combineReviews(overallOutcome, [
      { node_id: "node_a", outcome: nodeAOutcome },
      { node_id: "node_b", outcome: nodeBOutcome },
    ]);
    expect(combined.cost_micros).toBe(1500);
    expect(combined.latency_ms).toBe(625);
  });

  it("sums every model token field over every call made, keeping the overall's provider, model id, prompt version and cost basis", () => {
    const overallOutcome = outcome({
      model: {
        provider: "double",
        model_id: "double",
        prompt_version: "reviewer_v2",
        input_tokens: 1000,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 10,
        output_tokens: 200,
        cost_basis: "transport_reported",
      },
    });
    const nodeAOutcome = outcome({
      model: {
        provider: "double",
        model_id: "double",
        prompt_version: "reviewer_v2",
        input_tokens: 300,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        cost_basis: "unavailable",
      },
    });
    const nodeBOutcome = outcome({
      model: {
        provider: "double",
        model_id: "double",
        prompt_version: "reviewer_v2",
        input_tokens: 400,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
        output_tokens: 70,
        cost_basis: "unavailable",
      },
    });

    const combined = combineReviews(overallOutcome, [
      { node_id: "node_a", outcome: nodeAOutcome },
      { node_id: "node_b", outcome: nodeBOutcome },
    ]);

    // 1000 + 300 + 400, 200 + 20 + 30, 10 + 0 + 5, 200 + 50 + 70.
    expect(combined.model.input_tokens).toBe(1700);
    expect(combined.model.cache_read_input_tokens).toBe(250);
    expect(combined.model.cache_creation_input_tokens).toBe(15);
    expect(combined.model.output_tokens).toBe(320);
    expect(combined.model.provider).toBe("double");
    // The overall's basis, kept even though a node's disagreed — there is no
    // "mixed" member in ReviewCostBasisSchema to mark that with.
    expect(combined.model.cost_basis).toBe("transport_reported");
  });

  it("does not add a skipped node's null outcome into the sums", () => {
    const overallOutcome = outcome({ cost_micros: 1000, latency_ms: 500 });
    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: null }]);
    expect(combined.cost_micros).toBe(1000);
    expect(combined.latency_ms).toBe(500);
  });

  it("unions checks and context_manifest, deduplicated on the key each already carries", () => {
    const sharedCheck = check({ check_id: "check_scope", status: "passed" });
    const nodeOnlyCheck = check({
      check_id: "check_unit",
      status: "failed",
      node: { node_id: "node_a", scope: "task", paths: [], note: "narrowed" },
    });
    const sharedContextItem = {
      id: "plan_contract",
      kind: "plan_contract" as const,
      trust: "system" as const,
      provenance: "test",
      selection_reason: "test",
      bytes: 10,
      sha256: "0".repeat(64),
    };
    const overallOutcome = outcome({ checks: [sharedCheck], context_manifest: [sharedContextItem] });
    const nodeOutcome = outcome({ checks: [sharedCheck, nodeOnlyCheck], context_manifest: [sharedContextItem] });

    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);

    expect(combined.checks).toHaveLength(2);
    expect(combined.checks.filter((entry) => entry.check_id === "check_scope")).toHaveLength(1);
    expect(combined.context_manifest).toHaveLength(1);
  });

  it("concatenates rejected_verdicts and overrides without deduplicating", () => {
    const rejected = { attempt: 1, kind: "malformed_verdict" as const, reason: "bad shape" };
    const override = {
      check_id: "check_unit",
      check_name: "unit",
      measured_status: "failed",
      asserted_status: "passed",
      discarded: "the model's claim; the measurement is authoritative",
    };
    const overallOutcome = outcome({ rejected_verdicts: [rejected], overrides: [override] });
    const nodeOutcome = outcome({ rejected_verdicts: [rejected], overrides: [override] });
    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);
    expect(combined.rejected_verdicts).toHaveLength(2);
    expect(combined.overrides).toHaveLength(2);
  });

  it("parses under ReviewArtifactSchema", () => {
    const overallOutcome = outcome();
    const nodeOutcome = outcome();
    const combined = combineReviews(overallOutcome, [{ node_id: "node_a", outcome: nodeOutcome }]);
    expect(() => ReviewArtifactSchema.parse(combined)).not.toThrow();
  });
});

/**
 * `runReview` counts an escalation once per finding the blocking matrix
 * routed `escalates`, after `applyBlocking` has stamped that routing onto it
 * (`review.ts`). `combineReviews` above recomputes the same count over a
 * combined findings list, which is why this reads it back from `routing`
 * rather than from a separate tally.
 */
describe("escalationCount", () => {
  const routedFinding = (routing: string) => ({ rule_id: "r", blocking: false, routing }) as never;

  it("counts only the findings routed to escalate, not blocking, remediable or advisory ones", () => {
    const findings = [
      routedFinding("escalates"),
      routedFinding("blocks"),
      routedFinding("remediable"),
      routedFinding("escalates"),
      routedFinding("advisory"),
      routedFinding("waived"),
    ];
    expect(escalationCount(findings)).toBe(2);
  });

  it("is zero when nothing escalated", () => {
    expect(escalationCount([routedFinding("advisory"), routedFinding("blocks")])).toBe(0);
  });
});
