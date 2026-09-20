import type { InkIconName } from "../InkIcon.js";

/** The panes planning mode has, in rail order. Each pane's ticket adds its entry here. */
export const PLANNING_PANES = [
  { id: "spec", label: "Spec", icon: "document" },
  // The artwork Archive used to carry: what it draws is a folder of files, and
  // files are what this pane is.
  { id: "explorer", label: "Explorer", icon: "folder" },
  { id: "graph", label: "Graph", icon: "share" },
  { id: "impact", label: "Impact", icon: "growth-chart" },
] as const satisfies readonly {
  id: string;
  label: string;
  icon: InkIconName;
}[];
export type PlanningPane = (typeof PLANNING_PANES)[number]["id"];
export const isPlanningPane = (value: string | undefined): value is PlanningPane =>
  PLANNING_PANES.some((pane) => pane.id === value);
