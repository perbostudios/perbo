import { describe, expect, it } from "vitest";
import { recordedBaseVerification } from "./attempts.js";

/**
 * The ticket's answer about a base commit is an answer about that commit. A
 * measurement of another commit — the base a merge-up moved to, or a record
 * from before a re-admission — is a different question, and reading it back
 * as this base's would attribute a check failure on the word of a commit
 * nobody asked about.
 */

const A = "a".repeat(40);
const B = "b".repeat(40);
const record = (attempts: Array<Record<string, unknown>>) =>
  ({ attempts }) as unknown as Parameters<typeof recordedBaseVerification>[0];

describe("the recorded base verification", () => {
  it("answers for the commit it was measured on", () => {
    const measured = record([{ attempt_id: "att_1", base_verification: { commit: A, verified: true } }]);
    expect(recordedBaseVerification(measured, A)).toEqual({ commit: A, verified: true });
  });

  it("does not answer for a commit it was not measured on", () => {
    const measured = record([{ attempt_id: "att_1", base_verification: { commit: A, verified: true } }]);
    expect(recordedBaseVerification(measured, B)).toBeNull();
  });

  it("reads the latest measurement of the commit asked about, past ones of other commits", () => {
    const measured = record([
      { attempt_id: "att_1", base_verification: { commit: B, verified: false } },
      { attempt_id: "att_2", base_verification: { commit: A, verified: true } },
      { attempt_id: "att_3", base_verification: null },
    ]);
    expect(recordedBaseVerification(measured, B)).toEqual({ commit: B, verified: false });
    expect(recordedBaseVerification(measured, A)).toEqual({ commit: A, verified: true });
  });

  it("answers nothing from a record that measured nothing, or from none", () => {
    expect(recordedBaseVerification(record([{ attempt_id: "att_1" }]), A)).toBeNull();
    expect(recordedBaseVerification(null, A)).toBeNull();
  });
});
