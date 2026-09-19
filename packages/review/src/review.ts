import { createHash } from "node:crypto";
import {
  MAX_REVIEWABLE_DIFF_BYTES,
  REVIEW_ARTIFACT_SCHEMA_VERSION,
  ReviewArtifactSchema,
  changeSetFromDiff,
  checkIsFailureOrAbsent,
  compareLevels,
  deriveActualRisk,
  maxLevel,
  findingKey,
  hasAcceptanceCriteria,
  type ChangeSet,
  type CheckResult,
  type CriterionEvidenceBinding,
  type DeterministicOverride,
  type Evidence,
  type Finding,
  type FindingDirection,
  type PlanContract,
  type PlanContractWithCriteria,
  type PlanLevel,
  type RejectedVerdict,
  type ReviewArtifact,
  type ReviewDecision,
  type ReviewError,
  type VerdictRejectionKind,
} from "@perbo/contracts";
import { assessAgentConfiguration } from "./agent-config.js";
import {
  CURRENT_ROUTING_POLICY,
  applyBlocking,
  decideBlocking,
  isHighActualRisk,
  type BlockingInput,
} from "./blocking.js";
import { PROMPT_VERSION, buildContext, renderReadFileResult, systemPrompt } from "./prompt.js";
import { DEFAULT_REPO_LIMITS, RepoReader, type RepoLimits } from "./repo.js";
import {
  ProviderError,
  ZERO_USAGE,
  addUsage,
  resolveModelCost,
  type ModelUsage,
  type ReviewModel,
} from "./provider.js";
import { NO_MEASUREMENTS, type RuleAuthority, type SuppressionLookup } from "./suppression.js";
import { assessLegibility, illegibleReadFindings } from "./legibility.js";
import { assessScope } from "./scope.js";
import {
  MalformedVerdictError,
  READ_FILE_TOOL,
  SUBMIT_REVIEW_TOOL,
  UnknownCriterionError,
  verdictSchemas,
  type ClosureAuthority,
  type ModelVerdict,
  type VerdictSchemas,
} from "./verdict.js";

export { UnknownCriterionError, MalformedVerdictError };

/**
 * The reviewer's inputs. There is no field here for the executor's narrative or
 * transcript, at any risk level — that is what makes the independence claim in
 * the artifact something other than a promise.
 */
export interface ReviewInput {
  contract: PlanContract;
  diff: string;
  /**
   * The sealed change set, where the caller has one. Its file list comes from
   * `git diff --name-status`, so it is complete whatever the diff's size, and a
   * `truncated` one is refused deterministically rather than reviewed as the
   * prefix that survived. Absent, the change set is parsed from the diff —
   * the standalone `perbo review` path, which reads the whole file.
   */
  changeset?: ChangeSet | undefined;
  checks: CheckResult[];
  repoDir: string;
  model: ReviewModel;
  head_commit?: string | undefined;
  /**
   * Whether the base the change was cut from passed the workspace's verify
   * command at provisioning — the runner's own reading. The verify command may
   * run fewer checks than the pinned set, and the base is the provisioning
   * one (a base merged up mid-run is not re-verified): so the flag says the
   * base was green on what verify runs, not on every pinned check, and a base
   * red on a check verify does not cover costs one round the verifier then
   * stops. With it, a pinned check failing on the change's tree is read as the
   * change's own breakage and d069 routes it once (`caused_by_change`);
   * without it, or where the base did not verify, the finding blocks as every
   * deterministic one does.
   */
  baseVerified?: boolean | undefined;
  suppressions?: SuppressionLookup | undefined;
  ruleAuthority?: RuleAuthority | undefined;
  repoLimits?: RepoLimits | undefined;
  /**
   * False on the last remediation round: with no round left there is nowhere to
   * route a finding, so it takes the outcome the four-row matrix gives it and a
   * human sees it (D-051's bound). This is policy state, not executor prose —
   * there is still no field here for a narrative, a transcript or a summary.
   */
  remediationAvailable?: boolean;
  maxTurns?: number;
  now?: Date;
  /** Progress lines. These go to stderr; nothing here reaches stdout. */
  onProgress?: (message: string) => void;
}

export interface ReviewOutcome {
  artifact: ReviewArtifact;
  /** The turn-by-turn record, for a run bundle. Never contains a credential. */
  bundle: {
    prompt_version: string;
    system_prompt: string;
    turns: Array<{ tool: string; input: unknown }>;
    files_read: Array<{ path: string; bytes: number; sha256: string; refused: string | null }>;
    /**
     * Each rejected verdict as it was submitted, beside the reason it was
     * rejected, so a run bundle can retain the artifact a person would need to
     * see what the reviewer actually returned.
     */
    rejected_verdicts: Array<RejectedVerdict & { input: unknown }>;
  };
}

export class PlanNotReviewableError extends Error {}

const DEFAULT_MAX_TURNS = 14;

/**
 * How many verdicts one review will consider: the first, and one correction
 * (SCP-165). A verdict the plan cannot accept is a fault in the reviewer's
 * answer rather than in the change it was judging, so the review asks again
 * before giving up on it. It asks once.
 */
const MAX_VERDICT_ATTEMPTS = 2;

/**
 * The turn that asks for a correction.
 *
 * A user turn on the conversation the rejected verdict was submitted to, not a
 * change to the reviewer prompt: the question the reviewer was asked, and the
 * version recorded against the artifact, are the same as for a review that got
 * it right first time. The reason is quoted exactly as it is recorded.
 */
function correctionTurn(reason: string): string {
  return (
    "The verdict you submitted was rejected before it was used, for this reason: " +
    `"${reason}"\n\n` +
    "Call submit_review again with a corrected verdict: exactly one coverage entry per " +
    "criterion in the plan, no criterion covered twice, no criterion the plan does not " +
    "contain, and a check_id only where the change set has one. This is the only correction " +
    "that will be asked for; a second rejected verdict ends the review with no verdict."
  );
}

type VerdictOutcome =
  | { ok: true; verdict: ModelVerdict }
  | { ok: false; kind: VerdictRejectionKind; reason: string };

/**
 * The plan's own check on the verdict, run again here whatever the provider
 * enforced (ADR-0023 §2). A criterion the plan does not contain, a criterion
 * covered twice, a check that is not on this change set, or a shape the schema
 * does not describe is a rejection carrying a reason — not a finding, and not
 * an exception the caller has to catch.
 */
function acceptVerdict(schemas: VerdictSchemas, input: unknown): VerdictOutcome {
  try {
    return { ok: true, verdict: schemas.parse(input) };
  } catch (caught) {
    if (caught instanceof UnknownCriterionError) {
      return { ok: false, kind: "unknown_criterion_id", reason: caught.message };
    }
    if (caught instanceof MalformedVerdictError) {
      return { ok: false, kind: "malformed_verdict", reason: caught.message };
    }
    throw caught;
  }
}

/** The review's error when no verdict survived, carrying every reason in order. */
function verdictRejectedError(
  rejected: readonly RejectedVerdict[],
  contract: PlanContractWithCriteria,
): ReviewError {
  return {
    kind: "verdict_rejected",
    message:
      `the reviewer returned ${rejected.length} verdict(s) this plan cannot accept: ` +
      rejected.map((entry) => `(${entry.attempt}) ${entry.reason}`).join("; "),
    attempts: rejected.length,
    unresolved_criteria: contract.acceptance_criteria.map((criterion) => criterion.id),
    // The transport worked and the model answered; no file is implicated.
    reading: [],
  };
}

function reviewId(changeset: ChangeSet, at: Date): string {
  const digest = createHash("sha256")
    .update(`${changeset.changeset_id}|${at.toISOString()}`)
    .digest("hex");
  return `rev_${digest.slice(0, 16)}`;
}

/**
 * Deterministic checks produce findings that block, with d069's one exception:
 * a check that ran and failed on a tree whose base verified is the change's own
 * breakage, marked `caused_by_change` with the check's last lines in the
 * statement so the executor can act on it. A check that `skipped` is not a
 * pass: it is a check that did not run, and treating it as evidence is the
 * vacuous-pass failure the corpus exists to catch.
 */
function checkFindings(checks: CheckResult[], baseVerified: boolean | undefined): Finding[] {
  return checks
    .filter((check) => check.source !== "computed" && checkIsFailureOrAbsent(check))
    .map((check) => ({
      key: findingKey({ rule_id: `check.${check.kind}`, file: null, symbol: check.name }),
      rule_id: `check.${check.kind}`,
      source: "deterministic" as const,
      criterion_id: null,
      severity: check.status === "skipped" ? ("major" as const) : ("blocker" as const),
      blocking: true,
      blocking_reason: "",
      confidence: null,
      file: null,
      line: null,
      symbol: check.name,
      statement:
        check.status === "skipped"
          ? `The ${check.name} check did not run (${check.summary}). A skipped check is not a ` +
            "passing one and establishes nothing."
          : `The ${check.name} check ${check.status} (${check.summary}).${checkTail(check)}`,
      status: "open" as const,
      outcome: "unknown" as const,
      row: null,
      closure: null,
      direction: null,
      caused_by_change:
        check.status === "failed" && baseVerified !== undefined ? baseVerified : null,
      routing: "blocks" as const,
      waiver: null,
    }));
}

/** How many characters of a failed check's output the finding carries: enough for the failing test's name and assertion, not the whole run. */
const CHECK_TAIL_CHARS = 600;

/**
 * The last lines of a failed check's output, for the executor's round: the
 * finding is the whole of what it is told, and "exited 1" is not actionable.
 */
function checkTail(check: CheckResult): string {
  if (check.status !== "failed" || !check.detail) return "";
  const tail = check.detail.trim().slice(-CHECK_TAIL_CHARS).trim();
  return tail.length === 0 ? "" : ` Its last lines:\n${tail}`;
}

/**
 * A change set whose diff was withheld for size cannot be judged from what
 * survived; a reviewer shown a prefix would approve files it never saw. The
 * finding is deterministic, blocks, and says what to do instead.
 */
function tooLargeFinding(changeset: ChangeSet): Finding {
  const bytes = changeset.diff_bytes ?? 0;
  return {
    key: findingKey({ rule_id: "changeset.too_large_to_review", file: null, symbol: null }),
    rule_id: "changeset.too_large_to_review",
    source: "deterministic",
    criterion_id: null,
    severity: "blocker",
    blocking: true,
    blocking_reason: "",
    confidence: null,
    file: null,
    line: null,
    symbol: null,
    statement:
      `The diff is ${bytes} bytes, above the ${MAX_REVIEWABLE_DIFF_BYTES}-byte cap, so it was ` +
      "withheld from review rather than cut: a reviewer shown a prefix would judge files it " +
      `never saw. The ${changeset.files.length} changed paths were still checked for scope. ` +
      "Split the change into reviewable pieces.",
    status: "open",
    outcome: "unknown",
    row: null,
    closure: null,
    direction: null,
    caused_by_change: null,
    routing: "blocks",
    waiver: null,
  };
}

/**
 * ADR-0023 §3. Where the model asserts something a check measured, the check is
 * authoritative and the assertion is discarded — and the discard is recorded,
 * because an unrecorded one is indistinguishable from the model never having
 * made the claim.
 */
function applyDeterministicPrecedence(
  verdict: ModelVerdict,
  checks: CheckResult[],
): { overrides: DeterministicOverride[]; discreditedChecks: Set<string> } {
  const measured = new Map(checks.map((check) => [check.check_id, check]));
  const overrides: DeterministicOverride[] = [];
  const discreditedChecks = new Set<string>();

  for (const assertion of verdict.check_assertions) {
    const check = measured.get(assertion.check_id);
    if (!check) continue;
    if (check.status === assertion.asserted_status) continue;
    overrides.push({
      check_id: check.check_id,
      check_name: check.name,
      measured_status: check.status,
      asserted_status: assertion.asserted_status,
      discarded:
        `the reviewer's claim that ${check.name} ${assertion.asserted_status}; the recorded ` +
        `measurement is ${check.status} and is authoritative`,
    });
    discreditedChecks.add(check.check_id);
  }

  return { overrides, discreditedChecks };
}

/**
 * SCP-082. An assertion the reviewer cannot name is not `directly_verified`,
 * and neither is one resting on a check that did not pass. Both corrections are
 * deterministic, applied after the model has spoken.
 */
function correctVerificationStrength(
  entry: ModelVerdict["coverage"][number],
  checks: Map<string, CheckResult>,
  discredited: Set<string>,
): { strength: CriterionEvidenceBinding["verification_strength"]; note: string | null } {
  const named = (entry.evidence_assertion ?? "").trim().length > 0;
  if (entry.verification_strength !== "directly_verified") {
    return { strength: entry.verification_strength, note: null };
  }
  if (!named) {
    return {
      strength: "asserted_only",
      note: "downgraded: directly_verified requires naming the assertion, and none was named",
    };
  }
  const ref = entry.evidence_ref;
  if (ref && checks.has(ref)) {
    const check = checks.get(ref)!;
    if (check.status !== "passed") {
      return {
        strength: "asserted_only",
        note:
          `downgraded: the cited check ${check.check_id} ${check.status}, so it establishes ` +
          "nothing",
      };
    }
    if (discredited.has(ref)) {
      return {
        strength: "proxy",
        note: `downgraded: the reviewer's claim about ${ref} was overridden by the measurement`,
      };
    }
  }
  return { strength: "directly_verified", note: null };
}

function evidenceOf(entry: ModelVerdict["coverage"][number]): Evidence | null {
  if (entry.evidence_type === "none") return null;
  return {
    type: entry.evidence_type,
    ref: entry.evidence_ref,
    assertion: entry.evidence_assertion,
    location: entry.evidence_file
      ? { file: entry.evidence_file, line: entry.evidence_line, symbol: entry.evidence_symbol }
      : null,
  };
}

/**
 * How many of a review's findings escalated to a person (D-051): every
 * finding whose routing the blocking matrix decided was `escalates`, which
 * `applyBlocking` stamps onto `routing` unconditionally — so this reads back
 * from a final `findings` list the same count `runReview` decides it with,
 * and `combineReviews` (`graph.ts`) reads it the same way over the combined
 * list (D-107).
 */
export function escalationCount(findings: readonly Finding[]): number {
  return findings.filter((finding) => finding.routing === "escalates").length;
}

/**
 * The decision is derived, never emitted.
 *
 * docs/04 requires `decision` to be structured output over the plan's criteria
 * list and never parsed from prose. Deriving it from the structured per-criterion
 * answers is that, one step stronger: there is no `decision` field for an
 * instruction planted in repository content to aim at.
 *
 * `incomplete` outranks `changes_requested` because it is the more honest
 * signal and exits 3 rather than 2 — a reviewer that could not reach a verdict
 * on a criterion has not completed, whatever else it found.
 */
export function deriveDecision(args: {
  error: ReviewError | null;
  coverage: CriterionEvidenceBinding[];
  findings: Finding[];
  escalations: number;
}): ReviewDecision {
  if (args.error) return "error";
  if (args.coverage.some((entry) => entry.status === "cannot_determine")) return "incomplete";
  if (args.findings.some((finding) => finding.blocking)) return "changes_requested";
  // Escalation outranks remediation: if anything already needs a person, the
  // person is the bottleneck and spending an attempt first only delays them.
  if (args.escalations > 0) return "escalate";
  if (args.findings.some((finding) => finding.routing === "remediable")) return "remediable";
  return "approve";
}

export async function runReview(input: ReviewInput): Promise<ReviewOutcome> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const progress = input.onProgress ?? (() => undefined);

  if (!hasAcceptanceCriteria(input.contract)) {
    throw new PlanNotReviewableError(
      `plan ${input.contract.plan_id} is level ${input.contract.level}, which carries no ` +
        "acceptance criteria. Independent semantic review is not defined for it.",
    );
  }
  const contract: PlanContractWithCriteria = input.contract;

  const changeset =
    input.changeset ??
    changeSetFromDiff({
      diff: input.diff,
      base_commit: contract.base.base_commit,
      head_commit: input.head_commit,
    });
  const actualRisk = deriveActualRisk(changeset, contract.scope);
  const plannedRisk: PlanLevel = contract.level;
  // If actual exceeds planned the attempt is escalated, not discarded: the
  // stronger review and approval policy applies before publication.
  const escalated = compareLevels(actualRisk.level, plannedRisk) > 0;
  // Review is conducted under the stronger of the two. A human may raise a
  // level and may not lower one, so the declared level is a floor rather than a
  // description.
  const riskLevel = maxLevel(plannedRisk, actualRisk.level);

  progress(
    `change set ${changeset.changeset_id} (${changeset.base_commit} -> ${changeset.head_commit}), ` +
      `${changeset.files.length} files, actual_risk ${actualRisk.level}`,
  );

  // Deterministic first. It is cheap, it has near-zero false positives on the
  // classes it covers, and its results outrank anything the model says next.
  const scope = assessScope(changeset, contract.scope);
  const agentConfig = assessAgentConfiguration(changeset);
  // SCP-114. Asked here rather than after the model, because a file the diff
  // will not render is absent from everything downstream — including the
  // context the reviewer reads.
  const legibility = assessLegibility(input.diff ?? "", contract.scope.generated_paths ?? []);
  const checks: CheckResult[] = [
    ...input.checks,
    scope.check,
    agentConfig.check,
    legibility.check,
  ];
  const checkIndex = new Map(checks.map((check) => [check.check_id, check]));

  const reader = new RepoReader(input.repoDir, input.repoLimits ?? DEFAULT_REPO_LIMITS);
  const tree = reader.tree();
  const context = buildContext({ contract, changeset, checks, tree });
  const system = systemPrompt(contract, actualRisk.level);
  const schemas = verdictSchemas(
    contract.acceptance_criteria.map((criterion) => criterion.id),
    checks.map((check) => check.check_id),
  );

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: context.render() },
  ];
  const turns: Array<{ tool: string; input: unknown }> = [];

  let usage: ModelUsage = ZERO_USAGE;
  let modelTurns = 0;
  let reportedCostTurns = 0;
  let reportedCostMicros = 0;
  let verdict: ModelVerdict | null = null;
  let error: ReviewError | null = null;
  /**
   * The paths of the last batch of reads answered back to the model.
   *
   * A turn that fails is the turn carrying those results, so this is what the
   * review was reading when it died — the one fact that makes a re-run of the
   * ticket different from the run that failed (SCP-188).
   */
  let reading: string[] = [];
  const rejected: Array<RejectedVerdict & { input: unknown }> = [];
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;

  // A withheld diff leaves nothing for the model to judge, so it is not asked:
  // the deterministic finding below closes the gate and the coverage records
  // that no criterion was reached.
  if (changeset.truncated) {
    progress(`the diff is ${changeset.diff_bytes ?? "?"} bytes and was withheld; no model call`);
  }

  try {
    for (let turn = 0; turn < maxTurns && verdict === null && !changeset.truncated; turn += 1) {
      const forceSubmit = turn === maxTurns - 1;
      const result = await input.model.turn({ system, messages, forceSubmit });
      modelTurns += 1;
      usage = addUsage(usage, result.usage);
      if (result.reported_cost_micros !== undefined) {
        reportedCostTurns += 1;
        reportedCostMicros += result.reported_cost_micros;
      }

      const submit = result.toolCalls.find((call) => call.name === SUBMIT_REVIEW_TOOL);
      if (submit) {
        turns.push({ tool: SUBMIT_REVIEW_TOOL, input: submit.input });
        const accepted = acceptVerdict(schemas, submit.input);
        if (accepted.ok) {
          verdict = accepted.verdict;
          break;
        }
        rejected.push({
          attempt: rejected.length + 1,
          kind: accepted.kind,
          reason: accepted.reason,
          input: submit.input,
        });
        progress(`verdict rejected: ${accepted.reason}`);
        if (rejected.length >= MAX_VERDICT_ATTEMPTS) {
          error = verdictRejectedError(rejected, contract);
          break;
        }
        // The correction is asked for on this conversation, as a tool result on
        // the submission that was rejected — the shape every other turn uses,
        // and the one a resumed session carries.
        messages.push({
          role: "assistant",
          content: [
            { type: "tool_use", id: submit.id, name: submit.name, input: submit.input },
          ],
        });
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: submit.id,
              content: correctionTurn(accepted.reason),
              is_error: true,
            },
          ],
        });
        continue;
      }

      const reads = result.toolCalls.filter((call) => call.name === READ_FILE_TOOL);
      if (reads.length === 0) {
        // The model stopped without asking for anything and without submitting.
        // One more turn, with the submit tool forced.
        messages.push({ role: "assistant", content: [{ type: "text", text: "(no tool call)" }] });
        messages.push({
          role: "user",
          content: "Call submit_review now with one coverage entry per criterion.",
        });
        continue;
      }

      messages.push({
        role: "assistant",
        content: reads.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      });
      const results = reads.map((call) => {
        const path = String((call.input as { path?: unknown })?.path ?? "");
        const outcome = reader.read(path);
        turns.push({ tool: READ_FILE_TOOL, input: { path } });
        progress(`read ${path}${outcome.ok ? "" : " (refused)"}`);
        // SCP-077 acceptance criterion 6: the trust tier of every context item
        // is recorded. A file the reviewer chose to open is a context item, and
        // recording only the four the builder started with would answer "what
        // did the model read" with the part nobody selected.
        if (outcome.ok) {
          context.add({
            kind: "repo_file",
            trust: "repo",
            provenance: `${path} at head`,
            selection_reason: "independently selected by the reviewer",
            body: outcome.content,
            attrs: { path },
          });
        }
        return {
          type: "tool_result" as const,
          tool_use_id: call.id,
          content: renderReadFileResult(outcome),
          // A refused read is a failed tool call as far as the model is
          // concerned; the refusal text says why, and the flag says not to
          // treat it as the file's contents.
          ...(outcome.ok ? {} : { is_error: true }),
        };
      });
      messages.push({ role: "user", content: results });
      reading = reads.map((call) => String((call.input as { path?: unknown })?.path ?? ""));
    }

    if (verdict === null && error === null && !changeset.truncated) {
      error =
        rejected.length > 0
          ? // The turn budget ran out before the correction could be asked for.
            verdictRejectedError(rejected, contract)
          : {
              kind: "malformed_verdict",
              message: `the reviewer did not submit a verdict within ${maxTurns} turns`,
              attempts: maxTurns,
              unresolved_criteria: contract.acceptance_criteria.map((criterion) => criterion.id),
              reading: [],
            };
    }
  } catch (caught) {
    if (caught instanceof ProviderError) {
      error = {
        kind: caught.kind,
        message: caught.message,
        attempts: caught.attempts,
        unresolved_criteria: contract.acceptance_criteria.map((criterion) => criterion.id),
        reading,
      };
    } else {
      error = {
        kind: "internal",
        message: caught instanceof Error ? caught.message : String(caught),
        attempts: 1,
        unresolved_criteria: contract.acceptance_criteria.map((criterion) => criterion.id),
        reading,
      };
    }
  } finally {
    // The review is over for the transport whatever happens next: no further
    // turn is taken, and what it holds for this review goes now rather than at
    // the caller's convenience.
    await input.model.dispose?.();
  }

  const { overrides, discreditedChecks } =
    verdict !== null
      ? applyDeterministicPrecedence(verdict, checks)
      : { overrides: [] as DeterministicOverride[], discreditedChecks: new Set<string>() };
  for (const override of overrides) {
    progress(`override: ${override.discarded}`);
  }

  // Coverage: every criterion in the plan gets an entry, whether or not the
  // model produced one. A criterion nobody answered is `cannot_determine`, not
  // an absence — an absent criterion reads as a pass.
  const answered = new Map((verdict?.coverage ?? []).map((entry) => [entry.criterion_id, entry]));
  const coverage: CriterionEvidenceBinding[] = contract.acceptance_criteria.map((criterion) => {
    const entry = answered.get(criterion.id);
    if (!entry) {
      return {
        criterion_id: criterion.id,
        status: "cannot_determine",
        verification_strength: "asserted_only",
        evidence: null,
        authored_in_response_to: null,
        note: error
          ? "no verdict was reached on this criterion"
          : changeset.truncated
            ? "the diff was withheld from review for size, so no criterion was judged"
            : "the reviewer returned no answer for this criterion",
      };
    }
    const corrected = correctVerificationStrength(entry, checkIndex, discreditedChecks);
    return {
      criterion_id: criterion.id,
      status: entry.status,
      verification_strength: corrected.strength,
      evidence: evidenceOf(entry),
      authored_in_response_to: null,
      note: [corrected.note, entry.note].filter(Boolean).join("; ") || null,
    };
  });

  // The reviewer's per-criterion answer to "who can close this", kept beside the
  // coverage so the derived `criterion.unverified` finding can be routed by the
  // same judgement that produced it.
  const coverageClosure = new Map<string, ClosureAuthority | null>(
    (verdict?.coverage ?? []).map((entry) => [
      entry.criterion_id,
      entry.closure === "none" ? null : entry.closure,
    ]),
  );

  // Findings, in matrix order: deterministic first, then contract, then
  // verification strength, then semantic.
  const suppressions = input.suppressions;
  const authority: RuleAuthority = input.ruleAuthority ?? NO_MEASUREMENTS;
  const repositoryId = contract.scope.repository_id;
  const waivedFor = (rule_id: string) => suppressions?.find(rule_id, repositoryId) ?? null;

  const raw: Array<{
    finding: Finding;
    row: Parameters<typeof decideBlocking>[0]["row"];
    closure: ClosureAuthority | null;
    direction: FindingDirection | null;
  }> = [];

  // Deterministic findings carry no closure and are never routed — but for a
  // legibility finding on a path the change touched (d068): a failing
  // check or a scope escape says the change is wrong, not that it is unevidenced.
  for (const finding of [
    ...(changeset.truncated ? [tooLargeFinding(changeset)] : []),
    ...scope.findings,
    ...agentConfig.findings,
    ...legibility.findings,
    // A file the reviewer opened and could not read, for the same reason the
    // diff would not render it (SCP-188). The reads are over by now: the model
    // loop above has finished, whether with a verdict or with an error.
    ...illegibleReadFindings(reader.filesRead(), contract.scope.generated_paths ?? []),
    ...checkFindings(checks, input.baseVerified),
  ]) {
    raw.push({
      finding,
      row: finding.blocking ? "deterministic" : "semantic_ordinary",
      closure: null,
      // Deterministic findings are not asked: they are never routed, but for a
      // legibility finding on a path the change touched, which d068 routes on
      // `caused_by_change` rather than on an answer; the contract and
      // verification rows below are negative by construction and need no
      // answer either (D-064).
      direction: null,
    });
  }

  for (const entry of coverage) {
    if (entry.status === "not_met") {
      raw.push({
        finding: {
          key: findingKey({
            rule_id: "criterion.not_met",
            criterion_id: entry.criterion_id,
            file: entry.evidence?.location?.file ?? null,
            symbol: entry.evidence?.location?.symbol ?? null,
          }),
          rule_id: "criterion.not_met",
          source: "semantic",
          criterion_id: entry.criterion_id,
          severity: "blocker",
          blocking: true,
          blocking_reason: "",
          confidence: verdict?.overall_confidence ?? null,
          file: entry.evidence?.location?.file ?? null,
          line: entry.evidence?.location?.line ?? null,
          symbol: entry.evidence?.location?.symbol ?? null,
          statement:
            `${entry.criterion_id} is not met: ` +
            (entry.note ?? entry.evidence?.assertion ?? "the change does not satisfy it"),
          status: "open",
          outcome: "unknown",
          row: null,
          closure: null,
          direction: null,
          caused_by_change: null,
          routing: "blocks",
          waiver: null,
        },
        row: "contract",
        // D-056. The reviewer already answered who can close this criterion;
        // discarding it here is what made the contract row unroutable.
        closure: coverageClosure.get(entry.criterion_id) ?? null,
        direction: null,
      });
      continue;
    }
    if (entry.status === "met" && entry.verification_strength === "asserted_only") {
      raw.push({
        finding: {
          key: findingKey({
            rule_id: "criterion.unverified",
            criterion_id: entry.criterion_id,
            file: entry.evidence?.location?.file ?? null,
            symbol: entry.evidence?.location?.symbol ?? null,
          }),
          rule_id: "criterion.unverified",
          source: "semantic",
          criterion_id: entry.criterion_id,
          severity: "major",
          blocking: false,
          blocking_reason: "",
          confidence: verdict?.overall_confidence ?? null,
          file: entry.evidence?.location?.file ?? null,
          line: entry.evidence?.location?.line ?? null,
          symbol: entry.evidence?.location?.symbol ?? null,
          statement:
            `${entry.criterion_id} is established only by an assertion that does not exercise ` +
            `the criterion: ${entry.evidence?.assertion ?? "no assertion was named"}.`,
          status: "open",
          outcome: "unknown",
          row: null,
          closure: null,
          direction: null,
          caused_by_change: null,
          routing: "advisory",
          waiver: null,
        },
        row: "verification_strength",
        closure: coverageClosure.get(entry.criterion_id) ?? null,
        direction: null,
      });
    }
  }

  for (const finding of verdict?.findings ?? []) {
    raw.push({
      finding: {
        key: findingKey({
          rule_id: finding.rule_id,
          criterion_id: finding.criterion_id,
          file: finding.file,
          symbol: finding.symbol,
        }),
        rule_id: finding.rule_id,
        source: "semantic",
        criterion_id: finding.criterion_id,
        severity: finding.severity,
        blocking: false,
        blocking_reason: "",
        confidence: finding.confidence,
        file: finding.file,
        line: finding.line,
        symbol: finding.symbol,
        statement: finding.statement,
        status: "open",
        outcome: "unknown",
        row: null,
        closure: null,
        direction: null,
        caused_by_change: null,
        routing: "advisory",
        waiver: null,
      },
      row: isHighActualRisk(riskLevel) ? "semantic_high_risk" : "semantic_ordinary",
      closure: finding.closure,
      direction: finding.direction,
    });
  }

  const touched = pathsInDiff(input.diff ?? "");
  const seenKeys = new Set<string>();
  const findings: Finding[] = [];
  for (const { finding, row, closure, direction } of raw) {
    if (seenKeys.has(finding.key)) continue;
    seenKeys.add(finding.key);
    const waiver = waivedFor(finding.rule_id);
    const lookup: BlockingInput = {
      row,
      rule_id: finding.rule_id,
      criterion_id: finding.criterion_id ?? null,
      confidence: finding.confidence,
      risk_level: riskLevel,
      rule_demoted: authority.demoted(finding.rule_id),
      waived: waiver !== null,
      closure,
      direction,
      remediation_available: input.remediationAvailable ?? true,
      // A legibility finding on a path the diff touches is the change's own;
      // a check finding carries the runner's answer (the base verified) in.
      caused_by_change:
        finding.rule_id.split(".")[0] === "legibility" && finding.file !== null
          ? touched.has(finding.file)
          : finding.rule_id.split(".")[0] === "check"
            ? (finding.caused_by_change ?? undefined)
            : undefined,
    };
    const decision = decideBlocking(lookup);
    findings.push({ ...applyBlocking(finding, decision, lookup), waiver });
  }

  const decision = deriveDecision({ error, coverage, findings, escalations: escalationCount(findings) });

  const resolvedCost = resolveModelCost({
    usage,
    turns: modelTurns,
    reportedTurns: reportedCostTurns,
    reportedCostMicros,
    unreportedCostBasis: input.model.unreported_cost_basis,
  });
  const artifact = ReviewArtifactSchema.parse({
    schema_version: REVIEW_ARTIFACT_SCHEMA_VERSION,
    review_id: reviewId(changeset, now),
    created_at: now.toISOString(),
    target: {
      type: "changeset",
      id: changeset.changeset_id,
      base_commit: changeset.base_commit,
      head_commit: changeset.head_commit,
    },
    plan_id: contract.plan_id,
    plan_version: contract.version,
    planned_risk: plannedRisk,
    actual_risk: actualRisk.level,
    escalated,
    independence: {
      context_builder: PROMPT_VERSION,
      executor_narrative_visible: false,
      executor_transcript_visible: false,
      separate_process: true,
      model_family: "same",
      grounded_in: ["plan.acceptance_criteria", "diff", "check_results", "selected_files"],
    },
    context_manifest: context.manifest(),
    checks,
    overrides,
    coverage,
    findings,
    scope_deviation: scope.deviation,
    rejected_verdicts: rejected.map(({ attempt, kind, reason }) => ({ attempt, kind, reason })),
    decision,
    routing_policy: CURRENT_ROUTING_POLICY,
    confidence: verdict?.overall_confidence ?? null,
    cost_micros: resolvedCost.cost_micros,
    latency_ms: Date.now() - startedAt,
    model: {
      provider: input.model.provider,
      model_id: input.model.model_id,
      prompt_version: PROMPT_VERSION,
      input_tokens:
        usage.input_tokens +
        usage.cache_read_input_tokens +
        usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      output_tokens: usage.output_tokens,
      cost_basis: resolvedCost.cost_basis,
    },
    error,
  });

  return {
    artifact,
    bundle: {
      prompt_version: PROMPT_VERSION,
      system_prompt: system,
      turns,
      files_read: reader.filesRead().map((outcome) =>
        outcome.ok
          ? { path: outcome.path, bytes: outcome.bytes, sha256: outcome.sha256, refused: null }
          : { path: outcome.path, bytes: 0, sha256: "", refused: outcome.refusal },
      ),
      rejected_verdicts: rejected,
    },
  };
}

/** Every path the diff adds or modifies, as its headers name them. */
function pathsInDiff(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const path = match[2];
    if (path !== undefined) paths.add(path);
  }
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const path = match[1];
    if (path !== undefined) paths.add(path);
  }
  return paths;
}
