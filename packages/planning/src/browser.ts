// The part of this package a browser loads: the spec text, the impact report
// and the graph edit path, none of which touch the filesystem, so the
// desktop's renderer computes what the command line computes rather than
// asking the host for it. `browser.test.ts` holds the property.

export { applyGraphEdit, blockingEdit, emptyApproach, undoGraphEdit } from "./graph-edit.js";
export type { GraphEditOutcome } from "./graph-edit.js";
export { impactReport, withNoGo } from "./impact.js";
export type { ImpactReasonKind, ImpactReport, ImpactWarning } from "./impact.js";
export { renderNodePage } from "./node-page-text.js";
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
  specSlug,
  specSymbolNames,
  specTitleFromMessage,
  symbolBeingTyped,
  symbolOptions,
} from "./spec-text.js";
export type { Spec, SpecField } from "./spec-text.js";
