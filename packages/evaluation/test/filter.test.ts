import { describe, expect, it } from "vitest";
import { sample, SAMPLE_AUTHORED_IDS } from "./sample-fixtures.js";
import { matchesFilter, selectFixtures } from "../src/harness.js";

/**
 * `--filter` accepts comma-separated alternatives, because a run over a named
 * population — the four secret-bearing fixtures, the drivable SCP-112 set — is
 * one run with one runs.json and one report, not four runs whose rows have to
 * be recombined by hand.
 *
 * `matchesFilter` owns the whole no-filter semantic, so the dry listing and
 * the run cannot disagree about a population: null/undefined means no filter
 * (match all), and a blank filter matches NOTHING — a mangled shell variable
 * (`--filter "$F"` with F unset) must read as zero fixtures everywhere, never
 * as the whole corpus on one path and zero on the other.
 */
describe("matchesFilter", () => {
  it("matches a plain substring, as before", () => {
    expect(matchesFilter("sec-010-signing-key", "sec-010")).toBe(true);
    expect(matchesFilter("sec-010-signing-key", "cln-")).toBe(false);
  });

  it("matches any of a comma-separated list", () => {
    expect(matchesFilter("scp-002-committed-env", "sec-010,scp-002")).toBe(true);
    expect(matchesFilter("adv-003-injection", "sec-010,scp-002")).toBe(false);
  });

  it("matches everything when no filter was given", () => {
    expect(matchesFilter("anything", null)).toBe(true);
    expect(matchesFilter("anything", undefined)).toBe(true);
  });

  it("matches nothing on a blank filter, so a mangled shell variable stays loud", () => {
    expect(matchesFilter("anything", "")).toBe(false);
    expect(matchesFilter("anything", " ")).toBe(false);
    expect(matchesFilter("anything", ",,")).toBe(false);
  });
});

/**
 * The one selection both the dry listing and `runCorpus` use, so the "makes N
 * model calls" count and the spend can never diverge — neither on the filter
 * nor on the pinned-but-unprepared exclusion.
 */
describe("selectFixtures", () => {
  type Entry = { fixture: { id: string }; prepared: boolean };
  const entries = [
    { fixture: { id: "aaa-authored" }, prepared: true },
    { fixture: { id: "bbb-pinned-cached" }, prepared: true },
    { fixture: { id: "ccc-pinned-uncached" }, prepared: false },
  ] as Entry[] as never[];

  it("partitions unprepared fixtures out and names them", () => {
    const { selected, excluded_unprepared } = selectFixtures(entries, null);
    expect(selected.map((e) => e.fixture.id)).toEqual([
      "aaa-authored",
      "bbb-pinned-cached",
    ]);
    expect(excluded_unprepared).toEqual(["ccc-pinned-uncached"]);
  });

  it("applies the filter before the prepared split", () => {
    const { selected, excluded_unprepared } = selectFixtures(entries, "ccc");
    expect(selected).toEqual([]);
    expect(excluded_unprepared).toEqual(["ccc-pinned-uncached"]);
  });

  it("keeps unprepared fixtures only when explicitly asked", () => {
    const { selected, excluded_unprepared } = selectFixtures(entries, null, true);
    expect(selected.length).toBe(3);
    expect(excluded_unprepared).toEqual([]);
  });

  it("holds on the published sample: authored fixtures are always selectable", () => {
    // Floor on the authored count (AGENTS.md): pinned fixtures may lack a
    // cache on this machine, authored ones never do.
    const { selected } = selectFixtures(sample as never[], null);
    const authored = selected.filter((e) => e.pinned === false);
    expect(authored.length).toBeGreaterThanOrEqual(SAMPLE_AUTHORED_IDS.length);
  });
});
