import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Notice, cx } from "@perbo/ui";
import { bridge, errorMessage } from "../data.js";
import { InkIcon } from "../InkIcon.js";
import { LineIcon } from "../icons.js";
import type { EditingSession, EditingTarget, Snapshot } from "../../shared/protocol.js";
import type { PlanningPane } from "../planning/panes.js";
import type { Route } from "./App.js";
import { RAIL_WIDTH, useRailSize } from "./rail-size.js";
import { useShortcut } from "./shortcuts.js";

/**
 * Create (⌘1, and ⌘N as before): a picker that resumes planning already open
 * or starts it in a repository (D-101). The rail's Create item, Home's empty
 * state and both bindings open the same picker.
 */
export interface CreateApi {
  open: () => void;
  toggle: () => void;
  /** Pointer entered the Create control or the panel: open, and hold it open. */
  enter: () => void;
  /** Pointer left them: close a short beat later, so crossing the gap does not. */
  leave: () => void;
  isOpen: boolean;
}
export const CreateContext = createContext<CreateApi>({
  open: () => undefined,
  toggle: () => undefined,
  enter: () => undefined,
  leave: () => undefined,
  isOpen: false,
});
export const useCreate = (): CreateApi => useContext(CreateContext);

export function CreateProvider({
  workspace,
  navigate,
  children,
}: {
  workspace: Snapshot;
  navigate: (route: Route) => void;
  children: ReactNode;
}) {
  const [isOpen, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const open = (): void => {
    cancelClose();
    setOpen(true);
  };
  const close = (): void => {
    cancelClose();
    setOpen(false);
  };
  const toggle = (): void => {
    cancelClose();
    setOpen((current) => !current);
  };
  // Hover intent: the panel opens as the pointer reaches the Create control and
  // stays open while it is over the control or the panel; it closes a short beat
  // after the pointer leaves both, so moving across the gap between them (or a
  // brush past) does not shut it. The delay is the far side of transitions.dev's
  // panel-reveal timing, so an accidental leave is forgiven within it.
  const enter = (): void => open();
  const leave = (): void => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  useShortcut("plan", open);
  useShortcut("create", open);
  useEffect(() => () => cancelClose(), []);
  return (
    <CreateContext.Provider value={{ open, toggle, enter, leave, isOpen }}>
      {children}
      {isOpen && (
        <Picker
          workspace={workspace}
          close={close}
          navigate={(route) => {
            close();
            navigate(route);
          }}
        />
      )}
    </CreateContext.Provider>
  );
}

/**
 * The snapshot with a session the picker just opened listed first among its
 * drafts. The host's own refresh lands one round trip later, and the picker
 * may be opened again before it does; the session is seeded here so the list
 * never lacks what was just started.
 */
export function withDraft(snapshot: Snapshot, session: EditingSession): Snapshot {
  return {
    ...snapshot,
    drafts: [
      {
        id: session.id,
        repoId: session.repoId,
        key: session.key,
        outcome: session.form.draft.outcome,
        phase: session.phase,
        nodes: session.nodes,
        scope: {
          paths: [...session.form.draft.paths],
          prohibited: [...session.form.draft.prohibited],
        },
      },
      ...(snapshot.drafts ?? []).filter((draft) => draft.id !== session.id),
    ],
  };
}

interface Row {
  id: string;
  glyph: "spec" | "folder";
  title: string;
  detail: string;
  mono?: boolean;
  run: () => void | Promise<void>;
  /** Draft rows carry this: a bin that throws the draft away (D-102). */
  remove?: () => Promise<void>;
}
const shortKey = (key: string): string => "#" + key.replace(/^PRB-/, "");

function Picker({
  workspace,
  navigate,
  close,
}: {
  workspace: Snapshot;
  navigate: (route: Route) => void;
  close: () => void;
}) {
  const rail = useRailSize();
  const { enter, leave } = useCreate();
  const client = useQueryClient();
  const [at, setAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const repoName = (id: string): string =>
    workspace.repositories.find((repo) => repo.id === id)?.name ?? id;
  const reviewing = workspace.tasks.filter((row) => row.ticket.state === "plan_review");
  // A draft with a ticket is planning only while that ticket still waits for approval.
  const drafts = (workspace.drafts ?? []).filter(
    (draft) =>
      !draft.key ||
      reviewing.some((row) => row.repoId === draft.repoId && row.ticket.key === draft.key),
  );
  const covered = new Set(drafts.flatMap((draft) => (draft.key ? [draft.repoId + ":" + draft.key] : [])));
  const resume: Row[] = [
    ...drafts.map((draft) => ({
      id: "draft:" + draft.id,
      glyph: "spec" as const,
      title: draft.outcome.trim() || "Untitled work",
      detail:
        repoName(draft.repoId) +
        " · " +
        (draft.key
          ? shortKey(draft.key) + " drafted, not approved"
          : draft.phase === "working"
            ? "drafting the plan"
            : "draft in progress"),
      run: () => navigate({ page: "planning", sessionId: draft.id, pane: "spec" }),
      remove: async () => {
        // Drop the row at once so the bin feels instant; the host's refresh
        // lands a round trip later. A failure restores the list and says why.
        client.setQueryData<Snapshot>(["workspace"], (current) =>
          current
            ? { ...current, drafts: (current.drafts ?? []).filter((each) => each.id !== draft.id) }
            : current,
        );
        try {
          await bridge.request({ kind: "editingDiscard", id: draft.id });
        } catch (failure) {
          setError(errorMessage(failure));
          await client.invalidateQueries({ queryKey: ["workspace"] });
        }
      },
    })),
    // A ticket in plan_review is planning too (D-101): it opens planning mode
    // over a session of its own, on the graph, which is what there is to curate.
    ...reviewing
      .filter((row) => !covered.has(row.repoId + ":" + row.ticket.key))
      .map((row) => ({
        id: "ticket:" + row.repoId + ":" + row.ticket.key,
        glyph: "spec" as const,
        title: workspace.titles?.[row.repoId + ":" + row.ticket.key] ?? row.ticket.title,
        detail: row.repository + " · " + shortKey(row.ticket.key) + " drafted, not approved",
        run: () => open({ kind: "planning", repoId: row.repoId, key: row.ticket.key }, "graph"),
      })),
  ];
  /** Open planning mode over a target, with the session it lands on listed first. */
  const open = async (target: EditingTarget, pane: PlanningPane): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const session = await bridge.request({ kind: "editingOpen", target });
      client.setQueryData<Snapshot>(["workspace"], (current) =>
        current ? withDraft(current, session) : current,
      );
      navigate({ page: "planning", sessionId: session.id, pane });
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };
  const start: Row[] = workspace.repositories.map((repo) => ({
    id: "repo:" + repo.id,
    glyph: "folder" as const,
    mono: true,
    title: repo.name,
    detail: repo.path,
    run: () => open({ kind: "fresh", repoId: repo.id }, "spec"),
  }));
  const rows = [...resume, ...start];
  // Binning a draft shrinks the list: clamp the cursor so Enter never targets a
  // row that is gone, and the focus effect below (which also runs when the count
  // changes) moves focus back onto a surviving row, so the keyboard keeps
  // working after a delete rather than stranding focus on the removed bin.
  useEffect(() => {
    setAt((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLButtonElement>(".picker-row")[at]?.focus();
  }, [at, rows.length]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    // Click-outside closes it, for a panel opened by click or key. There is no
    // full-screen backdrop to catch the click — one would sit over the Create
    // control and steal its hover, flapping the panel open and shut — so this
    // listens on the window instead and leaves the panel and the control alone:
    // a click on the panel is the row's, and a click on the control is its own
    // toggle, which this would otherwise fight and reopen. A hover-opened panel
    // closes on mouse-leave, not this.
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest(".picker") || target?.closest('button[aria-label="Create"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [close]);
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setAt((index) => (index + 1) % rows.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setAt((index) => (index - 1 + rows.length) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!busy) void rows[at]?.run();
    }
  };
  const row = (entry: Row, index: number) => (
    <div className="picker-row-wrap" key={entry.id}>
      <button
        type="button"
        className={cx("picker-row", index === at && "active", entry.mono && "mono", entry.remove && "removable")}
        disabled={busy}
        onMouseEnter={() => setAt(index)}
        onClick={() => void entry.run()}
      >
        <span className="repo-glyph">
          {entry.glyph === "spec" ? <LineIcon name="spec" size={14} /> : <InkIcon name="folder" size={15} />}
        </span>
        <span className="picker-text">
          <strong>{entry.title}</strong>
          <small>{entry.detail}</small>
        </span>
      </button>
      {entry.remove && (
        <button
          type="button"
          className="picker-row-delete"
          aria-label={`Delete draft: ${entry.title}`}
          title="Delete draft"
          disabled={busy}
          onMouseEnter={() => setAt(index)}
          onClick={(event) => {
            event.stopPropagation();
            void entry.remove?.();
          }}
        >
          <LineIcon name="trash" size={14} />
        </button>
      )}
    </div>
  );
  return (
    <>
      <div
        className="picker"
        role="dialog"
        aria-label="Plan a piece of work"
        ref={ref}
        style={{ left: rail.collapsed ? 14 : RAIL_WIDTH + 8 }}
        onKeyDown={onKeyDown}
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
        <h3>Plan a piece of work</h3>
        <p>One piece of work, in one repository.</p>
        {resume.length > 0 && <div className="section-label">Continue planning</div>}
        {resume.map(row)}
        <div className="section-label">Start in</div>
        {start.length ? start.map((entry, index) => row(entry, index + resume.length)) : (
          <p className="small muted">Connect a repository in Settings first.</p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="picker-foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
        </div>
      </div>
    </>
  );
}
