import { Brand, Button, FactList, Notice, PageHeader, SectionLabel } from "../ui/index.js";
import { errorMessage, useAction, useUsage } from "../data.js";
import type { PageProps } from "../shell/App.js";
import { useSurface } from "../shell/surface.js";
import { dollars, monthLabel } from "./UsagePage.js";

/** Settings · General · About (S6C): what this is, and what this machine has merged, spent and connected. */
export function AboutPage({ workspace, navigate }: PageProps) {
  const action = useAction();
  const surface = useSurface();
  const usage = useUsage();
  const back = (): void => navigate({ page: "general" });
  return (
    <section className="screen" data-screen="s6c">
      <PageHeader crumbs={["Settings", "General", "About"]} />
      <div className="about-body">
        <div className="about-main">
          <div className="about-brand">
            <Brand />
            <div>
              <h1>perbo</h1>
              <span className="small muted">
                {workspace.version} ·{" "}
                {surface === "native" ? "desktop · local" : "interactive preview"}
              </span>
            </div>
          </div>
          <p className="about-copy">
            A desktop loop that takes one ticket at a time, agrees a contract
            with you, does the work in a throwaway worktree, and has a second
            agent check the result against the criteria you approved. It opens
            a pull request. It never merges one.
          </p>
          <FactList
            rows={[
              ["Built by", "Perbo"],
              ["Runner", "this machine · nothing hosted"],
              ["Credentials", "Claude Code and Codex subscription CLIs"],
              ["Telemetry", "off · no account required"],
              ["Licence", "source-available · FSL-1.1"],
              ["Updated", "Local build · " + workspace.version],
            ]}
          />
        </div>
        <aside className="about-side">
          <section className="outlined-card">
            <SectionLabel>Help</SectionLabel>
            <div className="about-help">
              {(
                [
                  ["documentation", "Documentation"],
                  ["problem", "Report a problem"],
                  ["releases", "Release notes"],
                  ["privacy", "Privacy"],
                ] as const
              ).map(([page, label]) => (
                <button
                  key={page}
                  onClick={() => action.mutate({ kind: "openHelp", page })}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
          <section className="outlined-card">
            <SectionLabel>This machine</SectionLabel>
            <FactList
              rows={[
                [
                  "Tickets merged",
                  workspace.tasks.filter(
                    (row) => row.ticket.state === "merged",
                  ).length,
                ],
                [
                  usage.data ? `Spent in ${monthLabel(usage.data.ledger.month)}` : "Spent this month",
                  usage.data
                    ? dollars(usage.data.ledger.spentMicros) +
                      (usage.data.ledger.unpricedAttempts ? " + unpriced attempts" : "")
                    : usage.error
                      ? "unavailable"
                      : "reading…",
                ],
                ["Repositories", workspace.repositories.length],
              ]}
            />
          </section>
          <span className="spacer" />
          <Button variant="primary" onClick={back}>
            Done
          </Button>
          {action.error && (
            <Notice tone="danger">{errorMessage(action.error)}</Notice>
          )}
        </aside>
      </div>
    </section>
  );
}
