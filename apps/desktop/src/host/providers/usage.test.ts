import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratch } from "@perbo/test-support";
import { usageReport, type UsageDeps } from "./usage.js";
import { attemptsPath } from "../repository/layout.js";
import { currentMonth } from "../records.js";
import { SettingsSchema } from "../../shared/protocol.js";
import type { Provider } from "../../shared/protocol.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Ticket } from "@perbo/contracts";

const scratchDirectory = createScratch("perbo-usage-");
afterEach(() => {
  scratchDirectory.removeAll();
});
function repository(): RegisteredRepository {
  const root = scratchDirectory();
  const path = join(root, "checkout");
  mkdirSync(join(path, ".perbo", "state"), { recursive: true });
  return { id: "80000000-0000-4000-8000-000000000001", name: "checkout", path };
}
const ticket = { key: "PRB-1", ticket_id: "ticket_1" } as unknown as Ticket;
const online = (id: string, authenticated: boolean): Provider =>
  ({ id, authenticated, installed: true }) as Provider;
function deps(repo: RegisteredRepository, over: Partial<UsageDeps> = {}): UsageDeps {
  return {
    repositories: () => [repo],
    lookup: () => repo,
    tickets: { list: () => Promise.resolve({ tickets: [ticket] }) },
    settings: () => SettingsSchema.parse({}),
    providers: () =>
      Promise.resolve([online("claude", true), online("codex", false), online("anthropic", false)]),
    probe: {
      claude: () => Promise.resolve({ plan: "Max", windows: null, detail: "Claude Code says so" }),
      codex: () => Promise.resolve({ plan: "Pro", windows: null, detail: "Codex says so" }),
    },
    ...over,
  };
}

describe("usageReport", () => {
  it("counts the month's spend from the attempts each ticket recorded", async () => {
    const repo = repository();
    writeFileSync(
      attemptsPath(repo, "ticket_1"),
      JSON.stringify({
        ticket_id: "ticket_1",
        attempts: [
          {
            attempt_id: "att_1",
            created_at: new Date().toISOString(),
            usage: { cost_micros: 1_500_000, cost_basis: "transport_reported" },
          },
        ],
      }),
    );
    const report = await usageReport(deps(repo));
    expect(report.ledger.month).toBe(currentMonth());
    expect(report.ledger.spentMicros).toBe(1_500_000);
    expect(report.readAt).toBeTruthy();
  });

  it("says which provider is each role's default", async () => {
    const repo = repository();
    const settings = SettingsSchema.parse({});
    const report = await usageReport(
      deps(repo, {
        settings: () => ({ ...settings, executorProvider: "claude-cli", reviewerProvider: "claude-cli" }),
      }),
    );
    const claude = report.providers.find((row) => row.id === "claude");
    expect(claude?.role).toBe("default executor · default reviewer");
    expect(report.providers.find((row) => row.id === "codex")?.role).toBeNull();
  });

  it("asks each provider for its own plan only where it is signed in", async () => {
    const repo = repository();
    let asked = 0;
    const counted = () => {
      asked += 1;
      return Promise.resolve({ plan: "Pro", windows: null, detail: "Says so" });
    };
    const report = await usageReport(
      deps(repo, {
        providers: () => Promise.resolve([online("claude", false), online("codex", false)]),
        probe: { claude: counted, codex: counted },
      }),
    );
    expect(asked).toBe(0);
    expect(report.providers.find((row) => row.id === "claude")).toMatchObject({
      connected: false,
      detail: "Claude Code is not signed in on this machine.",
    });
    expect(report.providers.find((row) => row.id === "codex")).toMatchObject({
      connected: false,
      detail: "Codex is not signed in on this machine.",
    });
    const online_ = await usageReport(
      deps(repo, {
        providers: () => Promise.resolve([online("claude", true), online("codex", true)]),
      }),
    );
    expect(online_.providers.find((row) => row.id === "claude")).toMatchObject({
      connected: true,
      plan: "Max",
      detail: "Claude Code says so",
    });
    expect(online_.providers.find((row) => row.id === "codex")).toMatchObject({
      connected: true,
      plan: "Pro",
      detail: "Codex says so",
    });
  });

  it("says a provider that is not there is not installed", async () => {
    const repo = repository();
    const report = await usageReport(
      deps(repo, {
        providers: () =>
          Promise.resolve([{ id: "codex", authenticated: false, installed: false } as Provider]),
      }),
    );
    expect(report.providers.find((row) => row.id === "codex")?.detail).toBe(
      "Codex is not installed on this machine.",
    );
  });

  it("notes a ticket whose attempts record could not be read", async () => {
    const repo = repository();
    writeFileSync(attemptsPath(repo, "ticket_1"), "{not json");
    const report = await usageReport(deps(repo));
    expect(report.notes[0]).toContain("checkout · PRB-1");
  });

  it("notes a repository it could not read at all, and still answers", async () => {
    const repo = repository();
    const report = await usageReport(
      deps(repo, {
        lookup: () => {
          throw new Error("This repository is no longer connected.");
        },
      }),
    );
    expect(report.notes[0]).toContain("checkout: ");
    expect(report.ledger.spentMicros).toBe(0);
  });
});
