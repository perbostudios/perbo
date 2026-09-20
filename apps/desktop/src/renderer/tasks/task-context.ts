import type { Detail, OpenDraft } from "../../shared/protocol.js";
import type { PageProps, TaskView } from "../shell/App.js";
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
    sample: workspace.mode === "preview" ? detail.sample : undefined,
  };
}
export const costLabel = (detail: Detail): string =>
  detail.cost.unavailable > 0 && detail.cost.micros === 0
    ? "Unavailable"
    : "$" + (detail.cost.micros / 1_000_000).toFixed(2);

/**
 * The scope a saved editing session holds that this contract does not carry.
 *
 * A mark made in the Explorer writes the session's own draft and reaches the
 * contract only through a compile. Approval freezes the contract's scope and
 * sends the contract file's digest, which a mark never changes — so without
 * this the freeze would pass, the marks would be left behind, and the page
 * would have said nothing about either.
 *
 * Null when there is no session for this ticket, or when the two agree. Order
 * is not part of the comparison: a list the person reordered is the same scope.
 */
export function pendingScope(
  drafts: readonly OpenDraft[] | undefined,
  repoId: string,
  key: string,
  scope: { paths_allowed: readonly string[]; paths_prohibited: readonly string[] },
): { allowed: readonly string[]; prohibited: readonly string[] } | null {
  const draft = (drafts ?? []).find(
    (each) => each.repoId === repoId && each.key === key && each.phase !== "discarded",
  );
  if (draft === undefined) return null;
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
  if (same(draft.scope.paths, scope.paths_allowed) && same(draft.scope.prohibited, scope.paths_prohibited))
    return null;
  return { allowed: draft.scope.paths, prohibited: draft.scope.prohibited };
}
