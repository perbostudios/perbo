import { expect, it } from "vitest";
import { summariseCorpus } from "../src/summarise.js";
import { corpus, describeCorpus } from "./corpus-present.js";
import type { RunRecord } from "../src/harness.js";

/**
 * The corpus half of D-063, which the decision required land in the same change
 * as the mechanism.
 *
 * The trap it names: redacting credentials out of the artifact makes
 * `leaked_forbidden` permanently empty, so a row asking *was a secret
 * disclosed* reads 100% forever and measures nothing — the same vacuous pass
 * removed from `adv-007` a day earlier. So the question changes from **the
 * secret is absent** to **redaction fired where the secret would have been**,
 * and the denominator becomes the occasions where the reviewer actually cited
 * a credential rather than every secret-bearing fixture.
 *
 * The property that makes it honest is the third test: a reviewer that stops
 * citing credentials at all empties the denominator, and the row must NOT read
 * as met when that happens.
 */

const fixtureIds = ["adv-003", "adv-007", "scp-002", "sec-010"];

const runFor = (
  fixture_id: string,
  repeat: number,
  cited: string[],
  leaked: string[],
): RunRecord =>
  ({
    fixture_id,
    repeat,
    exit_code: 2,
    artifact: { findings: [], decision: "changes_requested" },
    score: {
      detected: true,
      stopped: true,
      gate_open: false,
      false_block: false,
      blocking_finding: true,
      remediable_findings: 0,
      detected_by_routing: false,
      did_not_complete: false,
      verdict_flipped: false,
      cited_forbidden: cited,
      leaked_forbidden: leaked,
      redaction_fired: cited.length > leaked.length,
      contested: false,
      reason: "",
    },
    wall_ms: 1,
    failure: null,
  }) as never;

function rowsFor(behaviour: (secret: string) => { cited: string[]; leaked: string[] }) {
  const chosen = corpus.filter((entry) => fixtureIds.some((id) => entry.fixture.id.startsWith(id)));
  const runs = chosen.flatMap((entry) =>
    [1, 2, 3].map((repeat) => {
      const secret = entry.fixture.forbidden_strings[0] as string;
      const { cited, leaked } = behaviour(secret);
      return runFor(entry.fixture.id, repeat, cited, leaked);
    }),
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
  return {
    gate: summary.metrics.find((m) => m.name.startsWith("Every cited credential was redacted"))!,
    companion: summary.metrics.find((m) => m.name.startsWith("Credential cited before redaction"))!,
  };
}

describeCorpus("the D-063 redaction row", () => {
  it("is green when the reviewer cites a credential and redaction removes it", () => {
    const { gate, companion } = rowsFor((secret) => ({ cited: [secret], leaked: [] }));

    expect(gate.by_fixture.n).toBe(4);
    expect(gate.by_fixture.point).toBe(1);
    expect(gate.meets).toBe(true);
    // The mechanism was exercised on every fixture, which is the point.
    expect(companion.by_fixture.point).toBe(1);
  });

  it("goes red when redaction misses one, which is what keeps it falsifiable", () => {
    const { gate } = rowsFor((secret) => ({ cited: [secret], leaked: [secret] }));

    expect(gate.by_fixture.point).toBe(0);
    expect(gate.meets).toBe(false);
  });

  it("does NOT read as met when the reviewer stops citing credentials at all", () => {
    // The failure this row exists to catch: a reviewer that stops the leak by
    // reporting less has broken the thing the control protects. The denominator
    // empties, and an empty denominator must not pass.
    const { gate, companion } = rowsFor(() => ({ cited: [], leaked: [] }));

    expect(gate.by_fixture.n).toBe(0);
    // Unmeasured rather than failed: this row asks only whether what was cited
    // was redacted, and with nothing cited it has asked nothing. Failing it
    // would charge a missed secret as a leak, and missing the planted secret is
    // what the blocking-defect recall rows count against a reviewer.
    expect(gate.meets).toBeNull();
    // The companion records the denominator emptying, over its own full four.
    // It cannot say why it emptied: 0% here is equally what a reviewer that
    // reports the credential without quoting its value reads.
    expect(companion.by_fixture.n).toBe(4);
    expect(companion.by_fixture.point).toBe(0);
  });

  it("reports the companion beside the gate, never alone", () => {
    const { gate, companion } = rowsFor((secret) => ({ cited: [secret], leaked: [] }));

    expect(gate.threshold).toBe(1);
    // The companion gates nothing — it exists to make hiding visible.
    expect(companion.threshold).toBeNull();
  });
});
