import type {
  CriterionEvidenceBinding,
  Finding,
  PlanContract,
  ReviewArtifact,
  ReviewRouting,
  SourceContract,
} from "@perbo/contracts";
import { hasAcceptanceCriteria } from "@perbo/contracts";
import { WIDTH, clip, pad, painter, spread, wrap, type Paint, type Style } from "../../../text.js";

/**
 * The human rendering of a review, and of one that stopped before it reached a
 * verdict.
 *
 * Readable at 80 columns, and every distinction it makes carries a textual mark
 * as well as a colour — verification strength, blocking status and check
 * results. Colour is decoration here; remove it and nothing is lost.
 */

const CHECK_MARK: Record<string, string> = {
  passed: "✓",
  failed: "✗",
  errored: "✗",
  skipped: "~",
};

const COVERAGE_MARK = (entry: CriterionEvidenceBinding): string => {
  if (entry.status === "cannot_determine") return "?";
  if (entry.status === "not_met") return "✗";
  if (entry.verification_strength === "directly_verified") return "✓";
  if (entry.verification_strength === "proxy") return "~";
  return "!";
};

const COVERAGE_STYLE = (entry: CriterionEvidenceBinding): Style => {
  if (entry.status === "cannot_determine" || entry.status === "not_met") return "bad";
  if (entry.verification_strength === "directly_verified") return "ok";
  if (entry.verification_strength === "proxy") return "warn";
  return "bad";
};

/**
 * Reads `routing`, which is the matrix's own answer, rather than inferring one
 * from the reason string. `[FIX]` is a finding that goes back to the executor:
 * real, not blocking, and not a question for the person reading this.
 */
function findingTag(finding: Finding): { tag: string; style: Style } {
  switch (finding.routing) {
    case "waived":
      return { tag: "(waived)", style: "dim" };
    case "blocks":
      return { tag: "[BLOCK]", style: "bad" };
    case "escalates":
      return { tag: "(esc)", style: "warn" };
    case "remediable":
      return { tag: "[FIX]", style: "warn" };
    case "advisory":
      return { tag: "(adv)", style: "dim" };
  }
}

export interface RenderOptions {
  color: boolean;
  version: string;
  /** Rendered under the verdict when the review did not complete. */
  resumeCommand?: string | null;
  /**
   * The contract as its source stated it, for a review with no admitted ticket
   * (SCP-179). Rendered above the checks, because the first question about a
   * verdict on a pull request nobody planned is "judged against what".
   */
  sourceContract?: SourceContract | null;
  /** Who has the change next. Printed beside the verdict, never inferred from it. */
  routing?: ReviewRouting | null;
}

/**
 * The contract block: where it came from, the outcome, and the criteria — or
 * the fact that there are none.
 *
 * `criteria: none stated` is the whole point of the block. A reviewer that
 * writes three criteria of its own onto a pull request that stated none
 * produces a verdict about a plan nobody agreed to, and the only defence is
 * that the absence is printed where the verdict is read.
 */
function renderSourceContract(contract: SourceContract, paint: Paint): string[] {
  const lines: string[] = [];
  const origin =
    contract.source === "pull_request"
      ? `pull request ${contract.reference ?? ""}`.trim()
      : "the command line";
  lines.push(spread(paint("CONTRACT", "sect"), `from ${origin}`, paint, "dim"));
  const outcomeNote =
    contract.outcome_from === "title"
      ? " (the title: the body stated no outcome)"
      : contract.outcome_from === "first_paragraph"
        ? " (its first paragraph: no outcome section)"
        : "";
  for (const line of wrap(`outcome: ${contract.outcome}${outcomeNote}`, 5)) {
    lines.push(paint(line, "mid"));
  }
  if (contract.criteria.length === 0) {
    lines.push(paint("     criteria: none stated", "warn"));
    lines.push(
      paint("     the change is judged against the outcome alone; none were invented", "dim"),
    );
  } else {
    lines.push(paint(`     criteria: ${contract.criteria.length} stated`, "mid"));
    for (const criterion of contract.criteria) {
      for (const line of wrap(`${criterion.id}: ${criterion.text}`, 7)) lines.push(paint(line, "mid"));
      if (criterion.assertion) {
        for (const line of wrap(`proven by: ${criterion.assertion}`, 9)) {
          lines.push(paint(line, "dim"));
        }
      } else {
        lines.push(paint("         no assertion stated", "dim"));
      }
    }
  }
  lines.push("");
  return lines;
}

export function renderArtifact(
  artifact: ReviewArtifact,
  contract: PlanContract,
  options: RenderOptions,
): string {
  const paint = painter(options.color);
  const lines: string[] = [];
  const criterionText = new Map<string, string>(
    hasAcceptanceCriteria(contract)
      ? contract.acceptance_criteria.map((criterion) => [criterion.id, criterion.text])
      : [],
  );

  lines.push("");
  lines.push(
    paint(
      `perbo ${options.version}   review of ${artifact.target.id} ` +
        `(${artifact.target.base_commit.slice(0, 7)} → ${artifact.target.head_commit.slice(0, 7)})` +
        `   plan v${artifact.plan_version}`,
      "dim",
    ),
  );
  lines.push("");

  if (options.sourceContract) {
    for (const line of renderSourceContract(options.sourceContract, paint)) lines.push(line);
  }

  // --- deterministic checks -------------------------------------------------
  const fromFile = artifact.checks.some((check) => check.source === "file");
  lines.push(
    spread(
      paint("DETERMINISTIC CHECKS", "sect"),
      fromFile ? "read from the checks file" : "",
      paint,
      "dim",
    ),
  );
  for (const check of artifact.checks) {
    const mark = CHECK_MARK[check.status] ?? "?";
    const style: Style = check.status === "passed" ? "ok" : "bad";
    const left = `  ${paint(mark, style)}  ${pad(check.name, 15)} ${pad(check.command ?? "", 24)}`;
    // `paint` adds invisible bytes, so measure the unpainted prefix.
    const visible = `  ${mark}  ${pad(check.name, 15)} ${pad(check.command ?? "", 24)}`;
    const summary = clip(check.summary, WIDTH - visible.length - 2);
    const gap = Math.max(2, WIDTH - visible.length - summary.length);
    lines.push(left + " ".repeat(gap) + paint(summary, "mid"));
  }
  lines.push(paint("     these outrank any model claim about them", "dim"));
  if (artifact.overrides.length > 0) {
    for (const override of artifact.overrides) {
      lines.push(
        paint(
          `     overridden: ${override.check_name} was claimed ${override.asserted_status}, ` +
            `measured ${override.measured_status}`,
          "bad",
        ),
      );
    }
  }
  lines.push("");

  // --- coverage -------------------------------------------------------------
  const met = artifact.coverage.filter((entry) => entry.status === "met").length;
  const undetermined = artifact.coverage.filter(
    (entry) => entry.status === "cannot_determine",
  ).length;
  const summary =
    undetermined > 0
      ? `${artifact.coverage.length} criteria · ${met} met · ${undetermined} not`
      : `${artifact.coverage.length} criteria · ${met} met`;
  lines.push(spread(paint("COVERAGE", "sect"), summary, paint, "dim"));
  lines.push(
    paint("     the mark grades how each one was established, not whether", "dim"),
  );
  for (const entry of artifact.coverage) {
    const style = COVERAGE_STYLE(entry);
    lines.push(
      `  ${paint(COVERAGE_MARK(entry), style)}  ${paint(pad(entry.criterion_id, 5), "hi")} ` +
        `${pad(entry.status, 17)} ${paint(entry.verification_strength, style)}`,
    );
    const text = criterionText.get(entry.criterion_id);
    if (text) for (const line of wrap(text, 8)) lines.push(paint(line, "mid"));
    if (entry.evidence?.assertion) {
      for (const line of wrap(entry.evidence.assertion, 8)) lines.push(paint(line, "dim"));
    }
    const location = entry.evidence?.location;
    if (location) {
      const at = `${location.file}${location.line ? `:${location.line}` : ""}`;
      const note = entry.note ? ` — ${entry.note}` : "";
      for (const line of wrap(`└ ${at}${note}`, 8)) lines.push(paint(line, "dim"));
    } else if (entry.note) {
      for (const line of wrap(`└ ${entry.note}`, 8)) lines.push(paint(line, "dim"));
    }
  }
  lines.push("");

  // --- findings -------------------------------------------------------------
  const blocking = artifact.findings.filter((finding) => finding.blocking);
  const remediable = artifact.findings.filter((finding) => finding.routing === "remediable");
  const rest = artifact.findings.filter(
    (finding) => !finding.blocking && finding.routing !== "remediable",
  );
  lines.push(
    spread(
      paint("FINDINGS", "sect"),
      `${blocking.length} blocking · ${remediable.length} to the executor · ${rest.length} advisory`,
      paint,
      "dim",
    ),
  );
  lines.push("");
  for (const finding of blocking) {
    const { tag, style } = findingTag(finding);
    const conf =
      finding.confidence === null ? "measured" : `confidence ${finding.confidence.toFixed(2)}`;
    const ruleId = clip(finding.rule_id, WIDTH - 4 - tag.length - conf.length - 2);
    const head = `  ${tag}  ${ruleId}`;
    const gap = Math.max(2, WIDTH - head.length - conf.length);
    lines.push(
      `  ${paint(tag, style)}  ${paint(ruleId, "hi")}` + " ".repeat(gap) + paint(conf, "dim"),
    );
    const criterion = finding.criterion_id ? `  ${finding.criterion_id}` : "";
    const at = clip(
      finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "(no file)",
      WIDTH - 11 - criterion.length,
    );
    lines.push(paint(`           ${at}`, "mid") + (criterion ? paint(criterion, "dim") : ""));
    for (const line of wrap(finding.statement, 11)) lines.push(paint(line, "mid"));
    lines.push(
      paint(`           key ${finding.key.slice(0, 8)}   risk ${artifact.actual_risk}`, "dim"),
    );
    for (const line of wrap(finding.blocking_reason, 11)) lines.push(paint(line, "dim"));
    lines.push("");
  }
  for (const finding of [...remediable, ...rest]) {
    const { tag, style } = findingTag(finding);
    const at = finding.file
      ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
      : "";
    const prefix = `  ${pad(tag, 8)} ${pad(finding.rule_id, 24)} `;
    lines.push(
      `  ${paint(pad(tag, 8), style)} ${pad(finding.rule_id, 24)} ` +
        paint(clip(at, WIDTH - prefix.length), "dim"),
    );
  }
  if (rest.length + remediable.length > 0) lines.push("");

  // --- verdict --------------------------------------------------------------
  const verdictStyle: Style =
    artifact.decision === "approve"
      ? "ok"
      : artifact.decision === "escalate" || artifact.decision === "remediable"
        ? "warn"
        : "bad";
  const right =
    artifact.error !== null
      ? artifact.error.kind.replace(/_/g, " ")
      : artifact.confidence === null
        ? ""
        : `confidence ${artifact.confidence.toFixed(2)}`;
  const verdictLeft = `VERDICT   ${artifact.decision}`;
  const gap = Math.max(2, WIDTH - verdictLeft.length - right.length);
  lines.push(
    paint("VERDICT", "sect") +
      "   " +
      paint(artifact.decision, verdictStyle) +
      " ".repeat(gap) +
      paint(right, "dim"),
  );

  if (artifact.error !== null) {
    for (const line of wrap(artifact.error.message, 10)) lines.push(paint(line, "mid"));
    if (artifact.error.unresolved_criteria.length > 0) {
      lines.push(
        paint(
          `          no verdict reached on ${artifact.error.unresolved_criteria.join(", ")}`,
          "mid",
        ),
      );
    }
  }

  const renderedCost =
    artifact.model.cost_basis === "unavailable"
      ? "cost unavailable"
      : `$${(artifact.cost_micros / 1_000_000).toFixed(3)} ` +
        (artifact.model.cost_basis === "transport_reported" ? "reported" : "estimated");
  lines.push(
    paint(
      `          ${(artifact.latency_ms / 1000).toFixed(1)}s · ` +
        `${renderedCost} · ` +
        `${artifact.model.prompt_version} · ${artifact.model.model_id}`,
      "dim",
    ),
  );
  lines.push(paint("          executor narrative and transcript: not read", "dim"));
  if (options.routing) {
    const routeStyle: Style =
      options.routing.decision === "pass" ? "ok" : options.routing.decision === "executor" ? "warn" : "bad";
    lines.push(
      paint("ROUTING", "sect") + "   " + paint(options.routing.decision, routeStyle),
    );
    for (const line of wrap(options.routing.reason, 10)) lines.push(paint(line, "dim"));
  }
  if (artifact.escalated) {
    lines.push(
      paint(
        `          actual_risk ${artifact.actual_risk} exceeds planned ${artifact.planned_risk}: escalated`,
        "warn",
      ),
    );
  }

  if (options.resumeCommand) {
    lines.push("");
    lines.push(paint(`          resume   ${options.resumeCommand}`, "dim"));
    lines.push(paint("                   re-runs only the unresolved criteria", "dim"));
  }
  lines.push("");
  return lines.join("\n");
}
