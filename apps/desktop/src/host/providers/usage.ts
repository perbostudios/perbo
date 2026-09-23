import { currentMonth, ledgerFor, readAttempts } from "../records.js";
import type { StoredAttempt } from "../records.js";
import { redact } from "../process.js";
import { attemptsPath } from "../repository/layout.js";
import { noWindows, type claudeUsage, type codexUsage, type ProviderUsage } from "../usage-probe.js";
import type { TicketReads } from "../tickets/reads.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Provider, Settings, UsageReport } from "../../shared/protocol.js";
import type { Ticket } from "@perbo/contracts";

export interface UsageDeps {
  repositories(): readonly RegisteredRepository[];
  lookup(id: string): RegisteredRepository;
  tickets: Pick<TicketReads, "list">;
  settings(): Settings;
  providers(): Promise<Provider[]>;
  /** Each provider's own account of its plan windows; a fake in tests. */
  probe: { claude: typeof claudeUsage; codex: typeof codexUsage };
}

/** The month's ledger from retained attempts, and each provider's own account of its plan (S6E). */
export async function usageReport(deps: UsageDeps): Promise<UsageReport> {
  const records: { ticket: Ticket; attempts: StoredAttempt[] }[] = [];
  const notes: string[] = [];
  for (const repo of deps.repositories()) {
    try {
      deps.lookup(repo.id);
      for (const ticket of (await deps.tickets.list(repo)).tickets) {
        const record = readAttempts(
          attemptsPath(repo, ticket.ticket_id),
        );
        if (record.error)
          notes.push(`${repo.name} · ${ticket.key}: ${record.error}`);
        records.push({ ticket, attempts: record.attempts });
      }
    } catch (error) {
      notes.push(`${repo.name}: ${redact(String(error))}`);
    }
  }
  const settings = deps.settings();
  const roleOf = (
    id: "claude-cli" | "codex-cli" | "anthropic",
  ): string | null =>
    [
      settings.executorProvider === id && "default executor",
      settings.reviewerProvider === id && "default reviewer",
    ]
      .filter(Boolean)
      .join(" · ") || null;
  const providers = await deps.providers();
  const signedIn = (id: Provider["id"]): boolean =>
    providers.find((provider) => provider.id === id)?.authenticated ?? false;
  const ask = async (id: "claude" | "codex", name: string): Promise<ProviderUsage> =>
    signedIn(id)
      ? deps.probe[id]()
      : noWindows(
          `${name} is not ${providers.find((provider) => provider.id === id)?.installed ? "signed in" : "installed"} on this machine.`,
        );
  const [claude, codex] = await Promise.all([ask("claude", "Claude Code"), ask("codex", "Codex")]);
  return {
    readAt: new Date().toISOString(),
    ledger: ledgerFor(records, currentMonth()),
    providers: [
      { id: "claude", name: "Claude Code", role: roleOf("claude-cli"), connected: signedIn("claude"), ...claude },
      { id: "codex", name: "Codex", role: roleOf("codex-cli"), connected: signedIn("codex"), ...codex },
      {
        id: "anthropic",
        name: "Anthropic API",
        role: roleOf("anthropic"),
        connected: signedIn("anthropic"),
        plan: null,
        windows: null,
        detail: signedIn("anthropic")
          ? "Metered API usage; the API reports no plan window."
          : "No API key in the app environment.",
      },
    ],
    notes,
  };
}
