import { BUNDLE_DIRNAME, BUNDLE_FILENAME } from "./bundle.js";
import { MINIMUM_COMPLETENESS, type CorpusSummary, type MetricSummary } from "./summarise.js";
import type { Proportion, Quantile } from "./metrics.js";

/**
 * Re-exported from where the rule is applied. The floor belonged here when the
 * report was the only thing that knew about it; `summariseCorpus` now refuses
 * to mark a threshold met under the same rule, so the constant lives with the
 * refusal and this keeps the old import path working.
 */
export { MINIMUM_COMPLETENESS };

/** Markdown, because the result is written up and read by a person. */

const pct = (value: number) => (Number.isNaN(value) ? "—" : `${(value * 100).toFixed(0)}%`);

const proportion = (value: Proportion) =>
  value.n === 0
    ? "— (n=0)"
    : `${pct(value.point)} [${pct(value.low)}–${pct(value.high)}] n=${value.n}`;

const seconds = (value: Quantile) =>
  Number.isNaN(value.point)
    ? "—"
    : `${(value.point / 1000).toFixed(1)}s [${(value.low / 1000).toFixed(1)}–${(value.high / 1000).toFixed(1)}] n=${value.n}`;

const dollars = (value: Quantile) =>
  Number.isNaN(value.point)
    ? "—"
    : `$${(value.point / 1e6).toFixed(3)} [${(value.low / 1e6).toFixed(3)}–${(value.high / 1e6).toFixed(3)}] n=${value.n}`;

function verdict(metric: MetricSummary): string {
  if (metric.threshold === null || metric.meets === null) return "—";
  if (!metric.resolves) return metric.meets ? "**met, but unresolved**" : "**not met, unresolved**";
  return metric.meets ? "met" : "**NOT MET**";
}

const thresholdText = (metric: MetricSummary) =>
  metric.threshold === null
    ? "—"
    : `${metric.direction === "at_least" ? "≥" : "≤"} ${pct(metric.threshold)}`;

/**
 * The reviewer the run executed, as the report quotes it: the digest of the
 * bundle copy taken at run start, which is the only file that could not have
 * been rebuilt underneath the measurement.
 */
export interface ReportedBundle {
  sha256: string;
  bytes: number;
}

export function renderReport(
  summary: CorpusSummary,
  options: { model: string; bundle?: ReportedBundle | null },
): string {
  const lines: string[] = [];

  const complete = summary.completeness.point;
  const completeEnough = !Number.isNaN(complete) && complete >= MINIMUM_COMPLETENESS;
  // A summary built before `not_a_measurement` existed carries the completeness
  // rule only, which is what this branch computed on its own.
  const usable = (summary.not_a_measurement ?? null) === null && completeEnough;

  /**
   * The ceiling banner comes first and says the three things a reader of a
   * stopped run needs: what the ceiling was, how much of the population
   * completed, and which fixtures never ran. Nothing below it is a result.
   */
  if (summary.partial) {
    const partial = summary.partial;
    lines.push(
      `# PARTIAL RUN — stopped by the ${partial.ceiling} spend ceiling after ` +
        `${partial.completed} of ${partial.planned} reviews`,
    );
    lines.push("");
    lines.push(
      `Spend ceiling **${partial.ceiling}**, ${partial.spent} reported spent. ` +
        `**${partial.completed} of ${partial.planned} reviews completed**, and ` +
        `${partial.not_run_reviews.length} were never launched. **No threshold below is a ` +
        "measurement**: the fixtures here are the ones the run reached before the ceiling, " +
        "which is a truncated population and not a sample of the corpus.",
    );
    lines.push("");
    lines.push(
      partial.not_run.length > 0
        ? `Fixtures never run (${partial.not_run.length}): ${partial.not_run.join(", ")}`
        : "Every fixture ran at least once; the reviews not launched are repeats: " +
          `${partial.not_run_reviews.map((review) => `${review.fixture_id} #${review.repeat}`).join(", ")}`,
    );
    lines.push("");
    lines.push(`Why it stopped: ${partial.reason}`);
    lines.push("");
    lines.push(
      "Raise the ceiling and run it again. The numbers below are diagnostics.",
    );
    lines.push("");
  }

  if (!completeEnough) {
    const lost = summary.runs_attempted - summary.completeness.successes;
    lines.push(`# INVALID RUN — ${lost} of ${summary.runs_attempted} runs produced no artifact`);
    lines.push("");
    lines.push(
      `Completeness ${pct(complete)}, against a floor of ${pct(MINIMUM_COMPLETENESS)}. **No ` +
        "threshold below is a measurement.** The fixtures that survived are whatever survived, " +
        "which is a selected subset and not a sample — every number here is printed so the run " +
        "can be diagnosed, and none of it may be quoted, compared against a previous round, or " +
        "used to start or stop work.",
    );
    lines.push("");
    lines.push("Fix the cause and run it again. The numbers below are diagnostics.");
    lines.push("");
  }

  /**
   * Which reviewer produced these numbers, printed above the tables rather than
   * filed under run health. A report is quoted, compared against a previous
   * round and pasted into a result document, and every one of those uses needs
   * to be able to say what was executed — the digest names it exactly, and
   * `<out>/bin/` still holds the file it names.
   *
   * Absent only for a summary rendered outside a run (a stored `summary.json`
   * re-rendered by hand); a `--run` always has one.
   */
  if (options.bundle) {
    lines.push(
      `**Reviewer bundle** \`sha256:${options.bundle.sha256}\` (${options.bundle.bytes} bytes) — ` +
        `copied to \`${BUNDLE_DIRNAME}/${BUNDLE_FILENAME}\` before the first fixture and spawned ` +
        "for every review.",
    );
    lines.push("");
  }

  lines.push("| Metric | Threshold | By fixture (point, 95% interval, n) | By run | Verdict |");
  lines.push("|---|---|---|---|---|");
  for (const metric of summary.metrics) {
    lines.push(
      `| ${metric.name} | ${thresholdText(metric)} | ${proportion(metric.by_fixture)} | ` +
        `${proportion(metric.by_run)} | ` +
        `${usable ? verdict(metric) : summary.partial ? "**partial run**" : "**invalid run**"} |`,
    );
  }
  lines.push("");

  /**
   * The gate in one line, with the rows that measured nothing counted apart
   * from both outcomes.
   *
   * A gated row whose population was empty in this run neither held nor
   * failed, and folding it into either count states a result the run does not
   * have. Printed only for a run that is a measurement: a partial or invalid
   * one has no gate to summarise, and every cell above already says so.
   */
  if (usable) {
    const gatedRows = summary.metrics.filter((metric) => metric.threshold !== null);
    const holding = gatedRows.filter((metric) => metric.meets === true);
    const failed = gatedRows.filter((metric) => metric.meets === false).length;
    const unmeasured = gatedRows.length - holding.length - failed;
    const unresolved = holding.filter((metric) => !metric.resolves).length;
    lines.push(
      `**${holding.length} of ${gatedRows.length} gated metric${gatedRows.length === 1 ? "" : "s"} ` +
        `${holding.length === 1 ? "holds" : "hold"}, ${unmeasured} unmeasured, ${failed} fail.**` +
        (unmeasured > 0
          ? " An unmeasured row had no member of its population in this run — no fixture of " +
            "that class, no occasion for that mechanism to fire — so it neither passed nor " +
            "failed, and the threshold beside it says what would have been measured."
          : "") +
        // A count is the one place the `resolves` rule is easiest to lose:
        // three words above the table would otherwise round a row the corpus
        // cannot yet decide up into a pass.
        (unresolved > 0
          ? ` ${unresolved} of the rows counted as holding sit on an interval that straddles ` +
            "the threshold — *met, but unresolved* in the table above, and not yet a gate."
          : ""),
    );
    lines.push("");
  }

  lines.push("| | p50 | p95 | Threshold |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| Review wall clock | ${seconds(summary.latency_ms.p50)} | ${seconds(summary.latency_ms.p95)} | p50 ≤ 90s, p95 ≤ 4min |`,
  );
  lines.push(
    `| Review cost | ${dollars(summary.cost_micros.p50)} | ${dollars(summary.cost_micros.p95)} | ` +
      (summary.cost_micros.p50.n === 0 ? "not measured" : "p50 ≤ $0.25, p95 ≤ $1.00") +
      " |",
  );
  lines.push(
    `| Dollar price coverage | ${summary.cost_coverage.successes}/${summary.cost_coverage.n} completed reviews | — | ` +
      (summary.cost_coverage.n > 0 && summary.cost_coverage.successes === summary.cost_coverage.n
        ? "complete"
        : "incomplete; no dollar quantiles") +
      " |",
  );
  if (summary.cost_unavailable > 0) {
    lines.push("");
    lines.push(
      "Dollar cost unavailable for **" +
        summary.cost_unavailable +
        "** completed review(s); their token usage remains in each artifact, no " +
        "provider price was invented, and the priced subset is not used for dollar quantiles.",
    );
  }
  lines.push("");

  lines.push("### Routing (D-051)");
  lines.push("");
  lines.push("| | By fixture (any repeat) | By run |");
  lines.push("|---|---|---|");
  lines.push(
    `| Clean changes with a **blocking** finding | — | ${proportion(summary.routing.clean_with_blocking_finding)} |`,
  );
  lines.push(
    `| Clean changes with a finding **routed to the executor** | — | ${proportion(summary.routing.clean_with_remediable_finding)} |`,
  );
  lines.push(
    `| Seeded defects detected **only** by routing, never blocked | — | ${proportion(summary.routing.defective_detected_by_routing)} |`,
  );
  lines.push(
    `| **Clean changes on which a person was still shown something** (D-060) | ` +
      `${proportion(summary.routing.clean_shown_to_a_person.by_fixture_any_repeat)} | ` +
      `${proportion(summary.routing.clean_shown_to_a_person.by_run)} |`,
  );
  lines.push("");
  // D-060 requires this pair be read together. Precision of stopping improves
  // trivially if the reviewer shows people less, so the row above is what makes
  // a rising score readable — a gate that improves while it falls was widened
  // by hiding findings rather than by judging better.
  lines.push(
    "> D-060 gates on **precision of stopping** — of the changes review stopped, the share where " +
      "a person endorses the stop — and requires the row above beside it on every run. That number " +
      "falling while precision rises means findings were hidden, not that the gate got better. " +
      "Precision of stopping needs human labels, so it is not computed here.",
  );
  lines.push("");
  lines.push(
    `Findings routed to the executor: **${summary.routing.remediable_findings_total}** across the run, ` +
      `of which ${summary.routing.remediable_findings_on_clean_total} were on clean changes. ` +
      `Blocking findings on clean changes: **${summary.routing.blocking_findings_on_clean_total}**.`,
  );
  lines.push("");

  lines.push("### Recall by class");
  lines.push("");
  lines.push(
    "Attribution v2 gives gating credit only to a criterion match or a declared rule-prefix match, " +
      "while a finding that only names the expected file is shown as a candidate rather than " +
      "promoted into mechanism recall.",
  );
  lines.push("");
  lines.push(
    summary.attribution
      ? `Attribution-v2 coverage: ${proportion(summary.attribution.v2_coverage)}; ` +
          `file-only candidates: ${proportion(summary.attribution.file_only_candidates)}.`
      : "Attribution-v2 coverage: not recorded in this legacy summary; its detected column is the registered anchor score.",
  );
  lines.push("");
  lines.push(
    "| Class | Mechanism-confirmed, by fixture (mechanism) | Registered anchor (anchor-OR) | Candidate by run | Repeats disagreed |",
  );
  lines.push("|---|---|---|---|---|");
  for (const entry of summary.by_class) {
    const anchor = entry.anchor_summary ?? entry.summary;
    lines.push(
      `| ${entry.class} | ${proportion(entry.summary.by_fixture)} | ` +
        `${proportion(anchor.by_fixture)} | ` +
        `${entry.candidate_summary ? proportion(entry.candidate_summary.by_run) : "—"} | ` +
        `${entry.summary.stability.split}/${entry.summary.stability.fixtures} |`,
    );
  }
  lines.push("");

  lines.push("### Per fixture");
  lines.push("");
  lines.push("| Fixture | Class | Level | Mode | Confirmed | Anchor | Candidate | Decisions | Why |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const entry of summary.per_fixture) {
    lines.push(
      `| \`${entry.id}\` | ${entry.class} | ${entry.plan_level} | ${entry.mode} | ` +
        `${entry.detected_runs}/${entry.repeats} | ` +
        `${entry.anchor_detected_runs ?? entry.detected_runs}/${entry.repeats} | ` +
        `${entry.candidate_runs === undefined ? "—" : `${entry.candidate_runs}/${entry.repeats}`} | ` +
        `${entry.decisions.join(", ")} | ` +
        `${entry.reasons.join("; ")} |`,
    );
  }
  lines.push("");

  lines.push("### Run health");
  lines.push("");
  lines.push(
    `- ${summary.fixture_count} fixtures (${summary.defective_count} defective, ` +
      `${summary.clean_count} clean` +
      (summary.contested_count > 0 ? `, ${summary.contested_count} contested` : "") +
      `) × ${summary.repeats} repeats = ${summary.runs_attempted} runs`,
  );
  if (summary.contested_count > 0) {
    // Reported as a disagreement, never folded into the false-block rate: both
    // sides of a contested fixture are defensible (D-068).
    lines.push(
      `- contested fixtures where the gate closed: ${proportion(summary.contested_gate_closed)} ` +
        "— a disagreement rate between this reviewer and the merging maintainer, not an error rate",
    );
  }
  lines.push(`- ${summary.runs_failed} run(s) produced no artifact at all`);
  if (summary.excluded_unprepared.length > 0) {
    lines.push(
      `- **${summary.excluded_unprepared.length} fixture(s) excluded** — they pin a repository that ` +
        `was not prepared: ${summary.excluded_unprepared.join(", ")}. Run \`perbo-corpus prepare\`.`,
    );
  }
  lines.push(`- reviews that did not complete: ${proportion(summary.did_not_complete)}`);
  lines.push(`- model: \`${options.model}\``);
  lines.push(
    `- forbidden strings leaked into an artifact: ${
      summary.leaked_forbidden.length === 0 ? "none" : summary.leaked_forbidden.join(", ")
    }`,
  );
  lines.push(`- run started ${summary.started_at}, finished ${summary.finished_at}`);
  lines.push("");

  // An empty population has no interval, so it cannot straddle anything. Those
  // rows are unmeasured — counted as such in the gate line above — and listing
  // them here would give them a reason that is not theirs.
  const unresolved = summary.metrics.filter(
    (metric) => metric.resolves === false && metric.by_fixture.n > 0,
  );
  if (unresolved.length > 0) {
    lines.push("### Metrics this corpus size cannot resolve");
    lines.push("");
    lines.push(
      "D-050: if the interval at the staged size cannot distinguish pass from fail, the corpus " +
        "is not yet a gate for that metric and must not be used as one. These intervals straddle " +
        "their threshold:",
    );
    lines.push("");
    for (const metric of unresolved) {
      lines.push(
        `- **${metric.name}** — ${proportion(metric.by_fixture)} against ${thresholdText(metric)}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
