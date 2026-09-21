// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { HomePage } from "./HomePage.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { Snapshot, TaskRow, TaskSummary } from "../../shared/protocol.js";

let client: QueryClient;
let sample: Snapshot;
beforeAll(async () => {
  sample = await sampleBridge.request({ kind: "snapshot" });
});
beforeEach(() => {
  location.hash = "home";
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

/** One filed ticket, with the summary its row reads already answered. */
function archived(cost: TaskSummary["costMicros"]): { row: TaskRow; workspace: Snapshot } {
  const row = structuredClone(
    sample.tasks.find((task) => task.ticket.state === "merged") ?? sample.tasks[0]!,
  );
  row.ticket.state = "merged";
  const workspace: Snapshot = {
    ...structuredClone(sample),
    tasks: [row],
    archived: [row.repoId + ":" + row.ticket.key],
  };
  client.setQueryData<TaskSummary>(["summary", row.repoId, row.ticket.key], {
    branch: null,
    attempts: 1,
    latestAttemptAt: null,
    costMicros: cost,
    costBasis: cost === null ? "none" : "priced",
    diff: null,
    note: null,
  });
  return { row, workspace };
}

function costCell(): string {
  const cells = within(screen.getByRole("table", { name: "Completed tickets" })).getAllByRole(
    "cell",
  );
  // ID, Ticket name, Repo, Diff, Criteria, Cost, Merged, (restore).
  return cells[5]!.textContent ?? "";
}

describe("the archive's cost column", () => {
  it("reads the figure in dollars, at the precision every desktop amount uses", () => {
    const { workspace } = archived(1_234_567);
    render(
      <QueryClientProvider client={client}>
        <HomePage workspace={workspace} navigate={() => undefined} archive />
      </QueryClientProvider>,
    );
    expect(costCell()).toBe("$1.23");
  });

  it("says nothing rather than zero where the ticket has no figure", () => {
    const { workspace } = archived(null);
    render(
      <QueryClientProvider client={client}>
        <HomePage workspace={workspace} navigate={() => undefined} archive />
      </QueryClientProvider>,
    );
    expect(costCell()).toBe("—");
  });
});
