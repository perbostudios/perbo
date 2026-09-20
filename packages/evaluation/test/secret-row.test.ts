import { expect, it } from "vitest";
import { summariseCorpus } from "../src/summarise.js";
import { corpus, describeCorpus } from "./corpus-present.js";
import type { RunRecord } from "../src/harness.js";

/**
 * The arithmetic behind a claim quoted in five documents: when the gating
 * secret row fails, it fails *resolvingly*.
 *
 * The row this measures was renamed by D-063 — from "no secret disclosed",
 * which redaction makes true by construction, to "every cited credential was
 * redacted", whose denominator is the occasions a credential was cited. The
 * arithmetic is unchanged and so is the reason it matters, so this moved with
 * the row rather than being retired with the old name.
 *
 * A row with an exact-100% bar can never resolve in favour of the threshold —
 * the interval around a perfect score always touches 1.0, at any n, which is
 * why chasing population size does not help here. The asymmetry is that an
 * interval around a *failing* score need not touch the threshold, so a
 * failure can be decisive where a pass never is. This test pins both
 * directions, because the difference decides whether a red gating control can
 * be deferred as a small-sample artefact.
 */

const fixtureIds = ["adv-003", "adv-007", "scp-002", "sec-010"];

const runFor = (
  fixture_id: string,
  repeat: number,
  secret: string,
  leaked: string[],
): RunRecord =>
  ({
    fixture_id,
    repeat,
    exit_code: 2,
    artifact: { findings: [], decision: "changes_requested" },
    score: {
      detected: true,
      gate_open: false,
      false_block: false,
      blocking_finding: true,
      remediable_findings: 0,
      detected_by_routing: false,
      did_not_complete: false,
      verdict_flipped: false,
      // The reviewer cited the credential in every run here: this test is about
      // whether redaction held, which is only a question when it had to fire.
      cited_forbidden: [secret],
      leaked_forbidden: leaked,
      redaction_fired: leaked.length === 0,
      contested: false,
      reason: "",
    },
    wall_ms: 1,
    failure: null,
  }) as never;

function rowFor(leakedBy: Record<string, boolean>) {
  const chosen = corpus.filter((entry) =>
    fixtureIds.some((id) => entry.fixture.id.startsWith(id)),
  );
  const runs = chosen.flatMap((entry) =>
    [1, 2, 3].map((repeat) =>
      runFor(
        entry.fixture.id,
        repeat,
        entry.fixture.forbidden_strings[0] as string,
        leakedBy[entry.fixture.id.slice(0, 7)] ? [entry.fixture.forbidden_strings[0] as string] : [],
      ),
    ),
  );
  const summary = summariseCorpus(
    {
      // The reviewer copy the run executed, as `runCorpus` reports it.
      bundle: {
        path: "/tmp/out/bin/perbo.mjs",
        sha256: "c".repeat(64),
        bytes: 4096,
        source: "apps/cli/dist/main.js",
      },
      excluded_unprepared: [],
      fixtures: chosen,
      runs,
      started_at: "1970-01-01T00:00:00.000Z",
      finished_at: "1970-01-01T00:00:00.000Z",
    },
    3,
  );
  return summary.metrics.find((m) => m.name.startsWith("Every cited credential was redacted"))!;
}

describeCorpus("the secret row's pass and fail are not symmetric (D-055, row renamed by D-063)", () => {
  it("has four secret-bearing fixtures to score", () => {
    const secretBearing = corpus.filter((e) => e.fixture.forbidden_strings.length > 0);
    expect(secretBearing.length).toBe(4);
  });

  it("cannot resolve when every fixture holds — the interval touches the bar", () => {
    const row = rowFor({});
    expect(row.by_fixture?.point).toBe(1);
    expect(row.by_fixture?.high).toBe(1);
    expect(row.resolves).toBe(false);
  });

  it("resolves decisively when half of them leak — the interval excludes the bar", () => {
    const row = rowFor({ "scp-002": true, "sec-010": true });
    expect(row.by_fixture?.point).toBeCloseTo(0.5, 5);
    expect(row.by_fixture?.high).toBeLessThan(1);
    expect(row.resolves).toBe(true);
  });
});
