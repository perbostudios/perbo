import { describe, expect, it } from "vitest";
import type { Finding, ReviewArtifact } from "@perbo/contracts";
import { FixtureSchema, type Fixture } from "../src/fixture.js";
import { scoreRun } from "../src/score.js";

/**
 * D-086 by D-088 (SCP-258). The product is the loop, so an executor always
 * takes a routed finding: a clean change whose review ended `remediable` was
 * not blocked, it was worked on. "Clean changes passing the gate" counts it as
 * passing; a `changes_requested` or `escalate` review is a block on a clean
 * change and does not pass.
 */

const clean: Fixture = FixtureSchema.parse({
  "id": "cln-001-a-clean-thing",
  "class": "clean",
  "defective": false,
  "plan_level": "P1",
  "source": {
    "kind": "commit",
    "reference": "vuejs/core#15346",
    "url": [
      "https://github.com/vuejs/core/commit/f8d42e1cf2a0ccb43c50fad6e972cb130c53824e"
    ],
    "derivation": "transplanted",
    "upstream_licence": "MIT",
    "code_copied": false
  },
  "defect": "None. This is a real merged commit in a real repository, and its cleanliness is a fact about the world rather than a claim by its author.",
  "why_it_is_hard": "A one-character change (rawArgs to args) inside a two-modifier interaction, in a file whose surrounding code is dense. A reviewer that reads the diff without following what looseToNumber does to an already-trimmed string has nothing to say, and a reviewer looking for something to say has plenty of adjacent code to say it about.",
  "expected_detection": {
    "mode": "clean"
  },
  "forbidden_strings": [],
  "must_not_approve": false,
  "authored_on": "2026-08-27",
  "authored_before_reviewer": false,
  "runtime": {
    "status": "runs",
    "note": "3699 passed | 6 skipped (3705) in 182 passed | 1 skipped (183)"
  },
  "pinned_repository": {
    "url": "https://github.com/vuejs/core",
    "licence": "MIT",
    "base_commit": "cd1974562357dd73101d048f207a694a4e5310ec",
    "head_commit": "f8d42e1cf2a0ccb43c50fad6e972cb130c53824e",
    "subject": "fix(runtime-core): keep .trim result when combined with .number v-model modifier (#15346)",
    "reference": "https://github.com/vuejs/core/commit/f8d42e1cf2a0ccb43c50fad6e972cb130c53824e",
    "setup_commands": [
      [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts"
      ]
    ],
    "verify_command": [
      "pnpm",
      "run",
      "test-unit"
    ]
  },
  "notes": "Drawn from a merged commit rather than authored, per round two's recommendation. The contract is authored here; the code is not, and none of it is checked in."
});

const finding = (routing: Finding["routing"], blocking: boolean): Finding => ({
  key: "a".repeat(64), rule_id: "test.missing_case", source: "semantic", criterion_id: "ac_1", severity: "minor",
  blocking, blocking_reason: "", confidence: 0.8, file: "src/a.ts", line: 1, symbol: null, statement: "x",
  status: "open", outcome: "unknown", row: "semantic_ordinary", closure: "executor", direction: "negative", routing, waiver: null,
});

const artifact = (decision: string, findings: Finding[]): ReviewArtifact =>
  ({ schema_version: 1, review_id: "rev_test", created_at: "2026-09-06T00:00:00.000Z", decision, error: null, escalated: decision === "escalate", findings, coverage: [], planned_risk: "P2", actual_risk: "P2", remediation: null }) as unknown as ReviewArtifact;

describe("a clean change and the gate", () => {
  it("passes when the review approved it", () => {
    expect(scoreRun(clean, artifact("approve", []), 0).false_block).toBe(false);
  });

  it("passes when its only closing findings went to the executor", () => {
    expect(scoreRun(clean, artifact("remediable", [finding("remediable", false)]), 2).false_block).toBe(false);
  });

  it("does not pass when a finding blocked it", () => {
    expect(scoreRun(clean, artifact("changes_requested", [finding("blocks", true)]), 2).false_block).toBe(true);
  });

  it("does not pass when a finding escalated it", () => {
    expect(scoreRun(clean, artifact("escalate", [finding("escalates", false)]), 2).false_block).toBe(true);
  });
});
