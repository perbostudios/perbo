import type { ChangeSet, CheckResult, Finding, Scope } from "@perbo/contracts";
import { assessLegibility } from "./legibility.js";
import { assessScope } from "./scope.js";
import {
  ZERO_USAGE,
  addUsage,
  resolveModelCost,
  type Model,
  type ModelCostBasis,
  type ModelTurn,
  type ModelUsage,
} from "@perbo/model";

/**
 * Closure verification (D-061, SCP-101): the question asked after a remediation
 * round. It is deliberately **not** an independent review. A fresh opinion per
 * round is what made the false-block rate compound — each review is another
 * 44% draw from a well of true, unstated properties — so the re-review asks
 * exactly one thing per routed finding: *is this closed in the new change
 * set?* It may not raise new findings, and its verdict can only distinguish
 * closed from not-closed; the gate-opening judgement was made once, at round
 * zero, by the independent review.
 *
 * Two properties are enforced in code rather than hoped for:
 *
 * 1. **Deterministic evidence is consulted first and can only fail it.** A
 *    failed pinned check, or a scope escape in the fixed tree, fails
 *    verification before any model is asked. The model can never overrule the
 *    checks.
 * 2. **Uncertainty resolves toward a person.** `cannot_tell` — answered or
 *    implied by omission — counts as not closed. Verification exists to
 *    confirm work, never to wave it through.
 *
 * Like the reviewer, the verifier sees no transcript, narrative or summary of
 * the attempt. Unlike the reviewer, it *does* see the findings it verifies —
 * that is the point, and it is why its verdict has no authority to open the
 * gate on anything beyond them.
 */

/** v2 (2026-08-31, D-065): the idiomaticity question joined the schema. */
export const CLOSURE_VERIFY_PROMPT_VERSION = "closure_verify_v2";

export type ClosureStatus = "closed" | "not_closed" | "cannot_tell";

/**
 * D-065's second question, asked beside closure and never gating: is the fix
 * the established pattern, or merely a working one? A `working_but_not_idiomatic`
 * answer does not reopen the loop — the finding is closed and the checks pass —
 * it travels to the notification with the named practice, so the person who
 * merges sees "closed, though consider X" instead of discovering X later.
 * Recorded rather than routed because the two measured instances were both
 * correct code (a hand-rolled timingSafeEqual, an enumerated header list);
 * whether firing should cost a round is decided after its rate is known.
 */
export type ClosureIdiomatic = "established_pattern" | "working_but_not_idiomatic" | "cannot_tell";

export interface ClosureRow {
  finding_key: string;
  status: ClosureStatus;
  /** Where the closure is visible — a file, a test name, a hunk. Empty when not closed. */
  pointer: string;
  /** D-065: whether the fix is the established pattern. Never affects `status`. */
  idiomatic: ClosureIdiomatic;
  /** The established alternative, named, when `working_but_not_idiomatic`. Else empty. */
  practice: string;
}

export interface ClosureVerification {
  prompt_version: string;
  per_finding: ClosureRow[];
  /**
   * Set when a pinned check failed or the fixed tree escapes scope; the model
   * was not consulted and `per_finding` carries every finding as `cannot_tell`.
   */
  deterministic_failure: string | null;
  /** Which deterministic gate failed, so the stop can say so; `null` where none did. */
  deterministic_failure_kind: "check" | "scope" | "legibility" | null;
  all_closed: boolean;
  /** Findings still open after verification — the next round's work, if any. */
  open_keys: string[];
  usage: ModelUsage;
  cost_micros: number;
  /** `not_incurred` means deterministic evidence ended verification before a model call. */
  cost_basis: ModelCostBasis | "not_incurred";
}

/** JSON Schema for the verifier's single submit call. Keys are enumerated so the tool cannot invent a finding. */
export function closureVerifySchema(keys: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["closures"],
    properties: {
      closures: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["finding_key", "status", "pointer", "idiomatic", "practice"],
          properties: {
            finding_key: { type: "string", enum: keys },
            status: { type: "string", enum: ["closed", "not_closed", "cannot_tell"] },
            pointer: { type: "string" },
            idiomatic: {
              type: "string",
              enum: ["established_pattern", "working_but_not_idiomatic", "cannot_tell"],
              description:
                "Is the fix the established way to solve this — a platform or standard-library " +
                "primitive, the settled ecosystem pattern — or a working equivalent written by " +
                "hand? This does not affect whether the finding is closed.",
            },
            practice: {
              type: "string",
              description:
                "When working_but_not_idiomatic: name the established alternative, e.g. " +
                "'use crypto.timingSafeEqual'. Otherwise empty.",
            },
          },
        },
      },
    },
  };
}

export function closureVerifySystemPrompt(): string {
  return `You are verifying that specific findings from an earlier review were closed by a follow-up change.

You are NOT conducting a review. Do not raise new findings, do not judge the change's overall quality, and do not reconsider whether the findings were right. The independent review already happened; your verdict covers only the findings listed.

For each finding, answer:
- "closed" — the change set demonstrably addresses it; give a pointer to where (a file, a test, a hunk).
- "not_closed" — it is not addressed, or only partially.
- "cannot_tell" — the diff does not show enough to say. This counts as not closed.

Also answer, for each: is the fix the ESTABLISHED pattern — a platform or standard-library
primitive, the way the ecosystem settles this problem — or a working version written by hand?
A hand-rolled equivalent of a standard primitive, or an enumerated list standing in for general
handling, is "working_but_not_idiomatic": name the established alternative in "practice". This
answer never changes whether the finding is closed.

Call submit_review exactly once with one entry per finding key.`;
}

/** A `check.*` finding the review routed (d069): closed by the checks, not by the diff. */
function isRoutedCheckFinding(finding: Finding): boolean {
  return finding.source === "deterministic" && finding.rule_id.split(".")[0] === "check";
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…(clipped)` : text);

export async function verifyClosures(args: {
  findings: Finding[];
  diff: string;
  checks: CheckResult[];
  scope: Scope;
  changeset: ChangeSet;
  model: Model;
  onProgress?: (message: string) => void;
}): Promise<ClosureVerification> {
  const progress = args.onProgress ?? (() => undefined);
  const keys = args.findings.map((finding) => finding.key);
  const allCannotTell = (): ClosureRow[] =>
    keys.map((finding_key) => ({
      finding_key,
      status: "cannot_tell" as const,
      pointer: "",
      idiomatic: "cannot_tell" as const,
      practice: "",
    }));

  // 1. Deterministic evidence first. The model can fail verification; it can
  //    never rescue a tree the checks or the scope computation reject.
  const failedCheck = args.checks.find((check) => check.status !== "passed");
  if (failedCheck) {
    return {
      prompt_version: CLOSURE_VERIFY_PROMPT_VERSION,
      per_finding: allCannotTell(),
      deterministic_failure: `${failedCheck.check_id} is ${failedCheck.status}: the fixed tree does not pass the pinned checks`,
      deterministic_failure_kind: "check",
      all_closed: false,
      open_keys: keys,
      usage: ZERO_USAGE,
      cost_micros: 0,
      cost_basis: "not_incurred",
    };
  }
  const scopeAssessment = assessScope(args.changeset, args.scope);
  const scopeBlock = scopeAssessment.findings.find((finding) => finding.blocking);
  if (scopeBlock) {
    return {
      prompt_version: CLOSURE_VERIFY_PROMPT_VERSION,
      per_finding: allCannotTell(),
      deterministic_failure: `scope: ${scopeBlock.statement}`,
      deterministic_failure_kind: "scope",
      all_closed: false,
      open_keys: keys,
      usage: ZERO_USAGE,
      cost_micros: 0,
      cost_basis: "not_incurred",
    };
  }
  // A round that leaves illegible bytes in the change — the ones it was given
  // to remove, or new ones — fails here: the review routed them once, and this
  // is the once.
  const illegible = assessLegibility(args.diff, args.scope.generated_paths ?? []).findings[0];
  if (illegible) {
    return {
      prompt_version: CLOSURE_VERIFY_PROMPT_VERSION,
      per_finding: allCannotTell(),
      deterministic_failure: `legibility: ${illegible.statement} The round left the change illegible, so it stops here.`,
      deterministic_failure_kind: "legibility",
      all_closed: false,
      open_keys: keys,
      usage: ZERO_USAGE,
      cost_micros: 0,
      cost_basis: "not_incurred",
    };
  }

  // 1a. A routed check finding (d069) is closed by the evidence that just
  //     passed above: the pinned checks ran on the round's tree and every one
  //     passed, which is the whole of what the finding asked. The diff cannot
  //     show that, so the model is not asked; it is asked only about the rest.
  const checkRows: ClosureRow[] = args.findings
    .filter((finding) => isRoutedCheckFinding(finding))
    .map((finding) => {
      const check = args.checks.find((entry) => entry.name === finding.symbol);
      return {
        finding_key: finding.key,
        status: "closed" as const,
        pointer: `${check?.check_id ?? finding.symbol ?? "the pinned checks"} passed on the round's tree`,
        idiomatic: "cannot_tell" as const,
        practice: "",
      };
    });
  const modelFindings = args.findings.filter((finding) => !isRoutedCheckFinding(finding));
  const modelKeys = modelFindings.map((finding) => finding.key);

  // 1b. Nothing left to ask — every remaining finding was declined to a
  //     person (D-065) or closed by the checks above. The deterministic gates
  //     still applied: a tree that regressed the checks or escaped scope
  //     fails before this line.
  if (modelKeys.length === 0) {
    return {
      prompt_version: CLOSURE_VERIFY_PROMPT_VERSION,
      per_finding: checkRows,
      deterministic_failure: null,
      deterministic_failure_kind: null,
      all_closed: true,
      open_keys: [],
      usage: ZERO_USAGE,
      cost_micros: 0,
      cost_basis: "not_incurred",
    };
  }

  // 2. One model turn, forced to submit. No file reader and no second turn:
  //    the diff is the evidence, and a verification that needs to explore the
  //    repository is telling us the finding should go back to a person anyway.
  progress(`verifying ${modelKeys.length} closure(s)`);
  const findingsList = modelFindings
    .map(
      (finding) =>
        `- finding_key: ${finding.key}\n  rule: ${finding.rule_id}\n  file: ${finding.file ?? "(none)"}\n  statement: ${finding.statement}`,
    )
    .join("\n");
  let turn: ModelTurn;
  try {
    turn = await args.model.turn({
      system: closureVerifySystemPrompt(),
      messages: [
        {
          role: "user",
          content: `Findings to verify:\n${findingsList}\n\nThe follow-up change set:\n\n${clip(args.diff, 180_000)}`,
        },
      ],
      forceSubmit: true,
    });
  } finally {
    // One turn is the whole verification, so it is over here on both paths.
    await args.model.dispose?.();
  }

  const usage = addUsage(ZERO_USAGE, turn.usage);
  const submitCall = turn.toolCalls.find((call) => call.name === "submit_review");
  const submitted =
    submitCall && typeof submitCall.input === "object" && submitCall.input !== null
      ? ((submitCall.input as { closures?: unknown }).closures ?? [])
      : [];
  const byKey = new Map<string, ClosureRow>();
  if (Array.isArray(submitted)) {
    for (const row of submitted) {
      if (
        typeof row === "object" &&
        row !== null &&
        typeof (row as ClosureRow).finding_key === "string" &&
        modelKeys.includes((row as ClosureRow).finding_key) &&
        ["closed", "not_closed", "cannot_tell"].includes((row as ClosureRow).status)
      ) {
        const candidate = row as ClosureRow;
        byKey.set(candidate.finding_key, {
          finding_key: candidate.finding_key,
          status: candidate.status,
          pointer: typeof candidate.pointer === "string" ? candidate.pointer : "",
          idiomatic: ["established_pattern", "working_but_not_idiomatic", "cannot_tell"].includes(
            candidate.idiomatic,
          )
            ? candidate.idiomatic
            : "cannot_tell",
          practice: typeof candidate.practice === "string" ? candidate.practice : "",
        });
      }
    }
  }
  // A finding the model did not answer is `cannot_tell`, never silently closed.
  const per_finding: ClosureRow[] = [
    ...checkRows,
    ...modelKeys.map(
      (finding_key) =>
        byKey.get(finding_key) ?? {
          finding_key,
          status: "cannot_tell" as const,
          pointer: "",
          idiomatic: "cannot_tell" as const,
          practice: "",
        },
    ),
  ];
  const open_keys = per_finding.filter((row) => row.status !== "closed").map((row) => row.finding_key);
  const resolvedCost = resolveModelCost({
    usage,
    turns: 1,
    reportedTurns: turn.reported_cost_micros === undefined ? 0 : 1,
    reportedCostMicros: turn.reported_cost_micros ?? 0,
    unreportedCostBasis: args.model.unreported_cost_basis,
  });

  return {
    prompt_version: CLOSURE_VERIFY_PROMPT_VERSION,
    per_finding,
    deterministic_failure: null,
    deterministic_failure_kind: null,
    all_closed: open_keys.length === 0,
    open_keys,
    usage,
    cost_micros: resolvedCost.cost_micros,
    cost_basis: resolvedCost.cost_basis,
  };
}
