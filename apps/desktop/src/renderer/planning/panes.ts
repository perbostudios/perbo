import type { LineIconName } from "../icons.js";

/** The panes planning mode has, in rail order. Each pane's ticket adds its entry here. */
export const PLANNING_PANES = [
  { id: "spec", label: "Spec", icon: "spec" },
  { id: "explorer", label: "Explorer", icon: "explorer" },
  { id: "graph", label: "Graph", icon: "graph" },
  { id: "impact", label: "Impact", icon: "impact" },
] as const satisfies readonly {
  id: string;
  label: string;
  icon: LineIconName;
}[];
export type PlanningPane = (typeof PLANNING_PANES)[number]["id"];
export const isPlanningPane = (value: string | undefined): value is PlanningPane =>
  PLANNING_PANES.some((pane) => pane.id === value);
