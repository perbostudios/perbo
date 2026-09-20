import { Button, InkIcon, Notice, NumberPop, PageHeader, SectionLabel } from "../ui/index.js";
import { errorMessage, useUsage } from "../data.js";
import { timeAgo } from "../presentation.js";
import type { PageProps } from "../shell/App.js";
import type { UsageLedger, UsageWindow } from "../../shared/protocol.js";

export const dollars = (micros: number | null): string =>
  micros === null ? "—" : "$" + (micros / 1_000_000).toFixed(2);
const resetLabel = (window: UsageWindow): string => {
  if (!window.resetsAt) return "";
  const at = new Date(window.resetsAt);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.max(0, Math.round((at.getTime() - Date.now()) / 60_000));
  const inWords =
    minutes >= 24 * 60
      ? `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${minutes}m`;
  return `resets ${at.toLocaleString(undefined, { weekday: minutes >= 24 * 60 ? "short" : undefined, hour: "2-digit", minute: "2-digit" })} · in ${inWords}`;
};
export const monthLabel = (month: string): string => {
  const [year, index] = month.split("-").map(Number);
  return new Date(year ?? 2026, (index ?? 1) - 1, 1).toLocaleString(undefined, { month: "long" });
};
export function LedgerFacts({ ledger }: { ledger: UsageLedger }) {
  return (
    <dl className="usage-facts">
      <div>
        <dt>Spent in {monthLabel(ledger.month)}</dt>
        <dd>
          <NumberPop value={dollars(ledger.spentMicros)} />
          {ledger.unpricedAttempts > 0 && (
            <small>
              {" "}
              + {ledger.unpricedAttempts} unpriced {ledger.unpricedAttempts === 1 ? "attempt" : "attempts"}
            </small>
          )}
        </dd>
      </div>
      <div>
        <dt>Tickets run</dt>
        <dd>
          <NumberPop value={ledger.ticketsRun} />
          {ledger.stoppedShort > 0 && (
            <small> · {ledger.stoppedShort} stopped short</small>
          )}
        </dd>
      </div>
      <div>
        <dt>Average per merged ticket</dt>
        <dd>
          <NumberPop value={dollars(ledger.averageMergedMicros)} />
          <small>
            {" "}
            {ledger.ticketsMerged} merged{ledger.averageMergedMicros === null && ledger.ticketsMerged > 0 ? " · not every attempt was priced" : ""}
          </small>
        </dd>
      </div>
    </dl>
  );
}

/** Settings · Usage (S6E): can I start another ticket right now, from the providers' own replies and this machine's ledger. */
export function UsagePage({ workspace, navigate }: PageProps) {
  const usage = useUsage();
  const report = usage.data;
  const hot = report?.providers.flatMap((provider) =>
    (provider.windows ?? []).filter((window) => window.usedPercent >= 75).map((window) => ({ provider, window })),
  );
  return (
    <section className="screen" data-screen="s6e">
      <PageHeader
        crumbs={["Settings", "Usage"]}
        subtitle={
          usage.isFetching
            ? "reading from the providers…"
            : report
              ? `read from the providers · ${timeAgo(report.readAt).toLowerCase()}`
              : undefined
        }
      >
        <Button
          className="small"
          disabled={usage.isFetching}
          onClick={() => {
            void usage.refetch();
          }}
        >
          ↻ Refresh
        </Button>
      </PageHeader>
      {usage.error && (
        <div className="workspace-errors">
          <Notice tone="danger">{errorMessage(usage.error)}</Notice>
        </div>
      )}
      {usage.isPending && !usage.error && (
        <div className="launch">
          <InkIcon name="dots" size={28} className="waiting-dots" />
          <p className="muted">Asking the providers what they report…</p>
        </div>
      )}
      {report && (
        <div className="settings-columns usage-columns">
          <div className="stack">
            <div className="column-heading">
              <h3>Plans in use</h3>
              <span className="small muted">
                every number here comes from the provider’s own reply — perbo does not meter you
              </span>
            </div>
            {report.providers.map((provider) => (
              <section className="outlined-card usage-provider" key={provider.id}>
                <div className="card-heading">
                  <span className={"connection-dot" + (provider.windows ? "" : " disconnected")} />
                  <strong>
                    {provider.name}
                    {provider.plan ? ` · ${provider.plan}` : ""}
                  </strong>
                  {provider.role && <span className="role-tag">{provider.role}</span>}
                </div>
                {provider.windows?.length ? (
                  <div className="stack" style={{ gap: 12 }}>
                    {provider.windows.map((window) => (
                      <div className="usage-window" key={window.label}>
                        <div className="row">
                          <span className="spacer">{window.label}</span>
                          <span className="mono muted small">{resetLabel(window)}</span>
                          <strong className="mono">{Math.round(window.usedPercent)}% used</strong>
                        </div>
                        <div
                          className={"progress-track" + (window.usedPercent >= 75 ? " progress-track--hot" : "")}
                          role="meter"
                          aria-label={window.label}
                          aria-valuenow={Math.round(window.usedPercent)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <span style={{ width: Math.min(100, window.usedPercent) + "%" }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <p className="small muted" style={{ marginTop: provider.windows?.length ? 10 : 0 }}>
                  {provider.detail}
                </p>
              </section>
            ))}
            {hot && hot.length > 0 && (
              <div className="scope-message">
                <InkIcon name="alert" size={16} />
                <span>
                  {hot
                    .map(
                      ({ provider, window }) =>
                        `${provider.name}’s ${window.label.toLowerCase()} is at ${Math.round(window.usedPercent)}%.`,
                    )
                    .join(" ")}{" "}
                  A ticket started now may meet that limit; the loop records a provider wait rather than a failure when it does.
                </span>
              </div>
            )}
            <button className="add-row" onClick={() => navigate({ page: "connections" })}>
              <span>Connections</span>
              <span className="small">add a provider or change the defaults</span>
            </button>
          </div>
          <div className="stack">
            <section className="outlined-card">
              <SectionLabel>This machine</SectionLabel>
              <LedgerFacts ledger={report.ledger} />
              <p className="small muted" style={{ marginTop: 12 }}>
                Summed from retained attempt records. An attempt whose provider reported no price is
                counted, never priced.
              </p>
            </section>
            {report.notes.map((note) => (
              <Notice key={note}>{note}</Notice>
            ))}
            {workspace.mode === "preview" && (
              <p className="small muted">Sample figures. The desktop reads its own records.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
