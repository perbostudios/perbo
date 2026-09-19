import { useEffect, useRef, useState } from "react";
import { cx } from "@perbo/ui";
import { InkIcon } from "../InkIcon.js";
import { LineIcon } from "../icons.js";
import { PLANNING_PANES } from "../planning/panes.js";
import { useCreate } from "./create.js";
import { useShortcut } from "./shortcuts.js";
import { RAIL_WIDTH, setRailSize, useRailSize } from "./rail-size.js";
import type { Route } from "./App.js";

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

/**
 * The rail: Create first (D-101), with planning's panes under it while a
 * piece of work is being planned, then Home, Archive, and a settings icon
 * that grows upward into a pill of General, Usage and Connections. Outside
 * settings the pill opens on hover or focus; inside settings it stays open
 * and the tab you are on carries the bordered plate. It sits beneath the top
 * bar, and the bar's toggle hides it.
 */
export function Rail({
  route,
  navigate,
  attention,
}: {
  route: Route;
  navigate: (route: Route) => void;
  attention: number;
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
  const planning = route.page === "planning";
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
            create.isOpen && "selected",
            planning && !create.isOpen && "parent",
          )}
          aria-label="Create"
          title="Create — plan a piece of work"
          aria-expanded={create.isOpen}
          onClick={create.toggle}
          onMouseEnter={create.enter}
          onMouseLeave={create.leave}
        >
          <span className="rail-icon">
            <LineIcon name="create" size={22} />
          </span>
        </button>
        {planning && (
          <div className="rail-children" role="group" aria-label="Planning panes">
            {PLANNING_PANES.map((pane) => (
              <button
                key={pane.id}
                className={cx("rail-item", "rail-child", route.pane === pane.id && "selected")}
                aria-label={pane.label}
                title={pane.label}
                aria-current={route.pane === pane.id ? "page" : undefined}
                onClick={() => navigate({ ...route, pane: pane.id })}
              >
                <span className="rail-icon">
                  <LineIcon name={pane.icon} size={18} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {(
        [
          { page: "home", icon: "home", label: "Home" },
          { page: "archive", icon: "folder", label: "Archive" },
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
            <InkIcon name={icon} size={icon === "folder" ? 23 : 22} />
            {page === "home" && (
              <span
                className="t-badge rail-badge"
                data-open={attention > 0 ? "true" : "false"}
              >
                <span
                  className="t-badge-dot"
                  aria-label={attention + " tickets need action"}
                >
                  {attention}
                </span>
              </span>
            )}
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
