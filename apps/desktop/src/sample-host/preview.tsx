import { sampleBridge } from "./bridge.js";

/**
 * The development preview: the renderer, in a browser, against the sample host
 * ([D-NEW-desktop-sample-host](../../../../docs/11-open-decisions.md)). Vite
 * builds the app from `index.html` alone, so this page and everything it
 * reaches stay out of the packaged renderer.
 *
 * The adapter goes into the slot before the renderer is loaded, because
 * `renderer/data.ts` reads the slot as it loads.
 */
window.perbo = sampleBridge;
const { mountApp } = await import("../renderer/mount.js");
mountApp(document.getElementById("root")!, "sample");

/** Said on every screen, because nothing here is the person's own work. */
const indicator = document.createElement("div");
indicator.className = "preview-indicator";
indicator.title =
  "Interactive preview with sample records. No coding agents run and no repositories are accessed.";
indicator.textContent = "Sample workspace";
document.body.append(indicator);
