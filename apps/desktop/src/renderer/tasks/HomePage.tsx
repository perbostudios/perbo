import { useId, useRef, useState } from "react";
import { formatUsd } from "@perbo/contracts/browser";
import {
  Button,
  Dropdown,
  EmptyState,
  InkIcon,
  Notice,
  PageHeader,
  PaginationButton,
  cx,
  type InkIconName,
} from "../ui/index.js";
import { Rename } from "./Rename.js";
import { timeAgo } from "../time-ago.js";
import { errorMessage, useAction, useTaskSummary } from "../workspace/index.js";
import { useCreate, withoutDeleting } from "../shell/create.js";
import { useShortcut } from "../shell/shortcuts.js";
import { useToast } from "../shell/Toast.js";
import type { PageProps } from "../shell/route.js";
import type { Snapshot, TaskRow, TaskSummary } from "../../shared/protocol.js";
import { archiveRows, isArchivable, isFiled, isMergeDecided } from "../../shared/archive.js";
import { HOME_TONES, HOME_TONE_LABELS, completedLabel, displayKey, homeGroup, homeOrder, homeRows, homeTally, projectTicket, stageName, unseenAttention, type HomeTone } from "./ticket-workspace.js";
const countWord = (number: number): string =>
  ["No", "One", "Two", "Three", "Four", "Five"][number] ?? String(number);
const lower = (word: string): string => word.toLowerCase();
/**
 * The group each Show filter but "all" keeps: "running" is every ticket with
 * no colour, "merge" the pull requests waiting on the merge decision, and
 * "completed" only the tickets whose merge is decided.
 */
const SHOW_GROUP = { needs: "yellow", running: null, stopped: "red", merge: "green", completed: "decided" } as const;
/** Each tone's count in Home's header, and the completed count after them: its class and its icon. */
const HEADER_COUNT: Record<HomeTone | "completed", [className: string, icon: InkIconName, size: number]> = {
  yellow: ["attention-count", "alert", 13],
  red: ["stopped-count", "locked", 12],
  green: ["merge-count", "inbox", 12],
  completed: ["completed-count", "approve", 12],
};

/** What a card's blue circle says: the ticket needs the person and was not opened since. */
const UNSEEN = "Not opened since it needed you";

/** `+added −removed · files`, or the honest reason there is none (S4, S5). */
export function DiffLabel({
  summary,
  pending,
  refusal = null,
  compact = false,
}: {
  summary: TaskSummary | undefined;
  pending: boolean;
  /** Why the summary could not be read, where it could not; the label says so rather than "no diff yet". */
  refusal?: string | null;
  /** The archive column has room for the two numbers; the file count goes in the title. */
  compact?: boolean;
}) {
  if (pending) return <span className="diff-label muted">reading…</span>;
  if (refusal !== null)
    return (
      <span className="diff-label muted" title={refusal}>
        diff unavailable
      </span>
    );
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
  tone = null,
  decided = false,
}: {
  stage: number;
  /** The row's colour, which the ring's centre takes. */
  tone?: "green" | "yellow" | "red" | null;
  /** The merge is decided: the ring is whole and holds a check mark where its progress was. */
  decided?: boolean;
}) {
  if (decided)
    return (
      <span className="stage-ring stage-ring--green stage-ring--decided" aria-label="Completed">
        <span>
          <InkIcon name="approve" size={11} />
        </span>
      </span>
    );
  const share = (stage / 6) * 100;
  return (
    <span
      className={cx("stage-ring", tone && "stage-ring--" + tone)}
      aria-label={`Stage ${stage} of 6`}
      style={{
        background: `conic-gradient(var(--ink) 0 ${share}%,rgba(var(--ink-rgb),.16) ${share}% 100%)`,
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
  const { stage, tone, description } = projectTicket(workspace, row);
  // Completed is a decided merge alone: a cancelled or rolled-back ticket is a stop, or work a run carries again.
  const completed = isMergeDecided(row);
  const stopped = tone === "red";
  const summary = useTaskSummary(row.repoId, row.ticket.key);
  const branch = summary.data ? summary.data.branch : (row.ticket.delivery.branch ?? null);
  const finished = completed
    ? `${row.ticket.admission.criteria_count} criteria · the record stays here until you archive it`
    : null;
  const delivery =
    row.ticket.delivery.state === "merged"
      ? `merged as ${row.repository}#${row.ticket.delivery.pull_request_number}`
      : row.ticket.state === "closed"
        ? "closed unmerged"
        : row.ticket.state.replaceAll("_", " ");
  // A space holds the line's height while the outcome is read, or where there is none.
  const outcome = summary.data?.outcome;
  // The circle's words reach a screen reader through the card, whose children
  // a `button` role makes presentational, and show on hover as its title.
  const unseen = unseenAttention(workspace, row);
  const unseenId = useId();
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={title}
      aria-describedby={unseen ? unseenId : undefined}
      className={cx(
        "task-card",
        tone && "task-card--" + tone,
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
      {unseen && (
        <span id={unseenId} className="task-card-unseen" role="img" aria-label={UNSEEN} title={UNSEEN} />
      )}
      <div className="task-card-header">
        <StageRing stage={stage} tone={tone} decided={completed} />
        <span className="stage-pill">{stopped ? "loop stopped" : completed ? "completed" : stageName(stage)}</span>
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
          {completed ? delivery : "created " + timeAgo(row.ticket.admitted_at)}
        </span>
      </div>
      <div className="task-card-meta">
        {branch ? <span className="mono">{branch}</span> : <span className="mono muted">no branch yet</span>}
        <span className="muted" aria-hidden="true">·</span>
        <span className="mono">{row.repository}</span>
        <span className="muted" aria-hidden="true">·</span>
        <DiffLabel
          summary={summary.data}
          pending={summary.isPending && !summary.isError}
          refusal={summary.isError ? errorMessage(summary.error) : null}
        />
      </div>
      <div className="task-card-description">
        {stopped ? (
          <span>{finished ?? description}</span>
        ) : (
          <span className="task-card-outcome" title={outcome ?? undefined}>
            {outcome ?? "\u00a0"}
          </span>
        )}
        {isArchivable(workspace, row) && (
          <Button
            className="small task-card-archive"
            aria-label="Archive"
            title="Archive"
            onClick={(event) => {
              // A click on the card opens it, so Archive keeps its click to itself.
              event.stopPropagation();
              archive(row);
            }}
          >
            <InkIcon name="folder" size={14} />
          </Button>
        )}
      </div>
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
        <DiffLabel
          summary={summary.data}
          pending={summary.isPending && !summary.isError}
          refusal={summary.isError ? errorMessage(summary.error) : null}
          compact
        />
      </span>
      <span role="cell">{row.ticket.admission.criteria_count}</span>
      <span role="cell">
        {summary.data?.costMicros === null || summary.data === undefined
          ? "—"
          : formatUsd(summary.data.costMicros, 2)}
      </span>
      <span role="cell">
        {row.ticket.delivery.state === "merged"
          ? "#" + row.ticket.delivery.pull_request_number
          : row.ticket.state === "closed"
            ? "closed unmerged"
            : row.ticket.state}
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
  workspace: read,
  navigate,
  archive,
}: PageProps & { archive: boolean }) {
  const action = useAction();
  const toast = useToast();
  const create = useCreate();
  // Work being deleted is off Home from the click, as it is off the picker.
  const workspace = withoutDeleting(read, create.deleting);
  const [search, setSearch] = useState(""),
    [repoFilter, setRepoFilter] = useState("all"),
    [homeFilter, setHomeFilter] = useState<"all" | keyof typeof SHOW_GROUP>("all"),
    [outcome, setOutcome] = useState<"all" | "merged" | "closed" | "cancelled">(
      "all",
    ),
    [sort, setSort] = useState<"recent" | "newest" | "oldest" | "title" | "stage">("recent"),
    [page, setPage] = useState(0),
    [renaming, setRenaming] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useShortcut(archive ? "archiveSearch" : "search", () => searchInput.current?.focus());
  const all = homeRows(workspace);
  // The greeting, the filters and the sort read the groups the header's counts
  // and the rail's Home badge read (S4), so no two of them disagree on where a
  // ticket stands; the badge counts only those owed a look.
  const tally = homeTally(workspace, all);
  const groupOf = (row: TaskRow) => homeGroup(workspace, row);
  const running = all.length - tally.green - tally.red - tally.completed;
  // A ticket whose merge is decided stays below every other under each sort.
  const decidedLast = (a: TaskRow, b: TaskRow): number =>
    Number(groupOf(a) === "decided") - Number(groupOf(b) === "decided");
  const archivable = all.filter((row) => isArchivable(workspace, row));
  const open = (row: TaskRow): void => {
    const { primary, screen } = projectTicket(workspace, row);
    navigate({
      page: "task",
      repoId: row.repoId,
      key: row.ticket.key,
      // Where a ticket belongs is asked for with `auto` and answered once, in
      // `TaskPage`. Where the primary action only names the page `auto` would
      // land on anyway, ask for `auto` — so a ticket whose plan was divided
      // reaches its graph from here exactly as it does from the draft that
      // made it. Where the two differ, the action still says which it wants.
      ...(!archive ? { view: primary.view === screen ? ("auto" as const) : primary.view } : {}),
    });
  };
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
    sort: sort === "title" || sort === "oldest" ? sort : ("newest" as const),
  };
  const matches = (row: TaskRow): boolean =>
    [titleOf(row), row.ticket.key, row.repository, row.ticket.delivery.branch ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase());
  const shown = all
    .filter(matches)
    .filter((row) => repoFilter === "all" || row.repoId === repoFilter)
    .filter((row) => homeFilter === "all" || groupOf(row) === SHOW_GROUP[homeFilter]);
  const tasks = archive
    ? archiveRows(workspace, filters)
    : sort === "title"
      ? shown.sort((a, b) => decidedLast(a, b) || titleOf(a).localeCompare(titleOf(b)))
      : sort === "stage"
        ? shown.sort((a, b) => decidedLast(a, b) || projectTicket(workspace, b).stage - projectTicket(workspace, a).stage)
        : homeOrder(workspace, shown, sort === "recent" ? "opened" : sort);
  const repository = workspace.repositories[0],
    pageCount = Math.max(1, Math.ceil(tasks.length / 10)),
    currentPage = Math.min(page, pageCount - 1);
  const filed = workspace.tasks.filter((row) => isFiled(workspace, row));
  return (
    <section className="screen" data-screen={archive ? "s5" : "s4"}>
      <PageHeader
        title={archive ? "Archive" : <span className="header-wordmark">perbo</span>}
        subtitle={archive ? filed.length + " archived" : undefined}
      >
        {/* Each colour's count, in the order the rail's Home badge shows them (S4), then the completed. */}
        {!archive &&
          [...HOME_TONES, "completed" as const].map((count) => {
            const [className, icon, size] = HEADER_COUNT[count];
            return tally[count] > 0 && (
              <span key={count} className={className}>
                <InkIcon name={icon} size={size} />
                {count === "completed" ? completedLabel(tally[count]) : HOME_TONE_LABELS[count](tally[count])}
              </span>
            );
          })}
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
                {tally.yellow
                  ? lower(countWord(tally.yellow)) + " waiting on you"
                  : "nothing waiting on you"}
                {tally.green
                  ? ` · ${lower(countWord(tally.green))} waiting on your merge decision`
                  : ""}
                {tally.completed
                  ? ` · ${lower(countWord(tally.completed))} completed`
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
              <option value="stopped">Show · stopped</option>
              <option value="merge">Show · waiting on your merge decision</option>
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
              <option value="recent">Recently opened</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Task title</option>
              <option value="stage">Furthest along</option>
            </Dropdown>
            {archivable.length > 1 && (
              <button className="text-button small muted" onClick={() => file(archivable, true)}>
                Archive all {archivable.length}
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
              value={filters.sort}
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
            aria-label="Archived tickets"
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
              <small>tickets archived in total</small>
            </div>
          </div>
        </>
      )}
      {!archive && tasks.length === 0 && all.length > 0 && (
        <EmptyState title="Nothing matches">
          Clear the search or the filter to see every running ticket.
        </EmptyState>
      )}
      {!archive && all.length === 0 && (
        <div className="home-empty">
          <h2>Nothing admitted yet</h2>
          <span className="spacer" />
          <Button variant="primary" onClick={create.openUnselected}>
            Create a task
          </Button>
        </div>
      )}
      {action.error && (
        <div className="workspace-errors">
          <Notice tone="danger">{errorMessage(action.error)}</Notice>
        </div>
      )}
    </section>
  );
}
