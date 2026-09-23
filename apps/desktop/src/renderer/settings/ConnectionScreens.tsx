import { useEffect, useRef, useState } from "react";
import { exclusiveJob } from "../../shared/jobs.js";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Dropdown,
  FactList,
  Field,
  InkIcon,
  Notice,
  ProgressDots,
  SectionLabel,
  cx,
  useElapsed,
} from "../ui/index.js";
import { bridge, errorMessage, useAction } from "../workspace/index.js";
import { ManifestDialog } from "./ManifestDialog.js";
import { SkillPicker } from "./SkillPicker.js";
import type { PageProps } from "../shell/route.js";
import { ModelCatalogSchema } from "../../shared/protocol.js";
import type {
  ModelProvider,
  Provider,
  TaskModels,
} from "../../shared/protocol.js";

export const providerName = (id: string): string =>
  id === "codex-cli"
    ? "Codex"
    : id === "anthropic"
      ? "Anthropic API"
      : "Claude Code";
export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => bridge.request({ kind: "providers" }),
    staleTime: 30_000,
  });
}
export function ModelPicker({
  role,
  models,
  onChange,
  connections,
  compact = false,
}: {
  role: "executor" | "reviewer";
  models: TaskModels;
  onChange: (models: TaskModels) => void;
  connections?: Provider[] | undefined;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const provider =
    role === "executor" ? models.executorProvider : models.reviewerProvider;
  const model =
    role === "executor" ? models.executorModel : models.reviewerModel;
  const [selection, setSelection] = useState<{
    provider: ModelProvider;
    model: string;
  } | null>(null);
  const selectedProvider = selection?.provider ?? provider;
  const catalog = useQuery({
    queryKey: ["models", selectedProvider],
    queryFn: async () =>
      ModelCatalogSchema.parse(
        await bridge.request({ kind: "models", provider: selectedProvider }),
      ),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const choices = catalog.data?.models ?? [];
  const selectedModel =
    (selection?.model ?? model) ||
    choices.find((choice) => choice.isDefault)?.id ||
    choices[0]?.id ||
    "";
  const selectedChoice = choices.find((choice) => choice.id === selectedModel);
  const update = (id: string, modelId: string): void =>
    onChange(
      role === "executor"
        ? {
            ...models,
            executorProvider: id as TaskModels["executorProvider"],
            executorModel: modelId,
            draftingProvider: id as TaskModels["draftingProvider"],
          }
        : {
            ...models,
            reviewerProvider: id as TaskModels["reviewerProvider"],
            reviewerModel: modelId,
          },
    );
  return (
    <div className="model-picker">
      <button
        type="button"
        aria-label={"Change " + role + " model"}
        aria-expanded={open}
        onClick={() => {
          if (!open) setSelection({ provider, model });
          setOpen(!open);
        }}
      >
        <span className="spacer">
          {!compact && (
            <span className="role-name">
              {role === "executor" ? "Executor" : "Reviewer"}
              <br />
            </span>
          )}
          <strong>
            {providerName(provider)} · {model}
          </strong>
        </span>
        {compact ? (
          <img src="./brand/dropdown.svg" alt="" />
        ) : (
          <span className="small">change</span>
        )}
      </button>
      {open && (
        <div
          className="model-popup"
          role="group"
          aria-label={role + " model selection"}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <SectionLabel>{role} connection</SectionLabel>
          <Dropdown
            aria-label={role + " provider"}
            value={selectedProvider}
            onChange={(event) =>
              setSelection({
                provider: event.target.value as ModelProvider,
                model: "",
              })
            }
          >
            {(
              [
                "claude-cli",
                "codex-cli",
                ...(role === "reviewer" ? ["anthropic"] : []),
              ] as const
            ).map((id) => (
              <option
                key={id}
                value={id}
                disabled={
                  connections !== undefined &&
                  !connections.some(
                    (connection) =>
                      connection.id ===
                        (id === "claude-cli"
                          ? "claude"
                          : id === "codex-cli"
                            ? "codex"
                            : "anthropic") && connection.authenticated,
                  )
                }
              >
                {providerName(id)}
                {id === "anthropic" ? " · optional API" : " · subscription"}
              </option>
            ))}
          </Dropdown>
          <Field id={role + "-model-id"} label="Model">
            <Dropdown
              id={role + "-model-id"}
              value={selectedModel}
              aria-describedby={role + "-model-status"}
              disabled={choices.length === 0 || catalog.isFetching}
              onChange={(event) =>
                setSelection({
                  provider: selectedProvider,
                  model: event.target.value,
                })
              }
            >
              {!selectedChoice && (
                <option value={selectedModel} disabled>
                  {selectedModel
                    ? `${selectedModel} · ${catalog.isFetching ? "checking" : "not listed"}`
                    : catalog.isFetching
                      ? "Discovering models…"
                      : "No models available"}
                </option>
              )}
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </Dropdown>
          </Field>
          <div
            id={role + "-model-status"}
            className="small muted"
            role="status"
          >
            {catalog.isFetching
              ? "Discovering models…"
              : catalog.isError
                ? errorMessage(catalog.error)
                : choices.length === 0
                  ? "No models were reported. Check sign-in and refresh."
                  : !selectedChoice
                    ? "Your saved model is no longer listed. Choose a model to replace it."
                    : selectedChoice.description}
            {catalog.data?.source === "sample" && (
              <div>Sample catalog</div>
            )}
            {catalog.isError && choices.length > 0 && (
              <div>
                Showing the previous catalog. Refresh before changing models.
              </div>
            )}
          </div>
          <button
            type="button"
            className="text-button small"
            disabled={catalog.isFetching}
            onClick={() => {
              void catalog.refetch();
            }}
          >
            Refresh models
          </button>
          {role === "executor" && (
            <SkillPicker
              selected={models.executorSkills}
              onChange={(executorSkills) =>
                onChange({ ...models, executorSkills })
              }
            />
          )}
          <Button
            className="small"
            onClick={() => {
              update(selectedProvider, selectedModel);
              setOpen(false);
            }}
            disabled={!selectedChoice || catalog.isFetching || catalog.isError}
          >
            Done
          </Button>
        </div>
      )}
    </div>
  );
}
export function ProviderScreen({
  workspace,
  setup = false,
  onDone,
}: PageProps & { setup?: boolean; onDone: () => void }) {
  const [settings, setSettings] = useState(workspace.settings),
    [selected, setSelected] = useState("claude"),
    [copied, setCopied] = useState(false);
  const providers = useProviders(),
    action = useAction();
  const selectedProvider = providers.data?.find(
    (provider) => provider.id === selected,
  );
  const save = (): void => {
    void action
      .mutateAsync({ kind: "saveSettings", settings })
      .then(onDone)
      .catch(() => undefined);
  };
  return (
    <div
      className={cx("screen", "setup-page", !setup && "setup-page--settings")}
      data-screen={setup ? "s2" : "s6b"}
    >
      <div className="setup-heading">
        <div>
          <h1>{setup ? "Connect your accounts" : "Connect another account"}</h1>
          <p>
            Use the Claude Code and Codex subscriptions already on this machine.
            Sign in through their CLIs; credentials stay with the provider.
          </p>
        </div>
        {setup && <ProgressDots setup step={2} />}
      </div>
      <div className="provider-connect">
        <Dropdown
          aria-label="Provider to connect"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setCopied(false);
          }}
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </Dropdown>
        <div className="row connection-command">
          <code className="spacer">
            {selectedProvider?.authenticated
              ? "Signed in through your subscription"
              : (selectedProvider?.loginCommand ??
                "Checking CLI installation…")}
          </code>
          {!selectedProvider?.authenticated && (
            <button
              className="text-button small"
              disabled={!selectedProvider?.loginCommand}
              onClick={() => {
                void navigator.clipboard
                  .writeText(selectedProvider?.loginCommand ?? "")
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
        <Button
          variant="primary"
          disabled={providers.isFetching}
          onClick={() => {
            void providers.refetch();
          }}
        >
          Check
        </Button>
      </div>
      <div className="provider-list">
        {providers.data
          ?.filter((provider) => provider.id !== "anthropic")
          .map((provider) => (
            <div
              className={cx(
                "provider-row",
                provider.authenticated && "provider-row--connected",
              )}
              key={provider.id}
            >
              <div>
                <strong>{provider.name}</strong>
                <p>executor or reviewer</p>
              </div>
              <div>
                <code>
                  {provider.authenticated
                    ? "Subscription CLI · signed in"
                    : provider.installed
                      ? "Installed · sign in to continue"
                      : "Install the provider’s CLI"}
                </code>
                <p>{provider.detail}</p>
              </div>
              <div className="provider-status">
                {provider.authenticated ? (
                  <>
                    <span>connected</span>
                    <span className="connection-check">✓</span>
                  </>
                ) : (
                  <span className="muted">not connected</span>
                )}
              </div>
            </div>
          ))}
      </div>
      {providers.isPending && <p className="muted">Checking your CLIs…</p>}
      {providers.error && (
        <Notice tone="danger">{errorMessage(providers.error)}</Notice>
      )}
      <div className="model-defaults">
        <div className="column-heading">
          <h3>Select your defaults</h3>
          <span className="small muted">
            any connected model can take either role
          </span>
        </div>
        <p className="small muted">
          The reviewer starts a separate session and never receives the
          executor’s narrative. You can choose Claude Code or Codex for either
          role.
        </p>
        <div className="two-columns">
          {(["executor", "reviewer"] as const).map((role) => (
            <div className="provider-default" key={role}>
              <p className="small muted">
                {role === "executor"
                  ? "Executor — writes the change"
                  : "Reviewer — never sees the executor’s story"}
              </p>
              <div className="provider-default-model">
                <span className="connection-dot" />
                <ModelPicker
                  role={role}
                  compact
                  models={settings}
                  connections={providers.data}
                  onChange={(models) => setSettings({ ...settings, ...models })}
                />
              </div>
            </div>
          ))}
        </div>
        <details className="evidence-details">
          <summary>Optional API connection</summary>
          <p className="small muted">
            Anthropic API review can use an ANTHROPIC_API_KEY in the app’s
            launch environment. Perbo does not save API keys. Subscription CLIs
            are the default.
          </p>
        </details>
      </div>
      {action.error && (
        <Notice tone="danger">{errorMessage(action.error)}</Notice>
      )}
      <div className="setup-actions">
        <Button
          variant="primary"
          disabled={
            action.isPending ||
            !settings.executorModel.trim() ||
            !settings.reviewerModel.trim()
          }
          onClick={save}
        >
          {setup ? "Continue" : "Done"}
        </Button>
        {setup && (
          <button className="text-button small" onClick={onDone}>
            Skip — connect in settings
          </button>
        )}
        <span className="spacer" />
        <span className="small muted">
          {setup
            ? "Your subscriptions stay on this machine."
            : "Done returns you to settings. Nothing is saved anywhere but this machine."}
        </span>
      </div>
    </div>
  );
}
export function RepositoryScreen({
  workspace,
  setup = false,
  onDone,
}: PageProps & { setup?: boolean; onDone: () => void }) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(workspace.repositories[0]?.id ?? ""),
    [showCheck, setShowCheck] = useState(false),
    [chooseError, setChooseError] = useState<string | null>(null),
    [manifestOpen, setManifestOpen] = useState(false);
  const action = useAction(),
    // A readiness check and its configuration save are exclusive commands.
    active = Boolean(exclusiveJob(workspace.jobs));
  useEffect(() => {
    if (!selected && workspace.repositories[0])
      setSelected(workspace.repositories[0].id);
  }, [selected, workspace.repositories]);
  const choose = (): void => {
    void bridge
      .request({ kind: "chooseRepository" })
      .then((repo) => {
        if (repo) setSelected(repo.id);
      })
      .catch((error) => {
        setChooseError(errorMessage(error));
      });
  };
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);
  const selectedRepo = workspace.repositories.find(
    (repo) => repo.id === selected,
  );
  const doctor = [...workspace.jobs]
    .reverse()
    .find((job) => job.repoId === selected && job.kind === "doctor");
  const elapsed = useElapsed(doctor?.startedAt, doctor?.state === "running");
  const check = (writeConfig: boolean): void => {
    setShowCheck(true);
    action.mutate({ kind: "doctor", repoId: selected, writeConfig });
  };
  return (
    <div
      className={cx("screen", "setup-page", !setup && "setup-page--settings")}
      data-screen={setup ? "s3" : "s6d"}
    >
      <div className="setup-heading">
        <div>
          <h1>{setup ? "Repositories" : "Point at another repository"}</h1>
          <p>
            Choose the checkouts already on this machine. Nothing is cloned,
            nothing is pushed, and no organisation-wide permission is requested.
          </p>
        </div>
        {setup && <ProgressDots setup step={3} />}
      </div>
      <div className="repo-search">
        {setup && <InkIcon name="folder" size={19} />}
        <input
          ref={searchInput}
          aria-label="Search your checkouts"
          placeholder="Search your checkouts…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="mono muted small">⌘K</span>
      </div>
      <div className="repo-setup-list stack">
        {workspace.repositories
          .filter((repo) =>
            (repo.name + " " + repo.path)
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((repo) => (
            <div
              key={repo.id}
              className={cx(
                "repo-choice",
                selected === repo.id && "selected",
                !setup && repo.configured && "repo-choice--connected",
              )}
            >
              <button
                className="card-heading"
                style={{ width: "100%", textAlign: "left" }}
                onClick={() => {
                  setSelected(repo.id);
                  setShowCheck(false);
                }}
              >
                {selected === repo.id ? (
                  <InkIcon name="approve" size={19} />
                ) : (
                  <span className="repo-unselected" />
                )}
                <strong>{repo.name}</strong>
                <span className="small muted">
                  {repo.dirty ? "uncommitted changes" : "local checkout"}
                </span>
              </button>
              {selected === repo.id && (
                <>
                  <div className="repo-setup-facts">
                    <FactList
                      rows={[
                        ["path", repo.path],
                        [
                          "base commit",
                          repo.head.slice(0, 7) +
                            (repo.dirty
                              ? " · changes present"
                              : " · clean tree"),
                        ],
                      ]}
                    />
                    <FactList
                      rows={[
                        ["default branch", repo.branch],
                        [
                          "test command",
                          repo.testCommand ?? "Read by the environment check",
                        ],
                      ]}
                    />
                  </div>
                  <div className="repo-check">
                    <InkIcon
                      name={doctor?.state === "completed" ? "approve" : "dots"}
                      size={18}
                    />
                    <span className="spacer">
                      {doctor?.error ??
                        (doctor?.state === "running"
                          ? `Checking that a clean worktree installs and runs your tests… ${elapsed ?? ""}`
                          : doctor?.state === "completed"
                            ? "Readiness check completed — inspect the result below."
                            : "Check that this repository is ready for a clean worktree.")}
                    </span>
                    <button
                      className="text-button small"
                      disabled={active}
                      onClick={() => check(false)}
                    >
                      {doctor ? "re-check" : "Run first check"}
                    </button>
                  </div>
                </>
              )}
              {repo.error && <Notice tone="danger">{repo.error}</Notice>}
            </div>
          ))}
        <button className="add-row" onClick={choose}>
          + <span>Add a folder manually</span>
        </button>
      </div>
      {showCheck && (
        <div className="repo-setup-list">
          <details open className="evidence-details">
            <summary>Environment check</summary>
            {doctor ? (
              <>
                <pre className="terminal-output">
                  {doctor.error ?? doctor.log ?? "Waiting for the check…"}
                </pre>
                {!selectedRepo?.configured && doctor.state !== "running" && (
                  <Button
                    className="small"
                    onClick={() => check(true)}
                    disabled={active}
                  >
                    Save proposed configuration
                  </Button>
                )}
              </>
            ) : (
              <p className="small muted">Waiting for the CLI…</p>
            )}
          </details>
        </div>
      )}
      <div className="off-limits">
        <SectionLabel>Off limits in every repository</SectionLabel>
        <div className="path-chips">
          {(
            selectedRepo?.prohibitedPaths ?? [
              ".github/workflows/**",
              "infra/terraform/**",
              "**/*.env*",
            ]
          ).map((path) => (
            <span className="path-chip" key={path}>
              {path}
            </span>
          ))}
          <button
            className="text-button small"
            disabled={!selectedRepo}
            onClick={() => {
              if (selectedRepo) setManifestOpen(true);
            }}
          >
            edit list
          </button>
        </div>
      </div>
      {action.error && (
        <Notice tone="danger">{errorMessage(action.error)}</Notice>
      )}
      {chooseError && <Notice tone="danger">{chooseError}</Notice>}
      {manifestOpen && selectedRepo && (
        <ManifestDialog
          repoId={selectedRepo.id}
          close={() => setManifestOpen(false)}
        />
      )}
      <div className="setup-actions">
        <Button
          variant="primary"
          disabled={
            setup &&
            (!selectedRepo?.configured ||
              doctor?.state !== "completed" ||
              active)
          }
          onClick={onDone}
        >
          {setup ? "Finish setup" : "Done"}
        </Button>
        <span className="spacer" />
        <span className="small muted">
          {setup
            ? "One repository is enough to start. Add more in settings."
            : "Done returns you to settings. The check keeps running there."}
        </span>
      </div>
    </div>
  );
}
