// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleBridge } from "../../sample-host/bridge.js";
import { bridge } from "../workspace/index.js";
import { DELETE_TICKET_GONE } from "../../shared/discard.js";
import { TaskPage } from "./TaskPage.js";

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
