import { useEffect, useState } from "react";
import { Button, InkIcon, Notice, PageHeader, cx } from "../ui/index.js";
import { errorMessage, useAction } from "../workspace/index.js";
import { useToast } from "../shell/Toast.js";
import type { PageProps } from "../shell/route.js";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_GROUPS,
  bindingFromEvent,
  conflictFor,
  displayBinding,
  effectiveShortcuts,
  type ShortcutAction,
} from "../../shared/shortcuts.js";

export function Keys({ binding }: { binding: string }) {
  return (
    <span className="keys">
      {displayBinding(binding).map((part, index) => (
        <kbd key={index}>{part}</kbd>
      ))}
    </span>
  );
}

/** Settings · General · Shortcuts (S6G): every binding, recorded on click; a conflict is refused and named. */
export function ShortcutsPage({ workspace, navigate }: PageProps) {
  const action = useAction();
  const toast = useToast();
  const overrides = workspace.settings.shortcuts;
  const effective = effectiveShortcuts(overrides);
  const [recording, setRecording] = useState<ShortcutAction | null>(null),
    [refused, setRefused] = useState<string | null>(null),
    [shaking, setShaking] = useState(false);
  const refuse = (message: string): void => {
    setRefused(message);
    setShaking(false);
    requestAnimationFrame(() => setShaking(true));
  };
  useEffect(() => {
    if (!recording) return;
    const listen = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setRefused(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (!binding) return;
      const conflict = conflictFor(overrides, recording, binding);
      if (conflict) {
        refuse(`${displayBinding(binding).join(" ")} is already ${conflict.label}${conflict.fixed ? ", which cannot move" : ""}.`);
        return;
      }
      const definition = DEFAULT_SHORTCUTS.find((entry) => entry.action === recording)!;
      const next = { ...overrides };
      if (binding === definition.binding) delete next[recording];
      else next[recording] = binding;
      void action
        .mutateAsync({ kind: "saveSettings", settings: { ...workspace.settings, shortcuts: next } })
        .then(() => toast(`${definition.label} · ${displayBinding(binding).join(" ")}`))
        .catch(() => undefined);
      setRecording(null);
      setRefused(null);
    };
    window.addEventListener("keydown", listen, { capture: true });
    return () => window.removeEventListener("keydown", listen, { capture: true });
  }, [recording, overrides]);
  const current = recording ? DEFAULT_SHORTCUTS.find((entry) => entry.action === recording) : undefined;
  return (
    <section className="screen" data-screen="s6g">
      <PageHeader crumbs={["Settings", "General", "Shortcuts"]} subtitle="click a binding to record a new one" />
      <div className="settings-columns shortcuts-columns">
        <div className="stack">
          <div className="column-heading">
            <h3>Keyboard</h3>
            <span className="small muted">the whole app is reachable without the trackpad</span>
          </div>
          {SHORTCUT_GROUPS.map((group) => (
            <section className="shortcut-group" key={group.id}>
              <div className="column-heading">
                <strong>{group.title}</strong>
                <span className="small muted">{group.detail}</span>
              </div>
              {DEFAULT_SHORTCUTS.filter((entry) => entry.group === group.id).map((entry) => (
                <div className={cx("shortcut-row", entry.fixed && "shortcut-row--fixed")} key={entry.action}>
                  <span className="spacer">{entry.label}</span>
                  <button
                    type="button"
                    className={cx("shortcut-binding", recording === entry.action && "recording")}
                    aria-label={`${entry.label}: ${displayBinding(effective[entry.action]).join(" ")}${entry.fixed ? " (fixed)" : ""}`}
                    disabled={Boolean(entry.fixed)}
                    onClick={() => {
                      setRefused(null);
                      setRecording(recording === entry.action ? null : entry.action);
                    }}
                  >
                    {recording === entry.action ? (
                      <span className="mono small">
                        press keys… <InkIcon name="dots" size={12} className="waiting-dots" />
                      </span>
                    ) : (
                      <Keys binding={effective[entry.action]} />
                    )}
                  </button>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="stack">
          <section className={cx("outlined-card", "t-input-wrap", refused && "is-error")}>
            <div className="column-heading">
              <strong>Recording</strong>
              <span className="small muted">
                {current ? current.label : "click a binding on the left"}
              </span>
            </div>
            <div className={cx("shortcut-recorder", "t-input", refused && "is-error", shaking && "is-shaking")} role="status">
              {current ? (
                <span className="mono">
                  press keys… <InkIcon name="dots" size={12} className="waiting-dots" />
                </span>
              ) : (
                <span className="muted small">Nothing is being recorded.</span>
              )}
            </div>
            <p className={cx("t-error-msg", "small")} role={refused ? "alert" : undefined}>
              {refused ?? "A combination already in use is refused and named."}
            </p>
            <p className="small muted">
              A combination already in use is refused and named, not silently taken. Escape keeps the
              old binding. Bindings are per machine, like everything else in settings.
            </p>
            <Button
              className="small"
              disabled={Object.keys(overrides).length === 0}
              onClick={() => {
                void action
                  .mutateAsync({ kind: "saveSettings", settings: { ...workspace.settings, shortcuts: {} } })
                  .then(() => toast("Shortcuts reset to defaults"))
                  .catch(() => undefined);
              }}
            >
              Reset all to defaults
            </Button>
          </section>
          {action.error && <Notice tone="danger">{errorMessage(action.error)}</Notice>}
        </div>
      </div>
      <footer className="settings-identity">
        <span className="small muted">Done returns you to General, one level up.</span>
        <span className="spacer" />
        <Button variant="primary" className="small" onClick={() => navigate({ page: "general" })}>
          Done
        </Button>
      </footer>
    </section>
  );
}
