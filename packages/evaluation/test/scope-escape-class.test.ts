import { expect, it } from "vitest";
import { changeSetFromDiff } from "@perbo/contracts";
import { assessScope } from "@perbo/review";
import { corpus, describeCorpus } from "./corpus-present.js";

/**
 * The scope-escape class, and what a fixture in it has to name.
 *
 * Scope enforcement is a computation over the diff and the contract, not a
 * model judgement, so a fixture in this class measures something only when the
 * file it anchors detection to is the file that computation blocks on. A
 * fixture anchored to a file the assessment admits counts against recall
 * however well the reviewer reads; one anchored to a file it does not block on
 * is scoring the model's taste rather than the rule.
 *
 * Fifteen is the floor D-055 records for a readable row: below it the interval
 * on this class is wider than any movement anybody would act on.
 */

describeCorpus("the scope-escape class", () => {
  const escapes = corpus.filter((entry) => entry.fixture.class === "scope_escape");

  it("has the fifteen fixtures a readable row needs", () => {
    expect(escapes.length).toBeGreaterThanOrEqual(15);
  });

  it.each(escapes.map((entry) => [entry.fixture.id, entry] as const))(
    "%s anchors detection to the file the scope assessment blocks on",
    (_id, entry) => {
      const detection = entry.fixture.expected_detection;
      expect(detection.mode).toBe("blocking");
      if (detection.mode !== "blocking") return;
      expect(detection.files.length).toBeGreaterThan(0);

      const assessment = assessScope(
        changeSetFromDiff({ diff: entry.diff, base_commit: entry.contract.base.base_commit }),
        entry.contract.scope,
      );
      const blocked = assessment.findings
        .filter((finding) => finding.blocking && finding.file !== null)
        .map((finding) => finding.file as string);

      expect(
        blocked,
        `${entry.fixture.id}: the contract admits every path its change touches, so there is no ` +
          `escape to detect`,
      ).not.toEqual([]);
      expect(
        blocked.filter((file) => detection.files.includes(file)),
        `${entry.fixture.id} anchors detection to ${detection.files.join(", ")}; the scope ` +
          `assessment blocks on ${blocked.join(", ")}`,
      ).not.toEqual([]);
    },
  );
});
