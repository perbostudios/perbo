import type { PlanningPane } from "../planning/panes.js";
import type { Snapshot } from "../../shared/protocol.js";

/** Where the app can be, and what every page is handed. The shell owns both; a feature reads them from here. */
export type TaskView =
  | "auto"
  | "contract"
  | "loop"
  | "output"
  | "review"
  | "merge"
  | "decisions"
  | "called-off"
  | "complete"
  | "explorer";
export type SettingsSection =
  | "general"
  | "usage"
  | "connections"
  | "providers"
  | "repositories"
  | "about"
  | "shortcuts";
export type Route =
  | {
      page: "home" | "archive" | "setup" | "settings" | SettingsSection;
    }
  | { page: "planning"; sessionId: string; pane: PlanningPane }
  | {
      page: "task";
      repoId: string;
      key: string;
      view?: TaskView;
      edit?: boolean;
    };
export interface PageProps {
  workspace: Snapshot;
  navigate: (route: Route) => void;
}
