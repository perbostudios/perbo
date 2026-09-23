import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SecretIndex, type ReviewArtifact } from "@perbo/contracts";
import { BundleStore } from "../../bundle.js";
import { remediationToContinue } from "./continuation.js";
import { finding, makeReview } from "../../test-support/records.js";

const TICKET = "tkt_scp194";
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): BundleStore {
  const root = mkdtempSync(join(tmpdir(), "perbo-continuation-"));
  scratch.push(root);
  return new BundleStore({ root, retainContext: true });
}

const blank = {
  context_manifest: [],
  versions: { code: "stage-2", prompt: "p", policy: "b", model: "m", tool: "t" },
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cost_micros: 1,
    cost_basis: "transport_reported" as const,
    wall_clock_ms: 1,
  },
  errors: [],
  transitions: [],
  retention: { class: "replay_retained" as const, expires_at: null },
  secrets: new SecretIndex(),
  excluded_paths: [],
  deterministic: false,
  model_version_pinned: true,
};

function writeReview(bundles: BundleStore, artifact: ReviewArtifact, at: string): void {
  bundles.write({
    ...blank,
    kind: "review",
    subject_id: artifact.review_id,
    ticket_id: TICKET,
    inputs: { head_commit: artifact.target.head_commit },
    artifacts: [
      { name: "review.json", media_type: "application/json", body: JSON.stringify(artifact) },
    ],
    now: new Date(at),
  });
}

function writeVerification(
  bundles: BundleStore,
  inputs: Record<string, string | number | boolean | null>,
  at: string,
): void {
  bundles.write({
    ...blank,
    kind: "review",
    subject_id: "cv_att_0000000000000001",
    ticket_id: TICKET,
    inputs,
    artifacts: [],
    now: new Date(at),
  });
}

describe("the remediation a re-run continues", () => {
  it("has nothing to continue where no review is on record", () => {
    expect(remediationToContinue({ bundles: store(), ticket_id: TICKET })).toBeNull();
  });

  it("takes the last verification's open set and the commit it judged", () => {
    const bundles = store();
    const open = finding({ key: "a".repeat(64) });
    const closed = finding({ key: "b".repeat(64) });
    writeReview(
      bundles,
      makeReview({ decision: "changes_requested", findings: [open, closed] }),
      "2026-08-27T00:00:00.000Z",
    );
    writeVerification(
      bundles,
      { findings_open: open.key, head_commit: "fed4321" },
      "2026-08-27T01:00:00.000Z",
    );

    const continuing = remediationToContinue({ bundles, ticket_id: TICKET });

    expect(continuing?.findings.map((entry) => entry.key)).toEqual([open.key]);
    expect(continuing?.head_commit).toBe("fed4321");
  });

  it("reads the commit from the review itself where no round has verified yet", () => {
    const bundles = store();
    writeReview(
      bundles,
      makeReview({ decision: "changes_requested", findings: [finding()], head_commit: "def5678" }),
      "2026-08-27T00:00:00.000Z",
    );

    expect(remediationToContinue({ bundles, ticket_id: TICKET })?.head_commit).toBe("def5678");
  });

  it("refuses a verification that never recorded what was still open", () => {
    const bundles = store();
    writeReview(
      bundles,
      makeReview({ decision: "changes_requested", findings: [finding()] }),
      "2026-08-27T00:00:00.000Z",
    );
    writeVerification(bundles, { head_commit: "fed4321" }, "2026-08-27T01:00:00.000Z");

    expect(remediationToContinue({ bundles, ticket_id: TICKET })).toBeNull();
  });
});
