// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import { bridge } from "../workspace/index.js";
import { DELETE_TICKET_GONE } from "../../shared/discard.js";
import { TaskPage } from "./TaskPage.js";
import { HomePage } from "./HomePage.js";
import { unseenAttention } from "./ticket-workspace.js";
import { Rail } from "../shell/Rail.js";
import type { Snapshot } from "../../shared/protocol.js";

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

/**
 * A page holding the loop of PRB-412 whose next read of the ticket fails with
 * `error`, over a workspace listing that holds the ticket or no longer does.
 */
async function reread(error: string, listed: boolean): Promise<void> {
  const workspace = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
  const detail = await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: "PRB-412" });
  if (!listed) workspace.tasks = workspace.tasks.filter((task) => task !== row);
  workspace.jobs = [];
  const original = bridge.request.bind(bridge);
  vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) =>
    request.kind === "detail" ? Promise.reject(new Error(error)) : original(request)) as typeof bridge.request);
  // Read long enough ago that the page reads it again as it opens.
  client.setQueryData(["detail", row.repoId, "PRB-412"], detail, { updatedAt: 0 });
  render(
    <QueryClientProvider client={client}>
      <TaskPage
        workspace={workspace}
        navigate={() => undefined}
        repoId={row.repoId}
        taskKey="PRB-412"
        view="loop"
        edit={false}
      />
    </QueryClientProvider>,
  );
}

describe("a read of the ticket that fails once the page holds it", () => {
  it("keeps the page, and says the refresh failed, while the listing still holds the ticket", async () => {
    await reread(DELETE_TICKET_GONE, true);
    expect(await screen.findByText(/This ticket could not be read again/)).toBeTruthy();
    expect(document.querySelector('section[data-screen="s12"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps the page for any other failure, whatever the listing holds", async () => {
    await reread("These records changed while every attempt to read them was in flight.", false);
    expect(await screen.findByText(/This ticket could not be read again/)).toBeTruthy();
    expect(document.querySelector('section[data-screen="s12"]')).toBeTruthy();
  });

  it("leaves the page for a ticket deleted elsewhere: the store says it is gone and the listing no longer holds it", async () => {
    await reread(DELETE_TICKET_GONE, false);
    expect(await screen.findByRole("button", { name: "Home" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(DELETE_TICKET_GONE)).toBeTruthy();
    expect(document.querySelector('section[data-screen="s12"]')).toBeNull();
  });
});

describe("the opening a ticket's page records", () => {
  it("is recorded as the page opens, and again when the ticket comes to need the person while it is open", async () => {
    const workspace = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
    const row = workspace.tasks.find((task) => task.ticket.key === "PRB-412")!;
    const detail = structuredClone(await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: "PRB-412" }));
    detail.ticket.state = "executing";
    // Never opened, whatever the pages before this one recorded.
    workspace.lastOpened = {};
    workspace.jobs = [{
      id: "run-412", repoId: row.repoId, key: "PRB-412", resultKey: null, kind: "run", label: "Run", state: "running",
      startedAt: "2026-09-09T09:00:00.000Z", endedAt: null, log: "", error: null, result: null,
    }];
    const original = bridge.request.bind(bridge);
    const opened: string[] = [];
    vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) => {
      if (request.kind !== "ticketOpened") return original(request);
      opened.push(request.key);
      return Promise.resolve(null);
    }) as typeof bridge.request);
    client.setQueryData(["detail", row.repoId, "PRB-412"], detail);
    const page = (current: typeof workspace) => (
      <QueryClientProvider client={client}>
        <TaskPage workspace={current} navigate={() => undefined} repoId={row.repoId} taskKey="PRB-412" view="loop" edit={false} />
      </QueryClientProvider>
    );
    const { rerender } = render(page(workspace));
    expect(opened).toEqual(["PRB-412"]);
    // Still running, read again: nothing new to record.
    rerender(page({ ...workspace }));
    expect(opened).toEqual(["PRB-412"]);
    // The loop stops and waits on the person, with the page open: they are looking at it.
    const waiting = { ...detail.ticket, state: "changes_requested" as const };
    client.setQueryData(["detail", row.repoId, "PRB-412"], { ...detail, ticket: waiting });
    rerender(page({
      ...workspace,
      tasks: workspace.tasks.map((task) => (task === row ? { ...task, ticket: waiting } : task)),
      jobs: [{ ...workspace.jobs[0]!, state: "completed", endedAt: "2026-09-09T09:10:00.000Z" }],
    }));
    await vi.waitFor(() => expect(opened).toEqual(["PRB-412", "PRB-412"]));
  });

  it("is recorded again when the person's own stop settles with the page open, so Home neither circles nor counts it", async () => {
    const sample = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
    const row = sample.tasks.find((task) => task.ticket.key === "PRB-412")!;
    const entry = row.repoId + ":PRB-412";
    // Mid-loop, as the CLI leaves a ticket it started: a stop writes it no row.
    row.ticket.state = "provisioning";
    row.ticket.updated_at = "2026-09-09T08:59:00.000Z";
    row.ticket.history = [{ at: "2026-09-09T08:59:00.000Z", from: "ready", to: "provisioning", note: "run started" }];
    const detail = structuredClone(await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: "PRB-412" }));
    detail.ticket = structuredClone(row.ticket);
    const run = {
      id: "run-412", repoId: row.repoId, key: "PRB-412", resultKey: null, kind: "run" as const, label: "Run", state: "running" as const,
      startedAt: "2026-09-09T09:00:00.000Z", endedAt: null, log: "", error: null, result: null,
    };
    let current: Snapshot = { ...sample, tasks: [row], jobs: [run], archived: [], lastOpened: {} };
    // The host's clock, and the opening it writes down at it.
    let clock = "2026-09-09T09:01:00.000Z";
    const original = bridge.request.bind(bridge);
    const opened: string[] = [];
    vi.spyOn(bridge, "request").mockImplementation(((request: Parameters<typeof original>[0]) => {
      if (request.kind !== "ticketOpened") return original(request);
      opened.push(clock);
      current = { ...current, lastOpened: { ...current.lastOpened, [entry]: clock } };
      return Promise.resolve(null);
    }) as typeof bridge.request);
    client.setQueryData(["detail", row.repoId, "PRB-412"], detail);
    const page = () => (
      <QueryClientProvider client={client}>
        <TaskPage workspace={current} navigate={() => undefined} repoId={row.repoId} taskKey="PRB-412" view="loop" edit={false} />
      </QueryClientProvider>
    );
    const { rerender } = render(page());
    expect(opened).toEqual(["2026-09-09T09:01:00.000Z"]);
    rerender(page());
    // Stop the loop: the stop is taken at once, and the run goes red while its process goes.
    clock = "2026-09-09T09:02:00.000Z";
    current = { ...current, jobs: [{ ...run, state: "stopping" }] };
    rerender(page());
    // It settles later than any opening so far, leaving the ticket where it stood.
    clock = "2026-09-09T09:06:00.000Z";
    current = { ...current, jobs: [{ ...run, state: "cancelled", endedAt: "2026-09-09T09:05:00.000Z" }] };
    rerender(page());
    await waitFor(() => expect(opened.at(-1)).toBe("2026-09-09T09:06:00.000Z"));
    const settled = opened.length;
    rerender(page());
    expect(unseenAttention(current, row)).toBe(false);
    cleanup();
    // Home as the person comes back to it: no blue circle, and no count on the rail.
    render(
      <QueryClientProvider client={client}>
        <HomePage workspace={current} navigate={() => undefined} archive={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: row.ticket.title }).querySelector(".task-card-unseen")).toBeNull();
    cleanup();
    render(<Rail route={{ page: "home" }} navigate={() => undefined} workspace={current} />);
    expect(document.querySelector(".rail-badge")!.getAttribute("data-open")).toBe("false");
    // And the page, read again once recorded, records nothing more.
    expect(opened).toHaveLength(settled);
  });
});
