// Build first, then run with Node. Uses a disposable repository and profile;
// two real Electron processes exercise the built host, preload and renderer.
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

if (!process.versions.electron) {
  const root = mkdtempSync(join(tmpdir(), "perbo-editing-recovery-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  writeFileSync(join(repository, "README.md"), "# Native editing recovery fixture\n", { flag: "wx" });
  for (const args of [
    ["init", "--initial-branch=main"], ["config", "user.name", "Perbo fixture"],
    ["config", "user.email", "fixture@example.invalid"], ["config", "commit.gpgsign", "false"],
    ["add", "README.md"], ["commit", "-m", "Initialize recovery fixture"],
  ]) execFileSync("git", args, { cwd: repository, stdio: "pipe" });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PERBO_DESKTOP_DEV_URL;
  for (const phase of ["write", "recover"]) {
    const result = spawnSync(require("electron"), [__filename, `--phase=${phase}`, `--workspace=${root}`], {
      cwd: join(__dirname, ".."), env, encoding: "utf8", timeout: 50_000,
    });
    if (result.status !== 0 || result.error) {
      console.error(result.stdout, result.stderr, result.error ?? "");
      console.error("Retained smoke workspace:", root);
      process.exit(1);
    }
    process.stdout.write(result.stdout);
  }
  console.log("Retained smoke workspace:", root);
} else {
  const { app, BrowserWindow, dialog, ipcMain } = require("electron");
  const root = process.argv.find(value => value.startsWith("--workspace="))?.slice(12);
  const phase = process.argv.find(value => value.startsWith("--phase="))?.slice(8);
  assert.ok(root && ["write", "recover"].includes(phase), "Run this script with Node, which creates its disposable workspace.");
  const profile = join(root, "profile");
  const originalSetPath = app.setPath.bind(app);
  app.setPath = (name, path) => originalSetPath(name, name === "userData" ? profile : path);
  BrowserWindow.prototype.show = function () {};
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [join(root, "repository")] });
  let cancelledClose = false, inputQuiescentAtClose = false, completed = false;
  dialog.showMessageBox = async () => { cancelledClose = true; return { response: 0, checkboxChecked: false }; };
  dialog.showErrorBox = (title, content) => { console.error(title + ": " + content); app.exit(1); };
  const failures = [];
  const deadline = setTimeout(() => { console.error("Native recovery timed out"); app.exit(1); }, 40_000);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, name) {
    for (let i = 0; i < 150; i++) { if (await check()) return; await delay(30); }
    throw new Error("Timed out: " + name);
  }
  app.whenReady().then(() => app.dock?.hide());
  app.on("browser-window-created", (_event, window) => {
    const page = window.webContents;
    const js = text => page.executeJavaScript(text, true);
    const request = value => js(`window.perbo.request(${JSON.stringify(value)})`);
    const type = async (selector, value) => {
      await until(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), selector);
      await js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    };
    const click = text => js(`(() => { const button = [...document.querySelectorAll('button')].find(entry => entry.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('Button unavailable'); button.click(); })()`);
    page.on("render-process-gone", (_event, details) => failures.push(details.reason));
    page.once("did-finish-load", () => void (async () => {
      await until(() => js("Boolean(window.perbo)"), "native bridge");
      let workspace = await request({ kind: "snapshot" });
      if (phase === "write") {
        await request({ kind: "saveSettings", settings: { ...workspace.settings, onboardingComplete: true, executorModel: "native-recovery-model" } });
        await request({ kind: "chooseRepository" });
        workspace = await request({ kind: "snapshot" });
      }
      const repoId = workspace.repositories[0].id;
      await js("location.hash = 'new'");
      if (phase === "write") {
        await type("#outcome", "Native restart retains unfinished work");
        await click("Write criteria myself");
        await type('[aria-label="Criterion 1"]', "Unfinished native criterion");
        await type("#proof-0", "");
      } else {
        await until(() => js(`document.querySelector(${JSON.stringify('[aria-label="Criterion 1"]')})?.value === "Unfinished native criterion"`), "restored criterion buffer");
        const restored = await request({ kind: "editingOpen", target: { kind: "new", repoId } });
        assert.equal(restored.form.models.executorModel, "native-recovery-model");
        assert.equal(restored.form.draft.outcome, "Native restart retains unfinished work");
        assert.equal(restored.form.criterion.assertion, "");
        assert.equal(restored.form.editing, 0);
        assert.equal(workspace.tasks.length, 0);
        // The hidden window can paint later than the DOM checks above.
        page.setBackgroundThrottling(false);
        await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        writeFileSync(join(root, "recovered.png"), (await page.capturePage()).toPNG(), { flag: "wx" });
        const statePath = join(profile, "workspace.json"), backup = join(profile, "workspace.saved.json");
        renameSync(statePath, backup);
        mkdirSync(statePath);
        await type('[aria-label="Criterion 1"]', "Retried native edit");
        await until(() => js('document.body.innerText.includes("Retry saved edits")'), "save error");
        app.quit();
        await until(() => cancelledClose, "keep editing dialog");
        await until(() => js("!document.body.inert"), "input restored after cancelled quit");
        rmdirSync(statePath);
        renameSync(backup, statePath);
        await click("Retry saved edits");
        await until(() => js('document.body.innerText.includes("Edits saved on this device") && !document.body.innerText.includes("Saving edits…")'), "save retried");
      }
      const originalEmit = ipcMain.emit.bind(ipcMain);
      ipcMain.emit = function (name, ...args) {
        if (name === "perbo:close-response") {
          void js("document.body.inert").then(inert => {
            assert.equal(inert, true);
            inputQuiescentAtClose = true;
            setTimeout(() => originalEmit(name, ...args), 200);
          }).catch(error => { console.error(error); app.exit(1); });
          return true;
        }
        return originalEmit(name, ...args);
      };
      completed = true;
      app.quit();
    })().catch(error => { console.error(error.stack); app.exit(1); }));
  });
  app.on("will-quit", () => {
    assert.equal(completed, true);
    assert.equal(inputQuiescentAtClose, true);
    const stored = JSON.parse(readFileSync(join(profile, "workspace.json"), "utf8"));
    const session = stored.editingSessions.find(entry => entry.resumeNew);
    assert.equal(session.form.criterion.text, phase === "write" ? "Unfinished native criterion" : "Retried native edit");
    assert.equal(session.form.models.executorModel, "native-recovery-model");
    assert.equal(failures.length, 0);
    clearTimeout(deadline);
    const result = { phase, result: "pass", electron: process.versions.electron, session: session.id, revision: session.revision, incompleteCriterion: true, selectedModelRecovered: true, inputQuiescentAtClose, cancelledClose: phase === "recover" ? cancelledClose : null, tasksCreated: 0 };
    writeFileSync(join(root, phase + ".json"), JSON.stringify(result, null, 2), { flag: "wx" });
    console.log(JSON.stringify(result));
  });
  require(join(__dirname, "..", "dist", "host", "main.cjs"));
}
