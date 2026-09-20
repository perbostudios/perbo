/**
 * `@perbo/cli` as a library: what a caller that imports the package, rather
 * than running the binary, may use. `main.ts` is the binary's own entry.
 */
export type { ReviewArgs, ReviewFormat } from "./args.js";
export { DEFAULT_STATE_DIR, REVIEW_FORMATS, STDIN, UsageError, isTicketlessArgs, parseReviewArgs } from "./args.js";
export type { Paint, RenderOptions, Style } from "./render.js";
export { WIDTH, clip, pad, painter, renderArtifact, spread, wrap } from "./render.js";
export type { ResumeRecord } from "./resume.js";
export { ResumeRecordSchema, contractForUnresolved, loadResumeRecord, mergeResumed, saveResumeRecord } from "./resume.js";
export type { RunOptions, Streams } from "./run.js";
export { VERSION, describeFailure, runReviewCommand } from "./run.js";
