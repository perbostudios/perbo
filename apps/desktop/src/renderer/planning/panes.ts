import type { InkIconName } from "../InkIcon.js";
import type { Snapshot } from "../../shared/protocol.js";

/**
 * The panes planning mode has, in rail order. Each pane's ticket adds its
 * entry here.
 *
 * Graph is not among them until there is a graph. A plan the drafter divided
 * gets one, second, under the spec it came from; a flat plan never does,
 * because "one piece of work, not divided" is a page with nothing on it, and
 * an empty pane offered as a stage is a stage a person goes looking into.
 * Files and Impact are there from the first turn: both are about the draft's
 * scope, which is what the spec is being written against.
 */
const SPEC = { id: "spec", label: "Spec", icon: "document" } as const;
const GRAPH = { id: "graph", label: "Graph", icon: "share" } as const;
const REST = [
  // The artwork Archive used to carry: what it draws is a folder of files.
  { id: "explorer", label: "Explorer", icon: "folder" },
  { id: "impact", label: "Impact", icon: "growth-chart" },
] as const;

export const PLANNING_PANES = [SPEC, GRAPH, ...REST] as const satisfies readonly {
  id: string;
  label: string;
  icon: InkIconName;
}[];
export type PlanningPane = (typeof PLANNING_PANES)[number]["id"];
export const isPlanningPane = (value: string | undefined): value is PlanningPane =>
  PLANNING_PANES.some((pane) => pane.id === value);

/** Whether this planning drafted a plan the drafter divided into nodes. */
export function planningIsDivided(
  drafts: Snapshot["drafts"],
  sessionId: string,
): boolean {
  const draft = (drafts ?? []).find((entry) => entry.id === sessionId);
  return (draft?.nodes ?? 0) > 0;
}

/** The panes to offer this planning, which is all of them once it has a graph. */
export function panesFor(
  drafts: Snapshot["drafts"],
  sessionId: string,
): readonly (typeof PLANNING_PANES)[number][] {
  return planningIsDivided(drafts, sessionId) ? PLANNING_PANES : [SPEC, ...REST];
}
