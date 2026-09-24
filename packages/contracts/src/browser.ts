/**
 * What a browser bundle may take from this package.
 *
 * Every module named here imports zod, `./ids.js` and its neighbours and
 * nothing of Node, directly or at any depth; the root entry reaches
 * `node:crypto` and `node:path` and would pull them into the bundle.
 * `browser.test.ts` holds the invariant.
 */
export { APPROACH_SCHEMA_VERSION, approachProblems, ApproachRecordSchema } from "./approach.js";
export type { ApproachRecord, GraphEdge } from "./approach.js";
export { formatUsd } from "./cost.js";
export {
  answersReview,
  DECISION_CHOICES,
  DECISION_WORDS,
  decidable,
  decisionChoicesFor,
  routedToPerson,
} from "./decision.js";
export type { DecisionChoice } from "./decision.js";
export { EFFORT_LABELS, EFFORT_LEVELS, EffortLevelSchema } from "./effort.js";
export type { EffortLevel } from "./effort.js";
export { EXECUTOR_SKILLS, ExecutorSkillsSchema } from "./executor-skills.js";
export type { ExecutorSkillId } from "./executor-skills.js";
export { GraphEditSchema } from "./graph-edit.js";
export type { GraphEdit } from "./graph-edit.js";
export { CriterionIdSchema } from "./ids.js";
export {
  answersGroup,
  InterviewOptionSchema,
  LEAVE_IT_TO_THE_INTERVIEW,
  MAX_QUESTION_GROUPS,
  MAX_QUESTION_OPTIONS,
  MAX_QUESTION_PARTS,
  PART_LETTERS,
} from "./interview-protocol.js";
export { MaterializationEntrySchema } from "./materialisation-entry.js";
export {
  insideAllowedPaths,
  isConfigPath,
  isDependencyPath,
  isMigrationPath,
  isNeverReadPath,
  isSecurityPath,
  matchesAny,
  packageOf,
  resolveRepositoryPath,
} from "./paths.js";
export {
  AcceptanceCriterionSchema,
  hasAcceptanceCriteria,
  PlanContractSchema,
  planNodes,
  VERIFICATION_KINDS,
} from "./plan.js";
export type { AcceptanceCriterion, PlanContract, PlanNode, VerificationKind } from "./plan.js";
export { isPlannedP3Path } from "./risk.js";
export { SIZE_COUNTS, SIZE_NAMES, SIZE_THRESHOLDS, planSizeCounts, sizeEstimate } from "./size.js";
export type { SizeEstimate } from "./size.js";
export { standingGlob, StandingProhibitedEntrySchema } from "./standing.js";
export type { StandingProhibitedEntry } from "./standing.js";
export type { SymbolIndex, UnsupportedRepository } from "./symbol-index.js";
export { sameName } from "./ticket-name.js";
