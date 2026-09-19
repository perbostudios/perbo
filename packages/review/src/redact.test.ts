import { describe, expect, it } from "vitest";
import { redactReviewArtifact, REDACTION_SKIPPED_KEYS } from "./redact.js";
import type { ReviewArtifact } from "@perbo/contracts";

/**
 * The measured problem (D-063): a reviewer that correctly reports a committed
 * credential discloses it while reporting. These tests hold the mechanism to
 * the two properties the decision demands — it fires on the channels that
 * leaked, and it leaves byte-exact identifiers alone.
 */

const KEY = "sk_live_51H8xQ2LmNbVcXz9RtYuIoP";

/** Minimal artifact carrying only the fields these tests exercise. */
const artifactWith = (parts: Record<string, unknown>): ReviewArtifact =>
  ({
    schema_version: "2",
    review_id: "rev_01J8ZQ",
    created_at: "2026-08-30T00:00:00.000Z",
    target: {
      type: "changeset",
      id: "cs_01J8ZQ",
      base_commit: "a".repeat(40),
      head_commit: "b".repeat(40),
    },
    findings: [],
    coverage: [],
    checks: [],
    decision: "block",
    ...parts,
  }) as unknown as ReviewArtifact;

describe("redactReviewArtifact", () => {
  it("redacts a credential quoted in a finding statement", () => {
    const { artifact, redactions } = redactReviewArtifact(
      artifactWith({
        findings: [
          {
            key: "f".repeat(64),
            statement: `The committed file sets STRIPE_SECRET = "${KEY}" on the billing path.`,
          },
        ],
      }),
    );

    const serialised = JSON.stringify(artifact);
    expect(serialised).not.toContain(KEY);
    expect(redactions.count).toBe(1);
    expect(serialised).toContain("[redacted:");
  });

  it("redacts a credential quoted as criterion evidence, which is where sec-010 leaked", () => {
    const { artifact } = redactReviewArtifact(
      artifactWith({
        coverage: [
          {
            criterion_id: "ac_2",
            evidence: { kind: "directly_verified", assertion: `signing key is ${KEY}` },
          },
        ],
      }),
    );

    expect(JSON.stringify(artifact)).not.toContain(KEY);
  });

  it("redacts a credential in a check summary and detail", () => {
    const { artifact, redactions } = redactReviewArtifact(
      artifactWith({
        checks: [{ check_id: "c1", summary: `leaked ${KEY}`, detail: `again ${KEY}` }],
      }),
    );

    expect(JSON.stringify(artifact)).not.toContain(KEY);
    expect(redactions.count).toBe(2);
  });

  it("leaves commit shas and identifiers byte-exact", () => {
    const before = artifactWith({});
    const { artifact, redactions } = redactReviewArtifact(before);

    expect(artifact.target.base_commit).toBe("a".repeat(40));
    expect(artifact.target.head_commit).toBe("b".repeat(40));
    expect(artifact.review_id).toBe("rev_01J8ZQ");
    expect(redactions.count).toBe(0);
  });

  it("never rewrites a key on the skip list, even one holding a credential", () => {
    // A finding key is a sha256 and must survive verbatim: closure verification
    // matches routed findings by it, so mangling one silently unroutes work.
    expect(REDACTION_SKIPPED_KEYS).toContain("key");

    const { artifact } = redactReviewArtifact(
      artifactWith({ findings: [{ key: "c".repeat(64), statement: "nothing sensitive" }] }),
    );
    expect((artifact.findings[0] as { key: string }).key).toBe("c".repeat(64));
  });

  it("reports which rules fired, so a false positive is attributable", () => {
    const { redactions } = redactReviewArtifact(
      artifactWith({
        findings: [{ key: "d".repeat(64), statement: `token ${KEY}` }],
      }),
    );

    expect(redactions.rules).toContain("vendor.stripe_like");
  });

  it("does not mutate the artifact it was given", () => {
    const before = artifactWith({
      findings: [{ key: "e".repeat(64), statement: `token ${KEY}` }],
    });
    redactReviewArtifact(before);

    expect(JSON.stringify(before)).toContain(KEY);
  });
});
