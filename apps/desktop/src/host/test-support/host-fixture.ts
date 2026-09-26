import { join, resolve } from "node:path";
import { createScratch, initRepository } from "@perbo/test-support";
import { DesktopService, type ServiceOptions } from "../service.js";
import type { runProcess, startLineProcess } from "../process.js";
import type { Change } from "../../shared/protocol.js";

/**
 * A directory removed when the case that asked for it ends.
 *
 * `disposeFixtures` takes these back along with the hosts, so a file that
 * registers it has said where every directory it makes here goes.
 */
export const scratchDirectory = createScratch("perbo-desktop-");
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
  scratchDirectory.removeAll();
}
/** A host shut down when the case ends — a second one over the same profile included. */
export function trackService<T extends DesktopService>(service: T): T {
  services.push(service);
  return service;
}
/**
 * A whole host over a temporary checkout and the bundled CLI, with what it
 * asked of the machine recorded: the notifications it put, the sleep it held,
 * the theme it applied and every change it told.
 */
export function fixture(
  process?: typeof runProcess,
  startProcess?: typeof startLineProcess,
  /** Whatever else this fixture's service is to be built with. */
  also?: Partial<ServiceOptions>,
) {
  const root = scratchDirectory();
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
    usageProbe: {
      claude: async () => ({
        plan: "Max",
        windows: [{ label: "5-hour limit", usedPercent: 9, resetsAt: null }],
        detail: "Injected Claude.",
      }),
      codex: async () => ({
        plan: "Pro",
        windows: [{ label: "5-hour limit", usedPercent: 23, resetsAt: null }],
        detail: "Injected.",
      }),
    },
    // No provider CLI is asked for its catalog: one that lists nothing, which
    // leaves the chat on the planning's executor model.
    modelCatalog: async (provider) => ({
      provider,
      models: [],
      discoveredAt: new Date().toISOString(),
      source: "sample",
    }),
    ...(process ? { process } : {}),
    ...(startProcess ? { startProcess } : {}),
    ...(also ?? {}),
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
