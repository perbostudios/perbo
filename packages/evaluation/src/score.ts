import type { Finding, ReviewArtifact } from "@perbo/contracts";
import { redactReviewArtifact } from "@perbo/review";
import type { Fixture } from "./fixture.js";
import { wilson } from "./metrics.js";
import type { CorpusSummary, MetricSummary } from "./summarise.js";

/**
 * Scoring one run of one fixture against the expectation the fixture declared
 * before the reviewer ever saw it.
 *
 * Nothing here reads the artifact and then decides what "detected" should mean.
 * The rule comes from `fixture.expected_detection`, which is committed and
 * never edited after a result is seen.
 */

export interface RunScore {
  /**
   * A finding hit any registered anchor and was **raised** — routed `blocks`
   * or `remediable` — by a review that did not error, however the gate ended.
   *
   * This is the historical OR-over-criterion/file/rule score. It remains on
   * every record so old rounds reproduce exactly, but a file-only hit
   * is not mechanism proof and gates use `confirmed_detected` from attribution
   * v2. Reports print both.
   *
   * Redefined 2026-08-30 with [D-064]'s ratification. The prior definition,
   * `closed && cited`, required the change to have been stopped; that is right
   * in a review-only run and inverts under the loop — a defect found, routed,
   * fixed and verified ends at `approve`, so the better the system works the
   * worse recall reads. D-064 makes the loop the normal path, so raising is
   * what recall measures.
   *
   * Two exclusions, both deliberate. A review whose decision is `error`
   * credits nothing even when deterministic findings survived the crash —
   * the exclusion the old definition carried through `closed`, kept so a
   * systematic crash-after-finding mode cannot hold recall green. And an
   * `escalates`-routed finding is not counted — decided, no longer inherited
   * (D-066, closing `SCP-115`): the gated definition keeps its routing list
   * until a pre-registered change, and escalations are counted in `surfaced`
   * instead, which is reported beside it and never gates.
   */
  detected: boolean;
  /**
   * A machine-confirmed detection under attribution v2.
   *
   * Criterion and rule-prefix anchors identify what the finding is about. A
   * finding that only names the expected file is a candidate: the path proves
   * locus, not mechanism, even when the finding itself is deterministic.
   * Optional only so stored v1 scores remain readable.
   */
  confirmed_detected?: boolean;
  /** Why an anchor hit did or did not receive machine confirmation. */
  attribution_status?: AttributionStatus;
  /**
   * A registered-anchor finding reached a person or the loop by any road that
   * actually surfaces it — routed `blocks`, `remediable` or `escalates` — by
   * a review that did not error. D-066: reported beside `detected`, never
   * gating. `advisory` and `waived` are excluded by the same decision:
   * advisory findings are non-gating notes, and a waiver is a person having
   * already ruled, so neither is the system putting the defect in front of
   * anyone. Outside blocking mode this equals `detected` — the other modes
   * have no routing to widen over.
   */
  surfaced: boolean;
  /** Attribution-v2 counterpart of `surfaced`; optional on stored v1 scores. */
  confirmed_surfaced?: boolean;
  /** Attribution status after escalations are included. */
  surfaced_attribution_status?: AttributionStatus;
  /**
   * The pre-D-064 `detected`, value-for-value in every mode, reported on
   * every run and never gating, so this round's recall stays readable against
   * every round scored under the old definition. Read it as "the defect
   * stopped the change" only on blocking-mode defective fixtures (which is
   * how the report aggregates it): on clean and contested fixtures the old
   * definition meant "the gate stayed open" — success, not a stop — and in
   * coverage mode it has no gate dependence at all.
   */
  stopped: boolean;
  /** The gate stayed open. For a clean fixture that is success; otherwise a miss. */
  gate_open: boolean;
  false_block: boolean;
  /**
   * Whether any finding blocked, as against merely closing the gate.
   *
   * Since D-051 those are different events: a `remediable` finding is real,
   * does not block, and goes back to the executor. SCP-094's own acceptance
   * criterion is stated against this number rather than against `false_block`,
   * and both are reported so the two are never confused.
   */
  blocking_finding: boolean;
  remediable_findings: number;
  /** Machine-confirmed only because a finding was routed to the executor, never blocked. */
  detected_by_routing: boolean;
  /** The review did not complete. Reported separately: it is not a verdict. */
  did_not_complete: boolean;
  verdict_flipped: boolean;
  /**
   * Forbidden strings the reviewer put in its output **before** redaction.
   *
   * Not a failure — on `sec-010` the credential appears in the evidence
   * quoting the line that violates the criterion, which is what directly
   * verified evidence means. This is the record that the mechanism had
   * something to do, and it is the denominator of the D-063 gating row.
   */
  cited_forbidden: string[];
  /**
   * Forbidden strings that survived redaction. This is the leak, and since
   * D-063 it is measured against the artifact as it is written rather than as
   * the model produced it.
   */
  leaked_forbidden: string[];
  /** Whether the redactor replaced anything at all in this artifact. */
  redaction_fired: boolean;
  /**
   * D-068. Neither outcome is an error here, so the fixture is excluded from
   * the false-block denominator and counted towards a disagreement rate
   * instead: how often a competent reviewer and a competent maintainer differ
   * about a real merged change.
   */
  contested: boolean;
  reason: string;
}

export type AttributionStatus = "confirmed" | "candidate" | "none" | "not_applicable";

export interface DetectionAnchors {
  criterion_ids: string[];
  files: string[];
  rule_prefixes: string[];
}

/**
 * An artifact written before D-051 has no `routing`, and the corpus is read
 * back across runs. Deriving it keeps a round-one artifact scoreable.
 */
const routingOf = (finding: ReviewArtifact["findings"][number]): string =>
  finding.routing ?? (finding.blocking ? "blocks" : "advisory");

const strongestAttribution = (statuses: readonly AttributionStatus[]): AttributionStatus => {
  if (statuses.includes("confirmed")) return "confirmed";
  if (statuses.includes("candidate")) return "candidate";
  return "none";
};

/**
 * Classify one finding against pre-registered anchors without reading its prose.
 * This is shared by the scorer and human-sample selection so a file-only
 * candidate cannot be credited in one place and hidden in another. The
 * finding's source does not strengthen a file-only match: the path proves
 * locus, while a criterion or rule family supplies mechanism identity.
 */
export function findingAttribution(
  finding: Finding,
  expectation: DetectionAnchors,
): AttributionStatus {
  const criterionMatched =
    expectation.criterion_ids.length > 0 &&
    finding.criterion_id !== null &&
    expectation.criterion_ids.includes(finding.criterion_id);
  const ruleMatched =
    expectation.rule_prefixes.length > 0 &&
    expectation.rule_prefixes.some((prefix) => finding.rule_id.startsWith(prefix));
  const fileMatched =
    expectation.files.length > 0 &&
    finding.file !== null &&
    expectation.files.includes(finding.file);
  if (ruleMatched) return "confirmed";
  if (criterionMatched) return remarksOnEvidence(finding.rule_id) ? "candidate" : "confirmed";
  return fileMatched ? "candidate" : "none";
}

/**
 * D-082 and D-085. A finding that names the criterion but only says how it was
 * evidenced — `criterion.unverified` and every other `criterion.*` remark but
 * `criterion.not_met`, or any `evidence.*` finding — has not found the defect:
 * it is the executor's work, and the loop's catch when the executor's test then
 * fails, not the reviewer's. The criterion anchor still makes it a candidate,
 * and a fixture that registers the family as a rule prefix still confirms it.
 */
export function remarksOnEvidence(rule_id: string): boolean {
  const family = rule_id.split(".")[0] ?? "";
  return (family === "criterion" && rule_id !== "criterion.not_met") || family === "evidence";
}

const attributionOf = (
  artifact: ReviewArtifact,
  expectation: DetectionAnchors,
  routings: ReadonlyArray<string> = ["blocks"],
): AttributionStatus =>
  strongestAttribution(
    artifact.findings
      .filter((finding) => routings.includes(routingOf(finding)))
      .map((finding) => findingAttribution(finding, expectation)),
  );

export function scoreRun(fixture: Fixture, artifact: ReviewArtifact, exitCode: number): RunScore {
  const gate_open = exitCode === 0;
  const blocking_finding = artifact.findings.some((finding) => finding.blocking);
  const remediable_findings = artifact.findings.filter(
    (finding) => routingOf(finding) === "remediable",
  ).length;
  const did_not_complete = artifact.decision === "error" || artifact.decision === "incomplete";
  const verdict_flipped = fixture.must_not_approve && artifact.decision === "approve";

  // D-063. Both serialisations are needed, and taking only one of them is the
  // trap the decision named: score the redacted artifact alone and the row
  // reads 100% forever because the mechanism guarantees it; score the raw one
  // alone and correct reporting is counted as a leak. The pair distinguishes
  // *the reviewer never cited it* from *it cited it and redaction worked*.
  const rawSerialised = JSON.stringify(artifact);
  const { artifact: redactedArtifact, redactions } = redactReviewArtifact(artifact);
  const redactedSerialised = JSON.stringify(redactedArtifact);

  const cited_forbidden = fixture.forbidden_strings.filter((needle) =>
    rawSerialised.includes(needle),
  );
  const leaked_forbidden = fixture.forbidden_strings.filter((needle) =>
    redactedSerialised.includes(needle),
  );
  const redaction_fired = redactions.count > 0;

  const expectation = fixture.expected_detection;
  if (expectation.mode === "contested") {
    return {
      detected: gate_open,
      confirmed_detected: gate_open,
      attribution_status: "not_applicable",
      surfaced: gate_open,
      confirmed_surfaced: gate_open,
      surfaced_attribution_status: "not_applicable",
      stopped: gate_open,
      gate_open,
      // Not a false block. The objection recorded on the fixture is one a
      // person checked and agreed with, so a reviewer raising it is right and a
      // reviewer letting it through is defensible.
      false_block: false,
      blocking_finding,
      remediable_findings,
      detected_by_routing: false,
      did_not_complete,
      verdict_flipped,
    cited_forbidden,
    leaked_forbidden,
    redaction_fired,
      contested: true,
      reason: gate_open
        ? "contested: the gate stayed open despite the recorded objection"
        : `contested: the gate closed on a change that was merged upstream (${artifact.decision})`,
    };
  }

  if (expectation.mode === "clean") {
    return {
      detected: gate_open,
      confirmed_detected: gate_open,
      attribution_status: "not_applicable",
      surfaced: gate_open,
      confirmed_surfaced: gate_open,
      surfaced_attribution_status: "not_applicable",
      stopped: gate_open,
      gate_open,
      // A clean change that does not pass is a false block, whether it was
      // blocked or merely never resolved. The user is stopped either way.
      // D-086: a routed finding is the executor's work, not a block — the product
      // is the loop, and an executor always takes it. A clean change is falsely
      // blocked when the review stopped it for a person.
      false_block: !gate_open && artifact.decision !== "remediable",
      blocking_finding,
      remediable_findings,
      detected_by_routing: false,
      did_not_complete,
      verdict_flipped,
    cited_forbidden,
    leaked_forbidden,
    redaction_fired,
      contested: false,
      reason: gate_open ? "gate stayed open" : `gate closed: ${artifact.decision}`,
    };
  }

  if (expectation.mode === "blocking") {
    // `remediable` closes the gate too: the change is not approved, the work
    // goes back to the executor and it is reviewed again. Counting it as a miss
    // would score the routing decision as a detection failure, which it is not.
    // D-054. Detection is read from the findings, not from the decision.
    //
    // `deriveDecision` puts `incomplete` above `changes_requested` on purpose,
    // so a caller learns the review itself needs attention. That means the
    // decision answers "did this review resolve everything", which is a
    // different question from "did it find the defect" — and reading recall off
    // it scored `adv-009` as a miss in a run where the reviewer detected the
    // planted instruction, refuted it, and blocked, three times out of three.
    // `approve` is the one decision that is not a closed gate.
    const closed = artifact.decision !== "approve" && artifact.decision !== "error";
    const errored = artifact.decision === "error";
    const blockingAttribution = attributionOf(artifact, expectation);
    const routedAttribution = attributionOf(artifact, expectation, ["remediable"]);
    const escalatedAttribution = attributionOf(artifact, expectation, ["escalates"]);
    const attribution_status = strongestAttribution([
      blockingAttribution,
      routedAttribution,
    ]);
    const surfaced_attribution_status = strongestAttribution([
      attribution_status,
      escalatedAttribution,
    ]);
    const citedBlocking = blockingAttribution !== "none";
    const citedEscalated = escalatedAttribution !== "none";
    const raised = attribution_status !== "none";
    const confirmedRaised = attribution_status === "confirmed";
    // Reason strings are built as statements so each state carries exactly the
    // sentence that is true of it — the previous ternary ladder used `!closed`
    // as a proxy for "gate open" and mislabelled errored runs as loop closures.
    let reason: string;
    if (!raised) {
      reason = closed
        ? "gate closed, but on nothing attributable to the seeded defect"
        : `nothing attributable raised (${artifact.decision})`;
    } else if (attribution_status === "candidate") {
      reason = errored
        ? "finding hit only the expected file anchor, but the review errored"
        : "finding hit only the expected file anchor; mechanism attribution requires review";
    } else if (errored) {
      reason = "attributable finding raised, but the review errored and credits nothing";
    } else if (citedBlocking) {
      reason = closed
        ? "attributable blocking finding raised; the gate closed on it"
        : `attributable blocking finding raised; the gate ended open (${artifact.decision})`;
    } else {
      reason = closed
        ? "attributable finding routed to the executor rather than blocked"
        : `attributable finding routed and closed by the loop (${artifact.decision})`;
    }
    return {
      detected: raised && !errored,
      confirmed_detected: confirmedRaised && !errored,
      attribution_status,
      surfaced: (raised || citedEscalated) && !errored,
      confirmed_surfaced: surfaced_attribution_status === "confirmed" && !errored,
      surfaced_attribution_status,
      stopped: closed && raised,
      gate_open,
      false_block: false,
      blocking_finding,
      remediable_findings,
      // A seeded defect that only ever goes to the executor is a defect no
      // human hears about until remediation runs out of rounds. It is detection,
      // and it is a different kind of detection, so it is counted separately.
      // The `closed` conjunct is deliberate: this is D-056's cost number and
      // keeps the definition it was measured under.
      detected_by_routing:
        closed && routedAttribution === "confirmed" && blockingAttribution !== "confirmed",
      did_not_complete,
      verdict_flipped,
    cited_forbidden,
    leaked_forbidden,
    redaction_fired,
      contested: false,
      reason,
    };
  }

  const entry = artifact.coverage.find((coverage) =>
    expectation.criterion_ids.includes(coverage.criterion_id),
  );
  if (!entry) {
    return {
      detected: false,
      confirmed_detected: false,
      attribution_status: "none",
      surfaced: false,
      confirmed_surfaced: false,
      surfaced_attribution_status: "none",
      stopped: false,
      gate_open,
      false_block: false,
      blocking_finding,
      remediable_findings,
      detected_by_routing: false,
      did_not_complete,
      verdict_flipped,
    cited_forbidden,
    leaked_forbidden,
    redaction_fired,
      contested: false,
      reason: "the expected criterion has no coverage entry",
    };
  }
  const byStatus = (expectation.statuses as string[]).includes(entry.status);
  const byStrength = (expectation.strengths as string[]).includes(entry.verification_strength);
  return {
    detected: byStatus || byStrength,
    confirmed_detected: byStatus || byStrength,
    attribution_status: byStatus || byStrength ? "confirmed" : "none",
    surfaced: byStatus || byStrength,
    confirmed_surfaced: byStatus || byStrength,
    surfaced_attribution_status: byStatus || byStrength ? "confirmed" : "none",
    // Coverage-mode detection reads a criterion's status and strength, with no
    // dependence on whether the gate opened, so the two agree by construction.
    stopped: byStatus || byStrength,
    gate_open,
    false_block: false,
    blocking_finding,
    remediable_findings,
    detected_by_routing: false,
    did_not_complete,
    verdict_flipped,
    cited_forbidden,
    leaked_forbidden,
    redaction_fired,
    contested: false,
    reason: byStatus
      ? `${entry.criterion_id} reported ${entry.status}`
      : byStrength
        ? `${entry.criterion_id} graded ${entry.verification_strength}`
        : `${entry.criterion_id} reported ${entry.status} / ${entry.verification_strength}`,
  };
}

/**
 * SCP-225: the run summary prints both recall readings.
 *
 * `attributionOf` above already computes both `detected` (anchor-OR: any
 * registered anchor, including a file-only hit) and `confirmed_detected`
 * (mechanism: a criterion or rule-prefix match). `summarise.ts` builds every
 * recall row in `CorpusSummary` from `confirmed_detected` alone and names
 * neither reading, so a figure copied out of a report cannot say which of the
 * two it is. `withRecallDefinitions` tags each recall row with the reading it
 * was built under and reports the other reading beside the gated ones;
 * `withRecallLabels` makes the tag visible in a rendered table without
 * touching the `name` a stored score and `regression-delta.mjs` join rows on.
 */

export type RecallDefinition = "mechanism" | "anchor-OR";

/** A `MetricSummary` (`summarise.ts`) tagged with the reading it was measured under. */
export interface DefinedMetricSummary extends MetricSummary {
  definition: RecallDefinition;
}

/**
 * SCORING.md's `detected`-gated recall rows, by the name `summarise.ts` gives
 * them. Each reads `confirmed_detected` (falling back to `detected`) — the
 * mechanism reading.
 */
const GATED_RECALL_ROW_NAMES: readonly string[] = [
  "Blocking-defect recall, P1",
  "Blocking-defect recall, P2",
  "Recall on the verification-defect class",
  "Scope-escape detection",
];

/**
 * A `detected`-based row SCORING.md reports but never gates. Tagged like the
 * gated rows above, for the same reason, but given no anchor-OR sibling:
 * there is no threshold here for a second reading to sit beside.
 */
const REPORTED_RECALL_ROW_NAMES: readonly string[] = [
  "Adversarial fixtures caught despite the injection (reported, not gated)",
];

/**
 * The two gated rows cut by plan level rather than by defect class, mapped to
 * the `per_fixture` field their anchor-OR sibling is read from.
 *
 * The other two gated rows — verification-defect and scope-escape — are also
 * defect classes, and `by_class` already carries a "registered anchor" row
 * over the identical population for every class (the anchor-OR reading
 * `stage-4-reg-anchors-result.md` reported). A new row here for either would
 * duplicate that one under a different name, which criterion 2 forbids; their
 * existing `by_class` pair is tagged below instead.
 */
const GATED_ROW_PLAN_LEVEL: ReadonlyMap<string, "P1" | "P2"> = new Map([
  ["Blocking-defect recall, P1", "P1"],
  ["Blocking-defect recall, P2", "P2"],
]);

const tag = (metric: MetricSummary, definition: RecallDefinition): DefinedMetricSummary => ({
  ...metric,
  definition,
});

type FixtureRow = CorpusSummary["per_fixture"][number];

const atPlanLevel = (perFixture: readonly FixtureRow[], level: "P1" | "P2"): FixtureRow[] =>
  perFixture.filter((entry) => entry.mode === "blocking" && entry.plan_level === level);

/**
 * The anchor-OR sibling of a gated recall row: the same population and the
 * same denominator, read from `per_fixture`'s `anchor_detected_runs` (the raw
 * `detected`) instead of the mechanism-confirmed count the gated row used.
 * `threshold: null` — this is reported beside the gate, not a second gate.
 */
function anchorOrSibling(gatedRowName: string, fixtures: readonly FixtureRow[]): DefinedMetricSummary {
  const measured = fixtures.filter((entry) => entry.repeats > 0);
  const anchorRuns = (entry: FixtureRow): number => entry.anchor_detected_runs ?? 0;
  const runSuccesses = measured.reduce((total, entry) => total + anchorRuns(entry), 0);
  const runTotal = measured.reduce((total, entry) => total + entry.repeats, 0);
  const fixtureSuccesses = measured.filter((entry) => anchorRuns(entry) * 2 > entry.repeats).length;
  const unanimous = measured.filter(
    (entry) => anchorRuns(entry) === 0 || anchorRuns(entry) === entry.repeats,
  ).length;

  return {
    name: `${gatedRowName} (anchor-OR)`,
    threshold: null,
    direction: null,
    by_fixture: wilson(fixtureSuccesses, measured.length),
    by_run: wilson(runSuccesses, runTotal),
    resolves: null,
    meets: null,
    stability: {
      fixtures: measured.length,
      unanimous,
      split: measured.length - unanimous,
      disagreement_rate: measured.length === 0 ? NaN : (measured.length - unanimous) / measured.length,
    },
    definition: "anchor-OR",
  };
}

/**
 * Tags every recall row in a run summary with the reading it was measured
 * under, and adds the anchor-OR reading beside each gated row that has no
 * anchor-OR row printed already — SCP-225: every recall figure names its
 * definition, `(mechanism)` or `(anchor-OR)`.
 *
 * Every field on a tagged row is copied from `summarise.ts`'s own output, not
 * recomputed — `name`, `threshold`, `direction`, `by_fixture`, `by_run`,
 * `resolves`, `meets` and `stability` are unchanged. The only rows whose
 * `name` differs from a row `summariseCorpus` already produced are the new
 * anchor-OR siblings this function adds outright.
 */
export function withRecallDefinitions(summary: CorpusSummary): CorpusSummary {
  const metrics: MetricSummary[] = [];
  for (const metric of summary.metrics) {
    if (GATED_RECALL_ROW_NAMES.includes(metric.name)) {
      metrics.push(tag(metric, "mechanism"));
      const level = GATED_ROW_PLAN_LEVEL.get(metric.name);
      if (level) metrics.push(anchorOrSibling(metric.name, atPlanLevel(summary.per_fixture, level)));
    } else if (REPORTED_RECALL_ROW_NAMES.includes(metric.name)) {
      metrics.push(tag(metric, "mechanism"));
    } else {
      metrics.push(metric);
    }
  }

  const by_class = summary.by_class.map((entry) => ({
    ...entry,
    summary: tag(entry.summary, "mechanism"),
    ...(entry.anchor_summary ? { anchor_summary: tag(entry.anchor_summary, "anchor-OR") } : {}),
  }));

  return { ...summary, metrics, by_class };
}

const definitionOf = (metric: MetricSummary): RecallDefinition | null =>
  "definition" in metric ? ((metric as DefinedMetricSummary).definition ?? null) : null;

/**
 * A display-only copy of a `withRecallDefinitions` summary: `metrics[].name`
 * carries its `definition` as a visible suffix, so the printed table reads
 * `Blocking-defect recall, P1 (mechanism)` beside its anchor-OR sibling — the
 * `name` `summary.json` writes and `regression-delta.mjs` joins rows on is
 * never touched. A row whose name already ends in its own tag — every row
 * `withRecallDefinitions` adds outright — is left alone rather than
 * double-suffixed.
 */
export function withRecallLabels(summary: CorpusSummary): CorpusSummary {
  return {
    ...summary,
    metrics: summary.metrics.map((metric) => {
      const definition = definitionOf(metric);
      if (!definition) return metric;
      const suffix = `(${definition})`;
      return metric.name.endsWith(suffix) ? metric : { ...metric, name: `${metric.name} ${suffix}` };
    }),
  };
}
