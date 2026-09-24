import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, InkIcon, LineIcon, Notice, cx } from "../ui/index.js";
import { bridge, errorMessage } from "../workspace/index.js";
import { isPreLoop } from "../../shared/archive.js";
import { openDrafts } from "../../shared/contract-editing.js";
import type {
  EditingSession,
  EditingTarget,
  OpenDraft,
  PlanningPane,
  Request,
  SpecRow,
  Snapshot,
} from "../../shared/protocol.js";
import { reopenPane } from "../planning/panes.js";
import type { Route } from "./route.js";
import { RAIL_WIDTH, useRailSize } from "./rail-size.js";
import { useShortcut } from "./shortcuts.js";

/**
 * Create (⌘1, and ⌘N as before): a picker that resumes planning already open
 * or starts it in a repository (D-101). The rail's Create item, Home's empty
 * state and both bindings open the same picker.
 */
export interface CreateApi {
  open: () => void;
  /** Open with no row selected, as Home's empty state does: nothing there was pointed at. */
  openUnselected: () => void;
  toggle: () => void;
  /** Pointer entered the Create control or the panel: open, and hold it open. */
  enter: () => void;
  /** Pointer left them: close a short beat later, so crossing the gap does not. */
  leave: () => void;
  isOpen: boolean;
  /** The marks of the work being deleted, which Home and the picker leave out (`deletes`). */
  deleting: ReadonlySet<string>;
  /** Leave the work these marks name off Home and the picker until the answer is called. */
  hide: (marks: readonly string[]) => () => void;
}
export const CreateContext = createContext<CreateApi>({
  open: () => undefined,
  openUnselected: () => undefined,
  toggle: () => undefined,
  enter: () => undefined,
  leave: () => undefined,
  isOpen: false,
  deleting: new Set(),
  hide: () => () => undefined,
});
export const useCreate = (): CreateApi => useContext(CreateContext);
/**
 * Give back what {@link CreateApi.hide} left off once a read taken after the
 * host answered has replaced every earlier one, so no read landing while the
 * delete finishes puts the work back.
 */
export function useSettle(): (release: () => void) => void {
  const client = useQueryClient();
  return (release) => {
    void client
      .invalidateQueries({ queryKey: ["workspace"] })
      .catch(() => undefined)
      .then(release);
  };
}
/**
 * Delete a ticket for good and go Home, with it off Home and the Archive from
 * the click until {@link useSettle} gives it back, so no read landing while
 * the delete finishes puts it back; a refusal puts it back at once.
 */
export function useDiscardTicket(
  discard: (request: Extract<Request, { kind: "discard" }>) => Promise<unknown>,
  navigate: (route: Route) => void,
): (repoId: string, key: string, refused: () => void) => void {
  const { hide } = useCreate();
  const settle = useSettle();
  return (repoId, key, refused) => {
    const release = hide([deletes.ticket(repoId, key)]);
    void discard({ kind: "discard", repoId, key })
      .then(() => {
        navigate({ page: "home" });
        settle(release);
      })
      .catch(() => {
        release();
        refused();
      });
  };
}

export function CreateProvider({
  workspace,
  navigate,
  route,
  children,
}: {
  workspace: Snapshot;
  navigate: (route: Route) => void;
  /** Where the person is: on a repository's question page, the picker selects that repository's row. */
  route: Route;
  children: ReactNode;
}) {
  const [isOpen, setOpen] = useState(false);
  // Whether the picker opens with a row selected, which Enter takes.
  const [selectTop, setSelectTop] = useState(true);
  const client = useQueryClient();
  // What the picker, or a stopped run's Plan it again, has been asked to
  // delete and the host has not finished deleting, held here rather than in
  // the picker so a delete outlives the panel closing and Home reads it too.
  // The host's delete is slow — the ticket, the spec folder, the bundles,
  // git — and every read that lands before it finishes still holds some of
  // it, so Home and the picker leave it out of every read until the delete
  // settles, not just the one the click was made over.
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set());
  // Said in the picker, and kept while it is closed: a delete that fails
  // behind a closed panel is reported the next time it opens.
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen) setError(null);
  }, [isOpen]);
  const hide = (marks: readonly string[]): (() => void) => {
    const held = new Set(marks);
    setDeleting((current) => new Set([...current, ...held]));
    return () => setDeleting((current) => new Set([...current].filter((mark) => !held.has(mark))));
  };
  /**
   * Take a piece of work off the list at the click and delete it behind it.
   * `own` is the row's own entry, dropped from the snapshot as well; `also`
   * is the rest of the work it takes, which the picker leaves out too. It
   * stays off until a read taken after the host answered has replaced every
   * earlier one; a refusal puts it back and says why.
   */
  const remove = async (own: string, also: readonly string[], request: () => Promise<unknown>): Promise<void> => {
    const release = hide([own, ...also]);
    client.setQueryData<Snapshot>(["workspace"], (current) => (current ? withoutDeleting(current, new Set([own])) : current));
    try {
      await request();
    } catch (failure) {
      setError(errorMessage(failure));
    }
    await client.invalidateQueries({ queryKey: ["workspace"] }).catch(() => undefined);
    release();
  };
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const opener = (select: boolean) => (): void => {
    cancelClose();
    setSelectTop(select);
    setOpen(true);
  };
  const open = opener(true);
  const openUnselected = opener(false);
  const close = (): void => {
    cancelClose();
    setOpen(false);
  };
  const toggle = (): void => {
    cancelClose();
    setSelectTop(true);
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
    <CreateContext.Provider value={{ open, openUnselected, toggle, enter, leave, isOpen, deleting, hide }}>
      {children}
      {isOpen && (
        <Picker
          workspace={withoutDeleting(workspace, deleting)}
          selectTop={selectTop}
          asking={route.page === "ask" ? route.repoId : null}
          remove={remove}
          error={error}
          setError={setError}
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

/** What a delete takes, as the marks `withoutDeleting` reads: all of the work, whichever row it was asked from. */
export const deletes = {
  draft: (id: string): string => "draft:" + id,
  ticket: (repoId: string, key: string): string => "ticket:" + repoId + ":" + key,
  spec: (repoId: string, slug: string): string => deletes.specAt(repoId + "/" + slug),
  /** A spec as `ticketSpec` names it, `repoId/slug`. */
  specAt: (at: string): string => "spec:" + at,
};

/**
 * The snapshot without the work being deleted: the planning, its ticket, the
 * ticket drafted from its spec, and the spec. Every part of it, because a
 * delete takes the work whole, and a planning left out while its ticket or
 * spec is still read puts the work back as the ticket's or the spec's row
 * under the same title until the host has deleted those too.
 */
export function withoutDeleting(snapshot: Snapshot, marks: ReadonlySet<string>): Snapshot {
  if (marks.size === 0) return snapshot;
  return {
    ...snapshot,
    drafts: (snapshot.drafts ?? []).filter((draft) => !marks.has(deletes.draft(draft.id))),
    tasks: snapshot.tasks.filter(
      (row) =>
        !marks.has(deletes.ticket(row.repoId, row.ticket.key)) &&
        !ticketSpec(row).some((at) => marks.has(deletes.specAt(at))),
    ),
    specs: (snapshot.specs ?? []).filter((spec) => !marks.has(deletes.spec(spec.repoId, spec.slug))),
  };
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
      // Listed as the host lists it, so the row is the one its refresh brings.
      ...openDrafts([session]),
      ...(snapshot.drafts ?? []).filter((draft) => draft.id !== session.id),
    ],
  };
}

/**
 * The specs nothing in the app points at.
 *
 * A spec has a planning writing it, or a ticket drafted from it, or neither —
 * and neither is the one worth offering, because nothing else in the app
 * enumerates the spec folder. Deleting a piece of work here takes its spec
 * with it, so these are the ones written some other way: a folder committed by
 * somebody else, or one the command line wrote (D-129).
 *
 * Both claims are read, and they are not the same claim. A session says which
 * spec it writes; a ticket the CLI admitted has no session at all and says it
 * through the spec it recorded being drafted from. Reading only the sessions
 * would offer, as work with no plan, a spec whose plan is on the board.
 *
 * Every ticket counts and not only one in `plan_review`: a spec whose plan was
 * approved and has run is not a spec waiting for one.
 */
export function unclaimedSpecs(
  workspace: Pick<Snapshot, "specs" | "tasks">,
  drafts: readonly OpenDraft[],
): SpecRow[] {
  const claimed = new Set([...draftSpecs(drafts), ...workspace.tasks.flatMap(ticketSpec)]);
  return (workspace.specs ?? []).filter((spec) => !claimed.has(spec.repoId + "/" + spec.slug));
}

/** The specs the drafts are writing, as `repoId/slug`. */
const draftSpecs = (drafts: readonly OpenDraft[]): string[] =>
  drafts.flatMap((draft) => (draft.specSlug ? [draft.repoId + "/" + draft.specSlug] : []));

type SpecTicket = { repoId: string; ticket: { key: string; admission?: { spec?: { path?: string } | null } | null } };
/**
 * The spec a ticket was drafted from, as `repoId/slug`: `specs/<slug>/spec.md`,
 * in whatever folder this repository keeps specs in, so the slug is the folder
 * the path names, which is the last but one.
 */
const ticketSpec = (row: SpecTicket): string[] => {
  const slug = row.ticket.admission?.spec?.path?.split("/").at(-2);
  return slug ? [row.repoId + "/" + slug] : [];
};

interface Row {
  id: string;
  glyph: "spec" | "folder";
  title: string;
  detail: string;
  mono?: boolean;
  run: () => void | Promise<void>;
  /**
   * Every row of work carries a bin, which asks before it throws the row away.
   * `label` names what it throws away, because rows delete different things and
   * a control that names the wrong one is read by a screen reader as an offer
   * to delete something else. `confirm` asks in the words of the stage the row
   * is at: every row takes all of it, and what differs is what a person has
   * made by now.
   */
  bin?: Bin;
}
type Bin = { label: string; confirm: string; remove: () => Promise<void> };
/**
 * What to call a planning: its ticket's name, else the title of the spec it is
 * writing (D-127). The spec's title is
 * looked up on the snapshot, which already carries it for the rows that offer
 * a spec with no planning at all (D-103).
 */
export function titleOfDraft(
  workspace: Pick<Snapshot, "specs" | "tasks" | "titles">,
  draft: OpenDraft,
): string {
  // The ticket's name first: the one a person gave it on this machine, else
  // the one on the ticket.
  const ticket = workspace.tasks.find((row) => row.repoId === draft.repoId && row.ticket.key === draft.key);
  const planned = ticket && (workspace.titles?.[draft.repoId + ":" + draft.key] ?? ticket.ticket.title);
  // Then the spec's: during the interview there is no ticket and no outcome.
  const named = workspace.specs?.find((spec) => spec.repoId === draft.repoId && spec.slug === draft.specSlug)?.title;
  return planned?.trim() || named?.trim() || draft.outcome.trim() || "Untitled work";
}

/**
 * The tickets in plan_review that no draft row already stands for.
 *
 * By ticket, and by the spec it was drafted from. One spec is one piece of
 * work (D-103), so a planning writing that spec is that work's row whether or
 * not it holds the ticket yet — and a plan drafted by an interview that never
 * handed its ticket back is exactly that case. Listed by both, it appears
 * twice: once as the planning, once as the ticket. Deleting either leaves the
 * other standing under the same title, which reads as the delete having made
 * a copy of the thing it was asked to remove.
 */
export function ticketsNoDraftStandsFor<T extends SpecTicket>(reviewing: readonly T[], drafts: readonly OpenDraft[]): T[] {
  const byKey = new Set(drafts.flatMap((draft) => (draft.key ? [draft.repoId + ":" + draft.key] : [])));
  const bySpec = new Set(draftSpecs(drafts));
  return reviewing.filter(
    (row) => !byKey.has(row.repoId + ":" + row.ticket.key) && !ticketSpec(row).some((at) => bySpec.has(at)),
  );
}

const shortKey = (key: string): string => "#" + key.replace(/^PRB-/, "");

/**
 * What to ask before a row is deleted, in the words of the stage it is at.
 *
 * Three stages, because there are three things a person can have made by now:
 * a name, a spec written under it, and a plan drafted from that spec. Which one
 * they are at is what the sentence says, so the confirmation is about the
 * thing in front of them rather than about deleting in general.
 *
 * What it takes is all of it, at every stage: the planning, the ticket it
 * drafted, and the spec folder they came from. Leaving the writing behind would
 * put a row back under the same title the moment the delete finished, which reads
 * as the delete having made a copy of the thing it removed — a piece of work
 * is one thing and is deleted as one (D-101, D-103,
 * D-129).
 */
function confirmDelete(stage: "name" | "spec" | "plan", title: string): string {
  const named = title.trim().length > 0 ? `“${title.trim()}”` : "this planning";
  if (stage === "name")
    return `Delete ${named}? It has a name and nothing written under it yet.`;
  if (stage === "spec")
    return `Delete ${named}? A spec is written and no plan is drafted yet: the planning and the spec folder both go, and nothing of this is kept.`;
  return `Delete ${named}? A plan is drafted and not approved: the plan, its ticket and the spec folder they came from all go, and nothing of this is kept.`;
}

function Picker({
  workspace,
  selectTop,
  asking,
  remove,
  error,
  setError,
  navigate,
  close,
}: {
  workspace: Snapshot;
  selectTop: boolean;
  /** The repository whose question page the picker was opened over, whose row it selects. */
  asking: string | null;
  remove: (own: string, also: readonly string[], request: () => Promise<unknown>) => Promise<void>;
  error: string | null;
  setError: (error: string | null) => void;
  navigate: (route: Route) => void;
  close: () => void;
}) {
  const rail = useRailSize();
  const { enter, leave } = useCreate();
  const client = useQueryClient();
  // The bin that has been clicked and not yet answered. Held here rather
  // than asked through `window.confirm`: a native modal takes the pointer out
  // of the panel, which is what closes a panel opened by hover, so answering it
  // would shut the picker behind it.
  const [confirming, setConfirming] = useState<Bin | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const repoName = (id: string): string =>
    workspace.repositories.find((repo) => repo.id === id)?.name ?? id;
  // Everything before the loop, which is everything the picker is for: a plan
  // is approved on the contract page and approving starts the loop, so a ticket
  // still in plan_review is work a person is still planning.
  const reviewing = workspace.tasks.filter((row) => isPreLoop(row));
  // A draft with a ticket is planning only while that ticket still waits for approval.
  const drafts = (workspace.drafts ?? []).filter(
    (draft) =>
      !draft.key ||
      reviewing.some((row) => row.repoId === draft.repoId && row.ticket.key === draft.key),
  );
  const unclaimed = ticketsNoDraftStandsFor(reviewing, drafts);
  const orphaned = unclaimedSpecs(workspace, drafts);
  const resume: Row[] = [
    ...drafts.map((draft) => ({
      id: "draft:" + draft.id,
      glyph: "spec" as const,
      title: titleOfDraft(workspace, draft),
      detail:
        repoName(draft.repoId) +
        " · " +
        (draft.key
          ? shortKey(draft.key) + " drafted, not approved"
          : draft.phase === "working"
            ? "drafting the plan"
            : "draft in progress"),
      // Where it was left (D-130): its
      // ticket's page where that was its contract, which that page opens on;
      // else its problems while they are open, else the pane it was left at.
      run: () =>
        navigate(
          draft.key !== null && draft.lastView === "contract"
            ? { page: "task", repoId: draft.repoId, key: draft.key, view: "auto" }
            : { page: "planning", sessionId: draft.id, pane: reopenPane(workspace.drafts, draft.id) },
        ),
      bin: {
        label: "Delete planning",
        confirm: confirmDelete(
          draft.key !== null ? "plan" : draft.specSlug !== null ? "spec" : "name",
          draft.outcome,
        ),
        // The row goes at the click: the answer was given in the dialog, and
        // a row that sits there for the host's delete reads as a click that missed.
        remove: () =>
          remove(
            deletes.draft(draft.id),
            // A ticket it was opened over and did not draft stays, and so
            // does the spec that ticket names: the host deletes neither.
            draft.key !== null && !draft.admitted ? [] : [
              ...(draft.key ? [deletes.ticket(draft.repoId, draft.key)] : []),
              ...(draft.specSlug ? [deletes.spec(draft.repoId, draft.specSlug)] : []),
            ],
            () => bridge.request({ kind: "editingDiscard", id: draft.id }),
          ),
      },
    })),
    // A ticket in plan_review is planning too (D-101): it opens planning mode
    // over a session of its own, on the graph, which is what there is to curate.
    ...unclaimed.map((row) => {
      const title = workspace.titles?.[row.repoId + ":" + row.ticket.key] ?? row.ticket.title;
      return {
        id: "ticket:" + row.repoId + ":" + row.ticket.key,
        glyph: "spec" as const,
        title,
        detail: row.repository + " · " + shortKey(row.ticket.key) + " drafted, not approved",
        run: () => open({ kind: "planning", repoId: row.repoId, key: row.ticket.key }, "plan"),
        bin: {
          label: "Delete plan",
          confirm: confirmDelete("plan", title),
          // The same deletion the contract page offers.
          remove: () =>
            remove(
              deletes.ticket(row.repoId, row.ticket.key),
              ticketSpec(row).map(deletes.specAt),
              () => bridge.request({ kind: "discard", repoId: row.repoId, key: row.ticket.key }),
            ),
        },
      };
    }),
    // A spec nothing else points at is work in progress with its plan still to
    // come, and this is the only way back into it: nothing else in the app
    // enumerates the spec folder (D-129). Last,
    // because a plan already drafted is further along than a spec with none.
    ...orphaned.map((spec) => ({
      id: "spec:" + spec.repoId + "/" + spec.slug,
      glyph: "spec" as const,
      title: spec.title,
      detail: repoName(spec.repoId) + " · spec written, no plan yet",
      run: () => open({ kind: "spec", repoId: spec.repoId, slug: spec.slug }, "spec"),
      // This row is the spec itself, with no planning and no plan around it to
      // name in the sentence. It is kept nowhere else and nothing puts it back.
      bin: {
        label: "Delete spec",
        confirm: `Delete the spec “${spec.title}”? Everything written in it goes, and it is not kept anywhere else.`,
        remove: () =>
          remove(deletes.spec(spec.repoId, spec.slug), [], () =>
            bridge.request({ kind: "specDelete", repoId: spec.repoId, slug: spec.slug }),
          ),
      },
    })),
  ];
  /**
   * Open planning mode over a target, with the session it lands on listed
   * first, and go to a pane of it. Only a planning no row stands for
   * yet is opened this way — a ticket or a spec that some planning already
   * holds is listed as that planning's row, which reopens where it was left
   * (D-130) — so there is no pane left
   * at to ask for here.
   *
   * `"plan"` asks for whichever pane holds its plan, which is not known until
   * the session is open: the Problems pane while a reading of the plan
   * against its spec has found problems still open, since they are what the
   * planning is about until they are resolved (D-128);
   * else a graph for work the drafter divided, the criteria for work it did
   * not, and the spec where there is no plan yet. A ticket row carries none
   * of this, and opening a flat plan on a Graph the rail does not offer is a
   * page with nothing on it.
   */
  const open = async (target: EditingTarget, pane: PlanningPane | "plan"): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const session = await bridge.request({ kind: "editingOpen", target });
      client.setQueryData<Snapshot>(["workspace"], (current) =>
        current ? withDraft(current, session) : current,
      );
      const landing: PlanningPane =
        pane !== "plan"
          ? pane
          : session.key === null
            ? "spec"
            : session.drift !== null && session.drift.open.length > 0
              ? "drift"
              : session.nodes > 0
                ? "graph"
                : "criteria";
      navigate({ page: "planning", sessionId: session.id, pane: landing });
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
    // On the repository's question page, "What do you want to build?", which
    // creates nothing: the planning is made when its answer is sent
    // (D-131).
    run: () => navigate({ page: "ask", repoId: repo.id }),
  }));
  const rows = [...start, ...resume];
  // The selected row, none until a key or the pointer picks one where the
  // picker opened with nothing selected. Opened over a repository's question
  // page, that repository's row; else the top planning still open, so Enter
  // resumes it; else the top row.
  const [at, setAt] = useState<number | null>(() => {
    if (!selectTop) return null;
    const asked = start.findIndex((entry) => entry.id === "repo:" + asking);
    return asked >= 0 ? asked : drafts.length > 0 ? start.length : 0;
  });
  // Binning a draft shrinks the list: clamp the cursor so Enter never targets a
  // row that is gone, and the focus effect below (which also runs when the count
  // changes) moves focus back onto a surviving row, so the keyboard keeps
  // working after a delete rather than stranding focus on the removed bin.
  useEffect(() => {
    setAt((current) => (current === null ? null : Math.min(current, Math.max(0, rows.length - 1))));
  }, [rows.length]);
  useEffect(() => {
    // With no row selected the panel holds the focus, so the arrow keys reach it.
    if (at === null) ref.current?.focus();
    else ref.current?.querySelectorAll<HTMLButtonElement>(".picker-row")[at]?.focus();
  }, [at, rows.length]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // A modal dialog lets Escape reach the window as well as its own cancel,
      // so without this the key that dismisses the confirmation takes the list
      // it was asked about with it.
      if (confirming !== null) return;
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
      // The dialog hangs outside the panel in the DOM, so a click in it is a
      // click outside the picker and would close the thing being answered.
      if (confirming !== null) return;
      if (target?.closest(".picker") || target?.closest('button[aria-label="Create"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [close, confirming]);
  const onKeyDown = (event: React.KeyboardEvent): void => {
    // Guarded on the count: with no rows at all, the modulo below is a division
    // by zero, and the NaN it returns is kept by the clamp for as long as the
    // picker is open — so a row arriving on a later snapshot is unreachable.
    if (rows.length === 0) {
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setAt((index) => (index === null ? 0 : (index + 1) % rows.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setAt((index) => (index === null ? rows.length - 1 : (index - 1 + rows.length) % rows.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!busy && at !== null) void rows[at]?.run();
    }
  };
  const row = (entry: Row, index: number) => (
    <div className="picker-row-wrap" key={entry.id}>
      <button
        type="button"
        className={cx("picker-row", index === at && "active", entry.mono && "mono", entry.bin && "removable")}
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
      {entry.bin && (
        <button
          type="button"
          className="picker-row-delete"
          aria-label={`${entry.bin.label}: ${entry.title}`}
          title={entry.bin.label}
          disabled={busy}
          onMouseEnter={() => setAt(index)}
          onClick={(event) => {
            event.stopPropagation();
            setConfirming(entry.bin ?? null);
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
        tabIndex={-1}
        style={{ left: rail.collapsed ? 14 : RAIL_WIDTH + 8 }}
        onKeyDown={onKeyDown}
        onMouseEnter={enter}
        onMouseLeave={confirming === null ? leave : undefined}
      >
        <h3>Plan a piece of work</h3>
        <p>One piece of work, in one repository.</p>
        <div className="section-label">Start in</div>
        {start.length ? start.map(row) : (
          <p className="small muted">Connect a repository in Settings first.</p>
        )}
        {resume.length > 0 && <div className="section-label">Continue planning</div>}
        {resume.map((entry, index) => row(entry, index + start.length))}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
      {confirming !== null && (
        // Answered here and not by the browser, so the picker behind it stays
        // up: what was asked about is on that list, and a person who keeps it
        // should be looking at it still.
        <Dialog
          title={confirming.label}
          onClose={() => setConfirming(null)}
        >
          <p>{confirming.confirm}</p>
          <div className="dialog-actions">
            <Button onClick={() => setConfirming(null)}>Keep it</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const bin = confirming;
                setConfirming(null);
                void bin.remove();
              }}
            >
              {confirming.label}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
