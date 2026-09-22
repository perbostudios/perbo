import { costOf, costPhrase } from "@perbo/contracts";
import type { CheckResult, CriterionEvidenceBinding, Finding, ReviewArtifact } from "@perbo/contracts";

/**
 * The verdict as a pull-request comment (SCP-219).
 *
 * `perbo review` writes JSON, which is what the loop reads. A person posting
 * the same verdict onto a pull request has been reformatting it by hand — and a
 * rendering done by hand is one where the finding that did not fit gets left
 * out. This is that comment body, written from the artifact.
 *
 * **The artifact is the only input, deliberately.** Not the diff, not the plan
 * contract, not the source it came from. A comment that quotes the change back
 * at the reader is a comment that can say something the review never said, and
 * the reviewed diff is exactly the text nobody should have to re-read to check
 * that the verdict is about it. So the signature takes one argument, and the
 * criteria appear here as their ids and the coverage the verdict recorded for
 * them, never as the plan's wording. What the reviewer wrote — statements,
 * blocking reasons, the legibility summary — travels verbatim; nothing else
 * does.
 *
 * The bytes are pinned by `test/review-markdown.golden.md`, so a change to the
 * rendering is a change somebody reviewed rather than a comment that quietly
 * started saying something else.
 */

/**
 * The deterministic legibility row, by the id `assessLegibility` gives it.
 *
 * `@perbo/review` exports the rule (SCP-114) and it writes this row into every
 * artifact the reviewer produces; the footer below is that row's own status and
 * summary, quoted. It is not recomputed here — there is no diff to recompute it
 * from, and a second opinion about whether the change set was readable is
 * exactly the thing a rendering must not invent.
 */
const LEGIBILITY_CHECK_ID = "check_legibility";

/** The token a finding with no location renders as, never an empty path. */
export const UNLOCATABLE = "unlocatable";

/** One line, whatever the reviewer's own line breaks were. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * An inline code span that survives its own contents: the fence is longer than
 * the longest run of backticks inside, and a span whose text starts or ends
 * with one is padded, which is what the CommonMark rule requires.
 */
function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The routing, as the word the reader acts on. */
function routingLabel(finding: Finding): string {
  switch (finding.routing) {
    case "blocks":
      return "blocks";
    case "escalates":
      return "escalates";
    case "remediable":
      return "for the executor";
    case "advisory":
      return "advisory";
    case "waived":
      return "waived";
  }
}

/**
 * Where the finding is, or why it is nowhere.
 *
 * A finding with no file is not given an empty path or a `-`: both read as a
 * location and neither is one. It renders the literal `unlocatable` and the
 * reason the location is absent, which is a property of the finding itself —
 * a deterministic row is measured over the change set rather than at a path,
 * and a semantic finding without a file is one the reviewer recorded no file
 * for.
 *
 * A semantic finding's symbol is still not a location, but it is what there is,
 * so it is named in the reason rather than dropped. A deterministic row's is
 * not: there the field carries the check's name, not something to look up in
 * the tree, and offering it as a near-miss location would be the placeholder
 * this avoids.
 */
function location(finding: Finding): string {
  if (finding.file !== null) {
    return code(finding.line === null ? finding.file : `${finding.file}:${finding.line}`);
  }
  if (finding.source === "deterministic") {
    return `${UNLOCATABLE} — a deterministic check measured this over the change set rather than at a path`;
  }
  const symbol = finding.symbol === null ? "" : `, though it names the symbol ${code(finding.symbol)}`;
  return `${UNLOCATABLE} — the reviewer recorded no file for it${symbol}`;
}

/** One finding, as a list item whose continuation lines stay in the item. */
function renderFinding(finding: Finding): string[] {
  const confidence =
    finding.confidence === null ? "measured" : `confidence ${finding.confidence.toFixed(2)}`;
  const lines = [
    `- **${routingLabel(finding)}** · ${code(finding.rule_id)} · ${location(finding)} · ${confidence}`,
    `  ${oneLine(finding.statement)}`,
  ];
  if (finding.blocking) lines.push(`  Why it blocks: ${oneLine(finding.blocking_reason)}`);
  if (finding.waiver !== null) {
    lines.push(`  Waived by ${finding.waiver.authorised_by} until ${finding.waiver.expires_at}.`);
  }
  return lines;
}

/** The heading for one criterion's findings: its id and what the verdict said of it. */
function criterionHeading(id: string, coverage: CriterionEvidenceBinding | undefined): string {
  if (coverage === undefined) return `### ${id} — no coverage entry`;
  return `### ${id} — ${coverage.status}, ${coverage.verification_strength}`;
}

/**
 * Whether a person has to read this finding.
 *
 * A `remediable` finding went to the executor, which closed it and had the
 * closure verified before anybody saw this. Listing it asks for attention the
 * loop has already spent, so it is counted here and read in the record. What
 * blocks or escalates — and what the executor could not close, which comes
 * back as one of those on the last round — is unchanged.
 */
const needsAPerson = (finding: Finding): boolean => finding.routing !== "remediable";

/** The one line that says how many went to the executor, and which review holds them. */
function routedNote(routed: number, reviewId: string): string {
  return (
    `${routed} finding${routed === 1 ? "" : "s"} went to the executor and ${routed === 1 ? "is" : "are"} ` +
    `not listed here; review ${code(reviewId)} records each one.`
  );
}

/**
 * What an empty list says. A criterion whose every finding went to the
 * executor has findings; it has none for the person reading this, and saying
 * "no findings" of it would be the one place this rendering could mislead.
 */
const nothingShown = (routedAway: number): string =>
  routedAway === 0 ? "No findings" : "No findings that need you";

/** The verdict's own count of what it found, in the words the routing uses. */
function tally(findings: readonly Finding[]): string {
  const blocking = findings.filter((finding) => finding.blocking).length;
  const executor = findings.filter((finding) => finding.routing === "remediable").length;
  const rest = findings.length - blocking - executor;
  if (findings.length === 0) return "no findings";
  return `${blocking} blocking · ${executor} for the executor · ${rest} advisory`;
}

/** The cost, in the vocabulary the terminal rendering already uses. */
function renderedCost(artifact: ReviewArtifact): string {
  return costPhrase(
    costOf({ micros: artifact.cost_micros, basis: artifact.model.cost_basis }),
    { digits: 3 },
  );
}

/** The legibility row's own words, or the fact that this artifact has none. */
function legibilityFooter(checks: readonly CheckResult[]): string {
  const check = checks.find((one) => one.check_id === LEGIBILITY_CHECK_ID);
  if (check === undefined) {
    return `> **Legibility**: not recorded — this review carries no ${code(LEGIBILITY_CHECK_ID)} row.`;
  }
  return `> **Legibility**: ${check.status} — ${oneLine(check.summary)}`;
}

/**
 * The comment body. Ends without a trailing newline, like `renderArtifact`; the
 * caller adds the one that terminates the last line.
 */
export function renderReviewMarkdown(artifact: ReviewArtifact): string {
  const lines: string[] = [];

  // The verdict first, on the first line: a comment whose answer is below the
  // fold is one that gets read as "the reviewer said something".
  const confidence =
    artifact.confidence === null ? "" : ` · confidence ${artifact.confidence.toFixed(2)}`;
  lines.push(`**Verdict: ${artifact.decision}** — ${tally(artifact.findings)}${confidence}`);
  lines.push("");
  lines.push(
    `Review ${code(artifact.review_id)} of ${code(artifact.target.id)} — ` +
      `${code(artifact.target.base_commit.slice(0, 7))} → ` +
      `${code(artifact.target.head_commit.slice(0, 7))}, ` +
      `plan ${code(artifact.plan_id)} version ${artifact.plan_version}.`,
  );

  if (artifact.error !== null) {
    lines.push("");
    lines.push(`> **${artifact.error.kind.replace(/_/g, " ")}** — ${oneLine(artifact.error.message)}`);
    if (artifact.error.unresolved_criteria.length > 0) {
      lines.push(`> No verdict was reached on ${artifact.error.unresolved_criteria.join(", ")}.`);
    }
  }

  // --- findings, grouped by the criterion each one is about -----------------
  // The criteria in the order the coverage records them, then any a shown
  // finding names that the coverage does not — so a finding is never dropped
  // for belonging to a group this rendering did not think of.
  const shown = artifact.findings.filter(needsAPerson);
  const routed = artifact.findings.length - shown.length;
  lines.push("");
  lines.push("## Findings by acceptance criterion");
  if (routed > 0) {
    lines.push("");
    lines.push(routedNote(routed, artifact.review_id));
  }
  const coverageById = new Map(artifact.coverage.map((entry) => [entry.criterion_id, entry]));
  const ids = [...coverageById.keys()];
  for (const finding of shown) {
    if (finding.criterion_id !== null && !ids.includes(finding.criterion_id)) {
      ids.push(finding.criterion_id);
    }
  }
  for (const id of ids) {
    lines.push("");
    lines.push(criterionHeading(id, coverageById.get(id)));
    lines.push("");
    const mine = shown.filter((finding) => finding.criterion_id === id);
    if (mine.length === 0) {
      const all = artifact.findings.filter((finding) => finding.criterion_id === id);
      lines.push(`${nothingShown(all.length)}.`);
      continue;
    }
    for (const finding of mine) lines.push(...renderFinding(finding));
  }
  const loose = shown.filter((finding) => finding.criterion_id === null);
  if (loose.length > 0) {
    lines.push("");
    lines.push("### Findings tied to no acceptance criterion");
    lines.push("");
    for (const finding of loose) lines.push(...renderFinding(finding));
  }
  if (shown.length === 0 && ids.length === 0) {
    lines.push("");
    lines.push(`${nothingShown(routed)}, and the verdict recorded no criteria.`);
  }

  lines.push("");
  lines.push(legibilityFooter(artifact.checks));
  lines.push("");
  lines.push(
    `_Reviewed by ${code(`${artifact.model.provider}/${artifact.model.model_id}`)} · ` +
      `prompt ${code(artifact.model.prompt_version)} · ${renderedCost(artifact)}._`,
  );
  return lines.join("\n");
}
