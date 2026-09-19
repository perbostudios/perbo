import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { corpus, corpusDir, corpusPresent, describeCorpus } from "./corpus-present.js";
import { matchesFilter, selectFixtures } from "../src/harness.js";

/**
 * The regression suite (docs/evaluation/regression-suite.md) is a fixed list of
 * thirty fixture ids that `perbo-corpus --suite regression` runs when the
 * reviewer prompt, the routing policy or the model changes. `--suite` is
 * applied as an exact-id filter through `matchesFilter`, so what is pinned here
 * is exactly what makes that selection honest: the file parses, every id
 * exists, there are thirty and no more, and the id list selects those thirty
 * and nothing else.
 */

const SUITE_PATH = resolve(corpusDir, "..", "regression-suite.json");
const suite = corpusPresent
  ? (JSON.parse(readFileSync(SUITE_PATH, "utf8")) as { name: string; fixtures: string[] })
  : { name: "", fixtures: [] };
const corpusIds = corpus.map((entry) => entry.fixture.id);
const sorted = (ids: readonly string[]) => [...ids].sort();

describeCorpus("the regression suite file", () => {
  it("is named and lists exactly thirty unique fixtures", () => {
    expect(suite.name).toBe("regression");
    expect(suite.fixtures).toHaveLength(30);
    expect(new Set(suite.fixtures).size).toBe(30);
  });

  it("names only fixtures that exist in the corpus", () => {
    const known = new Set(corpusIds);
    const unknown = suite.fixtures.filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  it("is ten reverted commits, ten adversarial/security/scope and ten clean drawn from merged commits", () => {
    const byPrefix = (prefixes: string[]) =>
      suite.fixtures.filter((id) => prefixes.some((prefix) => id.startsWith(prefix)));
    expect(byPrefix(["reg-"])).toHaveLength(10);
    expect(byPrefix(["adv-", "sec-", "scp-"])).toHaveLength(10);
    const clean = byPrefix(["cln-"]);
    expect(clean).toHaveLength(10);
    for (const id of clean) {
      const entry = corpus.find((candidate) => candidate.fixture.id === id)!;
      // Pinned, so cleanliness is a fact about the world; not contested, so a
      // stop is a result rather than a defensible disagreement (D-068).
      expect(entry.pinned, `${id} should pin a merged commit`).toBe(true);
      expect(entry.fixture.expected_detection.mode, `${id} should be clean`).toBe("clean");
    }
  });

  it("carries every secret-bearing fixture, so the credential bar has its whole population", () => {
    const secretBearing = corpus
      .filter((entry) => entry.fixture.forbidden_strings.length > 0)
      .map((entry) => entry.fixture.id);
    expect(secretBearing.length).toBeGreaterThan(0);
    for (const id of secretBearing) expect(suite.fixtures).toContain(id);
  });

  it("carries the fixture whose flip closed the launch gate on 2026-09-01", () => {
    expect(suite.fixtures.some((id) => id.startsWith("adv-006-"))).toBe(true);
  });
});

describeCorpus("--suite regression lists exactly the thirty", () => {
  // `--suite` becomes a comma filter of exact ids. That is only exact because
  // no fixture id is a substring of another; if a future id breaks that, this
  // is the test that says so before a suite run silently grows.
  it("rests on no fixture id being a substring of another", () => {
    for (const id of corpusIds) {
      const containers = corpusIds.filter((other) => other !== id && other.includes(id));
      expect(containers, `${id} is contained in ${containers.join(", ")}`).toEqual([]);
    }
  });

  it("selects the thirty and nothing else, prepared or not", () => {
    const filter = suite.fixtures.join(",");
    const { selected } = selectFixtures(corpus, filter, true);
    expect(sorted(selected.map((entry) => entry.fixture.id))).toEqual(sorted(suite.fixtures));
  });

  it("partitions the same thirty between the listing and the excluded-unprepared note", () => {
    // The dry listing prints `selected` as rows and `excluded_unprepared` by
    // name; together they must be the suite, whatever this machine has cached.
    const filter = suite.fixtures.join(",");
    const { selected, excluded_unprepared } = selectFixtures(corpus, filter);
    const listed = [...selected.map((entry) => entry.fixture.id), ...excluded_unprepared];
    expect(sorted(listed)).toEqual(sorted(suite.fixtures));
  });

  it("intersects with --filter rather than replacing it", () => {
    const intersection = suite.fixtures.filter((id) => matchesFilter(id, "reg-"));
    expect(intersection).toHaveLength(10);
    const { selected } = selectFixtures(corpus, intersection.join(","), true);
    expect(selected.map((entry) => entry.fixture.id).every((id) => id.startsWith("reg-"))).toBe(true);
    expect(selected).toHaveLength(10);
    // No overlap at all is a blank filter, which matches nothing rather than everything.
    expect(matchesFilter("reg-001-anything", suite.fixtures.filter(() => false).join(","))).toBe(false);
  });
});
