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
export type { ReviewArgs, ReviewFormat } from "./args.js";
export { DEFAULT_STATE_DIR, REVIEW_FORMATS, STDIN, isTicketlessArgs, parseReviewArgs } from "./args.js";
export type { RenderOptions } from "./render.js";
export { renderArtifact } from "./render.js";
export type { ResumeRecord } from "./resume.js";
export { ResumeRecordSchema, contractForUnresolved, loadResumeRecord, mergeResumed, saveResumeRecord } from "./resume.js";
export type { RunOptions } from "./run.js";
export { runReviewCommand } from "./run.js";
