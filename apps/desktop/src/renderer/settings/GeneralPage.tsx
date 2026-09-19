import { useEffect, useState } from "react";
import { Button, Checkbox, Notice, Segmented, Switch } from "@perbo/ui";
import { InkIcon } from "../InkIcon.js";
import { Brand, IconButton, PageHeader, useElapsed } from "../Screen.js";
import { errorMessage, useAction } from "../data.js";
import { useToast } from "../shell/Toast.js";
import type { PageProps } from "../shell/App.js";
import type { Settings } from "../../shared/protocol.js";

const MOMENTS: { key: keyof Settings["notifyOn"]; label: string }[] = [
  { key: "decision", label: "A ticket needs a decision" },
  { key: "review", label: "A review finishes" },
  { key: "ceiling", label: "A run stops short — it stalls, or hits a ceiling you set" },
  { key: "stage", label: "Any stage changes" },
];

/** Settings · General (S6F): your name, what interrupts you, appearance, and the machine staying awake. */
export function GeneralPage({ workspace, navigate }: PageProps) {
  const action = useAction();
  const toast = useToast();
  const settings = workspace.settings;
  const [name, setName] = useState(settings.name),
    [editingName, setEditingName] = useState(false);
  useEffect(() => {
    if (!editingName) setName(settings.name);
  }, [settings.name, editingName]);
  const save = (patch: Partial<Settings>, said?: string): void => {
    void action
      .mutateAsync({ kind: "saveSettings", settings: { ...settings, ...patch } })
      .then(() => {
        if (said) toast(said);
      })
      .catch(() => undefined);
  };
  const saveName = (): void => {
    if (name.trim() && name.trim() !== settings.name) save({ name: name.trim() }, "Name saved");
    setEditingName(false);
  };
  const power = workspace.power;
  const holdElapsed = useElapsed(power?.since, power?.holding ?? false);
  const liveRun = workspace.jobs.find(
    (job) => ["run", "decide"].includes(job.kind) && ["running", "stopping"].includes(job.state),
  );
  return (
    <section className="screen" data-screen="s6f">
      <PageHeader crumbs={["Settings", "General"]} subtitle="nothing on this page leaves this machine" />
      <div className="settings-columns general-columns">
        <div className="stack">
          <section className="outlined-card">
            <div className="card-heading">
              <h3>You</h3>
              <span className="small muted">the name from the first screen, changeable at any time</span>
            </div>
            <div className="general-name">
              <span className="small muted">Username</span>
              {editingName ? (
                <input
                  aria-label="Your name"
                  autoFocus
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={saveName}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveName();
                    if (event.key === "Escape") {
                      setName(settings.name);
                      setEditingName(false);
                    }
                  }}
                />
              ) : (
                <>
                  <strong>{settings.name || "—"}</strong>
                  <IconButton icon="locked" size={15} label="Edit name" onClick={() => setEditingName(true)} />
                </>
              )}
            </div>
          </section>
          <section className="outlined-card">
            <div className="card-heading">
              <h3>Notify me when</h3>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              {MOMENTS.map((moment) => (
                <Checkbox
                  key={moment.key}
                  checked={settings.notifyOn[moment.key]}
                  onChange={(checked) => save({ notifyOn: { ...settings.notifyOn, [moment.key]: checked } })}
                >
                  {moment.label}
                </Checkbox>
              ))}
            </div>
            <div className="general-row" style={{ marginTop: 14 }}>
              <span className="small muted">Deliver to</span>
              <span className="path-chip">This Mac</span>
              <span className="spacer" />
              <span className="small muted">sound</span>
              <Switch
                on={settings.notifySound}
                label="Notification sound"
                onChange={(on) => save({ notifySound: on })}
              />
            </div>
          </section>
          <section className="outlined-card">
            <div className="card-heading">
              <h3>Appearance</h3>
            </div>
            <div className="general-row">
              <span className="small muted">Theme</span>
              <Segmented
                label="Theme"
                value={settings.theme}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "System" },
                ]}
                onChange={(theme) => save({ theme })}
              />
            </div>
            <div className="general-row">
              <span className="small muted">Text size</span>
              <Segmented
                label="Text size"
                value={settings.textSize}
                options={[
                  { value: "small", label: "Small" },
                  { value: "default", label: "Default" },
                  { value: "large", label: "Large" },
                ]}
                onChange={(textSize) => save({ textSize })}
              />
            </div>
            <div className="general-row">
              <span className="small muted">Reduce motion</span>
              <span className="small muted">— no sweeps, no pulses</span>
              <span className="spacer" />
              <Switch on={settings.reduceMotion} label="Reduce motion" onChange={(on) => save({ reduceMotion: on })} />
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="outlined-card">
            <div className="card-heading">
              <h3>Away from keyboard</h3>
              <span className="small muted">the loop runs here, so this machine has to stay awake</span>
            </div>
            <div className="general-row">
              <div className="spacer">
                <strong>AFK mode</strong>
                <p className="small muted">
                  Hold sleep off while a ticket is running, released when the last one stops.
                </p>
              </div>
              <Switch on={settings.afk.holdSleep} label="AFK mode" onChange={(on) => save({ afk: { ...settings.afk, holdSleep: on } })} />
            </div>
            <div className="general-row">
              <span className="spacer">Let the display sleep</span>
              <Switch
                on={settings.afk.displaySleep}
                label="Let the display sleep"
                disabled={!settings.afk.holdSleep}
                onChange={(on) => save({ afk: { ...settings.afk, displaySleep: on } })}
              />
            </div>
            <div className="general-row">
              <span className="spacer">Release the hold on battery power</span>
              <Switch
                on={settings.afk.releaseOnBattery}
                label="Release the hold on battery power"
                disabled={!settings.afk.holdSleep}
                onChange={(on) => save({ afk: { ...settings.afk, releaseOnBattery: on } })}
              />
            </div>
            <div className="scope-message" role="status">
              <InkIcon name={power?.holding ? "dots" : "locked"} size={18} />
              <span className="spacer">
                {power?.holding
                  ? `${power.detail ?? "Holding sleep now."} ${holdElapsed ?? ""}`
                  : power?.detail ??
                    (settings.afk.holdSleep
                      ? liveRun
                        ? "A run is live; the hold applies to run and decision commands."
                        : "Nothing is running, so nothing is held."
                      : "Sleep is not held. Turn on AFK mode to hold it while a ticket runs.")}
              </span>
            </div>
          </section>
          <button className="general-link outlined-card" onClick={() => navigate({ page: "shortcuts" })}>
            <span className="general-link-icon mono">⌘</span>
            <span className="spacer">
              <strong>Shortcuts</strong>
              <span className="small muted">every binding, and the two that cannot be rebound</span>
            </span>
            <span className="muted" aria-hidden="true">→</span>
          </button>
          <button className="general-link outlined-card" onClick={() => navigate({ page: "about" })}>
            <Brand />
            <span className="spacer">
              <strong>About</strong>
              <span className="small muted">version, licence, and what this machine has done</span>
            </span>
            <span className="muted" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
      {action.error && (
        <div className="workspace-errors">
          <Notice tone="danger">{errorMessage(action.error)}</Notice>
        </div>
      )}
      <footer className="settings-identity">
        <span className="small muted">Signed in on this machine as</span>
        <strong>{settings.name}</strong>
        <span className="spacer" />
        <span className="mono muted small">perbo {workspace.version}</span>
        <Button className="small" onClick={() => navigate({ page: "home" })}>
          Done
        </Button>
      </footer>
    </section>
  );
}
