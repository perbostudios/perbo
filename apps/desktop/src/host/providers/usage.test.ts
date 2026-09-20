import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageReport, type UsageDeps } from "./usage.js";
import { attemptsPath } from "../repository/layout.js";
import { currentMonth } from "../records.js";
import { SettingsSchema } from "../../shared/protocol.js";
import type { Provider } from "../../shared/protocol.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Ticket } from "@perbo/contracts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function repository(): RegisteredRepository {
  const root = mkdtempSync(join(tmpdir(), "perbo-usage-"));
  temporary.push(root);
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
    probe: () => Promise.resolve({ plan: "Pro", windows: null, detail: "Codex says so" }),
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
            usage: { cost_micros: 1_500_000, cost_basis: "metered" },
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

  it("asks Codex for its own plan only where it is signed in", async () => {
    const repo = repository();
    let asked = 0;
    const report = await usageReport(
      deps(repo, {
        providers: () => Promise.resolve([online("codex", false)]),
        probe: () => {
          asked += 1;
          return Promise.resolve({ plan: "Pro", windows: null, detail: "Codex says so" });
        },
      }),
    );
    expect(asked).toBe(0);
    expect(report.providers.find((row) => row.id === "codex")?.detail).toBe(
      "Codex is not signed in on this machine.",
    );
    const online_ = await usageReport(
      deps(repo, { providers: () => Promise.resolve([online("codex", true)]) }),
    );
    expect(online_.providers.find((row) => row.id === "codex")).toMatchObject({
      plan: "Pro",
      detail: "Codex says so",
    });
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
