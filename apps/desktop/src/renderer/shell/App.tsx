import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Brand, Button, HeaderSlotProvider, InkIcon, Notice, TitleBar } from "../ui/index.js";
import { bridge, errorMessage, useWorkspace } from "../workspace/index.js";
import { untouchedPlanning } from "../../shared/contract-editing.js";
import { HomePage } from "../tasks/HomePage.js";
import { Onboarding } from "../settings/Onboarding.js";
import { PlanningPaneSchema, type Settings } from "../../shared/protocol.js";
import { AskPage } from "../planning/AskPage.js";
import { PlanningMode } from "../planning/PlanningMode.js";
import { CreateProvider, nameOfRoute } from "./create.js";
import { Rail, RailToggle, SETTINGS_PAGES } from "./Rail.js";
import { useRailSize } from "./rail-size.js";
import { RailReveal } from "./rail-reveal.js";
import { ShortcutProvider, useShortcut } from "./shortcuts.js";
import type { PageProps, Route, SettingsSection, TaskView } from "./route.js";
import { ToastProvider } from "./Toast.js";
const SettingsPage = lazy(() =>
  import("../settings/SettingsPage.js").then((module) => ({
    default: module.SettingsPage,
  })),
);
const TaskPage = lazy(() =>
  import("../tasks/TaskPage.js").then((module) => ({
    default: module.TaskPage,
  })),
);

const PAGES = [
  "home",
  "archive",
  "setup",
  "settings",
  "general",
  "usage",
  "connections",
  "providers",
  "repositories",
  "about",
  "shortcuts",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readRoute(): Route {
  const parts = location.hash.slice(1).split("/").map(decodeURIComponent);
  const [page, repoId, key, view] = parts;
  // A session id is the host's identifier; a link carrying anything else is not a planning link.
  if (page === "planning" && repoId && UUID.test(repoId))
    return { page, sessionId: repoId, pane: PlanningPaneSchema.safeParse(key).data ?? null };
  if (page === "ask" && repoId) return { page, repoId };
  if (page === "task" && repoId && key)
    return {
      page,
      repoId,
      key,
      view: ([
        "contract",
        "loop",
        "output",
        "review",
        "merge",
        "decisions",
        "stopped",
        "called-off",
        "complete",
        "explorer",
      ].includes(view ?? "")
        ? view
        : "auto") as TaskView,
      edit: view === "edit",
    };
  if ((PAGES as readonly string[]).includes(page ?? ""))
    return { page } as Route;
  return { page: "home" };
}
/** Theme, text size and reduced motion are attributes on the document that the tokens read (S6F). */
function applyAppearance(
  settings: Pick<Settings, "theme" | "textSize" | "reduceMotion">,
): void {
  const root = document.documentElement;
  if (settings.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  if (settings.textSize === "default") delete root.dataset.textSize;
  else root.dataset.textSize = settings.textSize;
  if (settings.reduceMotion) root.dataset.motion = "reduced";
  else delete root.dataset.motion;
}
function Frame({
  route,
  navigate,
  collapsed,
  children,
}: {
  route: Route;
  navigate: (route: Route) => void;
  collapsed: boolean;
  children: ReactNode;
}) {
  useShortcut("home", () => navigate({ page: "home" }));
  useShortcut("archive", () => navigate({ page: "archive" }));
  // The rail owns ⌘4 while it is open (it raises the pill); collapsed, the binding still has to reach settings.
  useShortcut(
    "settings",
    collapsed ? () => navigate({ page: "general" }) : null,
  );
  // On the Archive itself the page binds ⇧⌘K to its search box.
  useShortcut(
    "archiveSearch",
    route.page === "archive" ? null : () => navigate({ page: "archive" }),
  );
  return children;
}
/** Under a hidden macOS title bar the rail runs beneath the traffic lights; every other host keeps its own chrome. */
const INSET_CHROME =
  typeof navigator !== "undefined" &&
  navigator.userAgent.includes("Electron/") &&
  /Mac/.test(navigator.platform);
export function App() {
  const workspace = useWorkspace();
  useEffect(() => {
    if (INSET_CHROME) document.documentElement.dataset.chrome = "inset";
  }, []);
  const rail = useRailSize();
  const [route, setRoute] = useState<Route>(readRoute);
  const navigate: PageProps["navigate"] = (next, options) => {
    const hash =
      next.page === "task"
        ? [
            "task",
            next.repoId,
            next.key,
            next.edit ? "edit" : (next.view ?? "auto"),
          ]
            .map(encodeURIComponent)
            .join("/")
        : next.page === "planning"
          ? ["planning", next.sessionId, ...(next.pane === null ? [] : [next.pane])]
              .map(encodeURIComponent)
              .join("/")
          : next.page === "ask"
            ? ["ask", next.repoId].map(encodeURIComponent).join("/")
            : next.page;
    if (options?.replace) history.replaceState(history.state, "", `#${hash}`);
    else location.hash = hash;
    setRoute(next);
  };
  useEffect(() => {
    const changed = (): void => setRoute(readRoute());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  // Leaving planning throws away a planning nothing was put into
  // (D-129).
  //
  // Read off the route rather than off PlanningMode's unmount: the route moves
  // once per leave, while an unmount also fires for StrictMode's double mount
  // (main.tsx) and for the app being torn down — and closing Perbo is not
  // clicking away. A pane change keeps the page, so it is not a leave either.
  const leaving = useRef(route);
  useEffect(() => {
    const before = leaving.current;
    leaving.current = route;
    if (before.page !== "planning" || route.page === "planning") return;
    const id = before.sessionId;
    void (async () => {
      const session = await bridge.request({ kind: "editingRead", id });
      if (!untouchedPlanning(session)) return;
      // At the revision the read came back with: anything that moves the
      // planning in between refuses this discard, which is the answer that
      // keeps it. A title the Spec pane held unsaved is not in between: the
      // pane sends it as it unmounts, ahead of this read on the same bridge.
      await bridge.request({ kind: "editingDiscard", id, revision: session.revision });
    })().catch(() => undefined);
  }, [route]);
  const appearance = workspace.data?.settings;
  useEffect(() => {
    if (appearance) applyAppearance(appearance);
  }, [appearance?.theme, appearance?.textSize, appearance?.reduceMotion]);
  if (workspace.isPending)
    return (
      <main className="launch">
        <Brand />
        <p>Opening your workspace…</p>
      </main>
    );
  if (workspace.error || !workspace.data)
    return (
      <main className="fatal">
        <h1>Your workspace couldn’t load.</h1>
        <Notice key={workspace.errorUpdatedAt} tone="danger">
          {errorMessage(workspace.error)}
        </Notice>
        <Button
          onClick={() => {
            void workspace.refetch();
          }}
        >
          Try again
        </Button>
      </main>
    );
  const data = workspace.data,
    props = { workspace: data, navigate };
  const name = nameOfRoute(data, route);
  const nav = <Rail route={route} navigate={navigate} workspace={data} />;
  const setup = !data.settings.onboardingComplete || route.page === "setup";
  const settings = (SETTINGS_PAGES as readonly string[]).includes(route.page);
  const section: SettingsSection =
    route.page === "settings" || !settings
      ? "general"
      : (route.page as SettingsSection);
  // One frame per page or ticket: moving between a ticket's views must not remount it and lose where you were.
  const frameKey =
    route.page === "task"
      ? ["task", route.repoId, route.key].join("/")
      : route.page === "planning"
        ? ["planning", route.sessionId].join("/")
        : route.page === "ask"
          ? ["ask", route.repoId].join("/")
          : route.page;
  const page = setup ? (
    <Onboarding {...props} />
  ) : route.page === "task" ? (
    <TaskPage
      key={route.repoId + ":" + route.key}
      {...props}
      repoId={route.repoId}
      taskKey={route.key}
      view={route.view ?? "auto"}
      edit={route.edit ?? false}
    />
  ) : route.page === "planning" ? (
    <PlanningMode {...props} sessionId={route.sessionId} pane={route.pane} />
  ) : route.page === "ask" ? (
    <AskPage key={route.repoId} {...props} repoId={route.repoId} />
  ) : settings ? (
    <SettingsPage {...props} section={section} />
  ) : (
    <HomePage key={route.page} {...props} archive={route.page === "archive"} />
  );
  return (
    <ShortcutProvider overrides={data.settings.shortcuts}>
      <ToastProvider>
        <Frame
          route={route}
          navigate={navigate}
          collapsed={!setup && rail.collapsed}
        >
          <CreateProvider workspace={data} navigate={navigate} route={route}>
          <HeaderSlotProvider>
            <div className="app-shell">
              {/* The bar is the drag region; the toggle and the header's controls punch no-drag holes in it. */}
              <TitleBar>
                {!setup && <RailToggle />}
                {!setup && name !== null && <span className="titlebar-name">{name}</span>}
              </TitleBar>
              <div className="app-body">
                {!setup && (rail.collapsed ? <RailReveal>{nav}</RailReveal> : nav)}
                <main id="content" className="workspace-shell">
                  {data.errors.length > 0 && (
                    <div className="workspace-errors">
                      {data.errors.map((error) => (
                        <Notice key={error} tone="danger">
                          {error}
                        </Notice>
                      ))}
                    </div>
                  )}
                  <Suspense
                    fallback={
                      <div className="launch">
                        <InkIcon name="dots" />
                        <p>Opening page…</p>
                      </div>
                    }
                  >
                    <div className="page-frame fx-page" key={frameKey}>
                      {page}
                    </div>
                  </Suspense>
                </main>
              </div>
            </div>
          </HeaderSlotProvider>
          </CreateProvider>
        </Frame>
      </ToastProvider>
    </ShortcutProvider>
  );
}
