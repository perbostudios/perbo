import { useEffect, useRef, useState } from "react";
import { inTheWay } from "../../shared/jobs.js";
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
import { ModelCatalogSchema, ModelProviderSchema } from "../../shared/protocol.js";
import { catalogDefault, pickerOrder, providerName, withOfferedDefaults } from "../../shared/contract-editing.js";
import { EFFORT_LABELS, type EffortLevel } from "@perbo/contracts/browser";
import type {
  ModelProvider,
  Provider,
  TaskModels,
} from "../../shared/protocol.js";

/** The connection a model provider runs on, as `providers` lists it: `claude-cli` on `claude`. */
const connectionOf = (id: ModelProvider): string => id.replace(/-cli$/, "");
const signedIn = (connections: Provider[] | undefined, id: ModelProvider): boolean =>
  connections?.some((connection) => connection.id === connectionOf(id) && connection.authenticated) ?? false;
/** How a provider is reached, as its option in a picker says it. */
const connectionKind = (id: string): string =>
  id === "anthropic" ? " · optional API" : id === "opencode-cli" ? " · CLI" : " · subscription";
/** The role a connection's `roles` names for each picker. */
const ROLE_LABELS = { executor: "Execution", reviewer: "Independent review" } as const;
/** Whether the host offers this role on this provider's connection; a role it withholds is greyed out. */
const offersRole = (connections: Provider[], id: ModelProvider, role: "executor" | "reviewer"): boolean =>
  connections.some((connection) => connection.id === connectionOf(id) && connection.roles.includes(ROLE_LABELS[role]));
const effortLabel = (level: EffortLevel | null): string => (level === null ? "Default" : EFFORT_LABELS[level]);
/**
 * `provider`'s model catalog, read through the host while `enabled`. The
 * pickers and the setup screen share one reading by its key.
 */
function useCatalog(provider: ModelProvider, enabled: boolean) {
  return useQuery({
    queryKey: ["models", provider],
    queryFn: async () =>
      ModelCatalogSchema.parse(
        await bridge.request({ kind: "models", provider }),
      ),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => bridge.request({ kind: "providers" }),
    staleTime: 30_000,
  });
}
/**
 * The name a closed picker reads for a model id: Claude's ids spelled as their
 * family and version ("claude-fable-5-1" is "Fable 5.1"), anything else as the
 * provider wrote it. The open list reads the catalog's own labels.
 */
export function modelName(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+(?:-\d{1,2})*)(?:-\d{8})?(\[1m\])?$/.exec(id);
  if (!claude) return id;
  const [, family = "", version = "", wide] = claude;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.replaceAll("-", ".")}${wide ? " · 1M" : ""}`;
}
/**
 * A role's model choice. Closed, it reads "<model>  <Effort>", and with
 * `connectionDot` a dot after them, green while the role's provider is signed
 * in and grey while it is not.
 */
export function ModelPicker({
  role,
  models,
  onChange,
  connections,
  compact = false,
  connectionDot = true,
  disabled = false,
}: {
  role: "executor" | "reviewer";
  models: TaskModels;
  onChange: (models: TaskModels) => void;
  connections?: Provider[] | undefined;
  compact?: boolean;
  connectionDot?: boolean;
  /** Held shut, reading the saved choice, while whatever the choice is written with is busy. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const provider =
    role === "executor" ? models.executorProvider : models.reviewerProvider;
  const model =
    role === "executor" ? models.executorModel : models.reviewerModel;
  const effort =
    role === "executor" ? models.executorEffort : models.reviewerEffort;
  const [selection, setSelection] = useState<{
    provider: ModelProvider;
    model: string;
    effort: EffortLevel | null;
  } | null>(null);
  const selectedProvider = selection?.provider ?? provider;
  const catalog = useCatalog(selectedProvider, open);
  // Every model the catalog offers, Claude Opus 5.5 first where it is offered,
  // and the one a role with nothing chosen takes (D-093).
  const choices = pickerOrder(catalog.data?.models ?? []);
  const selectedModel = (selection?.model ?? model) || catalogDefault(choices);
  const selectedChoice = choices.find((choice) => choice.id === selectedModel);
  // The levels this model offers; a level it does not offer sends nothing on
  // Claude Code; Codex starts at medium and the API at high.
  const levels = selectedChoice?.efforts ?? [];
  const selectedEffort = selection !== null ? selection.effort : effort;
  const chosenEffort =
    selectedEffort !== null && levels.includes(selectedEffort) ? selectedEffort : null;
  const done = !selectedChoice || catalog.isFetching || catalog.isError;
  const finish = (): void => {
    onChange(
      role === "executor"
        ? {
            ...models,
            executorProvider: selectedProvider as TaskModels["executorProvider"],
            executorModel: selectedModel,
            executorEffort: chosenEffort,
            draftingProvider: selectedProvider as TaskModels["draftingProvider"],
          }
        : {
            ...models,
            reviewerProvider: selectedProvider,
            reviewerModel: selectedModel,
            reviewerEffort: chosenEffort,
          },
    );
    setOpen(false);
  };
  // A click anywhere else puts the popup away as Done would, or leaves the
  // saved choice as it was where Done cannot be pressed. Only a popup with no
  // model chosen at all stays, because closing it would leave a role with no
  // model to run on.
  const away = useRef<() => void>(() => undefined);
  away.current = () => {
    if (selectedModel === "") return;
    if (done) setOpen(false);
    else finish();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) away.current();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  return (
    <div className="model-picker" ref={root}>
      <button
        type="button"
        aria-label={"Change " + role + " model"}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!open) setSelection({ provider, model, effort });
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
          <strong>{modelName(model)}</strong>
          <span className="model-effort">{effortLabel(effort)}</span>
          {connectionDot && (
            <span className={cx("connection-dot", !signedIn(connections, provider) && "disconnected")} />
          )}
        </span>
        {compact ? (
          <img src="./brand/dropdown.svg" alt="" />
        ) : (
          <span className="small">change</span>
        )}
      </button>
      {open && !disabled && (
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
                effort: null,
              })
            }
          >
            {/* Every provider the protocol names, the optional API for the
                reviewer only; one signed out, or whose connection the host
                does not offer this role on, is greyed out. */}
            {ModelProviderSchema.options
              .filter((id) => role === "reviewer" || id !== "anthropic")
              .map((id) => (
                <option
                  key={id}
                  value={id}
                  disabled={connections !== undefined && (!signedIn(connections, id) || !offersRole(connections, id, role))}
                >
                  {providerName(id)}
                  {connectionKind(id)}
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
                  effort: selectedEffort,
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
          {levels.length > 0 && (
            <div className="effort-control">
              <label htmlFor={role + "-effort"} className="small">
                Effort · <b>{effortLabel(chosenEffort)}</b>
              </label>
              {/* One stop per level this model offers, above the provider's
                  own default at the left; the label names the one chosen. */}
              <input
                id={role + "-effort"}
                type="range"
                aria-label={role + " effort"}
                aria-valuetext={effortLabel(chosenEffort)}
                min={0}
                max={levels.length}
                step={1}
                value={chosenEffort === null ? 0 : levels.indexOf(chosenEffort) + 1}
                onChange={(event) =>
                  setSelection({
                    provider: selectedProvider,
                    model: selectedModel,
                    effort: levels[Number(event.target.value) - 1] ?? null,
                  })
                }
              />
            </div>
          )}
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
          <Button className="small" onClick={finish} disabled={done}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}
/**
 * The Architect's model for new plannings (D-102): the chat's own model where
 * the person chooses one, from the catalog of the connection the chat runs
 * on, which is the executor's; and otherwise Default, the Architect's rule —
 * Claude Opus 5.5 where Claude Code's catalog offers it, and the planning's
 * executor model where it does not. A choice made on one connection holds
 * while the executor stays on it.
 */
export function ArchitectPicker({
  models,
  onChange,
}: {
  models: TaskModels;
  onChange: (models: TaskModels) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const provider = models.draftingProvider;
  const saved = models.architectModel !== null && models.architectProvider === provider ? models.architectModel : "";
  const [selection, setSelection] = useState<string | null>(null);
  const catalog = useCatalog(provider, open);
  const choices = pickerOrder(catalog.data?.models ?? []);
  const selected = selection ?? saved;
  const rule = provider === "claude-cli" ? "Opus 5.5 where offered" : "the executor's model";
  // Default needs no catalog, so it can be chosen while one is read or where
  // none could be; a model needs the catalog to list it.
  const done = selected !== "" && (catalog.isFetching || catalog.isError || !choices.some((choice) => choice.id === selected));
  const finish = (): void => {
    onChange({ ...models, architectProvider: selected === "" ? null : provider, architectModel: selected === "" ? null : selected });
    setOpen(false);
  };
  const away = useRef<() => void>(() => undefined);
  away.current = () => {
    if (done) setOpen(false);
    else finish();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) away.current();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  return (
    <div className="model-picker" ref={root}>
      <button
        type="button"
        aria-label="Change architect model"
        aria-expanded={open}
        onClick={() => {
          if (!open) setSelection(null);
          setOpen(!open);
        }}
      >
        <span className="spacer">
          <strong>{saved === "" ? "Default" : modelName(saved)}</strong>
          {saved === "" && <span className="model-effort">{rule}</span>}
        </span>
        <img src="./brand/dropdown.svg" alt="" />
      </button>
      {open && (
        <div
          className="model-popup"
          role="group"
          aria-label="architect model selection"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <SectionLabel>architect · {providerName(provider)}</SectionLabel>
          <Field id="architect-model-id" label="Model">
            <Dropdown
              id="architect-model-id"
              value={selected}
              aria-describedby="architect-model-status"
              disabled={catalog.isFetching}
              onChange={(event) => setSelection(event.target.value)}
            >
              <option value="">Default · {rule}</option>
              {selected !== "" && !choices.some((choice) => choice.id === selected) && (
                <option value={selected} disabled>
                  {`${selected} · ${catalog.isFetching ? "checking" : "not listed"}`}
                </option>
              )}
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </Dropdown>
          </Field>
          <div id="architect-model-status" className="small muted" role="status">
            {catalog.isFetching
              ? "Discovering models…"
              : catalog.isError
                ? errorMessage(catalog.error)
                : selected === ""
                  ? provider === "claude-cli"
                    ? "Claude Opus 5.5 where Claude Code offers it, and the executor's model where it does not."
                    : "The executor's model, which the spec is drafted with."
                  : (choices.find((choice) => choice.id === selected)?.description ??
                    "Your saved model is no longer listed. Choose a model to replace it.")}
            <div>The Architect runs on the executor's connection.</div>
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
          <Button className="small" onClick={finish} disabled={done}>
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
  // Setting up, the executor's default starts from Claude Code's catalog: on
  // Claude Code it takes Claude Opus 5.5 where the catalog offers it, and
  // keeps the model it has where it does not (D-093). The reviewer keeps its
  // own default (D-010), and an executor the person has chosen on this screen
  // keeps their choice.
  const executorChosen = useRef(false);
  const claudeCatalog = useCatalog("claude-cli", setup && signedIn(providers.data, "claude-cli"));
  useEffect(() => {
    if (!claudeCatalog.data || executorChosen.current) return;
    const offered = claudeCatalog.data.models.map((row) => row.id);
    setSettings((current) => withOfferedDefaults(current, offered));
  }, [claudeCatalog.data]);
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
                <ModelPicker
                  role={role}
                  compact
                  connectionDot={false}
                  models={settings}
                  connections={providers.data}
                  onChange={(models) => {
                    if (role === "executor") executorChosen.current = true;
                    setSettings({ ...settings, ...models });
                  }}
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
    // A readiness check and its configuration save take their turn over the
    // repository they check.
    active = Boolean(inTheWay(workspace.jobs, { repoId: selected, key: null, kind: "doctor" }));
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
