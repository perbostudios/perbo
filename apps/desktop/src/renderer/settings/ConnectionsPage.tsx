import { useState } from "react";
import { exclusiveJob, heldRepository } from "../../shared/jobs.js";
import { ManifestDialog } from "./ManifestDialog.js";
import { Button, Dialog, Field, Notice } from "../ui/index.js";
import { FactList, PageHeader, SectionLabel, useElapsed } from "../Screen.js";
import { errorMessage, useAction } from "../data.js";
import { useToast } from "../shell/Toast.js";
import { ModelPicker, useProviders } from "./ConnectionScreens.js";
import type { PageProps } from "../shell/App.js";

/** Settings · Connections (S6): the accounts, the defaults for new tasks, and the repositories. */
export function ConnectionsPage({ workspace, navigate }: PageProps) {
  const action = useAction(),
    providers = useProviders(),
    toast = useToast();
  const [loginError, setLoginError] = useState<{ id: string; message: string; command: string } | null>(null);
  const signIn = (provider: { id: "claude" | "codex"; loginCommand: string }): void => {
    setLoginError(null);
    void action
      .mutateAsync({ kind: "login", provider: provider.id })
      .then(() => toast("Finish signing in in your terminal, then refresh"))
      .catch((error: unknown) => setLoginError({ id: provider.id, message: errorMessage(error), command: provider.loginCommand }));
  };
  const [settings, setSettings] = useState(workspace.settings),
    [limitsOpen, setLimitsOpen] = useState(false),
    [diagnostic, setDiagnostic] = useState<string | null>(null),
    [manifestRepo, setManifestRepo] = useState<string | null>(null);
  // A readiness check is an exclusive command; disconnecting a repository
  // waits for whatever is running in it, in either lane.
  const active = Boolean(exclusiveJob(workspace.jobs));
  const held = (repoId: string): boolean => heldRepository(workspace.jobs, repoId);
  const save = async (): Promise<void> => {
    await action.mutateAsync({ kind: "saveSettings", settings });
  };
  const accounts = (providers.data ?? [])
    .filter((provider): provider is typeof provider & { id: "claude" | "codex" } => provider.id !== "anthropic")
    .sort((a, b) => Number(b.authenticated) - Number(a.authenticated));
  const connected = accounts.filter((provider) => provider.authenticated);
  const currentDoctor = [...workspace.jobs]
    .reverse()
    .find((job) => job.kind === "doctor" && job.repoId === diagnostic);
  const doctorElapsed = useElapsed(currentDoctor?.startedAt, currentDoctor?.state === "running");
  return (
    <section className="screen" data-screen="s6">
      <PageHeader
        crumbs={["Settings", "Connections"]}
        subtitle="keys and repositories live here — the rest of settings is in the pill"
      />
      <div className="settings-columns">
        <div className="stack">
          <div className="column-heading">
            <h3>Accounts</h3>
            <span className="small muted">
              credentials stay with the CLI
            </span>
            <span className="spacer" />
            <button
              className="text-button small muted"
              disabled={providers.isFetching}
              onClick={() => {
                void providers.refetch().then(() => toast("Connections refreshed"));
              }}
            >
              {providers.isFetching ? "refreshing…" : "↻ Refresh connections"}
            </button>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {accounts.map((provider) => (
              <section className="outlined-card" key={provider.id}>
                <div className="card-heading">
                  <span className={"connection-dot" + (provider.authenticated ? "" : " disconnected")} />
                  <strong>{provider.name}</strong>
                  <span className={"role-tag" + (provider.authenticated ? "" : " role-tag--off")}>
                    {!provider.authenticated
                      ? "not connected"
                      : workspace.settings.executorProvider.startsWith(provider.id)
                        ? "default executor"
                        : workspace.settings.reviewerProvider.startsWith(provider.id)
                          ? "default reviewer"
                          : "connected"}
                  </span>
                </div>
                <FactList
                  className="provider-facts"
                  rows={[
                    ["connection", "subscription CLI"],
                    [
                      "models",
                      [
                        workspace.settings.executorProvider.startsWith(
                          provider.id,
                        )
                          ? workspace.settings.executorModel
                          : null,
                        workspace.settings.reviewerProvider.startsWith(
                          provider.id,
                        )
                          ? workspace.settings.reviewerModel
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "available in your CLI",
                    ],
                    ["status", provider.detail],
                  ]}
                />
                <div className="repo-buttons">
                  <Button className="small" disabled={action.isPending} onClick={() => signIn(provider)}>
                    {provider.authenticated ? "Sign in again" : "Sign in"}
                  </Button>
                  <Button
                    className="small"
                    disabled={providers.isFetching}
                    onClick={() => {
                      void providers.refetch();
                    }}
                  >
                    Refresh
                  </Button>
                </div>
                {loginError?.id === provider.id && (
                  <div className="scope-message" role="alert">
                    <span className="spacer">
                      {loginError.message} <code>{loginError.command}</code>
                    </span>
                    <button
                      className="text-button small"
                      onClick={() => {
                        void navigator.clipboard.writeText(loginError.command).then(() => toast("Command copied"));
                      }}
                    >
                      Copy
                    </button>
                  </div>
                )}
              </section>
            ))}
            {providers.isPending && (
              <p className="small muted">Checking connections…</p>
            )}
            {!providers.isPending && connected.length === 0 && (
              <p className="small muted">
                Connect your Claude Code or Codex subscription to choose models.
              </p>
            )}
            <button
              className="add-row"
              onClick={() => navigate({ page: "providers" })}
            >
              + <span>Add a provider</span>
              <span className="small">change your defaults there too</span>
            </button>
          </div>
          <div className="outlined-card defaults-card">
            <SectionLabel>Defaults for new tasks</SectionLabel>
            {(["executor", "reviewer"] as const).map((role) => (
              <div className="default-row" key={role}>
                <span>{role === "executor" ? "Executor" : "Reviewer"}</span>
                <span>
                  <ModelPicker
                    role={role}
                    compact
                    models={workspace.settings}
                    connections={providers.data}
                    onChange={(models) => {
                      action.mutate({
                        kind: "saveSettings",
                        settings: { ...workspace.settings, ...models },
                      });
                    }}
                  />
                </span>
              </div>
            ))}
            <button
              className="default-row"
              onClick={() => {
                setSettings(workspace.settings);
                setLimitsOpen(true);
              }}
            >
              <span>Stops</span>
              <span className="mono">
                {workspace.settings.stallMinutes} min idle · $
                {workspace.settings.ticketDollars.toFixed(2)} a ticket
              </span>
              <img src="./brand/dropdown.svg" alt="" />
            </button>
          </div>
        </div>
        <div className="stack">
          <div className="column-heading">
            <h3>Repositories</h3>
            <span className="small muted">
              {workspace.repositories.length} connected · checkouts already on this machine
            </span>
          </div>
          {workspace.repositories.map((repo) => {
            const doctor = [...workspace.jobs]
              .reverse()
              .find((job) => job.kind === "doctor" && job.repoId === repo.id);
            return (
              <section className="outlined-card" key={repo.id}>
                <div className="card-heading">
                  <strong className="mono">{repo.name}</strong>
                  <span className="small muted">
                    {repo.configured ? "configured" : "never checked"}
                  </span>
                </div>
                <FactList
                  className="repo-facts"
                  rows={[
                    ["path", repo.path],
                    ["branch", repo.branch + " · " + repo.head.slice(0, 7)],
                    ...(repo.configured
                      ? ([
                          [
                            "test command",
                            repo.testCommand ?? "Pinned in configuration",
                          ],
                          [
                            "manifest",
                            repo.manifestCount === undefined
                              ? "Repository configuration"
                              : repo.manifestCount +
                                " files copied into each worktree",
                          ],
                          [
                            "off limits",
                            repo.prohibitedPaths?.join(" · ") ??
                              "Repository configuration",
                          ],
                          [
                            "last check",
                            doctor ? doctor.state : "not checked in this app",
                          ],
                        ] as [string, string][])
                      : []),
                  ]}
                />
                <div className="repo-buttons">
                  {repo.configured && (
                    <Button
                      className="small"
                      onClick={() => setManifestRepo(repo.id)}
                    >
                      Off limits · {repo.prohibitedPaths?.length ?? 0}
                    </Button>
                  )}
                  <Button
                    className="small"
                    variant={repo.configured ? "secondary" : "primary"}
                    disabled={active}
                    onClick={() => {
                      setDiagnostic(repo.id);
                      action.mutate({
                        kind: "doctor",
                        repoId: repo.id,
                        writeConfig: false,
                      });
                    }}
                  >
                    {repo.configured ? "Re-run check" : "Run first check"}
                  </Button>
                  <Button
                    className="small"
                    disabled={held(repo.id)}
                    onClick={() =>
                      action.mutate({
                        kind: "forgetRepository",
                        repoId: repo.id,
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
                {repo.error && <Notice tone="danger">{repo.error}</Notice>}
              </section>
            );
          })}
          <button
            className="add-row"
            onClick={() => navigate({ page: "repositories" })}
          >
            + <span>Add a repository</span>
          </button>
          <p className="small muted">
            Nothing is cloned and nothing is pushed without you — perbo reads the
            checkout in place and works in a throwaway worktree.
          </p>
        </div>
      </div>
      {(action.error || providers.error) && (
        <div className="workspace-errors">
          <Notice tone="danger">
            {errorMessage(action.error ?? providers.error)}
          </Notice>
        </div>
      )}
      <footer className="settings-identity">
        <span className="small muted">Signed in on this machine as</span>
        <strong>{workspace.settings.name}</strong>
        <button className="text-button small muted" onClick={() => navigate({ page: "general" })}>
          change in General
        </button>
        <span className="spacer" />
        <span className="mono muted small">perbo {workspace.version}</span>
      </footer>
      {limitsOpen && (
        <Dialog
          title="What stops a new run"
          onClose={() => setLimitsOpen(false)}
        >
          <p className="small muted">
            A run has no time, token, iteration or command ceiling. What stops
            one is a stall — no tool activity for the window below — and, where
            your executor authenticates with an API key, the ticket cost cap.
            On a subscription nothing caps the spend. These can tighten a
            repository’s own limits, never loosen them.
          </p>
          {(
            [
              {
                key: "stallMinutes",
                label: "Minutes with no tool activity before a run stops",
                min: 1,
                max: 240,
              },
              {
                key: "ticketDollars",
                label: "Ticket cost cap (USD, API-key executors only)",
                min: 0.1,
                max: 1000,
              },
            ] as const
          ).map((field) => (
            <Field id={field.key} label={field.label} key={field.key}>
              <input
                id={field.key}
                type="number"
                min={field.min}
                max={field.max}
                step={field.key === "ticketDollars" ? 0.1 : 1}
                value={settings[field.key]}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    [field.key]: Number(event.target.value),
                  })
                }
              />
            </Field>
          ))}
          <div className="dialog-actions">
            <Button
              variant="primary"
              onClick={() => {
                void save()
                  .then(() => setLimitsOpen(false))
                  .catch(() => undefined);
              }}
            >
              Done
            </Button>
          </div>
          {action.error && (
            <Notice tone="danger">{errorMessage(action.error)}</Notice>
          )}
        </Dialog>
      )}
      {manifestRepo && (
        <ManifestDialog
          repoId={manifestRepo}
          close={() => setManifestRepo(null)}
        />
      )}
      {diagnostic && (
        <Dialog
          title="Repository environment check"
          onClose={() => setDiagnostic(null)}
        >
          {currentDoctor?.state === "running" && (
            <p className="small muted">Checking that a clean worktree installs and runs your tests… {doctorElapsed}</p>
          )}
          <pre className="terminal-output">
            {currentDoctor?.error ??
              currentDoctor?.log ??
              "Waiting for the CLI…"}
          </pre>
          {!workspace.repositories.find((repo) => repo.id === diagnostic)
            ?.configured && (
            <div className="dialog-actions">
              <Button
                disabled={active}
                variant="primary"
                onClick={() =>
                  action.mutate({
                    kind: "doctor",
                    repoId: diagnostic,
                    writeConfig: true,
                  })
                }
              >
                Save proposed configuration
              </Button>
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}
