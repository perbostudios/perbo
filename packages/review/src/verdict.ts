import { z } from "zod";
import {
  CHECK_STATUSES,
  CLOSURE_AUTHORITIES,
  COVERAGE_STATUSES,
  EVIDENCE_TYPES,
  FINDING_DIRECTIONS,
  SEVERITIES,
  VERIFICATION_STRENGTHS,
  type ClosureAuthority,
  type FindingDirection,
} from "@perbo/contracts";

/**
 * The structured verdict (ADR-0023 §2, SCP-077).
 *
 * The criterion enum is built from the approved plan, so the tool schema itself
 * cannot express a criterion the plan does not have. `parseVerdict` checks the
 * same thing again on the way back, because a schema the provider enforces is
 * not a schema this process verified — and a verdict naming an unknown
 * `criterion_id` is a hard error, not a finding.
 *
 * There is no `decision` field, deliberately. The verdict is derived from these
 * structured answers, the deterministic checks and the blocking matrix. A model
 * that has been talked into approving something has nowhere to put it.
 */

/**
 * A fragment of the submission, made fit to put in a rejection reason.
 *
 * A rejection reason is recorded on the artifact, read by a person, and quoted
 * back to the reviewer as the retry turn, which the transport sends on stdin.
 * Anything taken from the verdict is therefore reduced to printable ASCII on a
 * single line, and kept whole (D-NEW-nothing-shown-is-cut).
 */
function fromSubmission(value: string): string {
  return value.replace(/[^\x20-\x7E]+/g, " ").replace(/\s+/g, " ").trim();
}

export class UnknownCriterionError extends Error {
  readonly criterion_id: string;
  readonly known: string[];

  constructor(criterion_id: string, known: string[]) {
    super(
      `verdict references criterion_id '${fromSubmission(criterion_id)}', which the approved ` +
        `plan does not contain (plan criteria: ${known.join(", ")})`,
    );
    this.name = "UnknownCriterionError";
    this.criterion_id = criterion_id;
    this.known = known;
  }
}

export class MalformedVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedVerdictError";
  }
}

/**
 * Who can close this, asked of the reviewer as structured output (D-051, SCP-094).
 *
 * The routing rule is **not** "is it about tests". It is whether the executor
 * can close the finding without a decision only a human can make. Two things
 * that look like verification findings and are not: a criterion with no test
 * *because the feature is a stub*, and a test that cannot be written because
 * its dependency returns a constant. Both are behavioural, and both are `human`.
 *
 * The vocabulary itself lives in `@perbo/contracts`, with the finding the
 * answer is recorded on. What stays here is the wording, because the wording is
 * prompt surface.
 */
export { CLOSURE_AUTHORITIES };
export type { ClosureAuthority };
export const COVERAGE_CLOSURES = ["none", ...CLOSURE_AUTHORITIES] as const;

/**
 * The question, `reviewer_v5`.
 *
 * `reviewer_v3` asked the same question in wording the measurement showed was
 * answered `human` by default: `executor` required "the one **obviously**
 * correct fix" against three broad alternatives for `human`, and the tie-break
 * — "answer 'unclear' rather than guessing 'executor'" — was read as *when in
 * doubt, a person*. Over 1,116 findings the reviewer answered `unclear` six
 * times and never once on a clean change, and 24 of the 28 blocking findings on
 * clean changes carried its own `human`.
 *
 * Three edits, one per observation: the definitions are symmetric, the
 * tie-break is replaced by the discriminator, and the reviewer is told the fact
 * that makes the question answerable — **both answers close the gate**. A
 * reviewer that thinks `executor` means "waved through" will hoard findings for
 * a person, which is what it did.
 *
 * Saying what the answer means is not the same as letting a model aim at a
 * verdict, and the difference is structural: `closure` cannot reach `approve`,
 * every routable outcome exits 2, `context.*` and `security.*` never route at
 * any answer, and there is still no `decision` field for anything to aim at.
 */
const CLOSURE_DESCRIPTION =
  "Who should be asked to close this first. " +
  "Both answers close the gate: the change does not merge either way, and an executor's work is " +
  "graded afterwards by a fresh independent review that is told nothing about why the code was " +
  "written. What you are choosing is who is asked first, not whether this is stopped. " +
  "'executor' — a coding agent working from the plan could close it: writing the missing test, " +
  "making an assertion real, or applying the fix the plan already implies. The plan states the " +
  "behaviour and the code does not match it yet. " +
  "'human' — closing it requires deciding what the software should do, beyond what the plan " +
  "already states: the correct behaviour is genuinely in question, or the change does something " +
  "the plan never asked for, or the criterion cannot be established in this tree at all because a " +
  "feature is a stub or a dependency returns a constant. " +
  "'unclear' — you genuinely cannot tell which of the two it is.";

/**
 * The direction question (D-064).
 *
 * The wording was validated on a person before it was asked of a model: the
 * Product Owner classified the whole blocking-on-clean population under it,
 * blind, and every answer had a direction. What the
 * answer decides is who acts first, not whether the finding is real: a
 * negative finding is fixed by the executor and the person is told; a neutral
 * one stops the change so the person can decide. `security.*` and `context.*`
 * stop whatever this answer says, so nothing here can talk a credential past
 * the gate.
 */
const DIRECTION_DESCRIPTION =
  "Does this finding have a direction? " +
  "'negative' — a defect, weakness or risk. It should not be that way, so fixing it needs no " +
  "product decision: the correct direction is known even if the exact fix is not. " +
  "'neutral' — a change to observable behaviour that the specification does not describe. No " +
  "correct direction exists; whether the software should do this is a product question only the " +
  "owner can answer. " +
  "'unsure' — you genuinely cannot tell whether it has a direction. " +
  "This is not severity: a minor finding with a direction is still 'negative', and a large " +
  "behavioural surprise with no direction is still 'neutral'.";

export interface VerdictSchemas {
  /** JSON Schema for the provider's `strict` tool definition. */
  toolInputSchema: Record<string, unknown>;
  /** The same shape, verified again locally. */
  parse: (input: unknown) => ModelVerdict;
}

const enumSchema = (values: readonly string[]) => ({ type: "string", enum: [...values] });
const nullableString = { type: ["string", "null"] };

export interface ModelVerdict {
  coverage: Array<{
    criterion_id: string;
    status: (typeof COVERAGE_STATUSES)[number];
    verification_strength: (typeof VERIFICATION_STRENGTHS)[number];
    evidence_type: (typeof EVIDENCE_TYPES)[number] | "none";
    evidence_ref: string | null;
    evidence_assertion: string | null;
    evidence_file: string | null;
    evidence_line: number | null;
    evidence_symbol: string | null;
    note: string | null;
    closure: (typeof COVERAGE_CLOSURES)[number];
  }>;
  findings: Array<{
    rule_id: string;
    criterion_id: string | null;
    severity: (typeof SEVERITIES)[number];
    confidence: number;
    file: string | null;
    line: number | null;
    symbol: string | null;
    statement: string;
    closure: ClosureAuthority;
    direction: FindingDirection;
  }>;
  check_assertions: Array<{
    check_id: string;
    asserted_status: (typeof CHECK_STATUSES)[number];
  }>;
  overall_confidence: number;
}

export function verdictSchemas(criterionIds: string[], checkIds: string[]): VerdictSchemas {
  const criterionEnum = enumSchema(criterionIds);
  const criterionOrNull = {
    anyOf: [{ type: "string", enum: [...criterionIds] }, { type: "null" }],
  };

  const toolInputSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["coverage", "findings", "check_assertions", "overall_confidence"],
    properties: {
      coverage: {
        type: "array",
        description:
          "One entry for every criterion in the plan. Exactly one entry per criterion id.",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "criterion_id",
            "status",
            "verification_strength",
            "evidence_type",
            "evidence_ref",
            "evidence_assertion",
            "evidence_file",
            "evidence_line",
            "evidence_symbol",
            "note",
            "closure",
          ],
          properties: {
            criterion_id: criterionEnum,
            status: enumSchema(COVERAGE_STATUSES),
            verification_strength: enumSchema(VERIFICATION_STRENGTHS),
            evidence_type: enumSchema([...EVIDENCE_TYPES, "none"]),
            evidence_ref: {
              ...nullableString,
              description: "A check_id where a check established it, otherwise a repo reference.",
            },
            evidence_assertion: {
              ...nullableString,
              description:
                "The exact assertion establishing this criterion, quoted. Required for " +
                "directly_verified: an assertion you cannot name is not one.",
            },
            evidence_file: nullableString,
            evidence_line: { type: ["integer", "null"], minimum: 1 },
            evidence_symbol: nullableString,
            note: nullableString,
            closure: {
              ...enumSchema(COVERAGE_CLOSURES),
              description:
                "'none' when the evidence already establishes this criterion. Otherwise: " +
                CLOSURE_DESCRIPTION,
            },
          },
        },
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "rule_id",
            "criterion_id",
            "severity",
            "confidence",
            "file",
            "line",
            "symbol",
            "statement",
            "closure",
            "direction",
          ],
          properties: {
            rule_id: {
              type: "string",
              description:
                "Dotted and stable, e.g. criterion.unverified, security.cors_wildcard_credentials, " +
                "migration.blocking_lock, context.injected_instruction.",
            },
            criterion_id: criterionOrNull,
            severity: enumSchema(SEVERITIES),
            confidence: { type: "number", minimum: 0, maximum: 1 },
            file: nullableString,
            line: { type: ["integer", "null"], minimum: 1 },
            symbol: nullableString,
            statement: {
              type: "string",
              description: "Intelligible with no diff beside it.",
            },
            closure: { ...enumSchema(CLOSURE_AUTHORITIES), description: CLOSURE_DESCRIPTION },
            direction: { ...enumSchema(FINDING_DIRECTIONS), description: DIRECTION_DESCRIPTION },
          },
        },
      },
      check_assertions: {
        type: "array",
        description:
          "Every deterministic check you relied on, with the status you believe it had. A " +
          "disagreement with the recorded status is resolved in the check's favour and recorded.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["check_id", "asserted_status"],
          properties: {
            check_id: enumSchema(checkIds),
            asserted_status: enumSchema(CHECK_STATUSES),
          },
        },
      },
      overall_confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };

  const known = new Set(criterionIds);
  const knownChecks = new Set(checkIds);

  const zodSchema = z.object({
    coverage: z.array(
      z.object({
        criterion_id: z.string(),
        status: z.enum(COVERAGE_STATUSES),
        verification_strength: z.enum(VERIFICATION_STRENGTHS),
        evidence_type: z.enum([...EVIDENCE_TYPES, "none"]),
        evidence_ref: z.string().nullable().default(null),
        evidence_assertion: z.string().nullable().default(null),
        evidence_file: z.string().nullable().default(null),
        evidence_line: z.number().int().min(1).nullable().default(null),
        evidence_symbol: z.string().nullable().default(null),
        note: z.string().nullable().default(null),
        // Defaulted rather than required: an older transport that does not
        // send it produces the pre-routing behaviour, which is the safe
        // direction. That default is `human` rather than `unclear` since D-056
        // widened routing — `unclear` now routes, so it is no longer the
        // cautious answer and cannot serve as the fallback.
        closure: z.enum(COVERAGE_CLOSURES).default("human"),
      }),
    ),
    findings: z
      .array(
        z.object({
          rule_id: z.string().min(1),
          criterion_id: z.string().nullable().default(null),
          severity: z.enum(SEVERITIES),
          confidence: z.number().min(0).max(1),
          file: z.string().nullable().default(null),
          line: z.number().int().min(1).nullable().default(null),
          symbol: z.string().nullable().default(null),
          statement: z.string().min(1),
          // `human` for the same reason as the coverage default above.
          closure: z.enum(CLOSURE_AUTHORITIES).default("human"),
          // `unsure` is the conservative default: only an affirmative
          // 'negative' opens D-064's fix-and-notify path, so a transport that
          // does not send the field keeps the pre-D-064 gate.
          direction: z.enum(FINDING_DIRECTIONS).default("unsure"),
        }),
      )
      .default([]),
    check_assertions: z
      .array(
        z.object({
          check_id: z.string().min(1),
          asserted_status: z.enum(CHECK_STATUSES),
        }),
      )
      .default([]),
    overall_confidence: z.number().min(0).max(1),
  });

  return {
    toolInputSchema,
    parse(input: unknown): ModelVerdict {
      const parsed = zodSchema.safeParse(input);
      if (!parsed.success) {
        throw new MalformedVerdictError(
          "submit_review input did not match the schema: " +
            fromSubmission(
              parsed.error.issues
                .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
                .join("; "),
            ),
        );
      }
      const verdict = parsed.data;

      for (const entry of verdict.coverage) {
        if (!known.has(entry.criterion_id)) {
          throw new UnknownCriterionError(entry.criterion_id, [...known]);
        }
      }
      for (const finding of verdict.findings) {
        if (finding.criterion_id !== null && !known.has(finding.criterion_id)) {
          throw new UnknownCriterionError(finding.criterion_id, [...known]);
        }
      }
      // A check assertion about a check that does not exist cannot be compared
      // with anything, so it is malformed rather than merely wrong.
      for (const assertion of verdict.check_assertions) {
        if (!knownChecks.has(assertion.check_id)) {
          throw new MalformedVerdictError(
            `verdict asserts a status for '${fromSubmission(assertion.check_id)}', which is not ` +
              `a check on this change set (checks: ${[...knownChecks].join(", ")})`,
          );
        }
      }

      const seen = new Set<string>();
      for (const entry of verdict.coverage) {
        if (seen.has(entry.criterion_id)) {
          throw new MalformedVerdictError(
            `verdict covers ${entry.criterion_id} more than once`,
          );
        }
        seen.add(entry.criterion_id);
      }

      return verdict as ModelVerdict;
    },
  };
}
