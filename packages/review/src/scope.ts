import {
  findingKey,
  matchesAny,
  packageOf,
  type ChangeSet,
  type CheckResult,
  type Finding,
  type Scope,
  type ScopeDeviation,
} from "@perbo/contracts";

/**
 * Scope enforcement is a computation over the diff and the contract. It must be
 * perfect and it is not a model task (docs/04, "Monorepo scope enforcement").
 * Nothing in this file consults the model, and the corpus carries a scope
 * fixture whose only purpose is to fail if that ever stops being true.
 */

export interface ScopeAssessment {
  deviation: ScopeDeviation;
  findings: Finding[];
  check: CheckResult;
}

const openFinding = (parts: {
  rule_id: string;
  file: string;
  statement: string;
  blocking: boolean;
  blocking_reason: string;
  severity: Finding["severity"];
}): Finding => ({
  key: findingKey({ rule_id: parts.rule_id, criterion_id: null, file: parts.file, symbol: null }),
  rule_id: parts.rule_id,
  source: "deterministic",
  // Overwritten by `applyBlocking`; a deterministic finding is never routed.
  row: null,
  closure: null,
  direction: null,
  caused_by_change: null,
  criterion_id: null,
  severity: parts.severity,
  blocking: parts.blocking,
  blocking_reason: parts.blocking_reason,
  confidence: null,
  file: parts.file,
  line: null,
  symbol: null,
  statement: parts.statement,
  routing: parts.blocking ? "blocks" : "advisory",
  status: "open",
  outcome: "unknown",
  waiver: null,
});

export function assessScope(changeset: ChangeSet, scope: Scope): ScopeAssessment {
  const allowedPackages = new Set(scope.paths_allowed.map((pattern) => packageOf(pattern)));

  const prohibited: string[] = [];
  const generated: string[] = [];
  const outside: string[] = [];
  const expansions: string[] = [];

  for (const file of changeset.files) {
    const path = file.path;
    // Prohibited first: a path can be both prohibited and generated, and the
    // exemption must not launder it.
    if (matchesAny(path, scope.paths_prohibited)) {
      prohibited.push(path);
      continue;
    }
    if (matchesAny(path, scope.generated_paths)) {
      generated.push(path);
      continue;
    }
    if (matchesAny(path, scope.paths_allowed)) continue;

    outside.push(path);
    if (allowedPackages.has(packageOf(path))) expansions.push(path);
  }

  const foreign = outside.filter((path) => !expansions.includes(path));
  const withinBudget = foreign.length === 0 && expansions.length <= scope.expansion_budget_files;

  // D-062. A generated path may declare its sources; a change to it with no
  // declared source in the same diff is decidable without knowing who typed:
  // either a hand edit the next regeneration erases, or a regeneration nothing
  // in the change accounts for. Paths with no declaration keep the plain
  // exemption — scp-006 was approved 3/3 precisely because this was silent.
  const changedPaths = changeset.files.map((file) => file.path);
  const unexplained: string[] = [];
  for (const path of generated) {
    const sources = Object.entries(scope.generated_sources ?? {})
      .filter(([pattern]) => matchesAny(path, [pattern]))
      .flatMap(([, sourceGlobs]) => sourceGlobs);
    if (sources.length === 0) continue;
    const explained = changedPaths.some((other) => other !== path && matchesAny(other, sources));
    if (!explained) unexplained.push(path);
  }

  const findings: Finding[] = [];
  for (const path of unexplained) {
    findings.push(
      openFinding({
        rule_id: "scope.generated_without_source",
        file: path,
        severity: "blocker",
        blocking: true,
        blocking_reason:
          "deterministic: a declared-generated file changed with none of its declared sources",
        statement:
          `${path} is declared generated and the change modifies it, but no file matching its ` +
          `declared sources changed. Either this is a hand edit the next regeneration will erase, ` +
          `or a regeneration nothing in this change accounts for. Change a declared source, or ` +
          `revise the contract's generated_sources.`,
      }),
    );
  }
  for (const path of prohibited) {
    findings.push(
      openFinding({
        rule_id: "scope.prohibited_path",
        file: path,
        severity: "blocker",
        blocking: true,
        blocking_reason: "deterministic: the change touches a path in scope.paths_prohibited",
        statement:
          `${path} is in the plan's paths_prohibited and the change modifies it. ` +
          "A prohibited path is never within the expansion budget.",
      }),
    );
  }
  for (const path of foreign) {
    findings.push(
      openFinding({
        rule_id: "scope.escape",
        file: path,
        severity: "blocker",
        blocking: true,
        blocking_reason:
          "deterministic: the change touches a package outside the plan's declared scope",
        statement:
          `${path} is outside the plan's paths_allowed and outside every package the plan ` +
          `declared (${[...allowedPackages].sort().join(", ")}). The contract must be revised.`,
      }),
    );
  }
  if (expansions.length > scope.expansion_budget_files) {
    for (const path of expansions) {
      findings.push(
        openFinding({
          rule_id: "scope.expansion_budget_exceeded",
          file: path,
          severity: "blocker",
          blocking: true,
          blocking_reason: "deterministic: in-package expansion exceeded expansion_budget_files",
          statement:
            `${expansions.length} files were touched outside paths_allowed but inside a declared ` +
            `package, against a budget of ${scope.expansion_budget_files}.`,
        }),
      );
    }
  } else {
    for (const path of expansions) {
      findings.push(
        openFinding({
          rule_id: "scope.expansion",
          file: path,
          severity: "advisory",
          blocking: false,
          blocking_reason:
            "deterministic: in-package expansion within expansion_budget_files is advisory",
          statement:
            `${path} is outside paths_allowed but inside a package the plan declared, and is ` +
            `within the expansion budget of ${scope.expansion_budget_files}.`,
        }),
      );
    }
  }

  const blockingCount = findings.filter((finding) => finding.blocking).length;
  const check: CheckResult = {
    check_id: "check_scope",
    name: "scope",
    kind: "scope",
    status: blockingCount === 0 ? "passed" : "failed",
    summary: `${outside.length + prohibited.length} outside paths_allowed`,
    // Not a command: the scope check is computed here rather than shelled out
    // to, and the column carries what it counted.
    command: `${changeset.files.length} files changed`,
    detail:
      prohibited.length > 0 || foreign.length > 0
        ? `prohibited: ${prohibited.join(", ") || "none"}; outside: ${foreign.join(", ") || "none"}`
        : null,
    duration_ms: null,
    source: "computed",
  };

  return {
    deviation: {
      files_outside_scope: [...prohibited, ...outside].sort(),
      files_in_prohibited_paths: prohibited.sort(),
      files_exempt_as_generated: generated.sort(),
      within_expansion_budget: withinBudget,
      expansion_budget_files: scope.expansion_budget_files,
    },
    findings,
    check,
  };
}
