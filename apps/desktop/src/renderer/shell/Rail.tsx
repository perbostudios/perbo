import { useEffect, useRef, useState } from "react";
import { InkIcon, cx } from "../ui/index.js";
import { curates, panesFor } from "../planning/panes.js";
import type { Snapshot } from "../../shared/protocol.js";
import { HOME_TONES, HOME_TONE_LABELS, homeRows, homeTally, type HomeTone } from "../tasks/ticket-workspace.js";
import { useCreate, withoutDeleting } from "./create.js";
import { useShortcut } from "./shortcuts.js";
import { RAIL_WIDTH, setRailSize, useRailSize } from "./rail-size.js";
import type { Route } from "./route.js";

export const SETTINGS_PAGES = [
  "general",
  "usage",
  "connections",
  "providers",
  "repositories",
  "about",
  "shortcuts",
  "settings",
] as const;
const TABS = [
  {
    page: "general",
    icon: "general",
    label: "General",
    covers: ["general", "about", "shortcuts", "settings"],
  },
  { page: "usage", icon: "usage", label: "Usage", covers: ["usage"] },
  {
    page: "connections",
    icon: "connections",
    label: "Connections",
    covers: ["connections", "providers", "repositories"],
  },
] as const;

/** The sidebar toggle, fixed in the top bar beside the traffic lights. */
export function RailToggle() {
  const size = useRailSize();
  const expanded = !size.collapsed;
  return (
    <button
      className="rail-toggle"
      aria-label={expanded ? "Reduce the sidebar" : "Expand the sidebar"}
      aria-pressed={expanded}
      title={expanded ? "Reduce the sidebar" : "Expand the sidebar"}
      onClick={() =>
        setRailSize((current) => ({ ...current, collapsed: expanded }))
      }
    >
      <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
        <rect
          x="0.75"
          y="0.75"
          width="16.5"
          height="12.5"
          rx="2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <line
          x1="6.5"
          y1="0.75"
          x2="6.5"
          y2="13.25"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    </button>
  );
}

/** How long the Home badge holds each colour before it gives way to the next. */
const BADGE_HOLD = 10_000;
/** How long the badge takes to shrink away before it reappears in the next colour. */
const BADGE_SWAP = 180;

/**
 * The count on Home's rail icon, one colour at a time (S4): the tickets
 * waiting on a decision in yellow, those whose loop stopped in red, those at
 * the journey's end in green, each in that order for as long as it has any.
 * Each holds ten seconds, then shrinks away and reappears as the next; with
 * one colour it stays, and with none there is no badge.
 */
function HomeBadge({ tally }: { tally: Record<HomeTone, number> }) {
  const shown = HOME_TONES.filter((tone) => tally[tone] > 0);
  const [state, setState] = useState<{ tone: HomeTone; leaving: boolean; swapped: boolean }>(() => ({
    tone: shown[0] ?? "yellow",
    leaving: false,
    swapped: false,
  }));
  // A colour whose count went to none gives way to the next one that has any.
  const tone = shown.includes(state.tone)
    ? state.tone
    : (shown.find((each) => HOME_TONES.indexOf(each) > HOME_TONES.indexOf(state.tone)) ?? shown[0] ?? null);
  // The colours with a count, as one value: `shown` is a new array every render.
  const cycle = shown.join(" ");
  useEffect(() => {
    if (tone === null || (!state.leaving && shown.length < 2)) return undefined;
    const next = shown[(shown.indexOf(tone) + 1) % shown.length] ?? tone;
    const timer = state.leaving
      ? setTimeout(() => setState({ tone: next, leaving: false, swapped: true }), BADGE_SWAP)
      : setTimeout(() => setState({ tone, leaving: true, swapped: state.swapped }), BADGE_HOLD - BADGE_SWAP);
    return () => clearTimeout(timer);
  }, [tone, state.leaving, cycle]);
  return (
    <span className="t-badge rail-badge" data-open={String(tone !== null)}>
      <span
        // A new dot at each change of colour, so the one taking over grows in afresh.
        key={state.swapped ? state.tone : "dot"}
        className={cx(
          "t-badge-dot",
          tone !== null && "rail-badge--" + tone,
          state.leaving && "rail-badge--leaving",
          state.swapped && "rail-badge--swapped",
        )}
        aria-label={tone === null ? undefined : HOME_TONE_LABELS[tone](tally[tone])}
        aria-hidden={tone === null || undefined}
      >
        {tone && tally[tone]}
      </span>
    </span>
  );
}

/**
 * The planning curating a plan whose contract this ticket page shows while the
 * plan waits for approval, as the contract's Back to planning finds it, with
 * no pane of it current; null on any other page of a ticket.
 */
function contractPlanning(
  workspace: Snapshot,
  route: Extract<Route, { page: "task" }>,
): { sessionId: string; pane: null } | null {
  if (route.edit || !["auto", "contract"].includes(route.view ?? "auto")) return null;
  const waiting = workspace.tasks.some(
    (row) =>
      row.repoId === route.repoId &&
      row.ticket.key === route.key &&
      row.ticket.state === "plan_review" &&
      row.ticket.approved_at === null,
  );
  const curating = workspace.drafts?.find(
    (draft) => draft.repoId === route.repoId && draft.key === route.key && curates(draft),
  );
  return waiting && curating ? { sessionId: curating.id, pane: null } : null;
}

/**
 * The rail: Create first (D-101), with planning's panes under it while a
 * piece of work is being planned and on the contract of its plan until that
 * is approved, then Home, Archive, and a settings icon
 * that grows upward into a pill of General, Usage and Connections. Outside
 * settings the pill opens on hover or focus; inside settings it stays open
 * and the tab you are on carries the bordered plate. It sits beneath the top
 * bar, and the bar's toggle hides it.
 */
export function Rail({
  route,
  navigate,
  workspace,
}: {
  route: Route;
  navigate: (route: Route) => void;
  /** What Home lists, which the Home badge counts, and the open plannings, which say which of them has a graph to offer. */
  workspace: Snapshot;
}) {
  const inSettings = (SETTINGS_PAGES as readonly string[]).includes(route.page);
  const [hover, setHover] = useState(false);
  const [closing, setClosing] = useState(false);
  // Leaving the pill for a moment (the gap between icon and pill, a slip of the pointer) must not shut it.
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = (): void => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    setHover(true);
  };
  const leave = (): void => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHover(false), 320);
  };
  useEffect(
    () => () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    },
    [],
  );
  // The pill opens on hover or focus, and stays open inside settings so the current tab carries its plate.
  const open = inSettings || hover;
  const pill = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    // Menu dropdown: swap .is-open for .is-closing, then drop it after the close clock.
    if (wasOpen.current && !open) {
      setClosing(true);
      const timer = setTimeout(() => setClosing(false), 150);
      wasOpen.current = open;
      return () => clearTimeout(timer);
    }
    wasOpen.current = open;
    return undefined;
  }, [open]);
  const create = useCreate();
  // Counted over what Home lists, work being deleted left out as Home leaves it.
  const visible = withoutDeleting(workspace, create.deleting);
  const tally = homeTally(visible, homeRows(visible));
  // The planning whose panes sit under Create: the one open, or the one whose
  // plan's contract is open awaiting approval, its panes each going back to
  // planning as the contract's Back to planning does, landing on that pane
  // (D-130). Approved, the contract is frozen and has none.
  const planning =
    route.page === "planning" ? route : route.page === "task" ? contractPlanning(workspace, route) : null;
  // A repository's question page is Create's own page: Create is lit there,
  // and there is no planning, so no panes under it, until it is answered
  // (D-131).
  const asking = route.page === "ask";
  // Create, Home and Archive bind in the shell so they work with the rail collapsed; ⌘4 is the rail's because it raises the pill.
  useShortcut("settings", () => {
    setHover(true);
    pill.current?.querySelector<HTMLButtonElement>("button")?.focus();
  });
  const current = (covers: readonly string[]): boolean =>
    covers.includes(route.page);
  return (
    <aside
      className="rail"
      style={{ width: RAIL_WIDTH }}
      aria-label="Main navigation"
    >
      <div className="rail-group">
        <button
          className={cx(
            "rail-item",
            (create.isOpen || asking) && "selected",
            planning && !create.isOpen && "parent",
          )}
          aria-label="Create"
          title="Create — plan a piece of work"
          aria-expanded={create.isOpen}
          aria-current={asking ? "page" : undefined}
          onClick={create.toggle}
          onMouseEnter={create.enter}
          onMouseLeave={create.leave}
        >
          <span className="rail-icon">
            <InkIcon name="add-circle" size={22} />
          </span>
        </button>
        {planning && (
          <div className="rail-children" role="group" aria-label="Planning panes">
            {panesFor(workspace.drafts, planning.sessionId).map((pane) => (
              <button
                key={pane.id}
                className={cx("rail-item", "rail-child", planning.pane === pane.id && "selected")}
                aria-label={pane.label}
                title={pane.label}
                aria-current={planning.pane === pane.id ? "page" : undefined}
                onClick={() => navigate({ page: "planning", sessionId: planning.sessionId, pane: pane.id })}
              >
                <span className="rail-icon">
                  <InkIcon name={pane.icon} size={19} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {(
        [
          { page: "home", icon: "home", label: "Home" },
          { page: "archive", icon: "inbox", label: "Archive" },
        ] as const
      ).map(({ page, icon, label: text }) => (
        <button
          className={cx("rail-item", route.page === page && "selected")}
          key={page}
          aria-label={text}
          aria-current={route.page === page ? "page" : undefined}
          onClick={() => navigate({ page })}
        >
          <span className="rail-icon">
            <InkIcon name={icon} size={22} />
            {page === "home" && <HomeBadge tally={tally} />}
          </span>
        </button>
      ))}
      <span className="spacer" />
      <div
        className={cx("rail-settings", open && "open")}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocusCapture={enter}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            leave();
        }}
      >
        <div
          ref={pill}
          className={cx(
            "settings-pill",
            "t-dropdown",
            open && "is-open",
            closing && "is-closing",
          )}
          data-origin="bottom-center"
          role="group"
          aria-label="Settings sections"
          aria-hidden={!open}
        >
          {TABS.map((tab) => (
            <button
              key={tab.page}
              className={cx(
                "rail-item",
                "rail-item--pill",
                inSettings && current(tab.covers) && "selected",
              )}
              aria-label={tab.label}
              title={tab.label}
              tabIndex={open ? 0 : -1}
              aria-current={
                inSettings && current(tab.covers) ? "page" : undefined
              }
              onClick={() => navigate({ page: tab.page })}
            >
              <span className="rail-icon">
                <InkIcon name={tab.icon} size={22} />
              </span>
            </button>
          ))}
        </div>
        <button
          className={cx("rail-item", inSettings && !open && "selected")}
          aria-label="Settings"
          title="Settings — opens on General"
          aria-expanded={open}
          onClick={() => navigate({ page: "general" })}
        >
          <span className="rail-icon">
            <InkIcon name="settings" size={22} />
          </span>
        </button>
      </div>
    </aside>
  );
}
