import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ExecutionAttemptSchema,
  SecretIndex,
  type CheckResult,
  type ExecutionAttempt,
  type ReviewArtifact,
  type RunBundle,
  type RunBundleKind,
} from "@perbo/contracts";
import { BundleStore } from "@perbo/runner";
import { UsageError } from "../usage-error.js";
import { buildInspectReport, inspectCommandLine, renderInspect } from "./inspect.js";
import { FINDING_KEY, makeAttempt, makeReview, makeTicket } from "../test-support/records.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";
import { WIDTH } from "../text.js";

const scratch = mkdtempSync(join(tmpdir(), "perbo-inspect-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TICKET_ID = "ticket_inspect0001";
const FIRST = "att_first000000001";
const SECOND = "att_second00000001";
const THIRD = "att_third000000001";

/**
 * The lines of one attempt's block, from its ATTEMPT line to the next one's —
 * so an assertion about the order inside a block cannot be satisfied by a line
 * belonging to the attempt above or below it.
 */
function attemptBlock(rendered: string, attempt_id: string): string[] {
  const lines = rendered.split("\n");
  const start = lines.findIndex((line) => line.startsWith("ATTEMPT") && line.includes(attempt_id));
  expect(start, `no ATTEMPT block for ${attempt_id}`).toBeGreaterThan(-1);
  const next = lines.slice(start + 1).findIndex((line) => line.startsWith("ATTEMPT"));
  return next === -1 ? lines.slice(start) : lines.slice(start, start + 1 + next);
}

/** Where a block first says something, refusing a needle it never says. */
function lineWith(block: string[], needle: string): number {
  const at = block.findIndex((line) => line.includes(needle));
  expect(at, `no line holds ${JSON.stringify(needle)}:\n${block.join("\n")}`).toBeGreaterThan(-1);
  return at;
}

const DIFF = `diff --git a/packages/search/src/query.ts b/packages/search/src/query.ts
index 1111111..2222222 100644
--- a/packages/search/src/query.ts
+++ b/packages/search/src/query.ts
@@ -1,1 +1,2 @@
-export const PAGE = 0;
+export const PAGE = 25;
+export const total = 140;
`;

/**
 * A store with three attempts on one ticket: one that hit the iteration
 * ceiling at 61 against 60 with no dollar cost available, one that completed
 * and was reviewed `remediable`, and a remediation round whose executor
 * declined the finding.
 */
function storeWithAttempts(
  name: string,
  checks?: ReviewArtifact["checks"],
): { repo: string; store: string } {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-7.json"),
    JSON.stringify(
      makeTicket({
        key: "AYO-7",
        ticket_id: TICKET_ID,
        repository_root: repo,
        pull_request_url: "https://example.invalid/pull/9",
      }),
    ),
  );
  // Raised since the first attempt ran, which is what makes "the ceiling in
  // force when it was hit" a distinct number from "the ceiling now".
  writeFileSync(
    join(store, "config.json"),
    JSON.stringify({ limits: { organisation: "t", limits: { attempt_iterations: 200 } } }),
  );

  const first = makeAttempt({
    attempt_id: FIRST,
    ticket_id: TICKET_ID,
    created_at: "2026-08-28T11:33:33.000Z",
    termination: {
      reason: "iteration_ceiling_exceeded",
      detail: "attempt_iterations would reach 61, above the limit of 60",
    },
    usage: {
      iterations: 61,
      commands: 40,
      wall_clock_ms: 320_000,
      input_tokens: 900_000,
      output_tokens: 40_000,
      cost_micros: 0,
      cost_basis: "unavailable",
    },
    changeset_id: null,
    head_commit: null,
  });
  const second = makeAttempt({
    attempt_id: SECOND,
    ticket_id: TICKET_ID,
    created_at: "2026-08-28T11:47:38.000Z",
    termination: { reason: "completed", detail: "" },
    usage: {
      iterations: 30,
      commands: 20,
      wall_clock_ms: 260_000,
      input_tokens: 500_000,
      output_tokens: 20_000,
      cost_micros: 1_230_000,
      cost_basis: "transport_reported",
    },
    changeset_id: "cs_inspect0001",
    head_commit: "b2c3d4e",
  });
  const third = makeAttempt({
    attempt_id: THIRD,
    root_attempt_id: SECOND,
    continues_attempt_id: SECOND,
    remediation_round: 1,
    ticket_id: TICKET_ID,
    created_at: "2026-08-28T11:56:00.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { iterations: 8, commands: 4, wall_clock_ms: 60_000, cost_basis: "not_incurred" },
    changeset_id: "cs_inspect0002",
    head_commit: "c3d4e5f",
  });
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [first, second, third] }, null, 2)}\n`,
  );

  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  const write = (
    kind: RunBundleKind,
    subject_id: string,
    inputs: RunBundle["inputs"],
    artifacts: Array<{ name: string; media_type: string; body: string }>,
    at: string,
  ) =>
    bundles.write({
      kind,
      subject_id,
      ticket_id: TICKET_ID,
      inputs,
      context_manifest: [],
      versions: { code: "stage-2", prompt: "executor_v4", policy: "A2b", model: "claude-opus-5", tool: "1.0.98" },
      usage: { input_tokens: 1, output_tokens: 1, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 1 },
      artifacts,
      errors: [],
      transitions: [],
      retention: { class: "raw_transcript", expires_at: null },
      secrets: new SecretIndex(),
      excluded_paths: [],
      deterministic: false,
      model_version_pinned: true,
      now: new Date(at),
    });

  write("execution", FIRST, { termination: "iteration_ceiling_exceeded" }, [
    { name: "attempt.json", media_type: "application/json", body: JSON.stringify(first) },
    { name: "transcript.jsonl", media_type: "application/x-ndjson", body: "" },
  ], "2026-08-28T11:38:53.000Z");
  write("execution", SECOND, { termination: "completed" }, [
    { name: "attempt.json", media_type: "application/json", body: JSON.stringify(second) },
    { name: "transcript.jsonl", media_type: "application/x-ndjson", body: "" },
    { name: "prompt.txt", media_type: "text/plain", body: "do the thing" },
    { name: "change.diff", media_type: "text/x-diff", body: DIFF },
  ], "2026-08-28T11:51:58.000Z");
  const review = makeReview({
    review_id: "rev_inspect0001",
    changeset_id: "cs_inspect0001",
    decision: "remediable",
    cost_basis: "unavailable",
    ...(checks ? { checks } : {}),
  });
  write("review", review.review_id, { changeset_id: "cs_inspect0001", decision: "remediable", remediation_round: 0 }, [
    { name: "review.json", media_type: "application/json", body: JSON.stringify(review) },
  ], "2026-08-28T11:52:30.000Z");
  const decline = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: `NO_PRACTICE ${FINDING_KEY}: whether the page size is a product choice` },
      ],
    },
  });
  write("execution", THIRD, {
    termination: "completed",
    remediation_round: 1,
    // SCP-194: what the round was handed, as the loop records it.
    findings_given: FINDING_KEY,
    findings_given_count: 1,
  }, [
    { name: "attempt.json", media_type: "application/json", body: JSON.stringify(third) },
    { name: "transcript.jsonl", media_type: "application/x-ndjson", body: decline },
    { name: "change.diff", media_type: "text/x-diff", body: DIFF },
  ], "2026-08-28T11:57:00.000Z");
  write("review", `cv_${THIRD}`, {
    verification: true,
    all_closed: true,
    remediation_round: 1,
    findings_given: FINDING_KEY,
    findings_closed: FINDING_KEY,
    findings_open: "",
  }, [
    {
      name: "verification.json",
      media_type: "application/json",
      body: JSON.stringify({
        prompt_version: "closure_verify_v2",
        per_finding: [
          { finding_key: FINDING_KEY, status: "closed", pointer: "src/paginate.ts:12" },
        ],
        deterministic_failure: null,
        all_closed: true,
        open_keys: [],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        cost_micros: 0,
        cost_basis: "not_incurred",
      }),
    },
  ], "2026-08-28T11:57:30.000Z");
  return { repo, store };
}

/**
 * One completed attempt whose reviewer returned two verdicts the plan could not
 * accept: the review is `error`, and both rejection reasons are on the artifact.
 */
function storeWithRejectedVerdicts(name: string): { repo: string; store: string } {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-14.json"),
    JSON.stringify(makeTicket({ key: "AYO-14", ticket_id: TICKET_ID, repository_root: repo })),
  );
  const attempt = makeAttempt({
    attempt_id: SECOND,
    ticket_id: TICKET_ID,
    created_at: "2026-09-02T11:47:38.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { iterations: 30, commands: 20, wall_clock_ms: 260_000 },
    changeset_id: "cs_inspect0003",
    head_commit: "b2c3d4e",
  });
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
  );

  const review = {
    ...makeReview({
      review_id: "rev_inspect0003",
      changeset_id: "cs_inspect0003",
      decision: "error",
      cost_basis: "provider_list_estimate",
    }),
    findings: [],
    rejected_verdicts: [
      { attempt: 1, kind: "malformed_verdict", reason: "verdict covers ac_1 more than once" },
      {
        attempt: 2,
        kind: "unknown_criterion_id",
        reason: "verdict references criterion_id 'ac_9', which the approved plan does not contain",
      },
    ],
    error: {
      kind: "verdict_rejected",
      message: "the reviewer returned a verdict this plan cannot accept, twice",
      attempts: 2,
      unresolved_criteria: ["ac_1"],
    },
  };
  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  bundles.write({
    kind: "review",
    subject_id: review.review_id,
    ticket_id: TICKET_ID,
    inputs: { changeset_id: "cs_inspect0003", decision: "error", remediation_round: 0 },
    context_manifest: [],
    versions: { code: "stage-2", prompt: "executor_v4", policy: "A2b", model: "claude-opus-5", tool: "1.0.98" },
    usage: { input_tokens: 1, output_tokens: 1, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 1 },
    artifacts: [{ name: "review.json", media_type: "application/json", body: JSON.stringify(review) }],
    errors: [],
    transitions: [],
    retention: { class: "replay_retained", expires_at: null },
    secrets: new SecretIndex(),
    excluded_paths: [],
    deterministic: false,
    model_version_pinned: true,
    now: new Date("2026-09-02T11:52:30.000Z"),
  });
  return { repo, store };
}

/** The admission record of a ticket a model drafted and a person approved. */
const DRAFTED_ADMISSION = {
  elapsed_ms: 18_410,
  criteria_source: "drafted",
  criteria_count: 4,
  drafted_at: "2026-09-01T23:58:41.892Z",
  human_elapsed_ms: 27_308,
  edit_count: 3,
  level_source: "derived",
  derived_level: "P1",
};

/**
 * The same record from a ticket admitted before those measurements existed:
 * every one of them null, including `criteria_source`, which the current
 * schema will not let `admit` write but which an older file can still hold.
 */
const UNRECORDED_ADMISSION = {
  elapsed_ms: 25,
  criteria_source: null,
  criteria_count: 2,
  drafted_at: null,
  human_elapsed_ms: null,
  edit_count: null,
  level_source: null,
  derived_level: null,
};

/** A ticket alone in a store, with the admission record written verbatim. */
function storeWithAdmission(name: string, admission: unknown): { repo: string; store: string } {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  const ticket = {
    ...makeTicket({ key: "AYO-4", ticket_id: TICKET_ID, repository_root: repo }),
    admission,
  };
  writeFileSync(join(store, "tickets", "AYO-4.json"), JSON.stringify(ticket));
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({
      ticket_id: TICKET_ID,
      attempts: [
        makeAttempt({
          attempt_id: FIRST,
          ticket_id: TICKET_ID,
          created_at: "2026-08-28T11:33:33.000Z",
          termination: { reason: "completed", detail: "" },
          usage: { iterations: 4, commands: 2, wall_clock_ms: 30_000 },
          changeset_id: null,
          head_commit: null,
        }),
      ],
    })}\n`,
  );
  return { repo, store };
}

/**
 * A ticket whose attempt added nothing to a change set that was already on its
 * branch: the executor changed no file, and the commit under review was sealed
 * by a run whose own record is gone.
 */
function storeWithCarriedForward(name: string): { repo: string; store: string } {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-13.json"),
    JSON.stringify(makeTicket({ key: "AYO-13", ticket_id: TICKET_ID, repository_root: repo })),
  );
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({
      ticket_id: TICKET_ID,
      attempts: [
        makeAttempt({
          attempt_id: FIRST,
          ticket_id: TICKET_ID,
          created_at: "2026-09-02T11:33:33.000Z",
          termination: {
            reason: "completed",
            detail: "the executor added nothing to the 1 commit(s) already on the branch",
          },
          usage: { iterations: 4, commands: 2, wall_clock_ms: 30_000 },
          changeset_id: "cs_carried000001",
          head_commit: "b2c3d4e",
          change_set_origin: "carried_forward",
          prior_commits: [{ sha: "b2c3d4e", attempt_id: null }],
        }),
      ],
    })}\n`,
  );
  return { repo, store };
}

describe("perbo inspect argument parsing", () => {
  it("counts tokens against the ceiling the way the runner does: cache reads excluded", () => {
    const repo = join(scratch, "tokens-cache");
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    const ticketId = "ticket_0000000000cache";
    writeFileSync(
      join(store, "tickets", "AYO-9.json"),
      JSON.stringify(makeTicket({ key: "AYO-9", ticket_id: ticketId, repository_root: repo, pull_request_url: null })),
    );
    const attempt = makeAttempt({
      attempt_id: "att_00000000cache01",
      ticket_id: ticketId,
      created_at: "2026-09-02T00:10:00.000Z",
      termination: { reason: "completed", detail: "" },
      usage: {
        iterations: 40,
        commands: 30,
        wall_clock_ms: 549_485,
        input_tokens: 6_778_856,
        cache_read_input_tokens: 5_000_000,
        output_tokens: 283,
        cost_micros: 4_019_925,
        cost_basis: "transport_reported",
      },
      changeset_id: "cs_inspectcache1",
      head_commit: "d4e5f6a",
    });
    writeFileSync(
      join(store, "state", `${ticketId}.attempts.json`),
      `${JSON.stringify({ ticket_id: ticketId, attempts: [attempt] }, null, 2)}\n`,
    );
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-9", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    // 6,778,856 − 5,000,000 + 283: the fresh input plus output the counter saw.
    // D-096 removed the ceiling it used to be tested against, so the count is
    // what the row is for, and it says there is nothing bounding it.
    expect(rendered).toMatch(/tokens\s+1,779,139 \/ no ceiling/);
    expect(rendered).not.toContain("ceiling hit");
    expect(rendered).toContain("6,778,856 in, 5,000,000 cached · 283 out");
  });

  it("takes exactly one key and rejects flags it does not know", () => {
    expect(inspectCommandLine.read(["AYO-1", "--attempt=att_x", "--json"])).toEqual({
      input: {
        target: { repo: ".", store: null },
        key: "AYO-1",
        attempt: "att_x",
        verify: null,
      },
      output: { json: true },
    });
    // The check names its own attempt, and reading is what happens without it.
    expect(inspectCommandLine.read(["AYO-1", "--verify", "att_x"]).input.verify).toBe("att_x");
    expect(inspectCommandLine.read(["AYO-1", "--verify=att_x"]).input.verify).toBe("att_x");
    expect(() => inspectCommandLine.read(["AYO-1", "--verify"]).input).toThrow(/--verify requires a value/);
    // Two answers to "which attempt": refused rather than one of them ignored.
    expect(() => inspectCommandLine.read(["AYO-1", "--verify", "att_x", "--attempt", "att_y"]).input).toThrow(
      /cannot be given with --attempt/,
    );
    expect(() => inspectCommandLine.read([]).input).toThrow(UsageError);
    expect(() => inspectCommandLine.read(["AYO-1", "AYO-2"]).input).toThrow(UsageError);
    expect(() => inspectCommandLine.read(["AYO-1", "--bundle"]).input).toThrow(/unknown flag/);
  });
});

describe("perbo inspect", () => {
  it("names the ceiling that was hit, at the value in force when it was hit", () => {
    const { store } = storeWithAttempts("ceiling");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(rendered).toMatch(/iterations\s+61 \/ 60 — ceiling hit/);
    expect(rendered).toContain("iteration_ceiling_exceeded");
    // The second attempt ran under the raised ceiling and did not hit it.
    expect(rendered).toMatch(/iterations\s+30 \/ 200\n/);
    expect(rendered).not.toMatch(/30 \/ 200 — ceiling hit/);
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("prints the remediation rounds as a ladder: given, closed and still open", () => {
    const { store } = storeWithAttempts("ladder");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    // SCP-194: the round's own record, not an inference from the diff.
    expect(report.attempts[2]?.ladder).toEqual({
      kind: "remediate",
      given: [FINDING_KEY],
      closed: [FINDING_KEY],
      open: [],
    });
    expect(report.attempts[0]?.ladder).toBeNull();
    expect(rendered).toContain("LADDER");
    expect(rendered).toMatch(/round 1\s+given 1 {2}closed 1 {2}all closed/);
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("says when an attempt added nothing to a change set already on the branch", () => {
    const { store } = storeWithCarriedForward("carried-forward");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-13", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(report.attempts[0]?.outcome).toContain("carried_forward");
    expect(rendered).toContain("carried_forward");
    expect(rendered).toContain("added nothing");
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("never prints an unavailable cost as a dollar figure", () => {
    const { store } = storeWithAttempts("cost");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(rendered).toContain("cost unavailable");
    expect(rendered).not.toContain("$0.0000");
    // D-096: the attempt authenticated on a subscription, so no cost cap
    // applied to it and the row says so rather than printing the per-token
    // default as though it had been in force.
    expect(rendered).toContain("$1.2300 reported / no ceiling");
    expect(rendered).toContain("not incurred");
  });

  it("shows the review, every finding's route, the checks, declines and the pull request", () => {
    const { store } = storeWithAttempts("review");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(rendered).toContain("pull request https://example.invalid/pull/9");
    expect(rendered).toContain("rev_inspect0001   remediable");
    expect(rendered).toContain("[FIX]");
    expect(rendered).toContain("test.mocks_module_under_test");
    expect(rendered).toContain("packages/search/test/query.test.ts:12");
    expect(rendered).toContain("not blocking · remediable");
    expect(rendered).toContain("mocks the module under test");
    expect(rendered).toMatch(/✓\s+unit/);
    expect(rendered).toContain("claude-opus-5 · claude-code 1.0.98 · subscription");
    expect(rendered).toContain("VERIFICATION   round 1");
    expect(rendered).toContain("all closed");
    expect(rendered).toContain("whether the page size is a product choice");
    expect(report.attempts[2]!.declines).toEqual([
      { finding_key: FINDING_KEY, reason: "whether the page size is a product choice" },
    ]);
  });

  describe("ac_4 / SCP-157 — a hand-off pull request reads differently from one the loop opened", () => {
    /** A ticket sitting at `pr_open`, whose only difference is who put it there. */
    function storeWithPullRequest(
      name: string,
      key: string,
      from: "failed" | "failed-unrecorded" | "independent_review",
    ): { store: string } {
      const repo = join(scratch, name);
      const store = join(repo, ".perbo");
      mkdirSync(join(store, "tickets"), { recursive: true });
      const ticket = makeTicket({
        key,
        ticket_id: `ticket_${name.replace(/-/g, "")}`,
        repository_root: repo,
        pull_request_url: "https://example.invalid/pull/77",
        state: "pr_open",
        history: [
          { at: "2026-08-28T11:33:17.079Z", from: null, to: "plan_review", note: "admitted" },
          { at: "2026-08-28T11:33:19.894Z", from: "plan_review", to: "ready", note: "contract approved" },
          {
            at: "2026-08-28T11:40:00.000Z",
            from: from === "failed-unrecorded" ? "failed" : from,
            to: "pr_open",
            note:
              from === "failed"
                ? "reconciled after the fact by `perbo sync` from `gh`: https://example.invalid/pull/77 " +
                  "exists on ayo/fixture/x — handed off: a person opened it, the loop did not"
                : from === "failed-unrecorded"
                  // SCP-176: neither a hand-off note nor a `handed_off` flag —
                  // the row `resumeWithUnrecordedOpener` writes.
                  ? "reconciled after the fact by `perbo sync` from `gh`: https://example.invalid/pull/77 " +
                    "exists on ayo/fixture/x — the opener is not recorded"
                  : "approved; a human merges it",
          },
        ],
      });
      writeFileSync(join(store, "tickets", `${key}.json`), JSON.stringify(ticket));
      return { store };
    }

    it("marks a handed-off pull request distinctly from one the loop published", () => {
      const { store } = storeWithPullRequest("inspect-handoff", "AYO-20", "failed");
      const report = buildInspectReport({ storeDirectory: store, key: "AYO-20", attempt: null });
      expect(report.handed_off).toBe(true);
      const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
      expect(rendered).toContain("pull request https://example.invalid/pull/77");
      expect(rendered).toMatch(/pull request .*hand/i);
    });

    it("does not mark a pull request the loop itself opened", () => {
      const { store } = storeWithPullRequest("inspect-loop", "AYO-21", "independent_review");
      const report = buildInspectReport({ storeDirectory: store, key: "AYO-21", attempt: null });
      expect(report.handed_off).toBe(false);
      const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
      expect(rendered).toContain("pull request https://example.invalid/pull/77");
      expect(rendered).not.toMatch(/hand/i);
    });

    it("SCP-176: reads an unrecorded opener as neither a hand-off nor the loop's", () => {
      const { store } = storeWithPullRequest("inspect-unrecorded", "AYO-22", "failed-unrecorded");
      const report = buildInspectReport({ storeDirectory: store, key: "AYO-22", attempt: null });
      expect(report.handed_off).toBeNull();
      const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
      expect(rendered).toContain("pull request https://example.invalid/pull/77");
      expect(rendered).toContain("opener not recorded");
      expect(rendered).not.toMatch(/hand/i);
    });
  });

  it("prints the failing tests beside a check, and marks a flaky one", () => {
    const { store } = storeWithAttempts("flaky-check", [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        status: "passed",
        summary: "flaky: 1 test failed, then passed on re-run",
        command: "pnpm exec turbo run test",
        detail: null,
        duration_ms: 1200,
        source: "file",
        failing_tests: ["apps/cli/test/admit.test.ts > admit > runs synchronously"],
        reruns: 1,
        flaky: true,
        rerun: {
          command: "pnpm exec vitest run test/admit.test.ts",
          scope: "files",
          note: null,
          status: "passed",
          summary: "Tests  12 passed (12)",
          failing_tests: [],
          duration_ms: 900,
        },
      },
    ]);
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(rendered).toContain("flaky");
    expect(rendered).toContain("re-run passed");
    expect(rendered).toContain("apps/cli/test/admit.test.ts > admit > runs synchronously");
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("prints the failing tests of a check that stayed failed", () => {
    const { store } = storeWithAttempts("failed-check", [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        status: "failed",
        summary: "Tests  1 failed | 142 passed (143)",
        command: "pnpm exec turbo run test",
        detail: null,
        duration_ms: 1200,
        source: "file",
        failing_tests: ["apps/cli/test/admit.test.ts > admit > runs synchronously"],
        reruns: 1,
        flaky: false,
        rerun: {
          command: "pnpm exec vitest run test/admit.test.ts",
          scope: "files",
          note: null,
          status: "failed",
          summary: "Tests  1 failed (1)",
          failing_tests: ["apps/cli/test/admit.test.ts > admit > runs synchronously"],
          duration_ms: 900,
        },
      },
    ]);
    const rendered = renderInspect(
      buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null }),
      { color: false, detail: false, version: "test" },
    );

    expect(rendered).toContain("re-run failed");
    expect(rendered).toContain("apps/cli/test/admit.test.ts > admit > runs synchronously");
    expect(rendered).not.toContain("flaky");
  });

  it("prints the temporary directory the checks ran under", () => {
    const { store } = storeWithAttempts("check-tmpdir", [
      {
        check_id: "check_unit",
        name: "unit",
        kind: "unit",
        status: "passed",
        summary: "Tests  143 passed (143)",
        command: "pnpm exec turbo run test",
        detail: null,
        duration_ms: 1200,
        source: "file",
        tmpdir: "/var/folders/9k/T",
      },
    ]);
    const rendered = renderInspect(
      buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null }),
      { color: false, detail: false, version: "test" },
    );

    // The difference between a check that ran in the loop and the same check
    // in a clean checkout is readable off the record.
    expect(rendered).toContain("tmpdir");
    expect(rendered).toContain("/var/folders/9k/T");
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("prints every rejected verdict's reason beside the round", () => {
    const { store } = storeWithRejectedVerdicts("rejected-verdicts");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-14", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(rendered).toContain("rev_inspect0003   error");
    expect(rendered).toContain("verdict covers ac_1 more than once");
    expect(rendered).toContain("which the approved plan does not contain");
    // Both, in the order the reviewer returned them.
    expect(rendered.indexOf("more than once")).toBeLessThan(
      rendered.indexOf("does not contain"),
    );
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("narrows to one attempt and lists its objects and changed files", () => {
    const { store } = storeWithAttempts("detail");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: SECOND });
    expect(report.attempts.map((attempt) => attempt.attempt_id)).toEqual([SECOND]);
    const rendered = renderInspect(report, { color: false, detail: true, version: "test" });

    expect(rendered).toContain("BUNDLE OBJECTS");
    expect(rendered).toContain("transcript.jsonl");
    expect(rendered).toContain("change.diff");
    expect(rendered).toContain("review.json");
    expect(rendered).toContain("CHANGE SET");
    expect(rendered).toMatch(/modified\s+packages\/search\/src\/query\.ts\s+\+2 -1/);
    expect(() => buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: "att_nope" })).toThrow(
      /has no attempt att_nope/,
    );
  });

  it("says in one sentence when nothing has run", async () => {
    const repo = join(scratch, "never-ran");
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    writeFileSync(
      join(store, "tickets", "AYO-2.json"),
      JSON.stringify(makeTicket({ key: "AYO-2", ticket_id: "ticket_neverran001", repository_root: repo, state: "ready" })),
    );
    const streams = recordStreams({ isTTY: true });
    expect(await runCommandLine(inspectCommandLine, { argv: ["AYO-2", "--repo", repo], streams, cwd: repo })).toBe(0);
    expect(streams.out()).toContain("AYO-2 has no attempts on record: nothing has run against it yet.");
    expect(streams.out().split("\n").filter((line) => line.includes("AYO-2 has no"))).toHaveLength(1);
  });

  it("distinguishes a ticket that never ran from one whose record is in another store", async () => {
    const repo = join(scratch, "ran-elsewhere");
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    writeFileSync(
      join(store, "tickets", "AYO-1.json"),
      JSON.stringify(
        makeTicket({ key: "AYO-1", ticket_id: "ticket_elsewhere01", repository_root: repo, runs_started: 3 }),
      ),
    );
    const streams = recordStreams({ isTTY: true });
    expect(await runCommandLine(inspectCommandLine, { argv: ["AYO-1", "--repo", repo], streams, cwd: repo })).toBe(0);
    const rendered = streams.out();
    expect(rendered).toContain("history shows 3 run(s) started");
    expect(rendered).toContain(join(store, "state", "ticket_elsewhere01.attempts.json"));
    expect(rendered).not.toContain("nothing has run against it yet");
  });

  it("shows the admission record above the attempts, in human units", () => {
    const { store } = storeWithAdmission("admission-drafted", DRAFTED_ADMISSION);
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-4", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(rendered).toContain("ADMISSION");
    expect(rendered).toContain("drafted · 4 criteria");
    expect(rendered).toContain("27.3 seconds from first rendering · 3 edits");
    expect(rendered).toContain("P1 derived");
    // The record is read before the runs it explains, not hunted for after them.
    expect(rendered.indexOf("ADMISSION")).toBeLessThan(rendered.indexOf("ATTEMPT"));
    expect(rendered).not.toContain("27308");
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("shows where the ticket stands in the queue and what it waits on", () => {
    const { repo, store } = storeWithAdmission("queue-standing", DRAFTED_ADMISSION);
    // A ticket ahead of it, which this one depends on and overlaps.
    writeFileSync(
      join(store, "tickets", "AYO-3.json"),
      JSON.stringify(makeTicket({ key: "AYO-3", ticket_id: "ticket_inspect0003", repository_root: repo, state: "ready" })),
    );
    const held = JSON.parse(readFileSync(join(store, "tickets", "AYO-4.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(store, "tickets", "AYO-4.json"),
      JSON.stringify({
        ...held,
        state: "blocked",
        depends_on: ["AYO-3"],
        scheduling: {
          waits_on: [{ key: "AYO-3", reason: "scope_overlap", paths: ["src/**"], state: "ready" }],
          decided_at: "2026-09-10T12:00:00.000Z",
          reconciliation: null,
        },
      }),
    );
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-4", attempt: null });
    expect(report.queue).toEqual({
      place: 2,
      holding: 2,
      depends_on: ["AYO-3"],
      waits: "waits on AYO-3 (scope overlap: src/**)",
    });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    expect(rendered).toContain("QUEUE");
    expect(rendered).toContain("2nd of 2 holding a place · blocked");
    expect(rendered).toContain("waits on AYO-3 (scope overlap: src/**)");
    expect(rendered).toContain("after      AYO-3");
    // Under the admission, above the runs: what the queue decided about this
    // ticket is read before what the runs did with it.
    expect(rendered.indexOf("ADMISSION")).toBeLessThan(rendered.indexOf("QUEUE"));
    expect(rendered.indexOf("QUEUE")).toBeLessThan(rendered.indexOf("ATTEMPT"));
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);

    // The one ahead holds the first place and waits on nothing.
    const ahead = buildInspectReport({ storeDirectory: store, key: "AYO-3", attempt: null });
    expect(ahead.queue).toEqual({ place: 1, holding: 2, depends_on: [], waits: null });
    expect(renderInspect(ahead, { color: false, detail: false, version: "test" })).toContain("1st of 2 holding a place · ready");
  });

  it("orders the whole store as serve does, so a settled dependency still places its dependant", () => {
    const { repo, store } = storeWithAdmission("queue-settled", DRAFTED_ADMISSION);
    const held = JSON.parse(readFileSync(join(store, "tickets", "AYO-4.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(store, "tickets", "AYO-4.json"), JSON.stringify({ ...held, state: "ready", priority: "normal" }));
    // AYO-4 is normal priority and ready. AYO-5 is low and merged; AYO-6 is
    // high and depends on it. The queue orders all three — AYO-4, then AYO-5,
    // then AYO-6 behind its dependency — and only then drops the merged one,
    // so AYO-6 is second, not first by its priority alone.
    for (const [key, id, state, priority, depends] of [
      ["AYO-5", "ticket_inspect0005", "merged", "low", []],
      ["AYO-6", "ticket_inspect0006", "ready", "high", ["AYO-5"]],
    ] as const) {
      writeFileSync(
        join(store, "tickets", `${key}.json`),
        JSON.stringify({
          ...makeTicket({ key, ticket_id: id, repository_root: repo, state }),
          priority,
          depends_on: [...depends],
        }),
      );
    }
    const first = buildInspectReport({ storeDirectory: store, key: "AYO-4", attempt: null });
    const second = buildInspectReport({ storeDirectory: store, key: "AYO-6", attempt: null });
    const settled = buildInspectReport({ storeDirectory: store, key: "AYO-5", attempt: null });
    expect(first.queue?.place).toBe(1);
    expect(second.queue?.place).toBe(2);
    expect(second.queue?.holding).toBe(2);
    expect(settled.queue).toEqual({ place: null, holding: 2, depends_on: [], waits: null });
    expect(renderInspect(settled, { color: false, detail: false, version: "test" })).toContain("not in the queue (merged)");
  });

  it("wraps a long wait under its label rather than clipping the keys after the first", () => {
    const { store } = storeWithAdmission("queue-wrapped", DRAFTED_ADMISSION);
    const held = JSON.parse(readFileSync(join(store, "tickets", "AYO-4.json"), "utf8")) as Record<string, unknown>;
    const waits = ["AYO-11", "AYO-12", "AYO-13"].map((key) => ({
      key,
      reason: "scope_overlap",
      paths: ["packages/runner/**", "packages/contracts/src/**", "apps/cli/src/**"],
      state: "ready",
    }));
    // And a glob no space ever splits, longer than the column.
    const glob = `packages/${"a-very-long-directory-name-".repeat(4)}/**`;
    writeFileSync(
      join(store, "tickets", "AYO-4.json"),
      JSON.stringify({
        ...held,
        state: "blocked",
        scheduling: {
          waits_on: [...waits, { key: "AYO-14", reason: "scope_overlap", paths: [glob], state: "ready" }],
          decided_at: "2026-09-10T12:00:00.000Z",
          reconciliation: null,
        },
      }),
    );
    const rendered = renderInspect(buildInspectReport({ storeDirectory: store, key: "AYO-4", attempt: null }), {
      color: false,
      detail: false,
      version: "test",
    });
    for (const key of ["AYO-11", "AYO-12", "AYO-13", "AYO-14"]) expect(rendered).toContain(key);
    expect(rendered).not.toContain("…");
    expect(rendered.replace(/\n\s*/g, "")).toContain(glob);
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("renders every unrecorded admission field as unrecorded, never as zero", async () => {
    const { repo, store } = storeWithAdmission("admission-null", UNRECORDED_ADMISSION);
    vi.stubEnv("NO_COLOR", "1");
    const streams = recordStreams({ isTTY: true });
    try {
      expect(await runCommandLine(inspectCommandLine, { argv: ["AYO-4", "--repo", repo, "--store", store], streams, cwd: repo })).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
    const rendered = streams.out();
    const block = rendered
      .split("\n")
      .slice(rendered.split("\n").findIndex((line) => line.includes("ADMISSION")))
      .slice(0, 5)
      .join("\n");

    // criteria source, human elapsed, edit count and the level: four measurements.
    expect(block.match(/not recorded/g)).toHaveLength(4);
    expect(block).toContain("not recorded · 2 criteria");
    expect(block).toContain("edits not recorded");
    // Nothing in the block reads as zero seconds, zero edits or level P0.
    expect(block).not.toContain("0");
  });

  it("reads a value this binary does not know as written rather than refusing the ticket", async () => {
    const future = { ...DRAFTED_ADMISSION, criteria_source: "attached", level_source: "inherited", derived_level: "P1" };
    const { repo, store } = storeWithAdmission("admission-future", future);
    const streams = recordStreams({ isTTY: false });
    expect(await runCommandLine(inspectCommandLine, { argv: ["AYO-4", "--repo", repo, "--store", store, "--json"], streams, cwd: repo })).toBe(0);
    expect(streams.json<{ admission: unknown }>().admission).toEqual(future);
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-4", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    expect(rendered).toContain("attached");
    expect(rendered).toContain("P1 inherited");
  });

  it("renders a half-populated level pair without running the two halves together", async () => {
    const { store } = storeWithAdmission("admission-half-level", {
      ...DRAFTED_ADMISSION,
      derived_level: null,
      level_source: "derived",
    });
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-4", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    expect(rendered).toContain("not recorded (source derived)");
    expect(rendered).not.toContain("not recorded derived");
  });

  it("carries the admission record verbatim under --json, nulls included", async () => {
    for (const [name, admission] of [
      ["json-drafted", DRAFTED_ADMISSION],
      ["json-null", UNRECORDED_ADMISSION],
      // A measurement a later version added: carried, not trimmed to what this
      // one can name.
      ["json-later", { ...DRAFTED_ADMISSION, queue_wait_ms: 900 }],
    ] as const) {
      const { repo, store } = storeWithAdmission(name, admission);
      const streams = recordStreams({ isTTY: false });
      expect(await runCommandLine(inspectCommandLine, { argv: ["AYO-4", "--repo", repo, "--store", store], streams, cwd: repo })).toBe(0);
      const report = streams.json<{ admission: unknown }>();
      const stored = JSON.parse(readFileSync(join(store, "tickets", "AYO-4.json"), "utf8")) as {
        admission: unknown;
      };

      expect(report.admission).toEqual(stored.admission);
      expect(report.admission).toEqual(admission);
    }
  });

  it("adds the admission and source keys to the JSON report and changes nothing else", async () => {
    const { repo } = storeWithAttempts("json-shape");
    const streams = recordStreams({ isTTY: false });
    expect(await runCommandLine(inspectCommandLine, { argv: ["AYO-7", "--repo", repo], streams, cwd: repo })).toBe(0);
    const report = streams.json<Record<string, unknown> & {
      attempts: Array<Record<string, unknown>>;
    }>();

    // The shape before this change, plus the two keys that read the ticket's
    // own record: how it was admitted, and what it was admitted from — and
    // `total_cost`, what every round has come to, and `verdicts`, the decisions
    // a person took on its findings at the command line (SCP-181).
    expect(Object.keys(report).sort()).toEqual(
      [
        "admission",
        "attempts",
        "attempts_path",
        // Where a run in this checkout publishes: the base and which of the
        // three sources named it. Null where no source names one, which is
        // what a run on such a checkout refuses for.
        "base",
        // AYO-32: which of the two things is being read, and the contract it
        // ran against — null here, because a ticket's source is its ticket.
        "kind",
        "outcome",
        "contract_source",
        "handed_off",
        // SCP-240: what the checks on the published head concluded. Null on a
        // ticket nothing has read them for.
        "delivery_checks",
        "pull_request_url",
        // SCP-227: where the ticket stands in the queue and what it waits on.
        "queue",
        // SCP-315: whether the spec this contract was drafted from is still
        // that spec. Null for a ticket drafted from anything else (D-103).
        "spec_staleness",
        // SCP-260: why a run stopped before an attempt existed. Null for a
        // ticket, whose history is on its own file, and never absent — a
        // refusal that is only printed is one nobody can read back.
        "refusal",
        // SCP-333: the plan's execution graph, and how big the plan is. Both
        // nodes and edges are null for a flat plan; the size is a reading of
        // every plan (D-100, D-104).
        "nodes",
        "edges",
        "approach_problem",
        "size",
        "runs_started",
        "source",
        "state",
        "ticket",
        "ticket_id",
        // What the ticket is called, apart from the outcome it runs against
        // (D-127).
        "title",
        "total_cost",
        "verdicts",
      ].sort(),
    );
    // Nothing has been decided in this store, and the report says so as a fact
    // rather than by leaving the field out.
    expect(report["verdicts"]).toEqual([]);
    expect(Object.keys(report.attempts[0]!)).not.toContain("admission");
    expect(report.attempts).toHaveLength(3);
    // A ticket whose admission was never measured still reports the record it has.
    expect(report.admission).toEqual({
      elapsed_ms: 25,
      criteria_source: "typed",
      criteria_count: 1,
      drafted_at: null,
      // Null for every source but a spec (D-103).
      spec: null,
      human_elapsed_ms: null,
      edit_count: null,
      counter_sealed_at: null,
      level_source: null,
      derived_level: null,
    });
  });

  it("emits the report as JSON when piped", async () => {
    const { repo } = storeWithAttempts("json");
    const streams = recordStreams({ isTTY: false });
    expect(await runCommandLine(inspectCommandLine, { argv: ["AYO-7", "--repo", repo], streams, cwd: repo })).toBe(0);
    const report = streams.json<{
      ticket: string;
      pull_request_url: string;
      attempts: Array<{
        attempt_id: string;
        ceilings: Array<{ resource: string; used: number | null; ceiling: number; hit: boolean }>;
        cost: { basis: string };
      }>;
    }>();
    expect(report.ticket).toBe("AYO-7");
    expect(report.pull_request_url).toBe("https://example.invalid/pull/9");
    const hit = report.attempts[0]!.ceilings.find((use) => use.resource === "attempt_iterations");
    expect(hit).toEqual({ resource: "attempt_iterations", used: 61, ceiling: 60, hit: true });
    expect(report.attempts[0]!.cost.basis).toBe("unavailable");
    const later = report.attempts[1]!.ceilings.find((use) => use.resource === "attempt_iterations");
    expect(later).toEqual({ resource: "attempt_iterations", used: 30, ceiling: 200, hit: false });
  });

  it("lists a re-run's attempts in run order, each labelled with the run that made it", () => {
    const repo = join(scratch, "re-run");
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    const ticket_id = "ticket_rerun00001";
    writeFileSync(
      join(store, "tickets", "AYO-9.json"),
      JSON.stringify(makeTicket({ key: "AYO-9", ticket_id, repository_root: repo, runs_started: 2 })),
    );

    // The record two runs of one contract leave: run 1 cut short by a ceiling,
    // then a re-run whose root is a different chain and whose first attempt
    // continues run 1's last, and its own remediation round.
    const first = makeAttempt({
      attempt_id: "att_run1round0",
      ticket_id,
      created_at: "2026-08-28T11:33:33.000Z",
      termination: {
        reason: "iteration_ceiling_exceeded",
        detail: "attempt_iterations would reach 61, above the limit of 60",
      },
      usage: { iterations: 61 },
      changeset_id: null,
      head_commit: null,
    });
    const second = makeAttempt({
      attempt_id: "att_run2round0",
      continues_attempt_id: first.attempt_id,
      ticket_id,
      created_at: "2026-08-28T12:10:00.000Z",
      termination: { reason: "completed", detail: "" },
      usage: { iterations: 12 },
      changeset_id: "cs_rerun00000001",
      head_commit: "b2c3d4e",
    });
    const third = makeAttempt({
      attempt_id: "att_run2round1",
      root_attempt_id: second.attempt_id,
      continues_attempt_id: second.attempt_id,
      remediation_round: 1,
      ticket_id,
      created_at: "2026-08-28T12:20:00.000Z",
      termination: { reason: "completed", detail: "" },
      usage: { iterations: 4 },
      changeset_id: "cs_rerun00000002",
      head_commit: "c3d4e5f",
    });
    writeFileSync(
      join(store, "state", `${ticket_id}.attempts.json`),
      `${JSON.stringify({ ticket_id, attempts: [first, second, third] }, null, 2)}\n`,
    );

    const report = buildInspectReport({ storeDirectory: store, key: "AYO-9", attempt: null });
    // The re-run's remediation round belongs to the re-run, not to a third run.
    expect(report.attempts.map((attempt) => attempt.run)).toEqual([1, 2, 2]);
    expect(report.runs_started).toBe(2);

    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    expect(rendered).toContain("run 1 · round 0");
    expect(rendered).toContain("run 2 · round 0");
    expect(rendered).toContain("run 2 · round 1");
    // Run 1 is still readable, in front of the run that followed it.
    expect(rendered.indexOf("att_run1round0")).toBeGreaterThan(-1);
    expect(rendered.indexOf("att_run1round0")).toBeLessThan(rendered.indexOf("att_run2round0"));
    expect(rendered.indexOf("run 1")).toBeLessThan(rendered.indexOf("run 2"));
    expect(rendered).toContain("iteration_ceiling_exceeded");
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);

    // Selecting one attempt shows the run it belongs to, not a renumbering of
    // what the filter left.
    const one = buildInspectReport({ storeDirectory: store, key: "AYO-9", attempt: "att_run2round1" });
    expect(one.attempts.map((attempt) => attempt.run)).toEqual([2]);
  });
});

describe("the admission line's human time", () => {
  it("prints the promoted unit in the admission line a person reads", () => {
    const { store } = storeWithAdmission("admission-rounded-minute", {
      ...DRAFTED_ADMISSION,
      human_elapsed_ms: 59_999,
    });
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-4", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(rendered).toContain("1.0 minute from first rendering");
    expect(rendered).not.toContain("60.0 seconds");
  });
});

/**
 * SCP-159: three attempts the runner stopped. Two carry what the transport had
 * reported by the stop; the third was stopped before it reported anything.
 */
function storeWithTerminatedCosts(name: string): { repo: string; store: string } {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  const ticketId = "ticket_terminated001";
  writeFileSync(
    join(store, "tickets", "AYO-15.json"),
    JSON.stringify(makeTicket({ key: "AYO-15", ticket_id: ticketId, repository_root: repo })),
  );
  const attempts = [
    makeAttempt({
      attempt_id: "att_partial00000001",
      ticket_id: ticketId,
      created_at: "2026-09-02T09:00:00.000Z",
      termination: {
        reason: "prohibited_action",
        detail: "write_outside_worktree: cp secrets.json ~/backup.json",
      },
      usage: {
        iterations: 69,
        commands: 120,
        wall_clock_ms: 420_000,
        input_tokens: 800_000,
        output_tokens: 30_000,
        cost_micros: 2_000_000,
        cost_basis: "transport_reported",
        cost_partial: true,
      },
      changeset_id: null,
      head_commit: null,
    }),
    makeAttempt({
      attempt_id: "att_partial00000002",
      ticket_id: ticketId,
      created_at: "2026-09-02T09:20:00.000Z",
      remediation_round: 1,
      root_attempt_id: "att_partial00000001",
      continues_attempt_id: "att_partial00000001",
      termination: {
        reason: "cost_ceiling_exceeded",
        detail: "attempt_cost_micros would reach 5110000, above the limit of 5000000",
      },
      usage: {
        iterations: 16,
        commands: 40,
        wall_clock_ms: 300_000,
        cost_micros: 5_110_000,
        cost_basis: "transport_reported",
        cost_partial: true,
      },
      changeset_id: null,
      head_commit: null,
    }),
    makeAttempt({
      attempt_id: "att_partial00000003",
      ticket_id: ticketId,
      created_at: "2026-09-02T09:40:00.000Z",
      remediation_round: 2,
      root_attempt_id: "att_partial00000001",
      continues_attempt_id: "att_partial00000002",
      termination: {
        reason: "wall_clock_exceeded",
        detail: "attempt_wall_clock_ms would reach 2700001, above the limit of 2700000",
      },
      usage: { iterations: 0, commands: 0, wall_clock_ms: 2_700_001, cost_basis: "unavailable", cost_partial: true },
      changeset_id: null,
      head_commit: null,
    }),
  ];
  writeFileSync(
    join(store, "state", `${ticketId}.attempts.json`),
    `${JSON.stringify({ ticket_id: ticketId, attempts }, null, 2)}\n`,
  );
  return { repo, store };
}

describe("what a terminated attempt says it cost", () => {
  it("prints the charge beside the termination reason, marked partial", () => {
    const { store } = storeWithTerminatedCosts("terminated-partial");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-15", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(rendered).toContain("termination prohibited_action");
    expect(rendered).toContain("cost $2.0000 partial");
    expect(rendered).toContain("termination cost_ceiling_exceeded");
    expect(rendered).toContain("cost $5.1100 partial");
    // The ceiling row says the same thing, against the ceiling in force.
    expect(rendered).toContain("$5.1100 partial / $5.0000");
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  /**
   * SCP-323: the one resource no attempt keeps a running count of, so the row
   * reads the silence out of the refusal's own message.
   */
  it("shows the stall window an attempt reached, and the cost cap a subscription never had", () => {
    const repo = join(scratch, "terminated-stalled");
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    const ticketId = "ticket_stalled000001";
    writeFileSync(
      join(store, "tickets", "AYO-16.json"),
      JSON.stringify(makeTicket({ key: "AYO-16", ticket_id: ticketId, repository_root: repo })),
    );
    writeFileSync(
      join(store, "state", `${ticketId}.attempts.json`),
      `${JSON.stringify(
        {
          ticket_id: ticketId,
          attempts: [
            makeAttempt({
              attempt_id: "att_stalled00000001",
              ticket_id: ticketId,
              created_at: "2026-09-02T09:00:00.000Z",
              termination: {
                reason: "stalled",
                detail:
                  "attempt_stall_ms would reach 1200001, above the limit of 1200000",
              },
              usage: {
                iterations: 4,
                commands: 3,
                wall_clock_ms: 5_400_000,
                cost_micros: 9_000_000,
                cost_basis: "transport_reported",
              },
              changeset_id: null,
              head_commit: null,
            }),
          ],
        },
        null,
        2,
      )}\n`,
    );

    const report = buildInspectReport({ storeDirectory: store, key: "AYO-16", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    const use = (resource: string) =>
      report.attempts[0]!.ceilings.find((entry) => entry.resource === resource)!;

    expect(rendered).toContain("termination stalled");
    expect(use("attempt_stall_ms")).toEqual({
      resource: "attempt_stall_ms",
      used: 1_200_001,
      ceiling: 1_200_000,
      hit: true,
    });
    expect(rendered).toContain("20m / 20m — ceiling hit");
    // Ninety minutes of work and $9 spent, and nothing bounded either: the
    // attempt authenticated on a subscription, so no cost cap applied to it
    // (D-096), and no wall clock was ever set.
    expect(use("attempt_cost_micros").ceiling).toBeNull();
    expect(use("attempt_wall_clock_ms").ceiling).toBeNull();
    expect(rendered).toContain("$9.0000 reported / no ceiling");
  });

  it("says unavailable, never $0.00, when the stop came before any usage", () => {
    const { store } = storeWithTerminatedCosts("terminated-unavailable");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-15", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(report.attempts[2]!.cost).toEqual({ micros: null, basis: "unavailable", partial: true });
    expect(rendered).toContain("cost unavailable");
    expect(rendered).not.toContain("$0.0000");
  });

  it("rolls partial charges into the round subtotal and the ticket total, and says so", () => {
    const { store } = storeWithTerminatedCosts("terminated-total");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-15", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(report.attempts[0]!.round_cost).toEqual({
      micros: 2_000_000,
      components: 1,
      priced: 1,
      reported: 1,
      estimated: 0,
      unavailable: 0,
      partial: 1,
    });
    expect(report.total_cost).toEqual({
      micros: 7_110_000,
      components: 3,
      priced: 2,
      reported: 2,
      estimated: 0,
      unavailable: 1,
      partial: 2,
    });
    expect(rendered).toContain("$7.1100");
    expect(rendered).toContain("2 partial");
    expect(rendered).toContain("1 unavailable");
  });

  it("leaves a completed attempt's cost as it was, with no partial marking", () => {
    const { store } = storeWithAttempts("completed-cost");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(report.attempts[1]!.cost).toEqual({
      micros: 1_230_000,
      basis: "transport_reported",
      partial: false,
    });
    expect(rendered).toContain("$1.2300 reported");
    expect(rendered).not.toContain("$1.2300 partial");
  });

  it("marks a provider-list-estimated attempt in the ticket total", () => {
    const { store, attempt } = storeWithUnpricedAttempt("estimated-total");
    const estimated = ExecutionAttemptSchema.parse({
      ...attempt,
      usage: {
        ...attempt.usage,
        cost_micros: 895,
        cost_basis: "provider_list_estimate",
        cost_partial: true,
      },
    });
    writeFileSync(
      join(store, "state", `${estimated.ticket_id}.attempts.json`),
      `${JSON.stringify({ ticket_id: estimated.ticket_id, attempts: [estimated] }, null, 2)}\n`,
    );

    const report = buildInspectReport({ storeDirectory: store, key: "AYO-16", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(report.total_cost).toMatchObject({
      micros: 895,
      priced: 1,
      reported: 0,
      estimated: 1,
      unavailable: 0,
    });
    expect(rendered).toContain("0 reported, 1 estimated");
  });
});

/**
 * D-070: one completed attempt whose transport reported no dollars at all.
 *
 * The record carries `cost_micros: 0` beside an `unavailable` basis, which is
 * exactly the shape `$0.0000` used to be printed from: the zero is the absence
 * of a measurement, not a charge of nothing.
 */
function storeWithUnpricedAttempt(name: string): {
  repo: string;
  store: string;
  attempt: ExecutionAttempt;
} {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  const ticketId = "ticket_unpriced0001";
  writeFileSync(
    join(store, "tickets", "AYO-16.json"),
    JSON.stringify(makeTicket({ key: "AYO-16", ticket_id: ticketId, repository_root: repo })),
  );
  const attempt = makeAttempt({
    attempt_id: "att_unpriced000001",
    ticket_id: ticketId,
    created_at: "2026-09-03T09:00:00.000Z",
    termination: { reason: "completed", detail: "" },
    usage: {
      iterations: 12,
      commands: 9,
      wall_clock_ms: 90_000,
      input_tokens: 400_000,
      output_tokens: 9_000,
      cost_micros: 0,
      cost_basis: "unavailable",
    },
    changeset_id: "cs_unpriced00001",
    head_commit: "b2c3d4e",
  });
  writeFileSync(
    join(store, "state", `${ticketId}.attempts.json`),
    `${JSON.stringify({ ticket_id: ticketId, attempts: [attempt] }, null, 2)}\n`,
  );
  return { repo, store, attempt };
}

/**
 * These four were run against the renderer as it stood before this change and
 * all four failed — measured, not reasoned about, and re-measurable by anyone:
 *
 *   git checkout 6e86387 -- apps/cli/src/inspect.ts
 *   pnpm --filter @perbo/cli exec vitest run src/commands/inspect.test.ts \
 *     -t "what an attempt leads with"
 *
 *   × leads a stopped attempt …    expected 4 to be 1
 *       (`termination` sat fourth, under `started`, `agent` and `bundle`)
 *   × leads a completed attempt …  no line holds "cost $1.2300 reported"
 *       (a completed attempt printed no cost line at all)
 *   × emits each attempt record …  ZodError: expected object, received undefined
 *       (`--json` carried no `record`)
 *   × renders an unpriced attempt … expected "    cost         cost unavailable
 *       / $5.0000" to be "  cost unavailable" (the only place the charge could
 *       be read was the ceiling row, as a fraction of a limit)
 *
 * Each assertion below therefore discriminates: none of them holds on the
 * rendering this change replaced.
 */
describe("what an attempt leads with, and what a script gets", () => {
  it("leads a stopped attempt with the outcome, the stop, the cost, then the bundle", () => {
    const { store } = storeWithAttempts("order-stopped");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    const block = attemptBlock(rendered, FIRST);

    // The outcome is the ATTEMPT line itself, which opens the block.
    expect(block[0]).toContain("run 1 · round 0 · iteration_ceiling_exceeded");
    // Then the stop reason and where it stopped, wrapped over as many lines as
    // it needs, starting immediately under the outcome.
    expect(lineWith(block, "termination iteration_ceiling_exceeded")).toBe(1);
    const stopEnd = lineWith(block, "above the limit of 60");
    // Then the cost, on the line straight after the stop it belongs to.
    const cost = lineWith(block, "cost unavailable");
    expect(cost).toBe(stopEnd + 1);
    // And only then the bundle and the rest.
    expect(cost).toBeLessThan(lineWith(block, "bundle  "));
    expect(lineWith(block, "bundle  ")).toBeLessThan(lineWith(block, "started 2026-08-28"));
    expect(lineWith(block, "started 2026-08-28")).toBeLessThan(lineWith(block, "agent   "));
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("leads a completed attempt with the outcome and the cost, before the bundle", () => {
    const { store } = storeWithAttempts("order-completed");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    const block = attemptBlock(rendered, SECOND);

    expect(block[0]).toContain("run 2 · round 0 · review remediable");
    // Nothing stopped it, so the slot the stop would have taken is not there.
    expect(block.filter((line) => line.includes("termination"))).toEqual([]);
    // The cost leads all the same: it used to be readable only as a fraction of
    // the cost ceiling, several lines further down.
    expect(lineWith(block, "cost $1.2300 reported")).toBe(1);
    expect(lineWith(block, "cost $1.2300 reported")).toBeLessThan(lineWith(block, "bundle  "));
    expect(lineWith(block, "bundle  ")).toBeLessThan(lineWith(block, "started 2026-08-28"));
    expect(lineWith(block, "started 2026-08-28")).toBeLessThan(lineWith(block, "agent   "));
    // And it is above the block that spends the same figure against a ceiling.
    expect(lineWith(block, "cost $1.2300 reported")).toBeLessThan(lineWith(block, "CEILINGS"));
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("emits each attempt record under --json in its own shape, unchanged", async () => {
    const { repo, store } = storeWithAttempts("json-attempt-record");
    const streams = recordStreams({ isTTY: true });
    expect(await runCommandLine(inspectCommandLine, { argv: ["AYO-7", "--repo", repo, "--json"], streams, cwd: repo })).toBe(0);
    const emitted = streams.json<{ attempts: Array<{ record: unknown }> }>();
    const stored = JSON.parse(
      readFileSync(join(store, "state", `${TICKET_ID}.attempts.json`), "utf8"),
    ) as { attempts: unknown[] };

    expect(emitted.attempts).toHaveLength(stored.attempts.length);
    emitted.attempts.forEach((attempt, index) => {
      // The contracts' own schema, which is strict: a record with a field this
      // renderer added, or missing one it did not name, would be refused here.
      expect(ExecutionAttemptSchema.parse(attempt.record)).toEqual(stored.attempts[index]);
    });
  });

  it("renders an unpriced attempt's cost as unavailable, and never as a zero amount", async () => {
    const { repo, store, attempt } = storeWithUnpricedAttempt("unpriced");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-16", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    const block = attemptBlock(rendered, attempt.attempt_id);

    // What a person reads: the word, on the cost line, and no dollar amount
    // anywhere in the rendering that could be read as a charge of nothing.
    expect(block[lineWith(block, "cost ")]).toBe("  cost unavailable");
    expect(rendered).not.toMatch(/\$0/);
    expect(rendered).toContain("unavailable — 1 component(s) unpriced");

    // What a script reads: no figure at all, the basis intact, and the record
    // itself carrying the `cost_micros: 0` the reading refuses to price.
    const streams = recordStreams({ isTTY: true });
    expect(await runCommandLine(inspectCommandLine, { argv: ["AYO-16", "--repo", repo, "--json"], streams, cwd: repo })).toBe(0);
    const emitted = streams.json<{
      attempts: Array<{ cost: unknown; record: unknown }>;
      total_cost: unknown;
    }>();
    expect(emitted.attempts[0]!.cost).toEqual({ micros: null, basis: "unavailable", partial: false });
    expect(ExecutionAttemptSchema.parse(emitted.attempts[0]!.record)).toEqual(attempt);
    expect(emitted.attempts[0]!.record).toMatchObject({
      usage: { cost_micros: 0, cost_basis: "unavailable" },
    });
    expect(emitted.total_cost).toEqual({
      micros: 0,
      components: 1,
      priced: 0,
      reported: 0,
      estimated: 0,
      unavailable: 1,
      partial: 0,
    });
  });
});

/**
 * SCP-163: an attempt that ended with nothing changed is only readable beside
 * what it was refused. The rule and the target are what a person acts on — a
 * path to move, or a verb to admit — and until this they were in an attempt
 * JSON nobody opened.
 */
describe("the denials of an attempt that ended without changes", () => {
  const DENIED = "att_denied00000001";

  const storeWithDenials = (name: string): string => {
    const repo = join(scratch, name);
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    writeFileSync(
      join(store, "tickets", "AYO-7.json"),
      JSON.stringify(makeTicket({ key: "AYO-7", ticket_id: TICKET_ID, repository_root: repo })),
    );
    const attempt = makeAttempt({
      attempt_id: DENIED,
      ticket_id: TICKET_ID,
      created_at: "2026-09-02T09:00:00.000Z",
      termination: {
        reason: "no_changes_after_denials",
        detail:
          "the branch adds no change to its base, and 2 command(s) the executor asked for " +
          "were refused: write_outside_worktree on /tmp/evidence; command_allow_list on " +
          "script -q /dev/null node x.js",
      },
      usage: { iterations: 54, commands: 2, wall_clock_ms: 120_000 },
      changeset_id: null,
      head_commit: null,
      commands: [
        {
          sequence: 0,
          tool: "Bash",
          detail: "rm -rf /tmp/evidence",
          decision: "denied",
          denial_reason: "the rm target /tmp/evidence resolves to /tmp/evidence, outside the worktree",
          denial_rule: "write_outside_worktree",
          denial_target: "/tmp/evidence",
          cwd: ".",
          decided_by: "pre_execution_hook",
          second_reading: null,
          agent: null,
          at: "2026-09-02T09:01:00.000Z",
        },
        {
          sequence: 1,
          tool: "Bash",
          detail: "script -q /dev/null node x.js",
          decision: "denied",
          denial_reason: "script is not on the runner's command allow-list",
          denial_rule: "command_allow_list",
          denial_target: "script -q /dev/null node x.js",
          cwd: ".",
          decided_by: "pre_execution_hook",
          second_reading: null,
          agent: null,
          at: "2026-09-02T09:02:00.000Z",
        },
      ],
    });
    writeFileSync(
      join(store, "state", `${TICKET_ID}.attempts.json`),
      JSON.stringify({ schema_version: 1, ticket_id: TICKET_ID, attempts: [attempt] }),
    );
    return store;
  };

  it("prints each denied command once, with the rule that denied it and the target", () => {
    const store = storeWithDenials("denials");
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });

    expect(report.attempts[0]!.termination.reason).toBe("no_changes_after_denials");
    expect(report.attempts[0]!.denials).toEqual([
      expect.objectContaining({ rule: "write_outside_worktree", target: "/tmp/evidence" }),
      expect.objectContaining({
        rule: "command_allow_list",
        target: "script -q /dev/null node x.js",
      }),
    ]);

    expect(rendered).toContain("DENIALS");
    for (const [rule, target] of [
      ["write_outside_worktree", "/tmp/evidence"],
      ["command_allow_list", "script -q /dev/null node x.js"],
    ]) {
      const section = rendered.slice(rendered.indexOf("DENIALS"));
      expect(section).toContain(rule!);
      expect(section).toContain(target!);
    }
    // Once each: two denied commands, two rule lines under the section.
    const lines = rendered
      .slice(rendered.indexOf("DENIALS"))
      .split("\n")
      .filter((line) => line.includes("write_outside_worktree") || line.includes("command_allow_list"));
    expect(lines).toHaveLength(2);
  });

  /**
   * D-106: a refusal a subagent earned is not the executor's, and a person
   * reading the round has to be able to tell which agent to brief differently.
   */
  it("names the subagent a refusal belongs to, and names none on the session's own", () => {
    const repo = join(scratch, "denials-by-agent");
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    writeFileSync(
      join(store, "tickets", "AYO-7.json"),
      JSON.stringify(makeTicket({ key: "AYO-7", ticket_id: TICKET_ID, repository_root: repo })),
    );
    const attempt = makeAttempt({
      attempt_id: "att_byagent00000001",
      ticket_id: TICKET_ID,
      created_at: "2026-09-02T09:00:00.000Z",
      termination: { reason: "completed", detail: "" },
      usage: { iterations: 4, commands: 2, wall_clock_ms: 1_000 },
      changeset_id: null,
      head_commit: null,
      commands: [
        {
          sequence: 0,
          tool: "Write",
          detail: "Write /tmp/evidence",
          decision: "denied",
          denial_reason: "the Write destination resolves outside the worktree",
          denial_rule: "write_outside_worktree",
          denial_target: "/tmp/evidence",
          cwd: null,
          decided_by: "pre_execution_hook",
          second_reading: null,
          agent: "perbo-implementer",
          at: "2026-09-02T09:01:00.000Z",
        },
        {
          sequence: 1,
          tool: "Bash",
          detail: "curl https://example.invalid",
          decision: "denied",
          denial_reason: "curl is on the runner's command deny-list",
          denial_rule: "command_deny_list",
          denial_target: "curl https://example.invalid",
          cwd: ".",
          decided_by: "pre_execution_hook",
          second_reading: null,
          agent: null,
          at: "2026-09-02T09:02:00.000Z",
        },
      ],
    });
    writeFileSync(
      join(store, "state", `${TICKET_ID}.attempts.json`),
      JSON.stringify({ schema_version: 1, ticket_id: TICKET_ID, attempts: [attempt] }),
    );

    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    expect(report.attempts[0]!.denials.map((denial) => denial.agent)).toEqual([
      "perbo-implementer",
      null,
    ]);

    const section = renderInspect(report, { color: false, detail: false, version: "test" }).slice(
      0,
    );
    const denials = section.slice(section.indexOf("DENIALS"));
    expect(denials).toContain("perbo-implementer");
    // The executor's own refusal reads as it always did: the role is printed
    // where there is one, and nothing stands in for it where there is not.
    const named = denials.split("\n").filter((line) => line.includes("perbo-implementer"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("Write /tmp/evidence");
  });
});

/**
 * What `inspect` prints a person is never cut (D-NEW-nothing-shown-is-cut):
 * text longer than its column goes under it, wrapped, and every word of it is
 * there. Each value here is longer than any column the card gives it.
 */
describe("the card, whole", () => {
  const long = (what: string) => `${what} ${"that runs on past any column the card could give it ".repeat(3)}END`;
  const flat = (rendered: string) => rendered.replace(/\s+/g, " ");
  const rendered = (edit: (report: ReturnType<typeof buildInspectReport>) => void, detail = false) => {
    const { store } = storeWithAttempts(`whole-${Math.random().toString(36).slice(2)}`);
    const report = buildInspectReport({ storeDirectory: store, key: "AYO-7", attempt: null });
    edit(report);
    const text = renderInspect(report, { color: false, detail, version: "test" });
    for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(WIDTH);
    return flat(text);
  };
  const check = (over: Partial<CheckResult>): CheckResult =>
    ({ check_id: "check_unit", name: "unit", kind: "unit", status: "failed", summary: "1 failed", command: "pnpm test", detail: null, duration_ms: null, source: "file", ...over }) as CheckResult;

  it("prints a check's command and summary whole", () => {
    const summary = long("Tests 1 failed | 311 passed");
    const command = "pnpm exec vitest run --project unit --reporter verbose";
    const out = rendered((report) => {
      report.attempts[1]!.checks = [check({ summary, command })];
    });
    expect(out).toContain(command);
    expect(out).toContain(summary);
  });

  it("prints what hangs under a check whole: its node, its re-run, its failing tests and its tmpdir", () => {
    const narrowed = long("packages/search/src/query.ts");
    const rerun = long("pnpm exec vitest run packages/search/test/query.test.ts");
    const note = long("the re-run named the same test");
    const test = long("packages/search/test/query.test.ts > paginates");
    const tmpdir = long("/private/var/folders/xy/abcdefghijklmnop/T/perbo-attempt");
    const out = rendered((report) => {
      report.attempts[1]!.checks = [
        check({
          node: { node_id: "node_1", scope: "files", paths: [narrowed] },
          rerun: { status: "failed", command: rerun, note },
          failing_tests: [test],
          tmpdir,
        } as unknown as Partial<CheckResult>),
      ];
    });
    for (const text of [narrowed, rerun, note, test, tmpdir]) expect(out).toContain(text);
  });

  it("prints a finding's location, a verification's pointer and a changed file whole", () => {
    const file = long("packages/search/src/a/deeply/nested/directory/query.ts").replace(/ /g, "-");
    const changed = long("packages/search/src/another/deeply/nested/directory/page.ts").replace(/ /g, "-");
    const pointer = long("src/paginate.ts:12, where the page size is read");
    const out = rendered((report) => {
      report.attempts[1]!.review!.findings[0]!.file = file;
      report.attempts[2]!.verification!.per_finding[0]!.pointer = pointer;
      report.attempts[1]!.changed_files = [{ path: changed, change_kind: "modified", additions: 3, deletions: 1 }];
    }, true);
    expect(out.replace(/ /g, "")).toContain(file);
    expect(out.replace(/ /g, "")).toContain(changed);
    expect(out).toContain(pointer);
  });

  it("prints the target of a refused command whole", () => {
    const target = long("/Users/someone/.config/an-application/settings.json");
    const out = rendered((report) => {
      report.attempts[1]!.denials = [{ tool: "Bash", command: "echo x > \"$CONFIG\"", rule: "write_outside_worktree", target, agent: null } as never];
    }, true);
    expect(out).toContain(target);
  });

  it("prints a remediation round's rung whole", () => {
    const out = rendered((report) => {
      const keys = Array.from({ length: 1000 }, (_, n) => `k${n}`);
      report.attempts[2]!.ladder = { kind: "resolve_conflict", given: keys, closed: keys, open: keys } as never;
    });
    expect(out).toContain("given 1000 closed 1000 open 1000 (conflict — not a remediation round)");
  });

  it("prints how a ticket was admitted whole", () => {
    const criteria = long("imported from the tracker");
    const level = long("P2 raised by the person");
    const out = rendered((report) => {
      report.admission = { criteria_source: criteria, criteria_count: 3, derived_level: level, level_source: "manual" } as never;
    });
    expect(out).toContain(criteria);
    expect(out).toContain(level);
  });

  it("prints how the approval went whole", () => {
    const out = rendered((report) => {
      report.admission = { human_elapsed_ms: 3_600_000 * 1e20, edit_count: 1e20 } as never;
    });
    expect(out).toContain("100000000000000000000.0 hours from first rendering · 100000000000000000000 edits");
  });

  it("marks where a check's name or a bundle object's name is cut to its column", () => {
    const name = "typecheck:desktop-renderer";
    const artifact = "a-bundle-object-named-past-its-column.json";
    const out = rendered((report) => {
      report.attempts[1]!.checks = [check({ name })];
      const bundle = report.attempts[1]!.bundles[0]!;
      bundle.artifacts = [{ ...bundle.artifacts[0]!, name: artifact }];
    }, true);
    expect(out).toContain(" typecheck:desk… ");
    expect(out).toContain(` ${artifact.slice(0, 27)}… `);
  });

  it("prints a local run's contract and url whole", () => {
    const reference = long("owner/repository#412");
    const url = `https://github.com/owner/repository/pull/412/${"files".repeat(20)}`;
    const out = rendered((report) => {
      report.admission = null;
      (report as { kind: string }).kind = "local";
      (report as { contract_source: unknown }).contract_source = {
        source: "pull_request",
        reference,
        outcome_from: "title",
        criteria: [],
        url,
      };
    });
    expect(out).toContain(reference);
    expect(out.replace(/ /g, "")).toContain(url);
  });
});
