import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  session,
  shell,
} from "electron";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  CHANNEL,
  CHANGED,
  CLOSE_REQUEST,
  CLOSE_RESPONSE,
  CLOSE_CANCEL,
  CloseResponseSchema,
} from "../shared/protocol.js";
import { DesktopService } from "./service.js";
import { redact } from "./process.js";

// Perbo, not Electron. `app.name` names the application menu's About, Hide
// and Quit items. The process title is what macOS shows as the application's
// name in the menu bar and the process list: it sets the process's
// LaunchServices display name, which otherwise comes from the running bundle
// and is "Electron" for `electron .`. The package electron-builder writes is
// Perbo.app, named from `productName`, and needs neither.
app.setName("Perbo");
process.title = "Perbo";
app.setPath("userData", join(app.getPath("appData"), "Perbo"));
if (!app.requestSingleInstanceLock()) app.quit();
else
  void start().catch((error: unknown) => {
    dialog.showErrorBox("Perbo could not start", redact(String(error)));
    app.quit();
  });

async function start(): Promise<void> {
  await app.whenReady();
  const devURL =
    !app.isPackaged &&
    process.env.PERBO_DESKTOP_DEV_URL === "http://127.0.0.1:51859"
      ? process.env.PERBO_DESKTOP_DEV_URL
      : null;
  const indexPath = join(__dirname, "../renderer/index.html");
  const iconPath = join(__dirname, "../renderer/brand/perbo-app-icon.png");
  app.dock?.setIcon(iconPath);
  // The About panel, not Electron's: named and versioned from package.json. The
  // build version is left out because an unpackaged run would report
  // Electron's own there.
  app.setAboutPanelOptions({
    applicationName: "Perbo",
    applicationVersion: app.getVersion(),
    version: "",
    iconPath,
  });
  const allowedURL = devURL ?? pathToFileURL(indexPath).href;
  const trustedURL = (candidate: string): boolean => {
    try {
      const url = new URL(candidate);
      url.hash = "";
      return url.href === new URL(allowedURL).href;
    } catch {
      return false;
    }
  };
  let window: BrowserWindow | null = null;
  let quitting = false;
  let quitRequested = false;
  let sleepBlocker: number | null = null;
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  const service = new DesktopService({
    dataDirectory: app.getPath("userData"),
    cliPath: app.isPackaged
      ? join(process.resourcesPath, "cli/dist/perbo.js")
      : join(__dirname, "../cli/dist/perbo.js"),
    // Electron is the Node runtime: `process.execPath` is this app's own
    // binary, and `ELECTRON_RUN_AS_NODE` — which `electronNode` sets on the
    // child's environment — makes it behave as `node` rather than start a
    // second window.
    //
    // A separate Node copied beside the app would be a copy of whichever
    // platform built it, which is a runtime that cannot be cross-packaged and a
    // second interpreter to keep patched. The one inside Electron is the one
    // already being shipped either way.
    nodeBinary: process.execPath,
    electronNode: true,
    version: app.getVersion(),
    changed: (change) => {
      if (window && !window.isDestroyed())
        window.webContents.send(CHANGED, change);
    },
    io: {
      async chooseDirectory() {
        const result = await dialog.showOpenDialog({
          title: "Connect a Git repository",
          properties: ["openDirectory"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      async openPath(path) {
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
      },
      async openExternal(url) {
        await shell.openExternal(url);
      },
      async saveFile(name, content) {
        const result = await dialog.showSaveDialog({
          title: "Export local evidence",
          defaultPath: name,
          filters: [
            {
              name: name.endsWith(".csv") ? "CSV records" : "JSON evidence",
              extensions: [name.endsWith(".csv") ? "csv" : "json"],
            },
          ],
        });
        if (result.canceled || !result.filePath) return null;
        await writeFile(result.filePath, content, { mode: 0o600 });
        return result.filePath;
      },
      notify(title, body, options) {
        if (Notification.isSupported())
          new Notification({
            title,
            body,
            silent: options?.silent ?? true,
          }).show();
      },
      holdSleep(hold, displaySleep) {
        if (sleepBlocker !== null) {
          powerSaveBlocker.stop(sleepBlocker);
          sleepBlocker = null;
        }
        if (hold)
          sleepBlocker = powerSaveBlocker.start(
            displaySleep ? "prevent-app-suspension" : "prevent-display-sleep",
          );
      },
      onBattery: () => powerMonitor.isOnBatteryPower(),
      applyTheme(theme) {
        nativeTheme.themeSource = theme;
        window?.setBackgroundColor(paper());
      },
      async openTerminal(command) {
        // macOS only: Terminal runs the provider's fixed sign-in command as argv words; nothing from a record or a model reaches it.
        if (process.platform !== "darwin")
          throw new Error(
            `Run ${command.join(" ")} in your terminal, then refresh the connection.`,
          );
        if (command.some((word) => !/^[a-z-]+$/.test(word)))
          throw new Error(
            "Refusing a sign-in command that is not a fixed word list.",
          );
        const script = `tell application "Terminal" to do script "${command.join(" ")}"`;
        await promisify(execFile)("osascript", [
          "-e",
          script,
          "-e",
          'tell application "Terminal" to activate',
        ]);
      },
    },
  });
  powerMonitor.on("on-battery", () => service.powerChanged());
  powerMonitor.on("on-ac", () => service.powerChanged());
  ipcMain.handle(CHANNEL, async (event, request: unknown) => {
    // Only our top-level renderer can use native capabilities. Subframes and other windows are refused.
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !trustedURL(event.senderFrame.url)
    )
      return { ok: false, error: "Untrusted desktop sender." };
    try {
      return {
        ok: true,
        value: await service.request(
          request as Parameters<typeof service.request>[0],
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error: redact(error instanceof Error ? error.message : String(error)),
      };
    }
  });
  const flushWindow = (current: BrowserWindow): Promise<void> =>
    new Promise((resolve, reject) => {
      const token = randomUUID();
      const cleanup = (): void => {
        clearTimeout(timer);
        ipcMain.removeListener(CLOSE_RESPONSE, received);
      };
      const received = (event: Electron.IpcMainEvent, value: unknown): void => {
        const response = CloseResponseSchema.safeParse(value);
        if (
          event.sender !== current.webContents ||
          event.senderFrame !== current.webContents.mainFrame ||
          !trustedURL(event.senderFrame?.url ?? "") ||
          !response.success ||
          response.data.token !== token
        )
          return;
        cleanup();
        if (response.data.ok) resolve();
        else
          reject(
            new Error(
              response.data.error ?? "Contract edits could not be saved.",
            ),
          );
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "The editor did not confirm that its pending edits were saved.",
          ),
        );
      }, 10_000);
      ipcMain.on(CLOSE_RESPONSE, received);
      current.webContents.send(CLOSE_REQUEST, token);
    });
  const canClose = async (current: BrowserWindow | null): Promise<boolean> => {
    if (!current || current.isDestroyed()) return true;
    try {
      await flushWindow(current);
      return true;
    } catch (error) {
      const result = await dialog.showMessageBox(current, {
        type: "warning",
        title: "Contract edits are not saved",
        message: redact(String(error)),
        detail: "The last saved edits remain on this device.",
        buttons: ["Keep editing", "Close without unsaved edits"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) current.webContents.send(CLOSE_CANCEL);
      return result.response === 1;
    }
  };
  /** The page's own paper colour, so a resize or a theme change never flashes the other theme. */
  const paper = (): string =>
    nativeTheme.shouldUseDarkColors ? "#17130f" : "#fbfaf6";
  nativeTheme.on("updated", () => window?.setBackgroundColor(paper()));
  const createWindow = async (): Promise<void> => {
    window = new BrowserWindow({
      title: "Perbo",
      icon: iconPath,
      width: 1280,
      height: 800,
      useContentSize: true,
      minWidth: 940,
      minHeight: 650,
      backgroundColor: paper(),
      // `hidden` rather than `hiddenInset`: the inset variant adds an empty native toolbar that swallows clicks in its row, so the sidebar toggle beside the lights could not be pressed.
      titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
      trafficLightPosition: { x: 18, y: 17 },
      show: false,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!trustedURL(url)) event.preventDefault();
    });
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    window.once("ready-to-show", () => window?.show());
    const current = window;
    let closing = false,
      closeAllowed = false;
    current.on("close", (event) => {
      if (quitting || closeAllowed) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      void canClose(current)
        .then((allowed) => {
          if (allowed && !current.isDestroyed()) {
            closeAllowed = true;
            current.close();
          }
        })
        .catch((error: unknown) => {
          if (!current.isDestroyed()) current.webContents.send(CLOSE_CANCEL);
          dialog.showErrorBox("Perbo could not close", redact(String(error)));
        })
        .finally(() => {
          closing = false;
        });
    });
    window.on("closed", () => {
      window = null;
    });
    if (devURL) await window.loadURL(devURL);
    else await window.loadFile(indexPath);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Perbo",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
          ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
      },
    ]),
  );
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("activate", () => {
    if (!window) void createWindow();
    else window.show();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      if (quitRequested) return;
      quitRequested = true;
      void canClose(window)
        .then(async (allowed) => {
          if (!allowed) return;
          await service.shutdown();
          quitting = true;
          app.quit();
        })
        .catch((error: unknown) => {
          if (window && !window.isDestroyed())
            window.webContents.send(CLOSE_CANCEL);
          dialog.showErrorBox("Perbo could not quit", redact(String(error)));
        })
        .finally(() => {
          quitRequested = false;
        });
    }
  });
  await createWindow();
}
