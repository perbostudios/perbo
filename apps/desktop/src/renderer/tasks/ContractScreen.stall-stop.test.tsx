// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { App } from "../shell/App.js";
import { ContractScreen } from "./ContractScreen.js";
import { sampleBridge } from "../../sample-host/bridge.js";
import { setPlatformForTests } from "../../shared/shortcuts.js";
import type { TaskContext } from "./task-context.js";

/**
 * What the desktop says stops a run (SCP-323, D-096).
 *
 * Nothing bounds a run's time, tokens, iterations or commands, so the two
 * surfaces that used to print those numbers print what is true instead: the
 * stall window, and a cost cap that binds only an executor billed per token.
 */

let client: QueryClient;
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
  sessionStorage.clear();
  location.hash = "home";
  setPlatformForTests(true);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  setPlatformForTests(null);
});

function mount(element: ReactNode): void {
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

async function contractContext(): Promise<TaskContext> {
  const workspace = structuredClone(await sampleBridge.request({ kind: "snapshot" }));
  const row = workspace.tasks.find((task) => task.ticket.key === "PRB-421")!;
  const detail = structuredClone(
    await sampleBridge.request({ kind: "detail", repoId: row.repoId, key: row.ticket.key }),
  );
  detail.attempts = [];
  workspace.jobs = [];
  return { workspace, detail, repoId: row.repoId, navigate: vi.fn(), show: vi.fn() };
}

describe("the ceilings the contract screen shows before a run", () => {
  it("names the stall window, no ceiling on the work, and an API-key-only cost cap", async () => {
    const context = await contractContext();
    mount(<ContractScreen {...context} />);

    const facts = (await screen.findByText("This run")).parentElement!;
    expect(within(facts).getByText("Stops after")).toBeTruthy();
    expect(
      within(facts).getByText(
        `${context.detail.effective.stallMinutes} min with no tool activity`,
      ),
    ).toBeTruthy();
    // The three the run no longer has, said out loud rather than left off: a
    // reader who remembers the old numbers needs to know they are gone.
    expect(within(facts).getByText("Time, tokens, commands")).toBeTruthy();
    expect(within(facts).getByText("No ceiling")).toBeTruthy();
    expect(within(facts).getByText("Cost cap")).toBeTruthy();
    expect(within(facts).getByText(/a ticket, on an API key$/)).toBeTruthy();
    expect(within(facts).queryByText("Wall clock")).toBeNull();
    expect(within(facts).queryByText("Commands")).toBeNull();
  });

  it("says a subscription run is not capped at all", async () => {
    const context = await contractContext();
    mount(<ContractScreen {...context} />);

    expect(
      await screen.findByText(/On a subscription nothing caps the spend/),
    ).toBeTruthy();
  });
});

describe("the settings that tighten what stops a run", () => {
  it("offers a stall window and a per-token ticket cap, and no wall clock or command ceiling", async () => {
    mount(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(
      within(await screen.findByRole("group", { name: "Settings sections" })).getByRole(
        "button",
        { name: "Connections" },
      ),
    );
    fireEvent.click(await screen.findByText("Stops"));

    await screen.findByText("What stops a new run");
    expect(
      screen.getByLabelText("Minutes with no tool activity before a run stops"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Ticket cost cap (USD, API-key executors only)"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Minutes per attempt")).toBeNull();
    expect(screen.queryByLabelText("Commands per attempt")).toBeNull();
  });
});

describe("the moment General offers to interrupt you on", () => {
  it("names a stall, because that is what stops a run now", async () => {
    mount(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    expect(
      await screen.findByText("A run stops short — it stalls, or hits a ceiling you set"),
    ).toBeTruthy();
  });
});
