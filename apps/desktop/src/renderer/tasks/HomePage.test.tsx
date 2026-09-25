// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TicketState } from "@perbo/contracts";
import { HomePage } from "./HomePage.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import type { Route } from "../shell/route.js";
import type { Request, Snapshot, TaskRow, TaskSummary } from "../../shared/protocol.js";
import { bridge } from "../workspace/index.js";

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
  vi.restoreAllMocks();
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

  /** The bridge, answering every request with nothing and keeping each one it was asked. */
  function asked(): Request[] {
    const requests: Request[] = [];
    vi.spyOn(bridge, "request").mockImplementation((async (request: Request) => {
      requests.push(request);
      return null;
    }) as typeof bridge.request);
    return requests;
  }
  /** A run under way for this board's ticket at `index`. */
  const running = (workspace: Snapshot, index: number): Snapshot["jobs"][number] => ({
    id: crypto.randomUUID(), repoId: workspace.tasks[index]!.repoId, key: workspace.tasks[index]!.ticket.key, resultKey: null,
    kind: "run", label: "Run", state: "running", startedAt: "2026-09-09T09:00:00.000Z", endedAt: null, log: "", error: null, result: null,
  });
  const cards = (): string[] =>
    [...document.querySelectorAll(".task-list .task-card")].map((entry) => entry.getAttribute("aria-label") ?? "");

  it("keeps a merged or closed ticket on Home, under every colour, with a check in its wheel and Archive to press", async () => {
    const requests = asked();
    const workspace = board([
      ["merged", pr], ["executing", null], ["closed", pr], ["changes_requested", null], ["failed", null], ["pr_open", pr],
    ]);
    workspace.jobs = [running(workspace, 1)];
    // Opened after every other ticket: still under them all.
    workspace.lastOpened = {
      [workspace.tasks[0]!.repoId + ":PRB-900"]: "2026-09-20T09:00:00.000Z",
      [workspace.tasks[2]!.repoId + ":PRB-902"]: "2026-09-21T09:00:00.000Z",
    };
    home(workspace);
    expect(cards()).toEqual([
      "Ticket 5 pr_open", "Ticket 3 changes_requested", "Ticket 4 failed", "Ticket 1 executing",
      "Ticket 2 closed", "Ticket 0 merged",
    ]);
    // Every other sort keeps the decided merges below the rest.
    const sorted = (option: string): string[] => {
      fireEvent.click(screen.getByLabelText("Sort tickets"));
      fireEvent.click(screen.getByRole("option", { name: option }));
      return cards();
    };
    for (const option of ["Newest first", "Oldest first"])
      expect(sorted(option).slice(4).sort()).toEqual(["Ticket 0 merged", "Ticket 2 closed"]);
    // By title, the merged ticket's comes first of all and still sits below.
    expect(sorted("Task title")).toEqual([
      "Ticket 1 executing", "Ticket 3 changes_requested", "Ticket 4 failed", "Ticket 5 pr_open",
      "Ticket 0 merged", "Ticket 2 closed",
    ]);
    // Furthest along, the merged ticket is at no further a stage than the stopped one above it.
    expect(sorted("Furthest along")).toEqual([
      "Ticket 5 pr_open", "Ticket 3 changes_requested", "Ticket 1 executing", "Ticket 4 failed",
      "Ticket 0 merged", "Ticket 2 closed",
    ]);
    // The wheel holds the check mark where its progress was; a card still in the loop holds its progress.
    for (const name of ["Ticket 0 merged", "Ticket 2 closed"]) {
      const ring = card(name).querySelector<HTMLElement>(".stage-ring")!;
      expect(ring.getAttribute("aria-label")).toBe("Completed");
      expect(ring.classList).toContain("stage-ring--decided");
      expect(ring.querySelector("img")!.getAttribute("src")).toBe("./brand/approve.png");
      expect(ring.style.background).toBe("");
    }
    for (const name of ["Ticket 5 pr_open", "Ticket 3 changes_requested", "Ticket 4 failed", "Ticket 1 executing"]) {
      const ring = card(name).querySelector<HTMLElement>(".stage-ring")!;
      expect(ring.querySelector("img")).toBeNull();
      expect(ring.style.background).toContain("conic-gradient");
    }
    // Rendered and left alone, nothing is filed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests.filter((request) => request.kind === "archive")).toEqual([]);
    // Archive on a decided card, and on a stopped one, is the same request.
    for (const name of ["Ticket 0 merged", "Ticket 2 closed", "Ticket 4 failed"])
      fireEvent.click(within(card(name)).getByRole("button", { name: "Archive" }));
    const repoId = workspace.tasks[0]!.repoId;
    await waitFor(() =>
      expect(requests.filter((request) => request.kind === "archive")).toEqual([
        { kind: "archive", repoId, keys: ["PRB-900"], archived: true },
        { kind: "archive", repoId, keys: ["PRB-902"], archived: true },
        { kind: "archive", repoId, keys: ["PRB-904"], archived: true },
      ]),
    );
  });

  it("marks a ticket that needs you with a blue circle until it is opened, and never a decided merge", () => {
    const workspace = board([
      ["changes_requested", null], ["failed", null], ["pr_open", pr], ["merged", pr], ["closed", pr], ["executing", null],
    ]);
    workspace.jobs = [running(workspace, 5)];
    const moved = "2026-09-10T09:00:00.000Z";
    for (const row of workspace.tasks) {
      row.ticket.history = [{ at: moved, from: "ready", to: row.ticket.state, note: "moved" }];
      row.ticket.updated_at = moved;
    }
    const circled = (): string[] =>
      cards().filter((name) => card(name).querySelector(".task-card-unseen") !== null);
    const { rerender } = home(workspace);
    expect(circled()).toEqual(["Ticket 2 pr_open", "Ticket 0 changes_requested", "Ticket 1 failed"]);
    const circle = card("Ticket 1 failed").querySelector(".task-card-unseen")!;
    expect(circle.getAttribute("role")).toBe("img");
    expect(circle.getAttribute("aria-label")).toBe("Not opened since it needed you");
    // A button's children are presentational, so the card itself carries the circle's words.
    const described = (): string[] =>
      screen.queryAllByRole("button", { description: "Not opened since it needed you" }).map((each) => each.getAttribute("aria-label") ?? "");
    expect(described()).toEqual(["Ticket 2 pr_open", "Ticket 0 changes_requested", "Ticket 1 failed"]);
    const blue = /\.task-card-unseen \{([^}]*)\}/.exec(readFileSync(`${import.meta.dirname}/../styles.css`, "utf8"))?.[1];
    expect(blue).toMatch(/background: var\(--blue\);/);
    expect(blue).toMatch(/position: absolute;/);
    // Opened after it came to stand there: the circle goes. Opened before: it stays.
    const opened = (index: number, at: string) => ({ [workspace.tasks[index]!.repoId + ":" + workspace.tasks[index]!.ticket.key]: at });
    const later = {
      ...workspace,
      lastOpened: { ...opened(1, "2026-09-10T09:05:00.000Z"), ...opened(0, "2026-09-09T09:00:00.000Z"), ...opened(3, "2026-09-09T09:00:00.000Z") },
    };
    rerender(
      <QueryClientProvider client={client}>
        <HomePage workspace={later} navigate={() => undefined} archive={false} />
      </QueryClientProvider>,
    );
    expect(circled()).toEqual(["Ticket 2 pr_open", "Ticket 0 changes_requested"]);
    expect(described()).toEqual(["Ticket 2 pr_open", "Ticket 0 changes_requested"]);
    expect(screen.getByRole("button", { name: "Ticket 1 failed", description: "" })).toBeTruthy();
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

  it("calls only a decided merge completed: a cancelled or rolled-back ticket a run carries keeps its stage and its ring", () => {
    const workspace = board([["cancelled", null], ["rolled_back", null], ["merged", pr]]);
    workspace.jobs = [running(workspace, 0), running(workspace, 1)];
    home(workspace);
    const pill = (name: string): string => card(name).querySelector(".stage-pill")!.textContent ?? "";
    const ring = (name: string): string => card(name).querySelector(".stage-ring")!.getAttribute("aria-label") ?? "";
    for (const name of ["Ticket 0 cancelled", "Ticket 1 rolled_back"]) {
      expect(card(name).className).not.toMatch(/task-card--red/);
      expect(pill(name)).not.toMatch(/completed|loop stopped/);
      expect(ring(name)).toMatch(/^Stage \d of 6$/);
      expect(card(name).className).not.toMatch(/task-card--complete/);
    }
    expect(pill("Ticket 2 merged")).toBe("completed");
    expect(ring("Ticket 2 merged")).toBe("Completed");
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
