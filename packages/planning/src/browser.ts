// The part of this package a browser loads: the spec text, the impact report,
// the graph edit path, the drift report's shape, the shape of the answers
// offered to a decision and a ticket's name, none of which touch the
// filesystem, so the desktop's renderer computes what the command line
// computes rather than asking the host for it. `browser.test.ts` holds the
// property.

export { assertionsChangedSinceDraft } from "./assertion-drift.js";
export { DECISION_OPTION_MAX_CHARS, DecisionOptionsVerdictSchema } from "./decision-options-report.js";
export type { DecisionOption, DecisionOptionsVerdict } from "./decision-options-report.js";
export {
  DriftFindingSchema,
  DriftVerdictSchema,
  MAX_DRIFT_FINDINGS,
  promiseTexts,
} from "./drift-report.js";
export type { DriftFinding, DriftVerdict } from "./drift-report.js";
export { applyGraphEdit, blockingEdit, emptyApproach, undoGraphEdit } from "./graph-edit.js";
export type { GraphEditOutcome } from "./graph-edit.js";
export { impactReport, withNoGo } from "./impact.js";
export type { ImpactReasonKind, ImpactReport, ImpactWarning } from "./impact.js";
export { nodePageNotes, renderNodePage } from "./node-page-text.js";
export {
  completeSymbol,
  EMPTY_SPEC_TEXT,
  markSpecSymbols,
  mergeSpecText,
  nearestSymbolNames,
  readSpecSections,
  renderSpec,
  replaceSymbolName,
  requirementNodes,
  retitleSpec,
  specSlug,
  specSymbolNames,
  specTitleFromMessage,
  symbolBeingTyped,
  symbolOptions,
} from "./spec-text.js";
export type { Spec, SpecField } from "./spec-text.js";
export { keptTitleRefusal, ticketName } from "./ticket-name.js";
export type { TicketNaming } from "./ticket-name.js";
