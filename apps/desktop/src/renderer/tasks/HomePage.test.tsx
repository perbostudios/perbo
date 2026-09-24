// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { TicketState } from "@perbo/contracts";
import { HomePage } from "./HomePage.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { Route } from "../shell/route.js";
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
    outcome: null,
  });
  return { row, workspace };
}

function costCell(): string {
  const cells = within(screen.getByRole("table", { name: "Archived tickets" })).getAllByRole(
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

describe("a Home card", () => {
  const pr = "https://github.com/example/webstore/pull/9";
  /** A board of these tickets, nothing filed and nothing running, each with its contract's outcome read. */
  function board(states: [TicketState, string | null][]): Snapshot {
    const template = sample.tasks.find((row) => row.repoId === sample.repositories[0]!.id)!;
    const tasks = states.map(([state, url], index) => {
      const row = structuredClone(template);
      row.ticket.key = "PRB-" + (900 + index);
      row.ticket.title = `Ticket ${index} ${state}`;
      row.ticket.state = state;
      row.ticket.delivery.pull_request_url = url;
      client.setQueryData<TaskSummary>(["summary", row.repoId, row.ticket.key], {
        branch: null,
        attempts: 1,
        latestAttemptAt: null,
        costMicros: null,
        costBasis: "none",
        diff: null,
        note: null,
        outcome: `The outcome of ticket ${index}, long enough that a narrow card has to cut it short at its edge`,
      });
      return row;
    });
    return { ...structuredClone(sample), tasks, jobs: [], archived: [], titles: {}, refreshingRepos: [], lastOpened: {} };
  }
  const home = (workspace: Snapshot, navigate: (route: Route) => void = () => undefined) =>
    render(
      <QueryClientProvider client={client}>
        <HomePage workspace={workspace} navigate={navigate} archive={false} />
      </QueryClientProvider>,
    );
  const card = (name: string): HTMLElement => screen.getByRole("button", { name });
  /** Every button inside a card but the title's own rename, by its accessible name. */
  const buttons = (name: string): string[] =>
    [...card(name).querySelectorAll("button")]
      .filter((button) => !button.closest(".rename"))
      .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");

  it("carries no button but Archive, which only a stop or a decided merge has, and opens on a click anywhere", () => {
    const opened: Route[] = [];
    home(
      board([
        ["failed", null], ["pr_open", pr], ["merged", pr], ["closed", pr], ["changes_requested", null], ["executing", null], ["plan_invalid", null],
      ]),
      (route) => opened.push(route),
    );
    expect(buttons("Ticket 0 failed")).toEqual(["Archive"]);
    // Green while the merge decision waits: nothing to archive yet.
    expect(buttons("Ticket 1 pr_open")).toEqual([]);
    // Merged, or closed without merge: decided, and archived from Home like a stop.
    expect(buttons("Ticket 2 merged")).toEqual(["Archive"]);
    expect(buttons("Ticket 3 closed")).toEqual(["Archive"]);
    expect(buttons("Ticket 4 changes_requested")).toEqual([]);
    expect(buttons("Ticket 6 plan_invalid")).toEqual(["Archive"]);
    // Archive is an icon alone, named for a screen reader.
    const archive = within(card("Ticket 2 merged")).getByRole("button", { name: "Archive" });
    expect(archive.textContent).toBe("");
    expect(archive.getAttribute("title")).toBe("Archive");
    // The card itself opens the ticket, which is all the buttons it had did.
    fireEvent.click(card("Ticket 4 changes_requested"));
    expect(opened).toMatchObject([{ page: "task", key: "PRB-904" }]);
  });

  it("says the contract's outcome on one line where the loop did not stop, and why it stopped where it did", () => {
    home(board([["pr_open", pr], ["merged", pr], ["changes_requested", null], ["failed", null]]));
    for (const [index, name] of ["Ticket 0 pr_open", "Ticket 1 merged", "Ticket 2 changes_requested"].entries()) {
      const line = card(name).querySelector(".task-card-description > span")!;
      expect(line.className).toBe("task-card-outcome");
      expect(line.textContent).toBe(
        `The outcome of ticket ${index}, long enough that a narrow card has to cut it short at its edge`,
      );
    }
    const stopped = card("Ticket 3 failed").querySelector(".task-card-description > span")!;
    expect(stopped.className).toBe("");
    expect(stopped.textContent).toBe("The loop stopped. Its work and evidence have been retained. Open the task to inspect the cause.");
    // No outcome to say, or none read yet: the line keeps its height with a space, so the card does not move.
    cleanup();
    const workspace = board([["merged", pr], ["executing", null]]);
    workspace.jobs = [{
      id: crypto.randomUUID(), repoId: workspace.tasks[1]!.repoId, key: workspace.tasks[1]!.ticket.key, resultKey: null,
      kind: "run", label: "Run", state: "running", startedAt: "2026-09-09T09:00:00.000Z", endedAt: null, log: "", error: null, result: null,
    }];
    client.setQueryData<TaskSummary>(["summary", workspace.tasks[0]!.repoId, "PRB-900"], (summary) => ({ ...summary!, outcome: null }));
    client.removeQueries({ queryKey: ["summary", workspace.tasks[1]!.repoId, "PRB-901"] });
    home(workspace);
    for (const name of ["Ticket 0 merged", "Ticket 1 executing"])
      expect(card(name).querySelector(".task-card-outcome")!.textContent).toBe("\u00a0");
    // One line, cut short with an ellipsis at the card's other end.
    const rule = /\.task-card-description > \.task-card-outcome \{([^}]*)\}/.exec(
      readFileSync(`${import.meta.dirname}/../styles.css`, "utf8"),
    )?.[1];
    expect(rule).toMatch(/white-space: nowrap;/);
    expect(rule).toMatch(/overflow: hidden;/);
    expect(rule).toMatch(/text-overflow: ellipsis;/);
  });

  it("names a stopped loop's stage 'loop stopped', and every other card by its stage", () => {
    home(board([["failed", null], ["plan_invalid", null], ["cancelled", null], ["executing", null], ["merged", pr], ["changes_requested", null]]));
    const pill = (name: string): string => card(name).querySelector(".stage-pill")!.textContent ?? "";
    expect(pill("Ticket 0 failed")).toBe("loop stopped");
    // At the contract when it stopped, which is no stage to name.
    expect(pill("Ticket 1 plan_invalid")).toBe("loop stopped");
    expect(pill("Ticket 2 cancelled")).toBe("loop stopped");
    // Mid-run with nothing running it: a stop too.
    expect(pill("Ticket 3 executing")).toBe("loop stopped");
    expect(pill("Ticket 4 merged")).toBe("completed");
    expect(pill("Ticket 5 changes_requested")).toBe("decisions required");
  });
});

/**
 * One ticket the sample host has no record of, so reading its summary is
 * refused, filed in the archive or left on the board.
 */
function unreadable(filed: boolean): Snapshot {
  const row = structuredClone(
    sample.tasks.find((task) => (task.ticket.state === "merged") === filed) ?? sample.tasks[0]!,
  );
  if (filed) row.ticket.state = "merged";
  // A key the protocol accepts and the sample host has no ticket for.
  row.ticket.key = "ZZZ-9999999";
  return {
    ...structuredClone(sample),
    tasks: [row],
    archived: filed ? [row.repoId + ":" + row.ticket.key] : [],
  };
}

describe("a diff whose summary could not be read", () => {
  for (const archive of [false, true]) {
    it(`says it is unavailable and why, not that there is none yet${archive ? ", in the archive" : ""}`, async () => {
      render(
        <QueryClientProvider client={client}>
          <HomePage workspace={unreadable(archive)} navigate={() => undefined} archive={archive} />
        </QueryClientProvider>,
      );
      const label = await screen.findByText("diff unavailable");
      expect(label.getAttribute("title")).toBe("Sample task not found in this repository.");
      expect(screen.queryByText("no diff yet")).toBeNull();
    });
  }
});
