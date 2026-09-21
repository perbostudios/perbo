import { formatUsd } from "@perbo/contracts/browser";
import type { Detail } from "../../shared/protocol.js";
import type { PageProps, TaskView } from "../shell/route.js";
import { projectTicket } from "./ticket-workspace.js";
export interface TaskContext extends PageProps {
  detail: Detail;
  repoId: string;
  show: (view: TaskView) => void;
}
export function taskRecords({ detail, workspace, repoId }: TaskContext) {
  const { ticket, contract } = detail;
  const projection = projectTicket(workspace, { repoId, ticket }, detail);
  const { jobs, active, recoverable, latest, review } = projection;
  const elapsedMs = jobs
    .filter((job) => ["run", "decide"].includes(job.kind) && job.endedAt)
    .reduce(
      (total, job) =>
        total +
        Math.max(0, Date.parse(job.endedAt!) - Date.parse(job.startedAt)),
      0,
    );
  const measuredMs = detail.attempts
    .flatMap((attempt) => attempt.bundles)
    .reduce((total, bundle) => total + bundle.usage.wall_clock_ms, 0);
  const seconds = Math.round((elapsedMs || measuredMs) / 1000);
  return {
    ticket,
    contract,
    jobs,
    active,
    recoverable,
    latest,
    review,
    projection,
    elapsed: seconds
      ? (seconds >= 60 ? Math.floor(seconds / 60) + "m " : "") +
        (seconds % 60) +
        "s"
      : "Not recorded",
    busy: projection.busy,
    held: projection.held,
    criteria:
      "acceptance_criteria" in contract ? contract.acceptance_criteria : [],
    models:
      workspace.taskModels?.[repoId + ":" + ticket.key] ?? workspace.settings,
    repo: workspace.repositories.find((repo) => repo.id === repoId),
    title: workspace.titles?.[repoId + ":" + ticket.key] ?? ticket.title,
  };
}
/**
 * What a run has cost so far. A total is all-in only where every component of
 * it is priced (D-070): where some are not, the figure is a floor and says so,
 * and where none is, there is no figure to give.
 */
export const costLabel = ({ cost }: Pick<Detail, "cost">): string =>
  cost.unavailable > 0 && cost.micros === 0
    ? "Unavailable"
    : cost.partial && cost.micros > 0
      ? `at least ${formatUsd(cost.micros, 2)}`
      : formatUsd(cost.micros, 2);
