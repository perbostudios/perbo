/**
 * `@perbo/cli` as a library: what a caller that imports the package, rather
 * than running the binary, may use. `main.ts` is the binary's own entry.
 */
export { UsageError } from "./usage-error.js";
export { VERSION } from "./version.js";
export { describeFailure } from "./failure.js";
export type { Streams } from "./streams.js";
export type { Paint, Style } from "./text.js";
export { WIDTH, clip, pad, painter, spread, wrap } from "./text.js";
export type {
  RenderOptions,
  ResumeRecord,
  ReviewArgs,
  ReviewFormat,
  RunOptions,
} from "./commands/review/index.js";
export {
  DEFAULT_STATE_DIR,
  REVIEW_FORMATS,
  ResumeRecordSchema,
  STDIN,
  contractForUnresolved,
  isTicketlessArgs,
  loadResumeRecord,
  mergeResumed,
  parseReviewArgs,
  renderArtifact,
  runReviewCommand,
  saveResumeRecord,
} from "./commands/review/index.js";
