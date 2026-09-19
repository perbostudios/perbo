# The Node runtime

Nothing is checked in for it. The app runs the CLI on the Node inside Electron
(`ELECTRON_RUN_AS_NODE`), so the only Node distributed is Electron's own, and
Electron's `LICENSE` and `LICENSES.chromium.html` ship beside the binary in
every package electron-builder produces.

# Bundled font licenses

The desktop imports three [Fontsource](https://fontsource.org/) packages (`apps/desktop/src/renderer/main.tsx`), each licensed under the [SIL Open Font License, Version 1.1](https://scripts.sil.org/OFL). Every `*-OFL.txt` here is the unmodified `LICENSE` file from the installed npm package at the version this build pins.

| Font | Package | Pinned version | License file | SHA-256 |
|---|---|---|---|---|
| Caveat | `@fontsource/caveat` | 5.2.8 | `caveat-OFL.txt` | `163a2b400e16916ad3196296c946c526d0efce6baf22a2164269ffc62fb9f671` |
| Instrument Sans | `@fontsource/instrument-sans` | 5.3.0 | `instrument-sans-OFL.txt` | `c27a3c53c3beed7f5c26853afa15991478ff7145d3754a36b0382f84e10c0d03` |
| JetBrains Mono | `@fontsource/jetbrains-mono` | 5.2.8 | `jetbrains-mono-OFL.txt` | `403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b` |

When a pinned `@fontsource/*` version changes, refresh its license file and hash here from the newly installed package.
