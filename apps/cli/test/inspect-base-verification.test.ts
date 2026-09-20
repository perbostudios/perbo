import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ReviewArtifactSchema, SecretIndex, type ExecutionAttempt, type Finding } from "@perbo/contracts";
import { BundleStore } from "@perbo/runner";
import { buildInspectReport, renderInspect } from "../src/inspect.js";
import { makeAttempt, makeReview, makeTicket } from "./attempt-fixture.js";

/**
 * A blocked check finding, read for what its attribution rests on.
 *
 * "The unit check failed" is the same sentence whether the change broke it or
 * the base was already red, and the routing that follows is opposite. What
 * separates the two is the verification of the contract's base commit, so the
 * report names that commit and what the verification said — and says so when
 * nothing measured it, rather than leaving a reader to assume.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-inspect-base-verify-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TICKET_ID = "ticket_baseverify1";
const CHANGESET_ID = "cs_baseverify1";
const BASE_COMMIT = "9f13c0a4b7e2d68";

const checkFinding = (over: Partial<Finding>): Finding =>
  ({
    key: "5".repeat(64),
    rule_id: "check.unit",
    source: "deterministic",
    criterion_id: null,
    severity: "blocker",
    blocking: true,
    blocking_reason:
      "deterministic: a security, scope or check failure always blocks — no confidence term",
    routing: "blocks",
    row: "deterministic",
    closure: null,
    direction: null,
    confidence: null,
    file: null,
    line: null,
    symbol: "unit",
    statement: "The unit check failed (1 failed | 142 passed).",
    status: "open",
    outcome: "unknown",
    caused_by_change: false,
    waiver: null,
    ...over,
  }) as Finding;

function storeWith(
  name: string,
  base_verification: ExecutionAttempt["base_verification"],
): string {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-1.json"),
    JSON.stringify(makeTicket({ key: "AYO-1", ticket_id: TICKET_ID, repository_root: repo })),
  );
  const attempt = makeAttempt({
    attempt_id: "att_baseverify0001",
    ticket_id: TICKET_ID,
    created_at: "2026-09-10T11:00:00.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { cost_micros: 0 },
    changeset_id: CHANGESET_ID,
    head_commit: "b2c3d4e",
    base_verification,
  });
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
  );
  const review = ReviewArtifactSchema.parse({
    ...makeReview({
      review_id: "rev_baseverify001",
      changeset_id: CHANGESET_ID,
      decision: "changes_requested",
      cost_basis: "provider_list_estimate",
    }),
    findings: [checkFinding({})],
  });
  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  const write = (
    kind: "execution" | "review",
    subject_id: string,
    inputs: Record<string, string | number | boolean | null>,
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
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cost_micros: 0,
        cost_basis: "unavailable",
        wall_clock_ms: 1,
      },
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
    [{ name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt) }],
    "2026-09-10T11:01:00.000Z",
  );
  write(
    "review",
    review.review_id,
    { changeset_id: CHANGESET_ID, decision: "changes_requested", remediation_round: 0 },
    [{ name: "review.json", media_type: "application/json", body: JSON.stringify(review) }],
    "2026-09-10T11:02:00.000Z",
  );
  return store;
}

const render = (store: string): string =>
  renderInspect(buildInspectReport({ storeDirectory: store, key: "AYO-1", attempt: null }), {
    color: false,
    detail: false,
    version: "test",
  });

describe("perbo inspect, on a check finding that blocks", () => {
  it("names the commit the attribution rests on and what its verification said", () => {
    const rendered = render(
      storeWith("measured", { commit: BASE_COMMIT, verified: false }),
    );
    expect(rendered).toContain(BASE_COMMIT.slice(0, 12));
    expect(rendered).toMatch(/base .*fail/i);
  });

  it("says the verification passed where it did", () => {
    const rendered = render(storeWith("passed", { commit: BASE_COMMIT, verified: true }));
    expect(rendered).toContain(BASE_COMMIT.slice(0, 12));
    expect(rendered).toMatch(/base .*pass/i);
  });

  it("says so when nothing has verified the base", () => {
    const rendered = render(storeWith("unmeasured", null));
    expect(rendered).toMatch(/no verification of the base/i);
  });
});
