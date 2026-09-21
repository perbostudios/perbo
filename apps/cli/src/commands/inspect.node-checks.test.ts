import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SecretIndex, type CheckResult } from "@perbo/contracts";
import { BundleStore } from "@perbo/runner";
import { buildInspectReport, inspectCommandLine, renderInspect } from "./inspect.js";
import { makeAttempt, makeTicket } from "../test-support/attempt-fixture.js";
import { runCommandLine } from "../command-line/terminal.js";

/**
 * What `perbo inspect` says about a graphed ticket's checks (D-107).
 *
 * The pinned set ran once over the whole change and once per node, and the
 * record holds all of them. The attempt's checks section shows the
 * whole-change results as it always has, and each node's results under its own
 * node id — so a person reading the record sees which node failed what.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-inspect-node-checks-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TICKET_ID = "ticket_graph00001";
const ATTEMPT = "att_graphed000001";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      stdout: (chunk: string) => out.push(chunk),
      stderr: (chunk: string) => err.push(chunk),
      isTTY: false,
    },
  };
}

const result = (over: Partial<CheckResult>): CheckResult =>
  ({
    check_id: "check_unit",
    name: "unit",
    kind: "unit",
    status: "passed",
    summary: "Tests  143 passed (143)",
    command: "pnpm exec turbo run test",
    detail: null,
    duration_ms: 1200,
    source: "file",
    ...over,
  }) as CheckResult;

/** One attempt whose checks ran over the whole change and over two nodes. */
function storeWithNodeChecks(): { repo: string; store: string } {
  const repo = join(scratch, "repo");
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-1.json"),
    JSON.stringify(makeTicket({ key: "AYO-1", ticket_id: TICKET_ID, repository_root: repo })),
  );

  const attempt = makeAttempt({
    attempt_id: ATTEMPT,
    ticket_id: TICKET_ID,
    created_at: "2026-08-28T11:47:38.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { iterations: 4, commands: 2, wall_clock_ms: 40_000, cost_basis: "not_incurred" },
    changeset_id: "cs_graph00000001",
    head_commit: "b2c3d4e",
  });
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
  );

  const checks: CheckResult[] = [
    result({}),
    result({
      status: "failed",
      summary: "Tests  1 failed (12)",
      command: "pnpm exec vitest run test/send.test.ts",
      node: {
        node_id: "node_queue",
        paths: ["packages/queue/test/send.test.ts"],
        scope: "files",
        note: null,
      },
    }),
    result({
      node: {
        node_id: "node_reports",
        paths: [],
        scope: "task",
        note: "no changed file inside the node's paths is a test file",
      },
    }),
  ];

  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  bundles.write({
    kind: "execution",
    subject_id: ATTEMPT,
    ticket_id: TICKET_ID,
    inputs: { termination: "completed" },
    context_manifest: [],
    versions: {
      code: "stage-3",
      prompt: "executor_v4",
      policy: "A2b",
      model: "claude-opus-5",
      tool: "1.0.98",
    },
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cost_micros: 0,
      cost_basis: "unavailable",
      wall_clock_ms: 1,
    },
    artifacts: [
      { name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt) },
      { name: "transcript.jsonl", media_type: "application/x-ndjson", body: "" },
      { name: "checks.json", media_type: "application/json", body: JSON.stringify(checks) },
    ],
    errors: [],
    transitions: [],
    retention: { class: "raw_transcript", expires_at: null },
    secrets: new SecretIndex(),
    excluded_paths: [],
    deterministic: false,
    model_version_pinned: true,
    now: new Date("2026-08-28T11:51:58.000Z"),
  });

  return { repo, store };
}

/** A minimal, schema-valid `ReviewArtifact`, decision and findings overridable. */
function reviewArtifact(over: {
  review_id: string;
  decision: string;
  findings?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    review_id: over.review_id,
    created_at: "2026-08-28T11:52:00.000Z",
    target: {
      type: "changeset",
      id: "cs_graph00000001",
      base_commit: "a1b2c3d",
      head_commit: "b2c3d4e",
    },
    plan_id: "plan_graph00001",
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
    coverage: [],
    findings: over.findings ?? [],
    scope_deviation: {
      files_outside_scope: [],
      files_in_prohibited_paths: [],
      files_exempt_as_generated: [],
      within_expansion_budget: true,
      expansion_budget_files: 0,
    },
    decision: over.decision,
    confidence: null,
    cost_micros: 0,
    latency_ms: 0,
    model: { provider: "double", model_id: "double", prompt_version: "reviewer_v2", input_tokens: 0, output_tokens: 0 },
    error: null,
  };
}

const blockingFinding = (key: string) => ({
  key,
  rule_id: "test.missing_for_criterion",
  source: "semantic",
  criterion_id: "ac_1",
  severity: "major",
  blocking: true,
  blocking_reason: "blocks",
  routing: "blocks",
  row: null,
  closure: null,
  direction: null,
  caused_by_change: null,
  confidence: 0.9,
  file: "packages/queue/src/send.ts",
  line: 1,
  symbol: null,
  statement: "A node-local defect.",
  status: "open",
  outcome: "unknown",
  waiver: null,
});

/** `storeWithNodeChecks`'s store, with a review bundle recording both nodes' reviews (D-107). */
function storeWithNodeReviews(): { repo: string; store: string } {
  const { repo, store } = storeWithNodeChecks();
  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  const combined = reviewArtifact({
    review_id: "rev_0000000000000f01",
    decision: "changes_requested",
    findings: [blockingFinding("f".repeat(64))],
  });
  bundles.write({
    kind: "review",
    subject_id: "rev_0000000000000f01",
    ticket_id: TICKET_ID,
    inputs: {
      changeset_id: "cs_graph00000001",
      base_commit: "a1b2c3d",
      head_commit: "b2c3d4e",
      decision: "changes_requested",
      remediation_round: 0,
      remediation_available: true,
    },
    context_manifest: [],
    versions: { code: "stage-2", prompt: "reviewer_v2", policy: "blocking-matrix-v2", model: "double", tool: "double" },
    usage: { input_tokens: 0, output_tokens: 0, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 0 },
    artifacts: [
      { name: "review.json", media_type: "application/json", body: JSON.stringify(combined) },
      {
        name: "node-reviews.json",
        media_type: "application/json",
        body: JSON.stringify([
          {
            node_id: "node_queue",
            review: reviewArtifact({
              review_id: "rev_0000000000000a01",
              decision: "changes_requested",
              findings: [blockingFinding("f".repeat(64))],
            }),
          },
          { node_id: "node_reports", review: null },
        ]),
      },
    ],
    errors: [],
    transitions: [],
    retention: { class: "replay_retained", expires_at: null },
    secrets: new SecretIndex(),
    excluded_paths: [],
    deterministic: false,
    model_version_pinned: true,
    now: new Date("2026-08-28T11:52:00.000Z"),
  });
  return { repo, store };
}

const NO_CHECKS_ATTEMPT = "att_graphed000002";

/**
 * A round whose checks section was never retained — no execution bundle at
 * all, so `attempt.checks` reads back empty — but whose review bundle still
 * carries `node-reviews.json`, exactly as a review that ran with no check
 * result to echo still would (D-107).
 */
function storeWithNodeReviewsNoChecks(): { repo: string; store: string } {
  const repo = join(scratch, "repo-no-checks");
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-2.json"),
    JSON.stringify(makeTicket({ key: "AYO-2", ticket_id: TICKET_ID, repository_root: repo })),
  );

  const attempt = makeAttempt({
    attempt_id: NO_CHECKS_ATTEMPT,
    ticket_id: TICKET_ID,
    created_at: "2026-08-28T11:47:38.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { iterations: 4, commands: 2, wall_clock_ms: 40_000, cost_basis: "not_incurred" },
    changeset_id: "cs_graph00000002",
    head_commit: "b2c3d4e",
  });
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
  );

  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  const combined = reviewArtifact({
    review_id: "rev_0000000000000f02",
    decision: "changes_requested",
    findings: [blockingFinding("e".repeat(64))],
  });
  // No execution bundle at all — measured checks are null — and the review
  // artifact's own checks field is empty, so attempt.checks reads back [].
  combined["checks"] = [];
  bundles.write({
    kind: "review",
    subject_id: "rev_0000000000000f02",
    ticket_id: TICKET_ID,
    inputs: {
      changeset_id: "cs_graph00000002",
      base_commit: "a1b2c3d",
      head_commit: "b2c3d4e",
      decision: "changes_requested",
      remediation_round: 0,
      remediation_available: true,
    },
    context_manifest: [],
    versions: { code: "stage-2", prompt: "reviewer_v2", policy: "blocking-matrix-v2", model: "double", tool: "double" },
    usage: { input_tokens: 0, output_tokens: 0, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 0 },
    artifacts: [
      { name: "review.json", media_type: "application/json", body: JSON.stringify(combined) },
      {
        name: "node-reviews.json",
        media_type: "application/json",
        body: JSON.stringify([
          {
            node_id: "node_queue",
            review: reviewArtifact({
              review_id: "rev_0000000000000a02",
              decision: "changes_requested",
              findings: [blockingFinding("e".repeat(64))],
            }),
          },
          { node_id: "node_reports", review: null },
        ]),
      },
    ],
    errors: [],
    transitions: [],
    retention: { class: "replay_retained", expires_at: null },
    secrets: new SecretIndex(),
    excluded_paths: [],
    deterministic: false,
    model_version_pinned: true,
    now: new Date("2026-08-28T11:52:00.000Z"),
  });
  return { repo, store };
}

/**
 * A review bundle written before D-107's per-node review existed: it carries
 * `review.json` but no `node-reviews.json` artifact at all — not an empty
 * one. `node_reviews` reads back as `[]`.
 */
function storeWithReviewButNoNodeReviewsArtifact(): { repo: string; store: string } {
  const repo = join(scratch, "repo-old-bundle");
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-3.json"),
    JSON.stringify(makeTicket({ key: "AYO-3", ticket_id: TICKET_ID, repository_root: repo })),
  );

  const attempt = makeAttempt({
    attempt_id: "att_graphed000003",
    ticket_id: TICKET_ID,
    created_at: "2026-08-28T11:47:38.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { iterations: 4, commands: 2, wall_clock_ms: 40_000, cost_basis: "not_incurred" },
    changeset_id: "cs_graph00000003",
    head_commit: "b2c3d4e",
  });
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
  );

  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  bundles.write({
    kind: "review",
    subject_id: "rev_0000000000000f03",
    ticket_id: TICKET_ID,
    inputs: {
      changeset_id: "cs_graph00000003",
      base_commit: "a1b2c3d",
      head_commit: "b2c3d4e",
      decision: "approve",
      remediation_round: 0,
      remediation_available: true,
    },
    context_manifest: [],
    versions: { code: "stage-2", prompt: "reviewer_v2", policy: "blocking-matrix-v2", model: "double", tool: "double" },
    usage: { input_tokens: 0, output_tokens: 0, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 0 },
    artifacts: [
      {
        name: "review.json",
        media_type: "application/json",
        body: JSON.stringify(reviewArtifact({ review_id: "rev_0000000000000f03", decision: "approve" })),
      },
      // No node-reviews.json: exactly what a bundle written before D-107's
      // per-node review existed carries.
    ],
    errors: [],
    transitions: [],
    retention: { class: "replay_retained", expires_at: null },
    secrets: new SecretIndex(),
    excluded_paths: [],
    deterministic: false,
    model_version_pinned: true,
    now: new Date("2026-08-28T11:52:00.000Z"),
  });
  return { repo, store };
}

describe("a graphed attempt's checks section", () => {
  it("shows each node's results under its node id, beside the whole-change ones", () => {
    const { store } = storeWithNodeChecks();
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-1", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    const lines = rendered.split("\n");

    const checksAt = lines.findIndex((line) => line.includes("CHECKS"));
    expect(checksAt).toBeGreaterThan(-1);

    // The whole-change result reads as it always has, above any node.
    const whole = lines.findIndex((line) => line.includes("pnpm exec turbo run test"));
    expect(whole).toBeGreaterThan(checksAt);

    const queue = lines.findIndex((line) => line.includes("node_queue"));
    const reports = lines.findIndex((line) => line.includes("node_reports"));
    expect(queue).toBeGreaterThan(whole);
    expect(reports).toBeGreaterThan(queue);

    // What that node measured, under the node that measured it: the check,
    // the paths its run was narrowed to, and the reason where it was not.
    const underQueue = lines.slice(queue, reports).join("\n");
    expect(underQueue).toContain("unit");
    expect(underQueue).toContain("packages/queue/test/send.test.ts");
    expect(lines.slice(reports).join("\n")).toContain("no changed file inside the node's paths");

    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("names a node's failed check as that node's own", async () => {
    const { repo, store } = storeWithNodeChecks();
    const streams = capture();
    expect(
      await runCommandLine(inspectCommandLine, {
        argv: ["AYO-1", "--repo", repo, "--store", store, "--json"],
        streams: streams.streams,
        cwd: repo,
      }),
    ).toBe(0);
    const report = JSON.parse(streams.out.join("")) as {
      attempts: Array<{ checks: CheckResult[] | null }>;
    };
    const checks = report.attempts[0]!.checks!;
    expect(checks.filter((check) => check.node === undefined)).toHaveLength(1);
    const failed = checks.find((check) => check.status === "failed")!;
    expect(failed.node?.node_id).toBe("node_queue");
    expect(failed.node?.paths).toEqual(["packages/queue/test/send.test.ts"]);
  });
});

/**
 * What `perbo inspect` says about a graphed ticket's review (D-107): each
 * node's own decision and how many of its findings block, printed under that
 * node's own id beside its checks, or that the node was not reviewed on its
 * own where it held no file to review.
 */
describe("a graphed attempt's review section", () => {
  it("prints each node's review decision and blocking count under its own id", () => {
    const { store } = storeWithNodeReviews();
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-1", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    const lines = rendered.split("\n");

    const queue = lines.findIndex((line) => line.includes("node_queue"));
    const reports = lines.findIndex((line) => line.includes("node_reports"));
    expect(queue).toBeGreaterThan(-1);
    expect(reports).toBeGreaterThan(queue);

    const underQueue = lines.slice(queue, reports).join("\n");
    expect(underQueue).toContain("changes_requested");
    expect(underQueue).toContain("1 blocking");

    const underReports = lines.slice(reports).join("\n");
    expect(underReports).toContain("not reviewed on its own");

    // Width discipline for the two lines this feature adds. The pre-existing
    // REVIEW section header's own width is that section's own test's concern.
    const reviewLine = lines.find((line) => line.includes("changes_requested") && line.includes("blocking"))!;
    const skipLine = lines.find((line) => line.includes("not reviewed on its own"))!;
    expect(reviewLine.length).toBeLessThanOrEqual(80);
    expect(skipLine.length).toBeLessThanOrEqual(80);
  });

  it("carries each node's own artifact in the JSON report, and null for the unreviewed one", async () => {
    const { repo, store } = storeWithNodeReviews();
    const streams = capture();
    expect(
      await runCommandLine(inspectCommandLine, {
        argv: ["AYO-1", "--repo", repo, "--store", store, "--json"],
        streams: streams.streams,
        cwd: repo,
      }),
    ).toBe(0);
    const report = JSON.parse(streams.out.join("")) as {
      attempts: Array<{
        node_reviews: Array<{ node_id: string; review: { decision: string } | null }>;
      }>;
    };
    const nodeReviews = report.attempts[0]!.node_reviews;
    expect(nodeReviews.map((entry) => entry.node_id)).toEqual(["node_queue", "node_reports"]);
    expect(nodeReviews[0]!.review?.decision).toBe("changes_requested");
    expect(nodeReviews[1]!.review).toBeNull();
  });

  it("prints the node block even when the round has no check result at all", () => {
    const { store } = storeWithNodeReviewsNoChecks();
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-2", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    const lines = rendered.split("\n");

    const queue = lines.findIndex((line) => line.includes("node_queue"));
    expect(queue).toBeGreaterThan(-1);
    const underQueue = lines.slice(queue, queue + 3).join("\n");
    expect(underQueue).toContain("changes_requested");
    expect(underQueue).toContain("1 blocking");
  });

  it("reads node_reviews as [] from a review bundle with no node-reviews.json artifact", async () => {
    const { repo, store } = storeWithReviewButNoNodeReviewsArtifact();
    const streams = capture();
    expect(
      await runCommandLine(inspectCommandLine, {
        argv: ["AYO-3", "--repo", repo, "--store", store, "--json"],
        streams: streams.streams,
        cwd: repo,
      }),
    ).toBe(0);
    const report = JSON.parse(streams.out.join("")) as {
      attempts: Array<{ review: { decision: string } | null; node_reviews: unknown[] }>;
    };
    expect(report.attempts[0]!.review?.decision).toBe("approve");
    expect(report.attempts[0]!.node_reviews).toEqual([]);
  });
});
