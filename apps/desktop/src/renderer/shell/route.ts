import type { PlanningPane, Snapshot } from "../../shared/protocol.js";

/** Where the app can be, and what every page is handed. The shell owns both; a feature reads them from here. */
export type TaskView =
  | "auto"
  | "contract"
  | "loop"
  | "output"
  | "review"
  | "merge"
  | "decisions"
  | "stopped"
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
  /**
   * A repository's question page, "What do you want to build?", where a
   * planning starts (D-NEW-a-planning-starts-with-what-to-build).
   */
  | { page: "ask"; repoId: string }
  /**
   * A pane of a planning, or null for the planning itself, which opens where
   * it was left (D-NEW-a-planning-reopens-where-it-was-left).
   */
  | { page: "planning"; sessionId: string; pane: PlanningPane | null }
  | {
      page: "task";
      repoId: string;
      key: string;
      view?: TaskView;
      edit?: boolean;
    };
export interface PageProps {
  workspace: Snapshot;
  /**
   * Go to a route. `replace` puts it in place of the route being left rather
   * than after it, for a route that only ever sends the person on: Back then
   * skips it rather than returning to it and being sent on again.
   */
  navigate: (route: Route, options?: { replace?: boolean }) => void;
}
