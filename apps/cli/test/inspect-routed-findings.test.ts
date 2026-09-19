import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SecretIndex } from "@perbo/contracts";
import { BundleStore } from "@perbo/runner";
import { buildInspectReport, renderInspect } from "../src/inspect.js";
import {
  BLOCKING_RULE,
  ESCALATED_RULE,
  ROUTED_RULES,
  makeAttempt,
  makeRoutedReview,
  makeTicket,
} from "./attempt-fixture.js";

/**
 * The record the pull request and the markdown verdict point at.
 *
 * They list what needs a person and count the findings the executor closed.
 * Here every finding is listed, whatever its routing, with the closure answer
 * and the reason the routing came from — so nothing is hidden, only not shown.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-inspect-routed-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TICKET_ID = "ticket_routed000001";
const CHANGESET_ID = "cs_routed00001";
const review = makeRoutedReview({ review_id: "rev_routed00001", changeset_id: CHANGESET_ID });

function storeWithRoutedReview(name: string): string {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-1.json"),
    JSON.stringify(makeTicket({ key: "AYO-1", ticket_id: TICKET_ID, repository_root: repo })),
  );
  const attempt = makeAttempt({
    attempt_id: "att_routed00000001",
    ticket_id: TICKET_ID,
    created_at: "2026-09-06T11:00:00.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { cost_micros: 0 },
    changeset_id: CHANGESET_ID,
    head_commit: "b2c3d4e",
  });
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
  );
  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  const write = (
    kind: "execution" | "review",
    subject_id: string,
    inputs: Record<string, unknown>,
    artifacts: Array<{ name: string; media_type: string; body: string }>,
    at: string,
  ) =>
    bundles.write({
      kind,
      subject_id,
      ticket_id: TICKET_ID,
      inputs,
      context_manifest: [],
      versions: {
        code: "test",
        prompt: "executor_v4",
        policy: "A2b",
        model: "claude-opus-5",
        tool: "1.0.98",
      },
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
  write(
    "execution",
    attempt.attempt_id,
    { termination: "completed" },
    [
      { name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt) },
      { name: "transcript.jsonl", media_type: "application/x-ndjson", body: "" },
    ],
    "2026-09-06T11:01:00.000Z",
  );
  write(
    "review",
    review.review_id,
    { changeset_id: CHANGESET_ID, decision: "changes_requested", remediation_round: 0 },
    [{ name: "review.json", media_type: "application/json", body: JSON.stringify(review) }],
    "2026-09-06T11:02:00.000Z",
  );
  return store;
}

describe("perbo inspect, on a review whose findings went four ways", () => {
  const store = storeWithRoutedReview("four-ways");
  const report = buildInspectReport({ storeDirectory: store, key: "AYO-1", attempt: null });

  it("lists every finding with its routing, the two the pull request only counts included", () => {
    const rendered = renderInspect(report, { color: false, detail: false, version: "test" });
    for (const rule of [...ROUTED_RULES, BLOCKING_RULE, ESCALATED_RULE]) {
      expect(rendered, rule).toContain(rule);
    }
    expect(rendered).toContain("[FIX]");
    expect(rendered).toContain("[BLOCK]");
    expect(rendered).toContain("(esc)");
    expect(rendered).toContain("not blocking · remediable");
  });

  it("keeps each routed finding's closure answer and the reason it was routed on", () => {
    const recorded = report.attempts[0]?.review?.findings ?? [];
    expect(recorded.map((one) => one.rule_id)).toEqual(review.findings.map((one) => one.rule_id));
    for (const rule of ROUTED_RULES) {
      const back = recorded.find((one) => one.rule_id === rule);
      expect(back?.closure).toBe("executor");
      expect(back?.blocking_reason).toBe(
        review.findings.find((one) => one.rule_id === rule)?.blocking_reason,
      );
    }
  });
});
