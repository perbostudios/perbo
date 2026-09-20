import { useRef, useState } from "react";
import {
  Button,
  Dropdown,
  EmptyState,
  InkIcon,
  Notice,
  PageHeader,
  PaginationButton,
  cx,
} from "../ui/index.js";
import { Rename } from "./Rename.js";
import { archived, timeAgo } from "../presentation.js";
import { errorMessage, useAction, useTaskSummary } from "../data.js";
import { useCreate } from "../shell/create.js";
import { useShortcut } from "../shell/shortcuts.js";
import { useToast } from "../shell/Toast.js";
import type { PageProps } from "../shell/App.js";
import type { Snapshot, TaskRow, TaskSummary } from "../../shared/protocol.js";
import { archiveRows, isFiled } from "../../shared/archive.js";
import { displayKey, projectTicket, stageName } from "./ticket-workspace.js";
const countWord = (number: number): string =>
  ["No", "One", "Two", "Three", "Four", "Five"][number] ?? String(number);
const lower = (word: string): string => word.toLowerCase();

/** `+added −removed · files`, or the honest reason there is none (S4, S5). */
export function DiffLabel({
  summary,
  pending,
  compact = false,
}: {
  summary: TaskSummary | undefined;
  pending: boolean;
  /** The archive column has room for the two numbers; the file count goes in the title. */
  compact?: boolean;
}) {
  if (pending) return <span className="diff-label muted">reading…</span>;
  if (!summary || summary.attempts === 0 || !summary.diff)
    return <span className="diff-label muted">{summary?.note ? "diff unavailable" : "no diff yet"}</span>;
  const files = `${summary.diff.files} ${summary.diff.files === 1 ? "file" : "files"}`;
  return (
    <span className="diff-label mono" title={summary.note ?? (compact ? files : undefined)}>
      <span className="added">+{summary.diff.additions}</span>{" "}
      <span className="removed">−{summary.diff.deletions}</span>
      {!compact && <span className="muted"> · {files}</span>}
    </span>
  );
}

function StageRing({
  stage,
  attention = false,
  complete = false,
}: {
  stage: number;
  attention?: boolean;
  complete?: boolean;
}) {
  const share = complete ? 100 : (stage / 6) * 100;
  return (
    <span
      className={cx(
        "stage-ring",
        attention && "stage-ring--attention",
        complete && "stage-ring--complete",
      )}
      aria-label={complete ? "Completed" : `Stage ${stage} of 6`}
      style={{
        background: `conic-gradient(${complete ? "var(--green)" : "var(--ink)"} 0 ${share}%,rgba(var(--ink-rgb),.16) ${share}% 100%)`,
      }}
    >
      <span />
    </span>
  );
}

function TaskCard({
  row,
  workspace,
  open,
  rename,
  archive,
  title,
  renaming,
  onRenameChange,
}: {
  row: TaskRow;
  workspace: Snapshot;
  open: (row: TaskRow) => void;
  rename: (row: TaskRow, title: string) => Promise<unknown>;
  archive: (row: TaskRow) => void;
  title: string;
  renaming: boolean;
  onRenameChange: (open: boolean) => void;
}) {
  const { stage, attention, primary, description } = projectTicket(workspace, row);
  const completed = archived(row.ticket.state);
  const summary = useTaskSummary(row.repoId, row.ticket.key);
  const branch = summary.data ? summary.data.branch : (row.ticket.delivery.branch ?? row.summary?.branch ?? null);
  const finished = completed
    ? [
        row.summary?.criteriaMet !== undefined
          ? `${row.summary.criteriaMet} / ${row.summary.criteriaTotal ?? row.ticket.admission.criteria_count} criteria`
          : `${row.ticket.admission.criteria_count} criteria`,
        row.summary?.cost,
        "the record stays here until you archive it",
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const delivery =
    row.ticket.delivery.state === "merged"
      ? `merged as ${row.repository}#${row.ticket.delivery.pull_request_number}`
      : row.ticket.state === "closed"
        ? "closed unmerged"
        : row.ticket.state === "cancelled"
          ? "cancelled"
          : row.ticket.state.replaceAll("_", " ");
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={title}
      className={cx(
        "task-card",
        attention && "task-card--attention",
        completed && "task-card--complete",
      )}
      onClick={() => open(row)}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          open(row);
        }
      }}
    >
      <div className="task-card-header">
        <StageRing stage={stage} attention={attention} complete={completed} />
        <span className="stage-pill">{completed ? "completed" : stageName(stage)}</span>
        <span className="task-key" title={row.ticket.key}>
          {displayKey(row.ticket.key)}
        </span>
        <Rename
          title={title}
          onSave={(next) => rename(row, next)}
          open={renaming}
          onOpenChange={onRenameChange}
        />
        <span className="task-created">
          {completed ? delivery : "created " + (row.summary?.created ?? timeAgo(row.ticket.admitted_at))}
        </span>
      </div>
      <div className="task-card-meta">
        {branch ? <span className="mono">{branch}</span> : <span className="mono muted">no branch yet</span>}
        <span className="muted" aria-hidden="true">·</span>
        <span className="mono">{row.repository}</span>
        <span className="muted" aria-hidden="true">·</span>
        {row.summary?.additions !== undefined && row.summary.deletions !== undefined && !summary.data ? (
          <span className="diff-label mono">
            <span className="added">+{row.summary.additions}</span> <span className="removed">−{row.summary.deletions}</span>
          </span>
        ) : (
          <DiffLabel summary={summary.data} pending={summary.isPending && !summary.isError} />
        )}
      </div>
      <div className="task-card-description">
        <span>{finished ?? description}</span>
        {completed ? (
          <span className="row">
            <button
              className="text-button small"
              onClick={(event) => {
                event.stopPropagation();
                open(row);
              }}
            >
              Report
            </button>
            <Button
              className="small"
              onClick={(event) => {
                event.stopPropagation();
                archive(row);
              }}
            >
              <InkIcon name="folder" size={14} />
              Archive
            </Button>
          </span>
        ) : (
          <Button
            variant={attention ? "primary" : "secondary"}
            onClick={(event) => {
              event.stopPropagation();
              open(row);
            }}
          >
            {primary.label}
          </Button>
        )}
      </div>
      {row.summary?.progress !== undefined && !completed && (
        <div className="card-progress">
          <div className="progress-track">
            <span style={{ width: row.summary.progress + "%" }} />
          </div>
          <span>
            {row.summary.elapsed} · {row.summary.cost ?? "cost unavailable"} ·{" "}
            {row.summary.files ?? "—"} files
          </span>
        </div>
      )}
    </article>
  );
}

function ArchiveRow({
  row,
  open,
  rename,
  restore,
  title,
}: {
  row: TaskRow;
  open: (row: TaskRow) => void;
  rename: (row: TaskRow, title: string) => Promise<unknown>;
  restore: (row: TaskRow) => void;
  title: string;
}) {
  const summary = useTaskSummary(row.repoId, row.ticket.key);
  return (
    <div
      role="row"
      tabIndex={0}
      className={
        "archive-row" +
        (row.ticket.state === "closed" ? " archive-row--closed" : "")
      }
      onClick={() => open(row)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === "Enter")
          open(row);
      }}
    >
      <span role="cell" className="muted">
        {displayKey(row.ticket.key)}
      </span>
      <span role="cell">
        <Rename title={title} onSave={(next) => rename(row, next)} size={13} />
      </span>
      <span role="cell">{row.repository}</span>
      <span role="cell">
        <DiffLabel summary={summary.data} pending={summary.isPending && !summary.isError} compact />
      </span>
      <span role="cell">
        {row.summary?.criteriaMet ?? "—"} /{" "}
        {row.summary?.criteriaTotal ?? row.ticket.admission.criteria_count}
      </span>
      <span role="cell">{row.summary?.cost ?? "—"}</span>
      <span role="cell">
        {row.summary?.delivery ??
          (row.ticket.delivery.state === "merged"
            ? "#" + row.ticket.delivery.pull_request_number
            : row.ticket.state === "closed"
              ? "closed unmerged"
              : row.ticket.state)}
      </span>
      <span role="cell">
        <button
          className="text-button small muted"
          aria-label="Return this ticket to Home"
          onClick={(event) => {
            event.stopPropagation();
            restore(row);
          }}
        >
          to Home
        </button>
      </span>
    </div>
  );
}

export function HomePage({
  workspace,
  navigate,
  archive,
}: PageProps & { archive: boolean }) {
  const action = useAction();
  const toast = useToast();
  const create = useCreate();
  const [search, setSearch] = useState(""),
    [repoFilter, setRepoFilter] = useState("all"),
    [homeFilter, setHomeFilter] = useState<"all" | "needs" | "running" | "completed">("all"),
    [outcome, setOutcome] = useState<"all" | "merged" | "closed" | "cancelled">(
      "all",
    ),
    [sort, setSort] = useState<"newest" | "oldest" | "title" | "stage">("newest"),
    [page, setPage] = useState(0),
    [renaming, setRenaming] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useShortcut(archive ? "archiveSearch" : "search", () => searchInput.current?.focus());
  const all = workspace.tasks.filter((row) => !isFiled(workspace, row));
  const needsAttention = (row: TaskRow): boolean =>
    projectTicket(workspace, row).attention;
  const completedRows = all.filter((row) => archived(row.ticket.state));
  const attention = all.filter(needsAttention).length;
  const running = all.length - completedRows.length;
  const open = (row: TaskRow): void =>
    navigate({
      page: "task",
      repoId: row.repoId,
      key: row.ticket.key,
      ...(!archive ? { view: projectTicket(workspace, row).primary.view } : {}),
    });
  const rename = (row: TaskRow, title: string): Promise<unknown> =>
    action.mutateAsync({
      kind: "rename",
      repoId: row.repoId,
      key: row.ticket.key,
      title,
    });
  const file = (rows: TaskRow[], filed: boolean): void => {
    const byRepo = new Map<string, string[]>();
    for (const row of rows) byRepo.set(row.repoId, [...(byRepo.get(row.repoId) ?? []), row.ticket.key]);
    void Promise.all(
      [...byRepo].map(([repoId, keys]) => action.mutateAsync({ kind: "archive", repoId, keys, archived: filed })),
    )
      .then(() =>
        toast(
          filed
            ? rows.length === 1
              ? `${displayKey(rows[0]!.ticket.key)} filed in the archive`
              : `${rows.length} tickets filed in the archive`
            : `${displayKey(rows[0]!.ticket.key)} is back on Home`,
        ),
      )
      .catch(() => undefined);
  };
  const titleOf = (row: TaskRow): string =>
    workspace.titles?.[row.repoId + ":" + row.ticket.key] ?? row.ticket.title;
  const filters = {
    repoId: repoFilter === "all" ? null : repoFilter,
    search,
    outcome,
    sort: sort === "stage" ? ("newest" as const) : sort,
  };
  const matches = (row: TaskRow): boolean =>
    [titleOf(row), row.ticket.key, row.repository, row.ticket.delivery.branch ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase());
  const tasks = archive
    ? archiveRows(workspace, filters)
    : all
        .filter(matches)
        .filter((row) => repoFilter === "all" || row.repoId === repoFilter)
        .filter((row) =>
          homeFilter === "all"
            ? true
            : homeFilter === "needs"
              ? needsAttention(row)
              : homeFilter === "completed"
                ? archived(row.ticket.state)
                : !archived(row.ticket.state) && !needsAttention(row),
        )
        .sort((a, b) => {
          if (sort === "title") return titleOf(a).localeCompare(titleOf(b));
          if (sort === "stage")
            return projectTicket(workspace, b).stage - projectTicket(workspace, a).stage;
          const rank = (row: TaskRow): number => (needsAttention(row) ? 0 : archived(row.ticket.state) ? 1 : 2);
          return (
            rank(a) - rank(b) ||
            (sort === "oldest"
              ? a.ticket.updated_at.localeCompare(b.ticket.updated_at)
              : b.ticket.updated_at.localeCompare(a.ticket.updated_at))
          );
        });
  const repository = workspace.repositories[0],
    pageCount = Math.max(1, Math.ceil(tasks.length / 10)),
    currentPage = Math.min(page, pageCount - 1);
  const filed = workspace.tasks.filter((row) => isFiled(workspace, row));
  return (
    <section className="screen" data-screen={archive ? "s5" : "s4"}>
      <PageHeader
        title={
          archive ? (
            "Archive"
          ) : (
            <>
              <span className="header-wordmark">perbo</span>
              {repository && (
                <span className="repo-tag">
                  {repository.name} · {repository.branch}
                </span>
              )}
            </>
          )
        }
        subtitle={archive ? filed.length + " completed" : undefined}
      >
        {!archive && (
          <>
            {attention > 0 && (
              <span className="attention-count">
                <InkIcon name="alert" size={13} />
                {attention} {attention === 1 ? "ticket needs" : "tickets need"}{" "}
                action
              </span>
            )}
            {completedRows.length > 0 && (
              <span className="completed-count">
                <InkIcon name="approve" size={12} />
                {completedRows.length} completed
              </span>
            )}
            <span className="runner-label">runner · this machine</span>
            <span className="live-dot" />
          </>
        )}
        {archive && (
          <button
            className="text-button mono small"
            disabled={!repository}
            onClick={() => action.mutate({ kind: "exportArchive", ...filters })}
          >
            export CSV
          </button>
        )}
      </PageHeader>
      {!archive ? (
        <>
          <div className="home-heading">
            <div>
              <h1>Hi, {workspace.settings.name || "there"}</h1>
              <p>
                {countWord(running)} {running === 1 ? "ticket" : "tickets"} running ·{" "}
                {attention
                  ? lower(countWord(attention)) + " waiting on you"
                  : "nothing waiting on you"}
                {completedRows.length
                  ? ` · ${lower(countWord(completedRows.length))} completed`
                  : ""}
              </p>
            </div>
          </div>
          <div className="home-controls">
            <div className="home-search">
              <input
                ref={searchInput}
                aria-label="Search running tickets"
                placeholder="Search running tickets…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <span className="mono muted small">⌘K</span>
            </div>
            <Dropdown
              aria-label="Filter tickets"
              value={homeFilter}
              onChange={(event) => setHomeFilter(event.target.value as typeof homeFilter)}
            >
              <option value="all">Show · all</option>
              <option value="needs">Show · needs you</option>
              <option value="running">Show · running</option>
              <option value="completed">Show · completed</option>
            </Dropdown>
            {workspace.repositories.length > 1 && (
              <Dropdown
                aria-label="Filter repository"
                value={repoFilter}
                onChange={(event) => setRepoFilter(event.target.value)}
              >
                <option value="all">Repo · all</option>
                {workspace.repositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </Dropdown>
            )}
            <Dropdown
              aria-label="Sort tickets"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Task title</option>
              <option value="stage">Furthest along</option>
            </Dropdown>
            {completedRows.length > 1 && (
              <button className="text-button small muted" onClick={() => file(completedRows, true)}>
                Archive all {completedRows.length} completed
              </button>
            )}
          </div>
          <div className="task-list">
            {tasks.map((row) => (
              <TaskCard
                key={row.repoId + row.ticket.key}
                row={row}
                workspace={workspace}
                open={open}
                rename={rename}
                archive={(target) => file([target], true)}
                title={titleOf(row)}
                renaming={renaming === row.repoId + row.ticket.key}
                onRenameChange={(isOpen) => setRenaming(isOpen ? row.repoId + row.ticket.key : null)}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="archive-filters">
            <input
              ref={searchInput}
              aria-label="Search archived tasks"
              placeholder="Search title, ticket or PR…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
            <Dropdown
              aria-label="Filter repository"
              value={repoFilter}
              onChange={(event) => {
                setRepoFilter(event.target.value);
                setPage(0);
              }}
            >
              <option value="all">Repo · all</option>
              {workspace.repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </Dropdown>
            <Dropdown
              aria-label="Filter outcome"
              value={outcome}
              onChange={(event) => {
                setOutcome(event.target.value as typeof outcome);
                setPage(0);
              }}
            >
              <option value="all">Outcome · all</option>
              <option value="merged">Outcome · merged</option>
              <option value="closed">Closed unmerged</option>
              <option value="cancelled">Cancelled</option>
            </Dropdown>
            <Dropdown
              aria-label="Sort archived tasks"
              value={sort === "stage" ? "newest" : sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Task title</option>
            </Dropdown>
          </div>
          <div
            className="archive-table"
            role="table"
            aria-label="Completed tickets"
          >
            <div className="archive-row archive-head" role="row">
              {["ID", "Ticket name", "Repo", "Diff", "Criteria", "Cost", "Merged", ""].map(
                (label, index) => (
                  <span role="columnheader" key={label || index}>
                    {label}
                  </span>
                ),
              )}
            </div>
            {tasks.slice(currentPage * 10, currentPage * 10 + 10).map((row) => (
              <ArchiveRow
                key={row.repoId + row.ticket.key}
                row={row}
                open={open}
                rename={rename}
                restore={(target) => file([target], false)}
                title={titleOf(row)}
              />
            ))}
          </div>
          <div className="archive-footer">
            <span className="small muted">
              Showing {Math.min(10, Math.max(0, tasks.length - currentPage * 10))} of{" "}
              {tasks.length}
            </span>
            <span className="spacer" />
            <PaginationButton
              previous
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            />
            <span className="mono small">
              {currentPage + 1} / {pageCount}
            </span>
            <PaginationButton
              disabled={currentPage + 1 >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            />
            <div className="archive-total">
              <strong>{filed.length}</strong>
              <small>tickets completed in total</small>
            </div>
          </div>
        </>
      )}
      {tasks.length === 0 && (
        <EmptyState
          title={
            archive
              ? "No completed tickets here yet"
              : all.length
                ? "Nothing matches"
                : "Nothing admitted yet"
          }
          action={
            !archive && !all.length ? (
              <Button onClick={create.open}>
                Create a task
              </Button>
            ) : undefined
          }
        >
          {archive
            ? "Change the filters, or return after a ticket has finished and been archived."
            : all.length
              ? "Clear the search or the filter to see every running ticket."
              : "Set up and waiting. Create the task you were about to work on anyway."}
        </EmptyState>
      )}
      {action.error && (
        <div className="workspace-errors">
          <Notice tone="danger">{errorMessage(action.error)}</Notice>
        </div>
      )}
    </section>
  );
}
