import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NEVER_HANDED_FAMILIES, SecretIndex, type ReviewArtifact } from "@perbo/contracts";
import { isRemediableFamily } from "@perbo/review";
import { BundleStore } from "../../bundle.js";
import { decidedDelivery, judgedOnRecord, remediationToContinue } from "./continuation.js";
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
    expect(remediationToContinue({ bundles: store(), ticket_id: TICKET, decided: [] })).toBeNull();
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

    const continuing = remediationToContinue({ bundles, ticket_id: TICKET, decided: [] });

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

    expect(remediationToContinue({ bundles, ticket_id: TICKET, decided: [] })?.head_commit).toBe("def5678");
  });

  it("refuses a verification that never recorded what was still open", () => {
    const bundles = store();
    writeReview(
      bundles,
      makeReview({ decision: "changes_requested", findings: [finding()] }),
      "2026-08-27T00:00:00.000Z",
    );
    writeVerification(bundles, { head_commit: "fed4321" }, "2026-08-27T01:00:00.000Z");

    expect(remediationToContinue({ bundles, ticket_id: TICKET, decided: [] })).toBeNull();
  });
});

describe("the delivery a person's answers take without a round", () => {
  const forPerson = finding({
    key: "c".repeat(64),
    rule_id: "product.preference",
    routing: "escalates",
    closure: "human",
  });
  const remediable = finding({ key: "d".repeat(64) });
  const answer = (at: string) => ({
    finding_key: forPerson.key,
    choice: "ship_as_is" as const,
    review_id: null,
    note: "Half-even.",
    author: "Owen",
    decided_at: at,
  });
  const delivery = (bundles: BundleStore, at: string) =>
    decidedDelivery({ bundles, ticket_id: TICKET, repository_id: "repo_fixture", decided: [answer(at)] });

  it("counts a finding the executor closed, as a verification recorded it, beside the answered one", () => {
    const bundles = store();
    writeReview(
      bundles,
      makeReview({ decision: "escalate", findings: [forPerson, remediable] }),
      "2026-08-27T00:00:00.000Z",
    );
    expect(delivery(bundles, "2026-08-27T02:00:00.000Z")).toBeNull();

    writeVerification(
      bundles,
      { findings_given: remediable.key, findings_open: "", head_commit: "fed4321" },
      "2026-08-27T01:00:00.000Z",
    );
    const delivered = delivery(bundles, "2026-08-27T02:00:00.000Z");
    expect(delivered?.head_commit).toBe("fed4321");
    expect(delivered?.decided.map((row) => row.finding_key)).toEqual([forPerson.key]);
    expect(delivered?.review.findings.find((row) => row.key === forPerson.key)?.waiver?.reason).toBe(
      "Half-even.",
    );
  });

  it("reads the last verification's open set, and a finding no verification was given as open", () => {
    const bundles = store();
    const declined = finding({ key: "e".repeat(64) });
    writeReview(
      bundles,
      makeReview({ decision: "escalate", findings: [forPerson, remediable, declined] }),
      "2026-08-27T00:00:00.000Z",
    );
    // Round 1 closed the remediable one; round 2 reopened it.
    writeVerification(
      bundles,
      { findings_given: remediable.key, findings_open: "", head_commit: "fed4321" },
      "2026-08-27T01:00:00.000Z",
    );
    writeVerification(
      bundles,
      { findings_given: remediable.key, findings_open: remediable.key, head_commit: "fed4322" },
      "2026-08-27T01:30:00.000Z",
    );
    expect(delivery(bundles, "2026-08-27T02:00:00.000Z")).toBeNull();

    // The declined finding was never given to a verification: it is not closed.
    const again = store();
    writeReview(
      again,
      makeReview({ decision: "escalate", findings: [forPerson, remediable, declined] }),
      "2026-08-27T00:00:00.000Z",
    );
    writeVerification(
      again,
      { findings_given: remediable.key, findings_open: "", head_commit: "fed4321" },
      "2026-08-27T01:00:00.000Z",
    );
    expect(delivery(again, "2026-08-27T02:00:00.000Z")).toBeNull();
  });

  it("delivers nothing on a ship-as-is answer to a finding the review routed to the executor", () => {
    const bundles = store();
    writeReview(
      bundles,
      makeReview({ decision: "escalate", findings: [forPerson, remediable] }),
      "2026-08-27T00:00:00.000Z",
    );
    const at = "2026-08-27T02:00:00.000Z";
    const both = [answer(at), { ...answer(at), finding_key: remediable.key }];
    expect(decidedDelivery({ bundles, ticket_id: TICKET, repository_id: "repo_fixture", decided: both })).toBeNull();
  });

  it("delivers nothing where no standing finding was answered by a person", () => {
    const bundles = store();
    writeReview(bundles, makeReview({ decision: "remediable", findings: [remediable] }), "2026-08-27T00:00:00.000Z");
    writeVerification(
      bundles,
      { findings_given: remediable.key, findings_open: "", head_commit: "fed4321" },
      "2026-08-27T01:00:00.000Z",
    );
    // A decision on a key this review does not hold answers nothing on it.
    expect(delivery(bundles, "2026-08-27T02:00:00.000Z")).toBeNull();
  });

  it("delivers nothing on a review that did not complete", () => {
    const bundles = store();
    writeReview(
      bundles,
      makeReview({ decision: "error", findings: [forPerson], error: { kind: "provider_unavailable" } }),
      "2026-08-27T00:00:00.000Z",
    );
    expect(delivery(bundles, "2026-08-27T02:00:00.000Z")).toBeNull();
  });

  it("holds a decision that named a review by its id to that review", () => {
    const bundles = store();
    writeReview(
      bundles,
      makeReview({ review_id: "rev_0000000000000002", decision: "escalate", findings: [forPerson] }),
      "2026-08-27T00:00:00.000Z",
    );
    const named = (review_id: string) =>
      decidedDelivery({
        bundles,
        ticket_id: TICKET,
        repository_id: "repo_fixture",
        decided: [{ ...answer("2026-08-27T02:00:00.000Z"), review_id }],
      });
    expect(named("rev_0000000000000001")).toBeNull();
    expect(named("rev_0000000000000002")?.decided).toHaveLength(1);
  });

  it("delivers again on the same answers after a verified round and a stop", () => {
    const bundles = store();
    writeReview(bundles, makeReview({ decision: "escalate", findings: [forPerson] }), "2026-08-27T00:00:00.000Z");
    // The person handed it to the executor, the round closed it, and the run
    // then stopped short of the pull request: the base would not merge.
    const handed = { ...answer("2026-08-27T01:00:00.000Z"), choice: "approach" as const, note: "Round half-even." };
    writeVerification(
      bundles,
      { findings_given: forPerson.key, findings_open: "", head_commit: "fed4321" },
      "2026-08-27T02:00:00.000Z",
    );
    const again = decidedDelivery({ bundles, ticket_id: TICKET, repository_id: "repo_fixture", decided: [handed] });
    expect(again?.head_commit).toBe("fed4321");
    expect(again?.decided).toEqual([handed]);
    expect(again?.review.findings[0]).toMatchObject({ status: "resolved", outcome: "fixed" });
    expect(judgedOnRecord({ bundles, ticket_id: TICKET })?.head_commit).toBe("fed4321");
  });

  it("does not hand a finding a round verified closed to the executor again", () => {
    const bundles = store();
    const other = finding({ key: "f".repeat(64), rule_id: "product.copy", routing: "escalates", closure: "human" });
    writeReview(
      bundles,
      makeReview({ decision: "escalate", findings: [forPerson, other] }),
      "2026-08-27T00:00:00.000Z",
    );
    const handed = { ...answer("2026-08-27T01:00:00.000Z"), choice: "approach" as const };
    writeVerification(
      bundles,
      { findings_given: forPerson.key, findings_open: "", head_commit: "fed4321" },
      "2026-08-27T02:00:00.000Z",
    );
    const shipped = { ...answer("2026-08-27T03:00:00.000Z"), finding_key: other.key };
    expect(remediationToContinue({ bundles, ticket_id: TICKET, decided: [handed, shipped] })).toBeNull();
    expect(
      decidedDelivery({ bundles, ticket_id: TICKET, repository_id: "repo_fixture", decided: [handed, shipped] })
        ?.decided.map((row) => row.choice),
    ).toEqual(["approach", "ship_as_is"]);
  });

  it("delivers nothing on a review that could not judge every criterion", () => {
    const bundles = store();
    writeReview(
      bundles,
      makeReview({
        decision: "incomplete",
        findings: [forPerson],
        coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
      }),
      "2026-08-27T00:00:00.000Z",
    );
    expect(delivery(bundles, "2026-08-27T02:00:00.000Z")).toBeNull();
  });

  it("hands nothing to the executor, and delivers nothing, on an answer to a review that did not judge the whole change", () => {
    const handed = { ...answer("2026-08-27T02:00:00.000Z"), choice: "let_it_decide" as const };
    const afterReview = (decision: ReviewArtifact["decision"]) => {
      const bundles = store();
      writeReview(
        bundles,
        makeReview({
          decision,
          findings: [forPerson],
          ...(decision === "incomplete" ? { coverage: [{ criterion_id: "ac_1", status: "cannot_determine" as const }] } : {}),
          ...(decision === "error" ? { error: { kind: "provider_unavailable" as const } } : {}),
        }),
        "2026-08-27T00:00:00.000Z",
      );
      const input = { bundles, ticket_id: TICKET, decided: [handed] };
      return {
        continuing: remediationToContinue(input),
        delivered: decidedDelivery({ ...input, repository_id: "repo_fixture" }),
      };
    };
    for (const decision of ["incomplete", "error"] as const) {
      expect(afterReview(decision), decision).toEqual({ continuing: null, delivered: null });
    }
    // The same answer on a review that judged the whole change is handed on.
    expect(afterReview("changes_requested").continuing?.findings.map((row) => row.key)).toEqual([forPerson.key]);
  });
});

describe("the answers a finding takes", () => {
  it("follow the reviewer's own rule for the families it never routes to the executor", () => {
    for (const family of NEVER_HANDED_FAMILIES) expect(isRemediableFamily(`${family}.x`), family).toBe(false);
    for (const family of ["scope", "changeset", "check", "legibility", "criterion", "evidence"]) {
      expect(isRemediableFamily(`${family}.x`), family).toBe(true);
    }
  });
});
