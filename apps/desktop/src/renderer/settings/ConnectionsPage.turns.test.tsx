// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { Job, Snapshot } from "../../shared/protocol.js";
import { ConnectionsPage } from "./ConnectionsPage.js";
import { RepositoryScreen } from "./ConnectionScreens.js";

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

function mount(element: ReactNode): void {
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

/** The sample's repository and a second one beside it, with a run live in `runningIn`. */
async function twoRepositories(runningIn: "first" | "second"): Promise<Snapshot> {
  const workspace = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
  const first = workspace.repositories[0]!;
  const second = { ...first, id: crypto.randomUUID(), name: "example/landing", path: "~/code/landing" };
  workspace.repositories = [first, second];
  const run: Job = {
    id: crypto.randomUUID(),
    repoId: runningIn === "first" ? first.id : second.id,
    key: "PRB-404",
    kind: "run",
    label: "Run engineering loop",
    state: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    log: "",
    error: null,
    resultKey: null,
    result: null,
  };
  workspace.jobs = [run];
  return workspace;
}

/**
 * A readiness check takes its turn over the repository it checks (D-049,
 * D-101): a run in that repository holds it, and a run in another repository
 * does not.
 */
describe("a repository's readiness check beside a run", () => {
  it("is offered for a repository with no run in it, and held for the one a run is in, on Connections", async () => {
    mount(<ConnectionsPage workspace={await twoRepositories("second")} navigate={vi.fn()} />);
    const checks = (await screen.findAllByRole("button", { name: /Re-run check|Run first check/ })) as HTMLButtonElement[];
    expect(checks).toHaveLength(2);
    expect(checks.map((button) => button.disabled)).toEqual([false, true]);
  });

  it("is offered for the chosen repository while a run is in another, and held while one is in it", async () => {
    mount(<RepositoryScreen workspace={await twoRepositories("second")} navigate={vi.fn()} onDone={vi.fn()} />);
    const offered = (await screen.findByRole("button", { name: /re-check|Run first check/ })) as HTMLButtonElement;
    expect(offered.disabled).toBe(false);
    cleanup();
    mount(<RepositoryScreen workspace={await twoRepositories("first")} navigate={vi.fn()} onDone={vi.fn()} />);
    const held = (await screen.findByRole("button", { name: /re-check|Run first check/ })) as HTMLButtonElement;
    expect(held.disabled).toBe(true);
  });
});
