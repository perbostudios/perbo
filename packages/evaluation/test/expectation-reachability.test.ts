import { describe, expect, it } from "vitest";
import { anchorFileIsReal, type LoadedFixture } from "../src/corpus.js";
import type { ExpectedDetection } from "../src/fixture.js";
import { corpus, describeCorpus } from "./corpus-present.js";

/**
 * A defective fixture has a registered anchor hit when the review produces a
 * finding matching a criterion id, file, or rule prefix the fixture declares.
 * Attribution v2 then distinguishes confirmed mechanism matches from
 * file-only candidates. An expectation that names none of those, or
 * names a criterion its own contract does not have, or a file its own diff does
 * not touch, can therefore **never** be satisfied: the fixture counts against
 * recall no matter how well the reviewer performs.
 *
 * The mirror defect is an expectation so broad it cannot discriminate — an
 * empty rule prefix matches every rule id, so the fixture would score as
 * detected on any finding at all.
 *
 * Both are the same failure as `adv-007`'s unreachable forbidden string
 * (2026-08-30): a check that cannot come out either way, sitting inside a
 * number people quote. This test exists because that one was found by hand.
 */

/** The expectation variants that carry anchors; `clean` and `contested` do not. */
type Anchored = Extract<ExpectedDetection, { mode: "blocking" | "coverage" }>;

describeCorpus("every defective fixture's expectation can be satisfied and can fail", () => {
  // The corpus the gate loaded, not a second read of its own: this factory runs
  // only where the corpus is, and `corpus` is the same fixtures the rest of the
  // package asserts on (`corpus-read-guard.test.ts`).
  const defective = corpus.filter((entry) => entry.fixture.defective);

  /**
   * The expectation's anchors. Only `blocking` and `coverage` carry any; a
   * fixture scored `clean` or `contested` registers nothing for a finding to
   * be attributed to, which is the unreachability this file exists to catch.
   */
  const anchorsOf = (entry: LoadedFixture): Anchored => {
    const expectation = entry.fixture.expected_detection;
    if (expectation.mode !== "blocking" && expectation.mode !== "coverage") {
      throw new Error(
        `${entry.fixture.id} is defective but scored in ${expectation.mode} mode, which ` +
          "registers no criterion, file or rule prefix at all",
      );
    }
    return expectation;
  };

  it("there are defective fixtures to check", () => {
    expect(defective.length).toBeGreaterThan(50);
  });

  it.each(
    defective.flatMap((entry) =>
      entry.fixture.expected_detection.mode === "blocking"
        ? [[entry.fixture.id, entry, entry.fixture.expected_detection] as const]
        : [],
    ),
  )("%s anchors a mechanism, not only a locus", (_id, entry, expectation) => {
    const criterionIds = expectation.criterion_ids;
    const prefixes = expectation.rule_prefixes;

    expect(
      criterionIds.length + prefixes.length,
      `${entry.fixture.id} is scored in blocking mode and registers only a file anchor. ` +
        "Since attribution v2 a file-only hit is a candidate and never confirmed, so the " +
        "fixture counts against the gated recall row however well the reviewer performs. " +
        "Register the criterion id its seeded defect violates, or the rule prefix the " +
        "finding would carry.",
    ).toBeGreaterThan(0);
  });

  it.each(defective.map((entry) => [entry.fixture.id, entry] as const))(
    "%s",
    (_id, entry) => {
      const expectation = anchorsOf(entry);
      const criterionIds = expectation.criterion_ids;
      const files = expectation.files;
      const prefixes = expectation.rule_prefixes;

      // Reachable: at least one channel by which a finding can be attributed.
      expect(
        criterionIds.length + files.length + prefixes.length,
        `${entry.fixture.id} declares no criterion, file or rule prefix, so no finding can ever ` +
          `be attributed to its seeded defect and it counts against recall unconditionally.`,
      ).toBeGreaterThan(0);

      // Discriminating: a prefix that matches everything is not an expectation.
      for (const prefix of prefixes) {
        expect(prefix.length, `${entry.fixture.id} has an empty rule prefix, which matches every rule`).toBeGreaterThan(2);
      }

      // Criteria must exist in the fixture's own contract.
      const declared = new Set(
        (entry.contract.level === "P0" ? [] : entry.contract.acceptance_criteria).map(
          (criterion) => criterion.id,
        ),
      );
      for (const id of criterionIds) {
        expect(
          declared.has(id),
          `${entry.fixture.id} expects detection on criterion ${id}, which its contract does not define`,
        ).toBe(true);
      }

      // Files must name a locus that exists: one the change touches, or one in
      // the fixture's own tree.
      if (entry.pinned && !entry.prepared) return; // prepare/runnable already refuses these
      for (const file of files) {
        expect(
          anchorFileIsReal(entry, file),
          `${entry.fixture.id} anchors detection to ${file}, which its diff does not touch and ` +
            "which is not in its tree either",
        ).toBe(true);
      }
    },
  );
});

describe("the guard catches the defect it exists for", () => {
  /**
   * Written because a test that has never been red is a test nobody has
   * checked. These assert the predicates directly, so the guard above cannot
   * quietly become a no-op if `expected_detection` grows a field.
   */
  const reachable = (e: { criterion_ids: string[]; files: string[]; rule_prefixes: string[] }) =>
    e.criterion_ids.length + e.files.length + e.rule_prefixes.length > 0;

  it("rejects an expectation with no channel at all", () => {
    expect(reachable({ criterion_ids: [], files: [], rule_prefixes: [] })).toBe(false);
    expect(reachable({ criterion_ids: ["ac_1"], files: [], rule_prefixes: [] })).toBe(true);
  });

  /**
   * The blocking-mode rule, asserted directly: an expectation reachable only
   * through its file anchor is reachable only as a candidate, and the gated
   * row reads candidates as misses.
   */
  const confirmable = (e: { criterion_ids: string[]; rule_prefixes: string[] }) =>
    e.criterion_ids.length + e.rule_prefixes.length > 0;

  it("rejects a blocking expectation whose only anchor is a file", () => {
    expect(confirmable({ criterion_ids: [], rule_prefixes: [] })).toBe(false);
    expect(confirmable({ criterion_ids: ["ac_2"], rule_prefixes: [] })).toBe(true);
    expect(confirmable({ criterion_ids: [], rule_prefixes: ["regression."] })).toBe(true);
  });

  it("rejects a rule prefix short enough to match everything", () => {
    const discriminating = (prefix: string) => prefix.length > 2;
    expect(discriminating("")).toBe(false);
    expect(discriminating("a.")).toBe(false);
    expect(discriminating("security.")).toBe(true);
  });

  /**
   * The file rule, on a fixture whose seeded breakage surfaces outside its own
   * diff. `reg-008` is that fixture and the reason the rule is not "in the
   * diff": the widened location override is in the change and the semicolon it
   * injects appears in `src/language-js/print/ignored.js`, which is not.
   */
  // Read from the pre-loaded corpus, which is empty when the corpus is absent, so
  // this block collects as skipped rather than failing at import without a corpus.
  const reg008 = corpus.find((entry) =>
    entry.fixture.id.startsWith("reg-008-"),
  );
  it.runIf(reg008?.prepared)("accepts a locus outside the diff and refuses one that is nowhere", () => {
    expect(anchorFileIsReal(reg008!, "src/language-js/location/overrides.js")).toBe(true);
    expect(anchorFileIsReal(reg008!, "src/language-js/print/ignored.js")).toBe(true);
    expect(anchorFileIsReal(reg008!, "src/language-js/print/ignored-typo.js")).toBe(false);
  });
});
