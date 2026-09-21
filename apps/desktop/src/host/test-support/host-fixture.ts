import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initRepository } from "@perbo/test-support";
import { DesktopService, type ServiceOptions } from "../service.js";
import type { runProcess, startLineProcess } from "../process.js";
import type { Change } from "../../shared/protocol.js";

const temporary: string[] = [];
const services: DesktopService[] = [];
/**
 * Shut down every host this module made and remove every directory it made.
 *
 * The caller says when: a file of cases that each make their own host calls it
 * after each, and one that drives a single host through a suite calls it when
 * that suite ends.
 */
export async function disposeFixtures(): Promise<void> {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
}
/** A host shut down when the case ends — a second one over the same profile included. */
export function trackService<T extends DesktopService>(service: T): T {
  services.push(service);
  return service;
}
/** A directory removed when the case ends. */
export function trackDirectory(path: string): string {
  temporary.push(path);
  return path;
}
/**
 * A whole host over a temporary checkout and the bundled CLI, with what it
 * asked of the machine recorded: the notifications it put, the sleep it held,
 * the theme it applied and every change it told.
 */
export function fixture(process?: typeof runProcess, startProcess?: typeof startLineProcess) {
  const root = trackDirectory(mkdtempSync(join(tmpdir(), "perbo-desktop-")));
  // The folder name holds a space, because a path this host hands to a command
  // is one argument whatever it holds.
  const repo = initRepository(join(root, "repository with spaces"), {
    files: { "README.md": "# Test repository\n" },
    message: "Initial test state",
  }).dir;
  const notifications: { title: string; body: string; silent: boolean | undefined }[] = [];
  const holds: { hold: boolean; displaySleep: boolean }[] = [];
  const themes: string[] = [];
  const changes: Change[] = [];
  let onBattery = false;
  const options: ServiceOptions = {
    dataDirectory: join(root, "profile"),
    cliPath: resolve("../cli/dist/perbo.js"),
    nodeBinary: globalThis.process.execPath,
    version: "test",
    changed: (change) => {
      changes.push(change);
    },
    io: {
      chooseDirectory: async () => repo,
      openPath: async () => undefined,
      openExternal: async () => undefined,
      saveFile: async (_name: string, _content: string): Promise<string | null> => null,
      notify: (title, body, extra) => {
        notifications.push({ title, body, silent: extra?.silent });
      },
      holdSleep: (hold, displaySleep) => {
        holds.push({ hold, displaySleep });
      },
      onBattery: () => onBattery,
      applyTheme: (theme) => {
        themes.push(theme);
      },
    },
    usageProbe: async () => ({
      plan: "Pro",
      windows: [{ label: "Session · 5-hour window", usedPercent: 23, resetsAt: null }],
      detail: "Injected.",
    }),
    ...(process ? { process } : {}),
    ...(startProcess ? { startProcess } : {}),
  };
  const service = trackService(new DesktopService(options));
  return {
    repo,
    root,
    service,
    options,
    notifications,
    holds,
    themes,
    changes,
    setBattery: (value: boolean) => {
      onBattery = value;
    },
  };
}
