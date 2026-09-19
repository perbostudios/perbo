import type { TicketState } from "@perbo/contracts";
import type { TaskRow } from "../shared/protocol.js";
export { isArchived as archived } from "../shared/archive.js";
export const stateLabels: Record<TicketState, string> = {
  draft: "Draft",
  specifying: "Drafting",
  plan_review: "Review contract",
  ready: "Ready to run",
  provisioning: "Preparing workspace",
  executing: "Agent working",
  verifying: "Running checks",
  independent_review: "Independent review",
  pr_open: "Pull request open",
  merged: "Merged",
  closed: "Closed without merge",
  done: "Done",
  deployed: "Deployed",
  observing: "Observing",
  changes_requested: "Needs your attention",
  plan_invalid: "Contract needs updating",
  blocked: "Blocked",
  failed: "Run stopped",
  cancelled: "Cancelled",
  inconclusive: "Inconclusive",
  rolled_back: "Rolled back",
};
export const attention = (state: string): boolean =>
  [
    "plan_review",
    "changes_requested",
    "failed",
    "blocked",
    "plan_invalid",
  ].includes(state);
export function tone(
  state: string,
): "success" | "warning" | "danger" | "neutral" {
  if (
    ["merged", "done", "deployed", "approve", "passed", "met"].includes(state)
  )
    return "success";
  if (["failed", "error", "not_met", "blocks"].includes(state)) return "danger";
  return attention(state) ||
    ["escalates", "cannot_determine", "remediable"].includes(state)
    ? "warning"
    : "neutral";
}
export const human = (value: string): string => value.replaceAll("_", " ");
export { runnerProgress } from "../shared/runner-progress.js";
export function timeAgo(value: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60_000),
  );
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(value).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
}
export function sortTasks(tasks: TaskRow[]): TaskRow[] {
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...tasks].sort(
    (a, b) =>
      Number(attention(b.ticket.state)) - Number(attention(a.ticket.state)) ||
      priority[a.ticket.priority] - priority[b.ticket.priority] ||
      b.ticket.updated_at.localeCompare(a.ticket.updated_at),
  );
}
