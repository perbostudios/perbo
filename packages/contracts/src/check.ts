import { z } from "zod";
import { CheckIdSchema, NodeIdSchema, type NodeId } from "./ids.js";

export const CHECK_KINDS = [
  "typecheck",
  "unit",
  "integration",
  "lint",
  "secret-scan",
  "dependency",
  "licence",
  "migration",
  "policy",
  "scope",
  /**
   * The change's own tests, run against the **base** commit.
   *
   * The status is inverted relative to every other kind, deliberately:
   * `passed` means the tests *failed* without the change, which is the evidence
   * that they discriminate, and `failed` means they passed without it and
   * therefore prove nothing. Encoding it this way keeps "passed is good" true
   * of every kind the reviewer sees — a literal `failed` here would be a
   * measurement that outranks the reviewer and make it block a change for
   * carrying exactly the evidence it asked for.
   */
  "regression-baseline",
  "other",
] as const;
export const CheckKindSchema = z.enum(CHECK_KINDS);
export type CheckKind = (typeof CHECK_KINDS)[number];

/**
 * `skipped` is a first-class status and never counts as evidence. A check that
 * skips itself when a dependency is missing reads green and means nothing, so
 * it must be distinguishable from one that ran and passed.
 */
export const CHECK_STATUSES = ["passed", "failed", "errored", "skipped"] as const;
export const CheckStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/**
 * The second run of a check that failed, on its own.
 *
 * `scope` says what ran: `files` narrowed the run to the failing test files in
 * the package that owns them, `task` re-ran the check's whole command because
 * the files could not be named or placed. `note` carries which of those it was
 * when the run was not narrowed.
 */
export const CheckRerunSchema = z.strictObject({
  command: z.string().min(1),
  scope: z.enum(["files", "task"]),
  note: z.string().min(1).nullable().default(null),
  status: CheckStatusSchema,
  summary: z.string(),
  failing_tests: z.array(z.string().min(1)).default([]),
  duration_ms: z.number().int().min(0).nullable().default(null),
});
export type CheckRerun = z.infer<typeof CheckRerunSchema>;

/**
 * The node of an execution graph a result belongs to (D-107).
 *
 * A graphed ticket runs each pinned check once over the whole change and once
 * per node. `scope` says which run this was: `files` narrowed it to `paths` —
 * the changed test files inside the node's paths — and `task` ran the check's
 * whole command over the change for that node because it could not be
 * narrowed, with `note` saying why.
 */
export const CheckNodeSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    node_id: NodeIdSchema,
    scope: z.literal("files"),
    /** Worktree-relative: the changed test files the run was narrowed to. */
    paths: z.array(z.string().min(1)).min(1),
    note: z.null().default(null),
  }),
  z.strictObject({
    node_id: NodeIdSchema,
    scope: z.literal("task"),
    paths: z.array(z.string().min(1)).max(0).default([]),
    /** Why the run could not be narrowed. */
    note: z.string().min(1),
  }),
]);
export type CheckNode = z.infer<typeof CheckNodeSchema>;

export const CheckResultSchema = z.strictObject({
  check_id: CheckIdSchema,
  name: z.string().min(1),
  kind: CheckKindSchema,
  status: CheckStatusSchema,
  /** Shown in the human rendering: "0 errors", "184 passed". */
  summary: z.string(),
  command: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
  duration_ms: z.number().int().min(0).nullable().default(null),
  /**
   * `file` — supplied by the caller in `checks.json`.
   * `computed` — derived here from the plan and the diff. Scope enforcement is
   * computed rather than accepted, because it must be perfect and is not a
   * model task (docs/04, "Monorepo scope enforcement").
   */
  source: z.enum(["file", "computed"]).default("file"),
  /**
   * Where the check came from: `configured` — the repository's own
   * `.perbo/config.json` — or `proposed`, derived from the scripts
   * `package.json` declares because that file does not exist yet (SCP-259).
   *
   * Absent means configured: a record written before the field existed parses
   * unchanged, and only the derived case has anything to say.
   */
  origin: z.enum(["configured", "proposed"]).optional(),
  /**
   * The tests that failed, parsed from the command's own captured output —
   * test file plus test name where the runner's marker carries one.
   *
   * The four fields below are `optional` rather than defaulted, and absent
   * means "not measured" rather than "measured and empty": a record written
   * before they existed parses unchanged, and a check computed rather than run
   * (scope, agent configuration) has no run to measure.
   */
  failing_tests: z.array(z.string().min(1)).optional(),
  /** How many times the check ran again after its first failure. At most one. */
  reruns: z.number().int().min(0).optional(),
  /** The check failed, and passed when its failing tests were run again alone. */
  flaky: z.boolean().optional(),
  /** The re-run's own record. Absent on a check that was not re-run. */
  rerun: CheckRerunSchema.nullable().optional(),
  /**
   * The temporary directory the command ran under (`TMPDIR`), `null` when the
   * runner had none to give it.
   *
   * A check that behaves differently in the loop and in a clean checkout is
   * usually reading a directory the two do not share, and this is what makes
   * that readable off the record instead of reproducible only by rerunning.
   */
  tmpdir: z.string().min(1).nullable().optional(),
  /**
   * The node this result was run for (D-107). Absent on a whole-change result,
   * which is what every result on a flat plan is and what judges the change.
   */
  node: CheckNodeSchema.optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const CheckResultsFileSchema = z.union([
  z.array(CheckResultSchema),
  z.strictObject({ checks: z.array(CheckResultSchema) }).transform((value) => value.checks),
]);

/**
 * The results that judge the change as a whole: every one run over the
 * whole change.
 *
 * Everything that decides an outcome over the whole change — the overall
 * review, the closure verification, the re-level and the desktop — reads
 * this rather than the list; a node's own review reads `checksForNode`
 * instead, and gates nothing on its own until that review does (D-107). A
 * flat plan's list passes through unchanged, since nothing in it is tagged.
 */
export function wholeChangeChecks(checks: readonly CheckResult[]): CheckResult[] {
  return checks.filter((check) => check.node === undefined);
}

/**
 * The results that judge one node: every one run for that node (D-107), and
 * nothing else — not the whole-change results, and not another node's.
 */
export function checksForNode(checks: readonly CheckResult[], nodeId: NodeId): CheckResult[] {
  return checks.filter((check) => check.node?.node_id === nodeId);
}

export function checkPassed(check: CheckResult): boolean {
  return check.status === "passed";
}

/** Anything that is not an unambiguous pass, including `skipped`. */
export function checkIsFailureOrAbsent(check: CheckResult): boolean {
  return check.status !== "passed";
}
